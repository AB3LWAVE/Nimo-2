export interface LanguageOption {
  name: string;
  bcp47: string;
  nativeName: string;
}

export const PRESET_LANGUAGES: LanguageOption[] = [
  { name: 'Spanish', bcp47: 'es-ES', nativeName: 'Español' },
  { name: 'French', bcp47: 'fr-FR', nativeName: 'Français' },
  { name: 'German', bcp47: 'de-DE', nativeName: 'Deutsch' },
  { name: 'Japanese', bcp47: 'ja-JP', nativeName: '日本語' },
  { name: 'Mandarin Chinese', bcp47: 'zh-CN', nativeName: '中文' },
  { name: 'Italian', bcp47: 'it-IT', nativeName: 'Italiano' },
  { name: 'Korean', bcp47: 'ko-KR', nativeName: '한국어' },
  { name: 'Portuguese', bcp47: 'pt-BR', nativeName: 'Português' },
  { name: 'Arabic', bcp47: 'ar-SA', nativeName: 'العربية' },
];

export function getBcp47ForLanguage(languageName: string): string {
  const found = PRESET_LANGUAGES.find(
    (l) => l.name.toLowerCase() === languageName.trim().toLowerCase()
  );
  return found?.bcp47 || 'en-US';
}

export interface AudioSupportStatus {
  micSupported: boolean;
  mediaRecorderSupported: boolean;
  audioContextSupported: boolean;
  browserTtsSupported: boolean;
  reason?: string;
}

export function checkAudioSupport(): AudioSupportStatus {
  const micSupported = Boolean(
    typeof navigator !== 'undefined' &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function'
  );
  const mediaRecorderSupported = typeof MediaRecorder !== 'undefined';
  const audioContextSupported =
    typeof window !== 'undefined' &&
    Boolean(
      window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    );
  const browserTtsSupported =
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    typeof SpeechSynthesisUtterance !== 'undefined';

  let reason: string | undefined;
  if (!micSupported) {
    reason = 'Microphone capture requires a modern browser over HTTPS or localhost.';
  } else if (!mediaRecorderSupported) {
    reason = 'MediaRecorder is not supported in this browser.';
  }

  return {
    micSupported,
    mediaRecorderSupported,
    audioContextSupported,
    browserTtsSupported,
    reason,
  };
}

let activeAudioElement: HTMLAudioElement | null = null;
let activeAudioUrl: string | null = null;

export function stopCurrentAudio() {
  if (activeAudioElement) {
    activeAudioElement.pause();
    activeAudioElement.src = '';
    activeAudioElement = null;
  }
  if (activeAudioUrl) {
    URL.revokeObjectURL(activeAudioUrl);
    activeAudioUrl = null;
  }
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
}

export async function playGeminiTTS(options: {
  text: string;
  language?: string;
  speed?: number;
  voiceName?: string;
  onStart?: () => void;
  onEnd?: () => void;
}): Promise<{ modelUsed: string }> {
  const { text, language = 'English', speed = 1.0, voiceName = 'Kore', onStart, onEnd } = options;
  stopCurrentAudio();

  const res = await fetch('/api/audio/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, language, voiceName }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || data.error || 'Failed to synthesize speech.');
  }

  const binary = atob(data.audioBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  const blob = new Blob([bytes], { type: data.mimeType || 'audio/wav' });
  const url = URL.createObjectURL(blob);
  activeAudioUrl = url;

  const audio = new Audio(url);
  audio.playbackRate = speed;
  activeAudioElement = audio;

  audio.onended = () => {
    if (activeAudioUrl === url) {
      URL.revokeObjectURL(url);
      activeAudioUrl = null;
      activeAudioElement = null;
    }
    onEnd?.();
  };

  audio.onerror = () => {
    if (activeAudioUrl === url) {
      URL.revokeObjectURL(url);
      activeAudioUrl = null;
      activeAudioElement = null;
    }
    onEnd?.();
  };

  onStart?.();
  await audio.play();
  return { modelUsed: data.modelUsed || 'gemini-3.8-flash-tts' };
}

export function playBrowserSpeechFallback(options: {
  text: string;
  language: string;
  speed: number;
  onEnd?: () => void;
}) {
  const { text, language, speed, onEnd } = options;
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    throw new Error('Browser speech synthesis is unavailable.');
  }
  stopCurrentAudio();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = getBcp47ForLanguage(language);
  utterance.rate = speed;
  utterance.onend = () => onEnd?.();
  utterance.onerror = () => onEnd?.();
  window.speechSynthesis.speak(utterance);
}

export function pickSupportedAudioMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return 'audio/webm';
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }
  return '';
}

export function mapMicrophoneError(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      return 'Microphone permission was denied. Enable microphone access in your browser site settings and try again.';
    }
    if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
      return 'No microphone device was found. Connect a microphone and try again.';
    }
    if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
      return 'Your microphone is currently in use by another application or tab.';
    }
  }
  return err instanceof Error ? err.message : 'Unable to access microphone.';
}

export interface ActiveRecording {
  stop: () => Promise<{ base64: string; mimeType: string }>;
  cancel: () => void;
  stream: MediaStream;
}

export async function startMicRecording(): Promise<ActiveRecording> {
  const support = checkAudioSupport();
  if (!support.micSupported || !support.mediaRecorderSupported) {
    throw new Error(support.reason || 'Audio recording is not supported in this browser.');
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    throw new Error(mapMicrophoneError(err));
  }

  const mimeType = pickSupportedAudioMimeType();
  const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  const chunks: Blob[] = [];

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) {
      chunks.push(e.data);
    }
  };

  recorder.start(150);

  const cleanup = () => {
    stream.getTracks().forEach((t) => t.stop());
  };

  return {
    stream,
    cancel: () => {
      try {
        if (recorder.state !== 'inactive') recorder.stop();
      } finally {
        cleanup();
      }
    },
    stop: () =>
      new Promise((resolve, reject) => {
        recorder.onstop = async () => {
          cleanup();
          const finalMime = recorder.mimeType || mimeType || 'audio/webm';
          const blob = new Blob(chunks, { type: finalMime });
          if (blob.size === 0) {
            reject(new Error('No audio was captured. Speak closer to the microphone and try again.'));
            return;
          }
          const reader = new FileReader();
          reader.onloadend = () => {
            const result = typeof reader.result === 'string' ? reader.result : '';
            const base64 = result.includes(',') ? result.split(',')[1] : '';
            resolve({ base64, mimeType: finalMime.split(';')[0] });
          };
          reader.onerror = () => reject(new Error('Failed to read recorded audio.'));
          reader.readAsDataURL(blob);
        };
        if (recorder.state !== 'inactive') {
          recorder.stop();
        } else {
          cleanup();
          reject(new Error('Recording ended unexpectedly.'));
        }
      }),
  };
}

export async function transcribeAudioClip(
  audioBase64: string,
  mimeType: string,
  languageHint?: string
): Promise<{ transcript: string; modelUsed: string }> {
  const res = await fetch('/api/audio/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audioBase64, mimeType, languageHint }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || data.error || 'Transcription failed.');
  }
  return data;
}

export function float32ToPcm16Base64(float32: Float32Array): string {
  const pcm16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const bytes = new Uint8Array(pcm16.buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function pcm24kBase64ToAudioBuffer(
  ctx: AudioContext,
  base64: string
): AudioBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const int16 = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 32768;
  }
  const buffer = ctx.createBuffer(1, float32.length, 24000);
  buffer.getChannelData(0).set(float32);
  return buffer;
}
