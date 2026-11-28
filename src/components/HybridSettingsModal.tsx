import React, { useEffect, useRef } from 'react';
import {
  CheckCircle2,
  Cloud,
  Cpu,
  Download,
  RefreshCw,
  ShieldCheck,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import {
  initializeOnDeviceModel,
  refreshHybridCapabilities,
} from '../services/hybridAi';
import type { HybridRuntimeStatus, InferenceModePreference } from '../types';

interface HybridSettingsModalProps {
  open: boolean;
  onClose: () => void;
  status: HybridRuntimeStatus;
  mode: InferenceModePreference;
  onModeChange: (mode: InferenceModePreference) => void;
}

const MODE_OPTIONS: Array<{
  id: InferenceModePreference;
  label: string;
  summary: string;
}> = [
  {
    id: 'prefer_on_device',
    label: 'Prefer On-Device',
    summary:
      'Runs locally via Chrome Prompt API (Gemini Nano) when ready, with automatic Firebase AI Logic Cloud fallback.',
  },
  {
    id: 'only_on_device',
    label: 'On-Device Only',
    summary:
      'Strictly local Chrome on-device inference. Never sends prompts to the cloud; errors if local model is unready.',
  },
  {
    id: 'prefer_in_cloud',
    label: 'Prefer Cloud',
    summary:
      'Uses Firebase AI Logic Cloud model first, falling back to on-device when available if cloud fails.',
  },
  {
    id: 'only_in_cloud',
    label: 'Cloud Only',
    summary:
      'Strictly routes inference through Firebase AI Logic Cloud backend (best for multimodal image analysis or long contexts).',
  },
];

export function HybridSettingsModal({
  open,
  onClose,
  status,
  mode,
  onModeChange,
}: HybridSettingsModalProps) {
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    closeBtnRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const availabilityLabel: Record<HybridRuntimeStatus['onDeviceAvailability'], string> = {
    available: 'Ready (Gemini Nano loaded on device)',
    downloadable: 'Downloadable (Click Initialize below)',
    downloading: 'Downloading on-device model...',
    unavailable: 'Unavailable on this device / browser flags',
    unsupported: 'Browser lacks built-in LanguageModel API',
  };

  const appCheckLabel: Record<HybridRuntimeStatus['appCheckStatus'], string> = {
    'active-recaptcha-v3': 'Active (reCAPTCHA v3)',
    'active-recaptcha-enterprise': 'Active (reCAPTCHA Enterprise)',
    'unconfigured-site-key': 'Not configured (optional; set VITE_RECAPTCHA_SITE_KEY or VITE_RECAPTCHA_ENTERPRISE_KEY)',
    error: 'Initialization error (check console)',
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="hybrid-settings-title"
    >
      <div className="w-full max-w-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-lg overflow-hidden max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-800">
          <div>
            <h2
              id="hybrid-settings-title"
              className="text-base font-semibold font-display text-slate-900 dark:text-white"
            >
              Firebase AI Logic Hybrid Runtime
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Control on-device vs cloud execution, inspect App Check, and download the local Chrome model.
            </p>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            onClick={onClose}
            aria-label="Close Hybrid Runtime settings"
            className="p-2 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-sky-500"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-5 overflow-y-auto">
          {/* Runtime Telemetry Grid */}
          <div className="grid sm:grid-cols-2 gap-3">
            <div className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 space-y-1">
              <div className="flex items-center gap-2 text-xs font-medium text-slate-500 dark:text-slate-400">
                <Cpu className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                <span>On-Device Capability</span>
              </div>
              <p className="text-sm font-medium text-slate-900 dark:text-white">
                {availabilityLabel[status.onDeviceAvailability]}
              </p>
            </div>

            <div className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 space-y-1">
              <div className="flex items-center gap-2 text-xs font-medium text-slate-500 dark:text-slate-400">
                <Cloud className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400" />
                <span>Cloud Fallback Model</span>
              </div>
              <p className="text-sm font-mono font-medium text-slate-900 dark:text-white">
                {status.cloudModel}
              </p>
            </div>

            <div className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 space-y-1">
              <div className="flex items-center gap-2 text-xs font-medium text-slate-500 dark:text-slate-400">
                {status.online ? (
                  <Wifi className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <WifiOff className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
                )}
                <span>Network Status</span>
              </div>
              <p className="text-sm font-medium text-slate-900 dark:text-white">
                {status.online ? 'Online' : 'Offline — Cloud inference unavailable'}
              </p>
            </div>

            <div className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 space-y-1">
              <div className="flex items-center gap-2 text-xs font-medium text-slate-500 dark:text-slate-400">
                <ShieldCheck className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400" />
                <span>Firebase App Check</span>
              </div>
              <p className="text-xs font-medium text-slate-900 dark:text-white">
                {appCheckLabel[status.appCheckStatus]}
              </p>
              {status.appCheckError && (
                <p className="text-[11px] text-amber-700 dark:text-amber-300 leading-snug pt-1">
                  {status.appCheckError}
                </p>
              )}
            </div>

            <div className="sm:col-span-2 p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                Last Inference Source
              </span>
              <span className="text-xs font-mono font-medium text-slate-900 dark:text-white">
                {status.lastInferenceSource
                  ? `${status.lastInferenceSource} · ${status.lastModelUsed ?? status.cloudModel}${
                      typeof status.lastLatencyMs === 'number' ? ` · ${status.lastLatencyMs} ms` : ''
                    }`
                  : 'No inference run yet (ready: Prefer On-Device -> Cloud fallback)'}
              </span>
            </div>
          </div>

          {/* On-Device Initialization Controls */}
          <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
                  On-Device Model Preparation
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Chrome Prompt API requires a button click to initialize or download Gemini Nano (~1.5 GB one-time browser download).
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => void refreshHybridCapabilities()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Recheck
                </button>
                <button
                  type="button"
                  onClick={() => void initializeOnDeviceModel()}
                  disabled={status.isDownloading || !status.browserSupported}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-lg bg-sky-600 hover:bg-sky-700 disabled:opacity-40 text-white whitespace-nowrap"
                >
                  {status.deviceModelReady ? (
                    <CheckCircle2 className="w-3.5 h-3.5" />
                  ) : (
                    <Download className="w-3.5 h-3.5" />
                  )}
                  {status.isDownloading
                    ? `Downloading ${status.downloadProgress ?? 0}%`
                    : status.deviceModelReady
                      ? 'On-Device Ready'
                      : 'Initialize On-Device Model'}
                </button>
              </div>
            </div>

            {status.downloadProgress !== null && (
              <div className="space-y-1">
                <div className="h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                  <div
                    className="h-full bg-emerald-500 transition-all duration-150"
                    style={{ width: `${status.downloadProgress}%` }}
                  />
                </div>
                <p className="text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
                  Download / initialization progress: {status.downloadProgress}%
                </p>
              </div>
            )}

            {status.lastError && (
              <p className="text-xs text-amber-700 dark:text-amber-300">{status.lastError}</p>
            )}
          </div>

          {/* Inference Mode Selector */}
          <div className="space-y-2.5">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
              Inference Routing Mode
            </h3>
            <div className="grid sm:grid-cols-2 gap-2.5">
              {MODE_OPTIONS.map((opt) => {
                const selected = mode === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => onModeChange(opt.id)}
                    className={`text-left p-3.5 rounded-xl border transition-colors ${
                      selected
                        ? 'border-sky-600 bg-sky-50 dark:bg-sky-950/40'
                        : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50'
                    }`}
                  >
                    <p className="text-sm font-semibold text-slate-900 dark:text-white">
                      {opt.label}
                    </p>
                    <p className="text-xs text-slate-600 dark:text-slate-400 mt-1 leading-relaxed">
                      {opt.summary}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Honest Architecture Disclosure */}
          <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-800 text-xs text-slate-600 dark:text-slate-300 leading-relaxed space-y-1">
            <p className="font-semibold text-slate-800 dark:text-slate-200">
              Architecture Disclosure
            </p>
            <p>
              Text tutoring, chat, study notes, quizzes, and Create workflows route first through Firebase AI Logic Hybrid Inference (<code className="font-mono">firebase/ai</code>). If Firebase AI Logic cloud is disabled on a Google-hosted Starter Tier project, non-local modes transparently fall back to the Express <code className="font-mono">/api/hybrid/fallback</code> Gemini endpoint (labeled <code className="font-mono">Server Cloud Fallback</code>); <code className="font-mono">On-Device Only</code> stays strictly local.
            </p>
            <p>
              Audio Text-to-Speech, Speech-to-Text, Live Voice, and audio pronunciation evaluation use browser Web Speech / MediaRecorder APIs and server-side Gemini audio endpoints, not on-device Gemini Nano.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
