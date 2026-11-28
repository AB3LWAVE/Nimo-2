import React, { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, PhoneOff, Volume2, X, AlertCircle } from 'lucide-react';
import {
  checkAudioSupport,
  float32ToPcm16Base64,
  mapMicrophoneError,
  pcm24kBase64ToAudioBuffer,
} from '../utils/audio';

interface LiveVoiceModalProps {
  open: boolean;
  onClose: () => void;
  mode: 'chat' | 'language';
  language?: string;
  level?: string;
}

interface TranscriptLine {
  id: string;
  speaker: 'You' | 'Nimo';
  text: string;
}

export function LiveVoiceModal({
  open,
  onClose,
  mode,
  language = 'Spanish',
  level = 'Beginner',
}: LiveVoiceModalProps) {
  const [status, setStatus] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [muted, setMuted] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [lines, setLines] = useState<TranscriptLine[]>([]);

  const mutedRef = useRef(false);
  const wsRef = useRef<WebSocket | null>(null);
  const inputCtxRef = useRef<AudioContext | null>(null);
  const outputCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const nextStartTimeRef = useRef(0);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

  const stopSession = () => {
    try {
      wsRef.current?.close();
    } catch {
      // ignore
    }
    wsRef.current = null;

    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current.onaudioprocess = null;
      processorRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    activeSourcesRef.current.forEach((s) => {
      try {
        s.stop();
      } catch {
        // ignore
      }
    });
    activeSourcesRef.current.clear();

    if (inputCtxRef.current) {
      inputCtxRef.current.close().catch(() => {});
      inputCtxRef.current = null;
    }
    if (outputCtxRef.current) {
      outputCtxRef.current.close().catch(() => {});
      outputCtxRef.current = null;
    }
    nextStartTimeRef.current = 0;
    setMicLevel(0);
    setStatus('idle');
  };

  useEffect(() => {
    if (!open) {
      stopSession();
      return;
    }

    let cancelled = false;
    const startLive = async () => {
      const support = checkAudioSupport();
      if (!support.micSupported || !support.audioContextSupported) {
        setStatus('error');
        setErrorMsg(support.reason || 'Web Audio or microphone APIs are unavailable in this browser.');
        return;
      }

      setStatus('connecting');
      setErrorMsg('');
      setLines([]);

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        if (!cancelled) {
          setStatus('error');
          setErrorMsg(mapMicrophoneError(err));
        }
        return;
      }

      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      streamRef.current = stream;

      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;

      const inputCtx = new AudioCtx({ sampleRate: 16000 });
      const outputCtx = new AudioCtx({ sampleRate: 24000 });
      inputCtxRef.current = inputCtx;
      outputCtxRef.current = outputCtx;

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const params = new URLSearchParams({ mode, language, level });
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws/live?${params.toString()}`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) return;
        const source = inputCtx.createMediaStreamSource(stream);
        const processor = inputCtx.createScriptProcessor(4096, 1, 1);
        processorRef.current = processor;

        processor.onaudioprocess = (e) => {
          const channel = e.inputBuffer.getChannelData(0);
          let sum = 0;
          for (let i = 0; i < channel.length; i++) {
            sum += Math.abs(channel[i]);
          }
          const avg = Math.min(1, (sum / channel.length) * 8);
          setMicLevel(mutedRef.current ? 0 : avg);

          if (!mutedRef.current && ws.readyState === WebSocket.OPEN) {
            const base64 = float32ToPcm16Base64(channel);
            ws.send(JSON.stringify({ audio: base64 }));
          }
        };

        source.connect(processor);
        processor.connect(inputCtx.destination);
      };

      ws.onmessage = (event) => {
        if (cancelled) return;
        try {
          const msg = JSON.parse(event.data) as {
            ready?: boolean;
            audio?: string;
            inputTranscript?: string;
            outputTranscript?: string;
            interrupted?: boolean;
            error?: string;
          };

          if (msg.ready) {
            setStatus('connected');
          }
          if (msg.error) {
            setStatus('error');
            setErrorMsg(msg.error);
          }
          if (msg.interrupted) {
            activeSourcesRef.current.forEach((s) => {
              try {
                s.stop();
              } catch {
                // ignore
              }
            });
            activeSourcesRef.current.clear();
            nextStartTimeRef.current = outputCtx.currentTime;
          }
          if (msg.audio) {
            const buffer = pcm24kBase64ToAudioBuffer(outputCtx, msg.audio);
            const source = outputCtx.createBufferSource();
            source.buffer = buffer;
            source.connect(outputCtx.destination);
            const now = outputCtx.currentTime;
            const startAt = Math.max(now, nextStartTimeRef.current);
            source.start(startAt);
            nextStartTimeRef.current = startAt + buffer.duration;
            activeSourcesRef.current.add(source);
            source.onended = () => activeSourcesRef.current.delete(source);
          }
          if (msg.inputTranscript) {
            setLines((prev) => {
              const last = prev[prev.length - 1];
              if (last && last.speaker === 'You') {
                return [...prev.slice(0, -1), { ...last, text: `${last.text} ${msg.inputTranscript}` }];
              }
              return [...prev, { id: `${Date.now()}-u`, speaker: 'You', text: msg.inputTranscript! }];
            });
          }
          if (msg.outputTranscript) {
            setLines((prev) => {
              const last = prev[prev.length - 1];
              if (last && last.speaker === 'Nimo') {
                return [...prev.slice(0, -1), { ...last, text: `${last.text} ${msg.outputTranscript}` }];
              }
              return [...prev, { id: `${Date.now()}-n`, speaker: 'Nimo', text: msg.outputTranscript! }];
            });
          }
        } catch {
          // ignore malformed messages
        }
      };

      ws.onerror = () => {
        if (!cancelled) {
          setStatus('error');
          setErrorMsg('WebSocket connection to live voice service failed.');
        }
      };

      ws.onclose = () => {
        if (!cancelled) {
          setStatus((curr) => (curr === 'error' ? 'error' : 'idle'));
        }
      };
    };

    startLive();

    return () => {
      cancelled = true;
      stopSession();
    };
  }, [open, mode, language, level]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        stopSession();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const toggleMute = () => {
    const next = !muted;
    mutedRef.current = next;
    setMuted(next);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="live-voice-title"
    >
      <div className="w-full max-w-xl bg-white dark:bg-[#161C24] border border-slate-200 dark:border-slate-800 rounded-xl shadow-xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-800">
          <div>
            <h3
              id="live-voice-title"
              className="text-base font-semibold font-display text-slate-900 dark:text-white"
            >
              {mode === 'language' ? `Live ${language} Voice Tutor` : 'Nimo Live Voice Session'}
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {mode === 'language'
                ? `${level} · Real-time audio via gemini-3.8-live`
                : 'Real-time voice conversation via gemini-3.8-live'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              stopSession();
              onClose();
            }}
            aria-label="Close live voice modal"
            className="p-2 text-slate-500 hover:text-slate-900 dark:hover:text-white rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {status === 'error' && (
            <div className="flex items-start gap-2.5 p-3.5 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-sm text-red-700 dark:text-red-300">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{errorMsg}</span>
            </div>
          )}

          <div className="flex items-center justify-between px-4 py-3 rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800">
            <div className="flex items-center gap-3">
              <Volume2 className="w-4 h-4 text-orange-600 dark:text-amber-400" />
              <span className="text-sm font-medium text-slate-800 dark:text-slate-200">
                {status === 'connecting' && 'Connecting microphone & live audio stream...'}
                {status === 'connected' && (muted ? 'Microphone muted' : 'Listening — speak naturally')}
                {status === 'idle' && 'Session disconnected'}
                {status === 'error' && 'Connection unavailable'}
              </span>
            </div>
            <div className="flex items-center gap-1 h-5" aria-hidden="true">
              {[0.3, 0.6, 1, 0.7, 0.4].map((scale, i) => (
                <span
                  key={i}
                  className="w-1 rounded-full bg-orange-500 dark:bg-amber-400 transition-all duration-75"
                  style={{
                    height: `${Math.max(4, Math.round(micLevel * 20 * scale))}px`,
                  }}
                />
              ))}
            </div>
          </div>

          <div className="h-56 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-800 p-4 space-y-3 bg-white dark:bg-slate-950/50">
            {lines.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-slate-400 text-center py-12">
                {status === 'connected'
                  ? 'Say hello to begin speaking with Nimo in real time.'
                  : 'Waiting for live transcript...'}
              </p>
            ) : (
              lines.map((line) => (
                <div key={line.id} className="text-sm">
                  <span className="font-semibold text-slate-900 dark:text-white mr-2">
                    {line.speaker}:
                  </span>
                  <span className="text-slate-700 dark:text-slate-300">{line.text}</span>
                </div>
              ))
            )}
          </div>

          <div className="flex items-center justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={toggleMute}
              disabled={status !== 'connected'}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 transition-colors whitespace-nowrap"
            >
              {muted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
              {muted ? 'Unmute Mic' : 'Mute Mic'}
            </button>
            <button
              type="button"
              onClick={() => {
                stopSession();
                onClose();
              }}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-red-600 hover:bg-red-700 text-white transition-colors whitespace-nowrap"
            >
              <PhoneOff className="w-4 h-4" />
              End Live Session
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
