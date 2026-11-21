import React, { useEffect, useRef, useState } from 'react';
import { User } from 'firebase/auth';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import {
  ImagePlus,
  Loader2,
  MessageSquarePlus,
  Mic,
  PhoneCall,
  Send,
  Square,
  Trash2,
  Volume2,
  VolumeX,
  X,
  AlertCircle,
} from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../firebase';
import { ChatMessage, ChatModelMode, ChatThread } from '../types';
import {
  ActiveRecording,
  playBrowserSpeechFallback,
  playGeminiTTS,
  startMicRecording,
  stopCurrentAudio,
  transcribeAudioClip,
} from '../utils/audio';
import { MarkdownRenderer } from './MarkdownRenderer';
import { LiveVoiceModal } from './LiveVoiceModal';

interface ChatSessionProps {
  user: User | null;
  onRequireSignIn: () => void;
}

const MODEL_MODES: Array<{
  id: ChatModelMode;
  label: string;
  modelName: string;
  hint: string;
}> = [
  { id: 'balanced', label: 'Balanced', modelName: 'gemini-4-hydrogen', hint: 'General conversation & tutoring' },
  { id: 'fast', label: 'Fast', modelName: 'gemini-3.1-flash-lite', hint: 'Low-latency quick answers' },
  { id: 'thinking', label: 'Deep Thinking', modelName: 'gemini-4-carbon', hint: 'High reasoning depth' },
  { id: 'vision', label: 'Vision', modelName: 'gemini-4-neon', hint: 'Image & complex analysis' },
];

const STARTER_PROMPTS = [
  'Explain how async/await works in JavaScript with a small example.',
  'Create a 5-day Spanish travel phrase practice plan for me.',
  'Walk me through solving quadratic equations step by step.',
];

function getTimestampMillis(ts: unknown): number {
  if (!ts) return 0;
  if (typeof ts === 'object' && ts !== null && 'toMillis' in ts && typeof (ts as { toMillis: () => number }).toMillis === 'function') {
    return (ts as { toMillis: () => number }).toMillis();
  }
  return 0;
}

export function ChatSession({ user, onRequireSignIn }: ChatSessionProps) {
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [guestMessages, setGuestMessages] = useState<ChatMessage[]>([]);

  const [modelMode, setModelMode] = useState<ChatModelMode>('balanced');
  const [input, setInput] = useState('');
  const [attachedImage, setAttachedImage] = useState<{
    base64: string;
    mimeType: string;
    previewUrl: string;
  } | null>(null);

  const [sending, setSending] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);
  const [ttsSpeed, setTtsSpeed] = useState<number>(1.0);
  const [liveOpen, setLiveOpen] = useState(false);

  const [errorState, setErrorState] = useState<{
    message: string;
    canRetryStandard?: boolean;
    lastPayload?: { prompt: string; image?: { data: string; mimeType: string } };
  } | null>(null);
  const [ttsFallbackNotice, setTtsFallbackNotice] = useState<string | null>(null);

  const activeRecordingRef = useRef<ActiveRecording | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // Sync user chat threads from Firestore
  useEffect(() => {
    if (!user) {
      setThreads([]);
      setActiveThreadId(null);
      setMessages([]);
      return;
    }

    const q = query(collection(db, 'chatThreads'), where('ownerId', '==', user.uid));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list = snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as Omit<ChatThread, 'id'>) }))
          .sort((a, b) => getTimestampMillis(b.updatedAt) - getTimestampMillis(a.updatedAt));
        setThreads(list);
        setActiveThreadId((prev) => {
          if (prev && list.some((t) => t.id === prev)) return prev;
          return list[0]?.id || null;
        });
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'chatThreads')
    );

    return () => unsub();
  }, [user]);

  // Sync active thread messages from Firestore
  useEffect(() => {
    if (!user || !activeThreadId) {
      setMessages([]);
      return;
    }

    const path = `chatThreads/${activeThreadId}/messages`;
    const q = query(collection(db, path), where('ownerId', '==', user.uid));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list = snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as Omit<ChatMessage, 'id'>) }))
          .sort((a, b) => getTimestampMillis(a.createdAt) - getTimestampMillis(b.createdAt));
        setMessages(list);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, path)
    );

    return () => unsub();
  }, [user, activeThreadId]);

  const displayedMessages = user ? messages : guestMessages;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [displayedMessages.length, sending]);

  useEffect(() => {
    return () => {
      stopCurrentAudio();
      activeRecordingRef.current?.cancel();
    };
  }, []);

  const createNewThread = async () => {
    setErrorState(null);
    if (!user) {
      setGuestMessages([]);
      return null;
    }
    const threadRef = doc(collection(db, 'chatThreads'));
    try {
      await setDoc(threadRef, {
        ownerId: user.uid,
        title: 'New Nimo Chat',
        modelMode,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setActiveThreadId(threadRef.id);
      return threadRef.id;
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `chatThreads/${threadRef.id}`);
    }
  };

  const handleDeleteThread = async (threadId: string) => {
    if (!user) return;
    try {
      await deleteDoc(doc(db, 'chatThreads', threadId));
      if (activeThreadId === threadId) {
        setActiveThreadId(null);
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `chatThreads/${threadId}`);
    }
  };

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setErrorState({ message: 'Please select an image file (PNG, JPG, WebP).' });
      return;
    }
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const base64 = result.includes(',') ? result.split(',')[1] : '';
      if (base64) {
        setAttachedImage({
          base64,
          mimeType: file.type,
          previewUrl: result,
        });
        setModelMode('vision');
      }
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const toggleVoiceRecording = async () => {
    setErrorState(null);
    if (recording && activeRecordingRef.current) {
      setRecording(false);
      setTranscribing(true);
      try {
        const clip = await activeRecordingRef.current.stop();
        activeRecordingRef.current = null;
        const { transcript } = await transcribeAudioClip(clip.base64, clip.mimeType);
        if (transcript) {
          setInput((prev) => (prev.trim() ? `${prev.trim()} ${transcript}` : transcript));
        } else {
          setErrorState({ message: 'No speech detected in the recording. Try speaking again.' });
        }
      } catch (err) {
        setErrorState({
          message: err instanceof Error ? err.message : 'Speech transcription failed.',
        });
      } finally {
        setTranscribing(false);
      }
      return;
    }

    try {
      const rec = await startMicRecording();
      activeRecordingRef.current = rec;
      setRecording(true);
    } catch (err) {
      setErrorState({
        message: err instanceof Error ? err.message : 'Unable to start microphone.',
      });
    }
  };

  const sendMessage = async (overridePrompt?: string, fallbackToStandard = false) => {
    const promptText = (overridePrompt ?? input).trim();
    const currentImage = attachedImage;
    if (!promptText && !currentImage) return;

    setErrorState(null);
    setSending(true);
    if (!overridePrompt) {
      setInput('');
      setAttachedImage(null);
    }

    let threadId = activeThreadId;
    if (user && !threadId) {
      threadId = await createNewThread();
    }

    const userContent = promptText || 'Analyze this attached image.';
    const historyForApi = displayedMessages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    if (user && threadId) {
      const msgPath = `chatThreads/${threadId}/messages`;
      try {
        await addDoc(collection(db, msgPath), {
          ownerId: user.uid,
          threadId,
          role: 'user',
          content: userContent.slice(0, 25000),
          modelUsed: 'user',
          hasImage: Boolean(currentImage),
          createdAt: serverTimestamp(),
        });
        const newTitle =
          displayedMessages.length === 0
            ? userContent.slice(0, 80) || 'Image Analysis'
            : threads.find((t) => t.id === threadId)?.title || 'Nimo Chat';
        await updateDoc(doc(db, 'chatThreads', threadId), {
          title: newTitle.slice(0, 140),
          modelMode,
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        setSending(false);
        handleFirestoreError(err, OperationType.WRITE, msgPath);
      }
    } else {
      setGuestMessages((prev) => [
        ...prev,
        {
          id: `guest-u-${Date.now()}`,
          ownerId: 'guest',
          threadId: 'guest',
          role: 'user',
          content: userContent,
          modelUsed: 'user',
          hasImage: Boolean(currentImage),
          imagePreview: currentImage?.previewUrl,
        },
      ]);
    }

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          history: historyForApi,
          prompt: userContent,
          mode: modelMode,
          image: currentImage ? { data: currentImage.base64, mimeType: currentImage.mimeType } : undefined,
          fallbackToStandard,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorState({
          message: data.message || data.error || 'Nimo could not generate a response.',
          canRetryStandard: Boolean(data.isBillingRequired),
          lastPayload: {
            prompt: userContent,
            image: currentImage ? { data: currentImage.base64, mimeType: currentImage.mimeType } : undefined,
          },
        });
        setSending(false);
        return;
      }

      const replyText = (data.text || '').slice(0, 25000) || 'I could not generate text for that request.';
      const usedModel = (data.modelUsed || 'gemini-4-hydrogen').slice(0, 64);

      if (user && threadId) {
        const msgPath = `chatThreads/${threadId}/messages`;
        try {
          await addDoc(collection(db, msgPath), {
            ownerId: user.uid,
            threadId,
            role: 'assistant',
            content: replyText,
            modelUsed: usedModel,
            hasImage: false,
            createdAt: serverTimestamp(),
          });
          await updateDoc(doc(db, 'chatThreads', threadId), {
            title: (threads.find((t) => t.id === threadId)?.title || userContent.slice(0, 80)).slice(0, 140),
            modelMode,
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.CREATE, msgPath);
        }
      } else {
        setGuestMessages((prev) => [
          ...prev,
          {
            id: `guest-a-${Date.now()}`,
            ownerId: 'guest',
            threadId: 'guest',
            role: 'assistant',
            content: replyText,
            modelUsed: usedModel,
            hasImage: false,
          },
        ]);
      }
    } catch (err) {
      setErrorState({
        message: err instanceof Error ? err.message : 'Network error reaching Nimo.',
      });
    } finally {
      setSending(false);
    }
  };

  const handleSpeakMessage = async (msg: ChatMessage) => {
    setTtsFallbackNotice(null);
    if (speakingMessageId === msg.id) {
      stopCurrentAudio();
      setSpeakingMessageId(null);
      return;
    }
    setSpeakingMessageId(msg.id);
    try {
      await playGeminiTTS({
        text: msg.content,
        speed: ttsSpeed,
        onEnd: () => setSpeakingMessageId(null),
      });
    } catch (err) {
      setSpeakingMessageId(null);
      setTtsFallbackNotice(
        `${err instanceof Error ? err.message : 'TTS failed.'} You can use your browser voice fallback below.`
      );
      try {
        playBrowserSpeechFallback({
          text: msg.content.slice(0, 600),
          language: 'English',
          speed: ttsSpeed,
          onEnd: () => setSpeakingMessageId(null),
        });
      } catch {
        // Browser speech also unavailable
      }
    }
  };

  return (
    <div className="flex flex-1 min-h-[calc(100vh-4rem)] bg-slate-50 dark:bg-slate-950">
      {/* Left History Rail */}
      <aside className="hidden md:flex w-64 shrink-0 flex-col border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <div className="p-4 border-b border-slate-200 dark:border-slate-800">
          <button
            type="button"
            onClick={createNewThread}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-sky-600 hover:bg-sky-700 text-white transition-colors whitespace-nowrap"
          >
            <MessageSquarePlus className="w-4 h-4" />
            New Chat
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-1">
          {!user ? (
            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800 space-y-2.5">
              <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                Sign in with Google to save your Nimo conversation history across sessions.
              </p>
              <button
                type="button"
                onClick={onRequireSignIn}
                className="w-full px-3 py-1.5 text-xs font-medium rounded-md border border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
              >
                Sign in to Sync
              </button>
            </div>
          ) : threads.length === 0 ? (
            <p className="px-2 py-6 text-xs text-slate-500 dark:text-slate-400 text-center">
              No saved threads yet. Start a conversation with Nimo.
            </p>
          ) : (
            threads.map((thread) => {
              const active = thread.id === activeThreadId;
              return (
                <div
                  key={thread.id}
                  className={`group flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                    active
                      ? 'bg-sky-50 dark:bg-sky-950/50 text-sky-700 dark:text-sky-300 font-medium'
                      : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/70'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setActiveThreadId(thread.id)}
                    className="flex-1 text-left truncate"
                  >
                    {thread.title}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteThread(thread.id)}
                    aria-label={`Delete ${thread.title}`}
                    className="opacity-0 group-hover:opacity-100 p-1 text-slate-400 hover:text-red-600 dark:hover:text-red-400 transition-opacity"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </aside>

      {/* Main Chat Workspace */}
      <section className="flex-1 flex flex-col min-w-0">
        {/* Workspace Toolbar */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-3 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800">
          <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800 overflow-x-auto">
            {MODEL_MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                title={m.hint}
                onClick={() => setModelMode(m.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  modelMode === m.id
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
              <span>Voice Speed</span>
              <select
                value={ttsSpeed}
                onChange={(e) => setTtsSpeed(Number(e.target.value))}
                className="px-2 py-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs font-mono tabular-nums text-slate-800 dark:text-slate-100"
              >
                <option value={0.75}>0.75x</option>
                <option value={1}>1.0x</option>
                <option value={1.25}>1.25x</option>
                <option value={1.5}>1.5x</option>
              </select>
            </label>

            <button
              type="button"
              onClick={() => setLiveOpen(true)}
              className="inline-flex items-center gap-2 px-3.5 py-1.5 text-xs font-medium rounded-lg border border-sky-200 dark:border-sky-800 bg-sky-50 dark:bg-sky-950/50 text-sky-700 dark:text-sky-300 hover:bg-sky-100 dark:hover:bg-sky-900/50 transition-colors whitespace-nowrap shrink-0"
            >
              <PhoneCall className="w-3.5 h-3.5" />
              Live Voice
            </button>
          </div>
        </div>

        {/* Scrollable Message Thread */}
        <div className="flex-1 overflow-y-auto px-4 sm:px-8 py-6">
          <div className="max-w-3xl mx-auto space-y-6">
            {displayedMessages.length === 0 ? (
              <div className="py-12 space-y-6">
                <div className="space-y-2">
                  <h1 className="text-2xl sm:text-3xl font-bold font-display text-slate-900 dark:text-white">
                    Ask Nimo anything
                  </h1>
                  <p className="text-[15px] text-slate-600 dark:text-slate-400 max-w-xl">
                    Start a multi-turn conversation, attach a photo or diagram for analysis, dictate via microphone, or switch to Deep Thinking for complex reasoning.
                  </p>
                </div>
                <div className="grid sm:grid-cols-3 gap-3">
                  {STARTER_PROMPTS.map((starter) => (
                    <button
                      key={starter}
                      type="button"
                      onClick={() => sendMessage(starter)}
                      className="text-left p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-sky-400 dark:hover:border-sky-600 transition-colors text-sm text-slate-700 dark:text-slate-200 leading-relaxed"
                    >
                      {starter}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              displayedMessages.map((msg) => {
                const isUser = msg.role === 'user';
                return (
                  <div
                    key={msg.id}
                    className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}
                  >
                    <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 mb-1.5 px-1">
                      <span className="font-medium text-slate-700 dark:text-slate-300">
                        {isUser ? 'You' : 'Nimo'}
                      </span>
                      {!isUser && msg.modelUsed && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono">{msg.modelUsed}</span>
                        </>
                      )}
                      {msg.hasImage && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>Image attached</span>
                        </>
                      )}
                    </div>

                    <div
                      className={`max-w-[88%] rounded-xl px-4 py-3 ${
                        isUser
                          ? 'bg-sky-600 text-white'
                          : 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-800 dark:text-slate-100'
                      }`}
                    >
                      {msg.imagePreview && (
                        <img
                          src={msg.imagePreview}
                          alt="Uploaded context"
                          referrerPolicy="no-referrer"
                          className="max-h-52 rounded-lg mb-2 object-contain"
                        />
                      )}
                      {isUser ? (
                        <p className="text-[15px] leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                      ) : (
                        <MarkdownRenderer content={msg.content} />
                      )}
                    </div>

                    {!isUser && (
                      <div className="mt-1.5 px-1">
                        <button
                          type="button"
                          onClick={() => handleSpeakMessage(msg)}
                          className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-sky-600 dark:text-slate-400 dark:hover:text-sky-400 transition-colors whitespace-nowrap"
                        >
                          {speakingMessageId === msg.id ? (
                            <>
                              <VolumeX className="w-3.5 h-3.5" />
                              Stop Audio
                            </>
                          ) : (
                            <>
                              <Volume2 className="w-3.5 h-3.5" />
                              Listen
                            </>
                          )}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })
            )}

            {sending && (
              <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
                <Loader2 className="w-4 h-4 animate-spin text-sky-600" />
                <span>Nimo is thinking...</span>
              </div>
            )}

            {errorState && (
              <div className="p-4 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-sm text-red-700 dark:text-red-300 space-y-2">
                <div className="flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{errorState.message}</span>
                </div>
                {errorState.canRetryStandard && errorState.lastPayload && (
                  <button
                    type="button"
                    onClick={() => {
                      const payload = errorState.lastPayload!;
                      setModelMode('balanced');
                      sendMessage(payload.prompt, true);
                    }}
                    className="px-3 py-1.5 text-xs font-medium rounded-lg bg-white dark:bg-slate-900 border border-red-300 dark:border-red-800 text-slate-900 dark:text-white hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
                  >
                    Retry with Balanced (gemini-4-hydrogen)
                  </button>
                )}
              </div>
            )}

            {ttsFallbackNotice && (
              <p className="text-xs text-amber-700 dark:text-amber-300">{ttsFallbackNotice}</p>
            )}

            <div ref={bottomRef} />
          </div>
        </div>

        {/* Multimodal Composer */}
        <div className="p-4 sm:px-8 bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800">
          <div className="max-w-3xl mx-auto space-y-2.5">
            {attachedImage && (
              <div className="inline-flex items-center gap-3 p-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800">
                <img
                  src={attachedImage.previewUrl}
                  alt="Attachment preview"
                  referrerPolicy="no-referrer"
                  className="h-12 w-12 rounded object-cover"
                />
                <span className="text-xs text-slate-600 dark:text-slate-300">
                  Image ready for gemini-4-neon analysis
                </span>
                <button
                  type="button"
                  onClick={() => setAttachedImage(null)}
                  aria-label="Remove image"
                  className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-white"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}

            <form
              onSubmit={(e) => {
                e.preventDefault();
                sendMessage();
              }}
              className="flex items-end gap-2"
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleImageSelect}
                className="hidden"
              />

              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                title="Attach photo for visual analysis"
                className="p-2.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors shrink-0"
              >
                <ImagePlus className="w-5 h-5" />
              </button>

              <button
                type="button"
                onClick={toggleVoiceRecording}
                disabled={transcribing}
                title={recording ? 'Stop recording and transcribe' : 'Dictate via microphone'}
                className={`p-2.5 rounded-lg border transition-colors shrink-0 ${
                  recording
                    ? 'border-red-500 bg-red-50 dark:bg-red-950/50 text-red-600 dark:text-red-400'
                    : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                {transcribing ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : recording ? (
                  <Square className="w-5 h-5" />
                ) : (
                  <Mic className="w-5 h-5" />
                )}
              </button>

              <textarea
                rows={1}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage();
                  }
                }}
                placeholder={
                  recording
                    ? 'Recording audio... click Stop to transcribe'
                    : 'Message Nimo, upload an image, or use microphone...'
                }
                className="flex-1 resize-none rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/70 px-3.5 py-2.5 text-sm text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-500"
              />

              <button
                type="submit"
                disabled={sending || (!input.trim() && !attachedImage)}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-sky-600 hover:bg-sky-700 disabled:opacity-40 text-white text-sm font-medium transition-colors whitespace-nowrap shrink-0"
              >
                <Send className="w-4 h-4" />
                Send
              </button>
            </form>
          </div>
        </div>
      </section>

      <LiveVoiceModal
        open={liveOpen}
        onClose={() => setLiveOpen(false)}
        mode="chat"
      />
    </div>
  );
}
