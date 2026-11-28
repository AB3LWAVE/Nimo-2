import {
  AIError,
  AIErrorCode,
  getGenerativeModel,
  InferenceMode,
  InferenceSource,
  type Content,
  type Part,
} from 'firebase/ai';
import { ai, appCheckStatus, getAppCheckError, subscribeAppCheckError } from '../firebase';
import type {
  HybridGenerationResult,
  HybridInferenceSource,
  HybridRuntimeStatus,
  InferenceModePreference,
  OnDeviceAvailabilityState,
  SdkInferenceSource,
} from '../types';
import { extractAndParseJson, truncateConversationHistory } from '../utils/validation';

interface ChromeLanguageModelGlobal {
  availability?: (options?: unknown) => Promise<string>;
}

const configuredCloudModel =
  typeof import.meta !== 'undefined'
    ? (import.meta.env?.VITE_HYBRID_CLOUD_MODEL || '').trim()
    : '';

if (typeof window !== 'undefined' && !configuredCloudModel) {
  console.info(
    '[Nimo] Optional VITE_HYBRID_CLOUD_MODEL not set; using default cloud fallback model "gemini-3.5-flash-lite".'
  );
}

export const DEFAULT_CLOUD_MODEL = configuredCloudModel || 'gemini-3.5-flash-lite';

export function toSdkInferenceMode(pref: InferenceModePreference): InferenceMode {
  switch (pref) {
    case 'prefer_on_device':
      return InferenceMode.PREFER_ON_DEVICE;
    case 'only_on_device':
      return InferenceMode.ONLY_ON_DEVICE;
    case 'prefer_in_cloud':
      return InferenceMode.PREFER_IN_CLOUD;
    case 'only_in_cloud':
      return InferenceMode.ONLY_IN_CLOUD;
  }
}

export function normalizeInferenceMode(
  mode: string | undefined
): InferenceModePreference {
  if (
    mode === 'prefer_on_device' ||
    mode === 'only_on_device' ||
    mode === 'prefer_in_cloud' ||
    mode === 'only_in_cloud'
  ) {
    return mode;
  }
  if (mode === 'fast') return 'prefer_on_device';
  if (mode === 'thinking' || mode === 'vision') return 'only_in_cloud';
  return 'prefer_on_device';
}

export function mapAiError(
  err: unknown,
  mode: InferenceModePreference,
  online: boolean
): { message: string; retryable: boolean; code: string } {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();
  const code = err instanceof AIError ? err.code : 'unknown';

  if (mode === 'only_on_device') {
    if (
      lower.includes('unavailable') ||
      lower.includes('not available') ||
      lower.includes('download') ||
      lower.includes('unsupported') ||
      lower.includes('languagemodel') ||
      code === AIErrorCode.UNSUPPORTED
    ) {
      return {
        message:
          'On-device model is not ready or unsupported in this browser. Click "Initialize On-Device Model" in Hybrid AI Settings (Chrome Desktop 139+ with Prompt API enabled) or switch mode to "Prefer On-Device".',
        retryable: false,
        code,
      };
    }
  }

  if (!online && (mode === 'only_in_cloud' || mode === 'prefer_in_cloud')) {
    return {
      message:
        'You appear to be offline while Cloud Inference is required. Reconnect to the internet or switch to "Prefer On-Device" / "On-Device Only".',
      retryable: true,
      code: 'offline',
    };
  }

  if (code === AIErrorCode.API_NOT_ENABLED || lower.includes('firebaseai.googleapis.com')) {
    return {
      message:
        'Firebase AI Logic API is not enabled for this Firebase project. Enable the Gemini Developer API / Firebase AI Logic in the Firebase Console.',
      retryable: false,
      code,
    };
  }

  if (
    lower.includes('exchangedebugtoken') ||
    lower.includes('fetch-status-error') ||
    lower.includes('initial-throttle') ||
    lower.includes('app check') ||
    lower.includes('appcheck') ||
    lower.includes('401') ||
    lower.includes('403')
  ) {
    const capturedAppCheckErr = getAppCheckError();
    if (capturedAppCheckErr) {
      return {
        message: capturedAppCheckErr,
        retryable: false,
        code: 'app_check_or_403',
      };
    }
    const errCode =
      err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string'
        ? (err as { code: string }).code
        : '';
    const detail = [errCode ? `code: ${errCode}` : '', raw ? `message: ${raw}` : '']
      .filter(Boolean)
      .join(' | ');
    const isDebugExchange =
      lower.includes('exchangedebugtoken') ||
      lower.includes('fetch-status-error') ||
      lower.includes('initial-throttle');
    return {
      message: isDebugExchange
        ? `Firebase App Check :exchangeDebugToken returned 403 (${detail}). Check Google Cloud API key restrictions, Firebase App Check API permissions, and Manage debug tokens for web app 1:347676576464:web:96a145247bc2fdbab0acd5.`
        : `Request blocked by Firebase App Check or project permissions (${detail}). Configure VITE_RECAPTCHA_SITE_KEY or register your local App Check debug token under Manage debug tokens for web app 1:347676576464:web:96a145247bc2fdbab0acd5 in Firebase Console (and check Google Cloud API key / Firebase App Check API permissions).`,
      retryable: false,
      code: 'app_check_or_403',
    };
  }

  if (lower.includes('429') || lower.includes('quota') || lower.includes('resource_exhausted')) {
    return {
      message:
        'Rate limit or quota reached on cloud inference. Wait a moment and retry, or use On-Device mode if supported.',
      retryable: true,
      code: 'quota_429',
    };
  }

  if (lower.includes('timeout') || lower.includes('timed out')) {
    return {
      message: 'Inference request timed out. Please try again.',
      retryable: true,
      code: 'timeout',
    };
  }

  return {
    message: raw || 'Hybrid AI generation failed.',
    retryable: true,
    code,
  };
}

export function shouldUseServerHybridFallback(
  err: unknown,
  mode: InferenceModePreference,
  online: boolean
): boolean {
  if (mode === 'only_on_device' || !online) return false;
  if (err instanceof Error && err.name === 'AbortError') return false;

  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();
  const code = err instanceof AIError ? err.code : '';

  return (
    code === AIErrorCode.API_NOT_ENABLED ||
    lower.includes('firebaseai.googleapis.com') ||
    lower.includes('api_not_enabled') ||
    lower.includes('has not been used in project') ||
    lower.includes('app check') ||
    lower.includes('appcheck') ||
    lower.includes('exchangedebugtoken') ||
    lower.includes('fetch-status-error') ||
    lower.includes('initial-throttle') ||
    lower.includes('throttled') ||
    lower.includes('unauthenticated') ||
    lower.includes('permission_denied') ||
    lower.includes('not_found') ||
    lower.includes('not found') ||
    lower.includes('401') ||
    lower.includes('403') ||
    lower.includes('404')
  );
}

let runtimeStatus: HybridRuntimeStatus = {
  browserSupported: false,
  onDeviceAvailability: 'unsupported',
  online: typeof navigator !== 'undefined' ? navigator.onLine : true,
  downloadProgress: null,
  isDownloading: false,
  deviceModelReady: false,
  appCheckStatus,
  appCheckError: getAppCheckError(),
  cloudModel: DEFAULT_CLOUD_MODEL,
  lastInferenceSource: null,
  lastModelUsed: null,
  lastLatencyMs: null,
  lastError: null,
};

const listeners = new Set<(status: HybridRuntimeStatus) => void>();

function notifyListeners() {
  const snapshot = { ...runtimeStatus };
  listeners.forEach((cb) => cb(snapshot));
}

export function getHybridRuntimeStatus(): HybridRuntimeStatus {
  return { ...runtimeStatus };
}

export function subscribeHybridRuntimeStatus(
  cb: (status: HybridRuntimeStatus) => void
): () => void {
  listeners.add(cb);
  cb({ ...runtimeStatus });
  return () => {
    listeners.delete(cb);
  };
}

export async function refreshHybridCapabilities(): Promise<HybridRuntimeStatus> {
  const online = typeof navigator !== 'undefined' ? navigator.onLine : true;
  const lm = (globalThis as unknown as { LanguageModel?: ChromeLanguageModelGlobal })
    .LanguageModel;

  let browserSupported = false;
  let onDeviceAvailability: OnDeviceAvailabilityState = 'unsupported';
  let deviceModelReady = runtimeStatus.deviceModelReady;

  if (lm && typeof lm.availability === 'function') {
    browserSupported = true;
    try {
      const avail = await lm.availability({
        expectedInputs: [{ type: 'text' }],
        expectedOutputs: [{ type: 'text' }],
      });
      if (
        avail === 'available' ||
        avail === 'downloadable' ||
        avail === 'downloading' ||
        avail === 'unavailable'
      ) {
        onDeviceAvailability = avail;
        if (avail === 'available') {
          deviceModelReady = true;
        }
      } else {
        onDeviceAvailability = 'unavailable';
      }
    } catch {
      onDeviceAvailability = 'unavailable';
    }
  }

  runtimeStatus = {
    ...runtimeStatus,
    browserSupported,
    onDeviceAvailability,
    online,
    deviceModelReady,
    appCheckStatus,
  };
  notifyListeners();
  return getHybridRuntimeStatus();
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    runtimeStatus = { ...runtimeStatus, online: true };
    notifyListeners();
  });
  window.addEventListener('offline', () => {
    runtimeStatus = { ...runtimeStatus, online: false };
    notifyListeners();
  });
  subscribeAppCheckError((appCheckError) => {
    runtimeStatus = { ...runtimeStatus, appCheckError };
    notifyListeners();
  });
  void refreshHybridCapabilities();
}

/**
 * Must be called from a user gesture (e.g. button click) because Chrome Prompt API
 * requires user activation when downloading the on-device Gemini Nano model.
 */
export async function initializeOnDeviceModel(): Promise<HybridRuntimeStatus> {
  const current = await refreshHybridCapabilities();
  if (!current.browserSupported || current.onDeviceAvailability === 'unavailable') {
    runtimeStatus = {
      ...runtimeStatus,
      lastError:
        'Chrome built-in Prompt API (LanguageModel) is unavailable in this browser/device.',
    };
    notifyListeners();
    return getHybridRuntimeStatus();
  }

  runtimeStatus = {
    ...runtimeStatus,
    isDownloading: true,
    downloadProgress: 0,
    lastError: null,
  };
  notifyListeners();

  try {
    const model = getGenerativeModel(ai, {
      mode: InferenceMode.PREFER_ON_DEVICE,
      onDeviceParams: {
        createOptions: {
          expectedInputs: [{ type: 'text', languages: ['en'] }],
          expectedOutputs: [{ type: 'text', languages: ['en'] }],
        },
      },
      inCloudParams: {
        model: DEFAULT_CLOUD_MODEL,
      },
    });

    await model.initializeDeviceModel((progressValue) => {
      const pct = Math.max(0, Math.min(100, Math.round(progressValue * 100)));
      runtimeStatus = {
        ...runtimeStatus,
        isDownloading: pct < 100,
        downloadProgress: pct,
      };
      notifyListeners();
    });

    runtimeStatus = {
      ...runtimeStatus,
      isDownloading: false,
      downloadProgress: 100,
      deviceModelReady: true,
      onDeviceAvailability: 'available',
      lastError: null,
    };
  } catch (err) {
    runtimeStatus = {
      ...runtimeStatus,
      isDownloading: false,
      lastError:
        err instanceof Error
          ? err.message
          : 'Failed to initialize Chrome on-device model.',
    };
  }

  notifyListeners();
  return getHybridRuntimeStatus();
}

const inFlightRequests = new Map<string, AbortController>();

export interface GenerateHybridTextOptions {
  prompt: string;
  systemInstruction?: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  mode?: InferenceModePreference;
  temperature?: number;
  image?: { base64: string; mimeType: string };
  jsonMode?: boolean;
  requestKey?: string;
  timeoutMs?: number;
}

export async function generateHybridText(
  options: GenerateHybridTextOptions
): Promise<HybridGenerationResult> {
  const {
    prompt,
    systemInstruction,
    history = [],
    mode = 'prefer_on_device',
    temperature,
    image,
    jsonMode = false,
    requestKey,
    timeoutMs = 45000,
  } = options;

  const trimmedPrompt = prompt.trim();
  if (!trimmedPrompt && !image) {
    throw new Error('Prompt or image input is required.');
  }

  if (requestKey && inFlightRequests.has(requestKey)) {
    inFlightRequests.get(requestKey)?.abort();
    inFlightRequests.delete(requestKey);
  }

  const controller = new AbortController();
  if (requestKey) {
    inFlightRequests.set(requestKey, controller);
  }

  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const online = typeof navigator !== 'undefined' ? navigator.onLine : true;

  // When an image is attached, Chrome Prompt API only supports specific image inputs
  // or cloud multimodal fallback when Prefer On-Device is active.
  const sdkMode = toSdkInferenceMode(mode);
  const startedAt = performance.now();

  try {
    const model = getGenerativeModel(
      ai,
      {
        mode: sdkMode,
        onDeviceParams: {
          createOptions: {
            expectedInputs: image
              ? [{ type: 'text' }, { type: 'image' }]
              : [{ type: 'text' }],
            expectedOutputs: [{ type: 'text' }],
          },
        },
        inCloudParams: {
          model: DEFAULT_CLOUD_MODEL,
          ...(systemInstruction ? { systemInstruction } : {}),
          ...(temperature !== undefined
            ? { generationConfig: { temperature } }
            : {}),
        },
      },
      { timeout: timeoutMs }
    );

    const safeHistory = truncateConversationHistory(history, 10, 8000);
    const contents: Content[] = [
      ...safeHistory.map((m, idx) => ({
        role: (m.role === 'assistant' ? 'model' : 'user') as 'model' | 'user',
        parts: [
          {
            type: 'text' as const,
            text:
              idx === 0 && systemInstruction && mode !== 'only_in_cloud'
                ? `${systemInstruction}\n\n${m.content}`
                : m.content,
          },
        ] as Part[],
      })),
      {
        role: 'user' as const,
        parts: [
          ...(image
            ? [
                {
                  type: 'inlineData' as const,
                  inlineData: {
                    mimeType: image.mimeType,
                    data: image.base64,
                  },
                } as Part,
              ]
            : []),
          {
            type: 'text' as const,
            text:
              systemInstruction && safeHistory.length === 0 && mode !== 'only_in_cloud'
                ? `${systemInstruction}\n\nUser request:\n${trimmedPrompt || 'Analyze this attached image.'}`
                : trimmedPrompt || 'Analyze this attached image.',
          } as Part,
        ],
      },
    ];

    const result = await model.generateContent(
      { contents },
      { signal: controller.signal }
    );
    const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
    const responseText = result.response.text();
    const rawSource = result.response.inferenceSource;
    const inferenceSource: HybridInferenceSource =
      rawSource === InferenceSource.ON_DEVICE ? 'on_device' : 'in_cloud';
    const sdkInferenceSource: SdkInferenceSource =
      rawSource === InferenceSource.ON_DEVICE ? 'ON_DEVICE' : 'IN_CLOUD';

    const modelUsed =
      inferenceSource === 'on_device'
        ? 'gemini-nano (on-device)'
        : DEFAULT_CLOUD_MODEL;

    runtimeStatus = {
      ...runtimeStatus,
      lastInferenceSource: sdkInferenceSource,
      lastModelUsed: modelUsed,
      lastLatencyMs: latencyMs,
      lastError: null,
    };
    notifyListeners();

    return {
      text: responseText,
      inferenceSource,
      sdkInferenceSource,
      modelUsed,
      latencyMs,
      modeUsed: mode,
    };
  } catch (err) {
    if (
      typeof window !== 'undefined' &&
      shouldUseServerHybridFallback(err, mode, online)
    ) {
      let fallbackErrorMessage: string | null = null;
      try {
        const res = await fetch('/api/hybrid/fallback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            prompt: trimmedPrompt,
            systemInstruction,
            history: truncateConversationHistory(history, 10, 8000),
            temperature,
            image,
            jsonMode,
          }),
        });
        const payload = (await res.json().catch(() => ({}))) as {
          text?: string;
          modelUsed?: string;
          message?: string;
          error?: string;
        };
        if (res.ok && typeof payload.text === 'string') {
          const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
          const modelUsed = `${payload.modelUsed || 'gemini-3.1-flash-lite'} (server fallback)`;
          runtimeStatus = {
            ...runtimeStatus,
            lastInferenceSource: 'IN_CLOUD',
            lastModelUsed: modelUsed,
            lastLatencyMs: latencyMs,
            lastError: null,
          };
          notifyListeners();
          return {
            text: payload.text,
            inferenceSource: 'in_cloud',
            sdkInferenceSource: 'IN_CLOUD',
            modelUsed,
            latencyMs,
            modeUsed: mode,
          };
        }
        if (payload.message || payload.error) {
          fallbackErrorMessage = payload.message || payload.error || null;
        }
      } catch (fallbackErr) {
        if (fallbackErr instanceof Error && fallbackErr.name === 'AbortError') {
          throw new Error('Inference request timed out. Please try again.');
        }
      }

      if (fallbackErrorMessage) {
        throw new Error(fallbackErrorMessage);
      }
    }

    const mapped = mapAiError(err, mode, online);
    throw new Error(mapped.message);
  } finally {
    clearTimeout(timer);
    if (requestKey && inFlightRequests.get(requestKey) === controller) {
      inFlightRequests.delete(requestKey);
    }
  }
}

export async function generateHybridJson<T>(
  options: GenerateHybridTextOptions & { validator?: (raw: unknown) => T }
): Promise<{ data: T; meta: Omit<HybridGenerationResult, 'text'> }> {
  const { validator, ...rest } = options;
  const result = await generateHybridText({
    ...rest,
    jsonMode: true,
    temperature: rest.temperature ?? 0.3,
  });

  const parsed = extractAndParseJson<unknown>(result.text);
  const data = validator ? validator(parsed) : (parsed as T);
  return {
    data,
    meta: {
      inferenceSource: result.inferenceSource,
      sdkInferenceSource: result.sdkInferenceSource,
      modelUsed: result.modelUsed,
      latencyMs: result.latencyMs,
      modeUsed: result.modeUsed,
    },
  };
}
