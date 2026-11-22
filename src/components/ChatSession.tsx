import React, { useEffect, useRef, useState } from 'react';
import { User } from 'firebase/auth';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import {
  AlertCircle,
  Check,
  Copy,
  History,
  ImagePlus,
  Loader2,
  MessageSquarePlus,
  Mic,
  PhoneCall,
  RefreshCw,
  Send,
  SlidersHorizontal,
  Square,
  Trash2,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../firebase';
import { generateHybridText } from '../services/hybridAi';
import {
  ChatMessage,
  ChatThread,
  HybridInferenceSource,
  InferenceModePreference,
} from '../types';
import {
  ActiveRecording,
  playBrowserSpeechFallback,
  playGeminiTTS,
  startMicRecording,
  stopCurrentAudio,
  transcribeAudioClip,
} from '../utils/audio';
import { InferenceBadge } from './InferenceBadge';
import { LiveVoiceModal } from './LiveVoiceModal';
import { MarkdownRenderer } from './MarkdownRenderer';

interface ChatSessionProps {
  user: User | null;
  onRequireSignIn: () => void;
  inferenceMode: InferenceModePreference;
  onInferenceModeChange: (mode: InferenceModePreference) => void;
  onOpenHybridSettings: () => void;
}

const HYBRID_MODES: Array<{
  id: InferenceModePreference;
  label: string;
  hint: string;
}> = [
  {
    id: 'prefer_on_device',
    label: 'Prefer On-Device',
    hint: 'Runs locally via Chrome Gemini Nano when ready; falls back to Firebase Cloud.',
  },
  {
    id: 'only_on_device',
    label: 'On-Device Only',
    hint: 'Strictly local on-device inference; never sends prompts to the cloud.',
  },
  {
    id: 'prefer_in_cloud',
    label: 'Prefer Cloud',
    hint: 'Uses Firebase Cloud first with on-device fallback if needed.',
  },
  {
    id: 'only_in_cloud',
    label: 'Cloud Only',
    hint: 'Routes directly to Firebase AI Logic Cloud backend (best for images).',
  },
];

const STARTER_PROMPTS = [
  'Explain how async/await works in JavaScript with a clean example.',
  'Create a 5-day Spanish travel phrase practice plan for me.',
  'Walk me through solving quadratic equations step by step.',
];

function getTimestampMillis(ts: unknown): number {
  if (!ts) return 0;
  if (
    typeof ts === 'object' &&
    ts !== null &&
    'toMillis' in ts &&
    typeof (ts as { toMillis: () => number }).toMillis === 'function'
  ) {
    return (ts as { toMillis: () => number }).toMillis();
  }
  if (typeof ts === 'number') return ts;
  return 0;
}

function formatMessageTime(ts: unknown): string {
  const ms = getTimestampMillis(ts);
  if (!ms) return '';
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function ChatSession({
  user,
  onRequireSignIn,
  inferenceMode,
  onInferenceModeChange,
  onOpenHybridSettings,
}: ChatSessionProps) {
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [guestMessages, setGuestMessages] = useState<ChatMessage[]>([]);
  const [mobileThreadsOpen, setMobileThreadsOpen] = useState(false);

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
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [ttsSpeed, setTtsSpeed] = useState<number>(1.0);
  const [liveOpen, setLiveOpen] = useState(false);

  const [errorState, setErrorState] = useState<{
    message: string;
    lastPrompt?: string;
    lastImage?: { base64: string; mimeType: string; previewUrl: string };
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
    setMobileThreadsOpen(false);
    if (!user) {
      setGuestMessages([]);
      return null;
    }
    const threadRef = doc(collection(db, 'chatThreads'));
    try {
      await setDoc(threadRef, {
        ownerId: user.uid,
        title: 'New Nimo Chat',
        modelMode: inferenceMode,
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
      const msgsSnap = await getDocs(
        query(collection(db, `chatThreads/${threadId}/messages`), where('ownerId', '==', user.uid))
      );
      for (const mDoc of msgsSnap.docs) {
        await deleteDoc(mDoc.ref);
      }
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
    if (file.size > 4 * 1024 * 1024) {
      setErrorState({ message: 'Image must be smaller than 4 MB.' });
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

  const generateAndStoreReply = async (options: {
    promptText: string;
    history: Array<{ role: 'user' | 'assistant'; content: string }>;
    image: { base64: string; mimeType: string; previewUrl: string } | null;
    threadId: string | null;
    skipUserAppend?: boolean;
  }) => {
    const { promptText, history, image, threadId, skipUserAppend } = options;

    if (!skipUserAppend) {
      if (user && threadId) {
        const msgPath = `chatThreads/${threadId}/messages`;
        try {
          await addDoc(collection(db, msgPath), {
            ownerId: user.uid,
            threadId,
            role: 'user',
            content: promptText.slice(0, 25000),
            modelUsed: 'user',
            inferenceSource: 'user',
            hasImage: Boolean(image),
            createdAt: serverTimestamp(),
          });
          const newTitle =
            displayedMessages.length === 0
              ? promptText.slice(0, 80) || 'Image Analysis'
              : threads.find((t) => t.id === threadId)?.title || 'Nimo Chat';
          await updateDoc(doc(db, 'chatThreads', threadId), {
            title: newTitle.slice(0, 140),
            modelMode: inferenceMode,
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
            content: promptText,
            modelUsed: 'user',
            inferenceSource: 'user',
            hasImage: Boolean(image),
            imagePreview: image?.previewUrl,
            createdAt: Date.now(),
          },
        ]);
      }
    }

    const effectiveMode: InferenceModePreference =
      image && inferenceMode === 'only_on_device' ? 'only_on_device' : inferenceMode;

    try {
      const result = await generateHybridText({
        prompt: promptText,
        history,
        mode: effectiveMode,
        systemInstruction:
          'You are Nimo, a sharp, accurate, and encouraging AI companion. Give clear, structured responses with markdown and fenced code blocks when helpful.',
        image: image ? { base64: image.base64, mimeType: image.mimeType } : undefined,
        requestKey: 'chat-send',
      });

      const replyText =
        (result.text || '').slice(0, 25000) || 'No text was generated for this request.';
      const usedModel = result.modelUsed.slice(0, 64);
      const source: HybridInferenceSource = result.inferenceSource;

      if (user && threadId) {
        const msgPath = `chatThreads/${threadId}/messages`;
        try {
          await addDoc(collection(db, msgPath), {
            ownerId: user.uid,
            threadId,
            role: 'assistant',
            content: replyText,
            modelUsed: usedModel,
            inferenceSource: source,
            latencyMs: result.latencyMs,
            hasImage: false,
            createdAt: serverTimestamp(),
          });
          await updateDoc(doc(db, 'chatThreads', threadId), {
            title: (
              threads.find((t) => t.id === threadId)?.title || promptText.slice(0, 80)
            ).slice(0, 140),
            modelMode: inferenceMode,
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
            inferenceSource: source,
            latencyMs: result.latencyMs,
            hasImage: false,
            createdAt: Date.now(),
          },
        ]);
      }
    } catch (err) {
      setErrorState({
        message: err instanceof Error ? err.message : 'Unable to generate response.',
        lastPrompt: promptText,
        lastImage: image || undefined,
      });
    } finally {
      setSending(false);
    }
  };

  const sendMessage = async (overridePrompt?: string) => {
    if (sending) return;
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
    const historyForAi = displayedMessages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    await generateAndStoreReply({
      promptText: userContent,
      history: historyForAi,
      image: currentImage,
      threadId,
    });
  };

  const regenerateLastResponse = async () => {
    if (sending || displayedMessages.length === 0) return;
    const lastUserIndex = [...displayedMessages]
      .reverse()
      .findIndex((m) => m.role === 'user');
    if (lastUserIndex === -1) return;
    const actualUserIdx = displayedMessages.length - 1 - lastUserIndex;
    const lastUserMsg = displayedMessages[actualUserIdx];
    const historyBefore = displayedMessages
      .slice(0, actualUserIdx)
      .map((m) => ({ role: m.role, content: m.content }));

    setErrorState(null);
    setSending(true);
    await generateAndStoreReply({
      promptText: lastUserMsg.content,
      history: historyBefore,
      image: null,
      threadId: activeThreadId,
      skipUserAppend: true,
    });
  };

  const handleCopyMessage = async (msg: ChatMessage) => {
    try {
      await navigator.clipboard.writeText(msg.content);
      setCopiedMessageId(msg.id);
      setTimeout(() => setCopiedMessageId(null), 1600);
    } catch {
      // Clipboard unavailable
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
        `${err instanceof Error ? err.message : 'TTS failed.'} Trying browser speech fallback.`
      );
      try {
        playBrowserSpeechFallback({
          text: msg.content.slice(0, 600),
          language: 'English',
          speed: ttsSpeed,
          onEnd: () => setSpeakingMessageId(null),
        });
      } catch {
        // Browser speech unavailable
      }
    }
  };

  const threadListContent = (
    <>
      <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2">
        <button
          type="button"
          onClick={createNewThread}
          className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-sky-600 hover:bg-sky-700 text-white transition-colors whitespace-nowrap"
        >
          <MessageSquarePlus className="w-4 h-4" />
          New Chat
        </button>
        {mobileThreadsOpen && (
          <button
            type="button"
            onClick={() => setMobileThreadsOpen(false)}
            aria-label="Close thread history"
            className="md:hidden p-2 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-1">
        {!user ? (
          <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800 space-y-2.5">
            <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
              Sign in with Google to sync your Nimo threads to Firestore across sessions.
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
                  onClick={() => {
                    setActiveThreadId(thread.id);
                    setMobileThreadsOpen(false);
                  }}
                  className="flex-1 text-left truncate"
                >
                  {thread.title}
                </button>
                <button
                  type="button"
                  onClick={() => handleDeleteThread(thread.id)}
                  aria-label={`Delete ${thread.title}`}
                  className="opacity-70 md:opacity-0 md:group-hover:opacity-100 p-1 text-slate-400 hover:text-red-600 dark:hover:text-red-400 transition-opacity"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })
        )}
      </div>
    </>
  );

  const lastAssistantIdx = (() => {
    for (let i = displayedMessages.length - 1; i >= 0; i--) {
      if (displayedMessages[i].role === 'assistant') return i;
    }
    return -1;
  })();

  return (
    <div className="flex flex-1 min-h-[calc(100vh-4rem)] bg-slate-50 dark:bg-slate-950 relative">
      {/* Desktop Left History Rail */}
      <aside className="hidden md:flex w-64 shrink-0 flex-col border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        {threadListContent}
      </aside>

      {/* Mobile History Drawer */}
      {mobileThreadsOpen && (
        <div className="fixed inset-0 z-40 md:hidden flex">
          <div
            className="fixed inset-0 bg-slate-950/50"
            onClick={() => setMobileThreadsOpen(false)}
          />
          <aside className="relative z-10 w-72 max-w-[85vw] flex flex-col bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 h-full">
            {threadListContent}
          </aside>
        </div>
      )}

      {/* Main Chat Workspace */}
      <section className="flex-1 flex flex-col min-w-0">
        {/* Workspace Toolbar */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 sm:px-6 py-3 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800">
          <div className="flex items-center gap-2 min-w-0">
            <button
              type="button"
              onClick={() => setMobileThreadsOpen(true)}
              aria-label="Open chat history"
              className="md:hidden inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200"
            >
              <History className="w-3.5 h-3.5" />
              Threads
            </button>

            <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800 overflow-x-auto">
              {HYBRID_MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  title={m.hint}
                  onClick={() => onInferenceModeChange(m.id)}
                  className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    inferenceMode === m.id
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                      : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={onOpenHybridSettings}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap"
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              Hybrid Setup
            </button>

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
              className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-lg border border-sky-200 dark:border-sky-800 bg-sky-50 dark:bg-sky-950/50 text-sky-700 dark:text-sky-300 hover:bg-sky-100 dark:hover:bg-sky-900/50 transition-colors whitespace-nowrap shrink-0"
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
              <div className="py-10 space-y-6">
                <div className="space-y-2">
                  <h1 className="text-2xl sm:text-3xl font-bold font-display text-slate-900 dark:text-white">
                    Ask Nimo anything
                  </h1>
                  <p className="text-[15px] text-slate-600 dark:text-slate-400 max-w-2xl">
                    Powered by Firebase AI Logic Hybrid Inference: runs locally on Chrome&apos;s on-device Gemini Nano when available or seamlessly routes to Firebase Cloud, with multimodal image upload and optional voice playback.
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
              displayedMessages.map((msg, idx) => {
                const isUser = msg.role === 'user';
                const timeText = formatMessageTime(msg.createdAt);
                const resolvedSource =
                  msg.inferenceSource ||
                  (!isUser
                    ? msg.modelUsed.includes('on-device')
                      ? 'on_device'
                      : 'in_cloud'
                    : 'user');
                return (
                  <div
                    key={msg.id}
                    className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}
                  >
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400 mb-1.5 px-1">
                      <span className="font-medium text-slate-700 dark:text-slate-300">
                        {isUser ? 'You' : 'Nimo'}
                      </span>
                      {!isUser && (
                        <InferenceBadge
                          source={resolvedSource}
                          modelUsed={msg.modelUsed}
                          latencyMs={msg.latencyMs}
                        />
                      )}
                      {msg.hasImage && <span>· Image attached</span>}
                      {timeText && <span className="font-mono tabular-nums">{timeText}</span>}
                    </div>

                    <div
                      className={`max-w-[90%] rounded-xl px-4 py-3 ${
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
                        <p className="text-[15px] leading-relaxed whitespace-pre-wrap">
                          {msg.content}
                        </p>
                      ) : (
                        <MarkdownRenderer content={msg.content} />
                      )}
                    </div>

                    {!isUser && (
                      <div className="mt-1.5 px-1 flex flex-wrap items-center gap-4">
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

                        <button
                          type="button"
                          onClick={() => handleCopyMessage(msg)}
                          className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-sky-600 dark:text-slate-400 dark:hover:text-sky-400 transition-colors whitespace-nowrap"
                        >
                          {copiedMessageId === msg.id ? (
                            <>
                              <Check className="w-3.5 h-3.5 text-emerald-500" />
                              Copied
                            </>
                          ) : (
                            <>
                              <Copy className="w-3.5 h-3.5" />
                              Copy
                            </>
                          )}
                        </button>

                        {idx === lastAssistantIdx && (
                          <button
                            type="button"
                            onClick={regenerateLastResponse}
                            disabled={sending}
                            className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-sky-600 dark:text-slate-400 dark:hover:text-sky-400 transition-colors whitespace-nowrap disabled:opacity-40"
                          >
                            <RefreshCw className="w-3.5 h-3.5" />
                            Regenerate
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}

            {sending && (
              <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
                <Loader2 className="w-4 h-4 animate-spin text-sky-600" />
                <span>Nimo is running hybrid inference...</span>
              </div>
            )}

            {errorState && (
              <div className="p-4 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-sm text-red-700 dark:text-red-300 space-y-2.5">
                <div className="flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{errorState.message}</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {errorState.lastPrompt && (
                    <button
                      type="button"
                      onClick={() => {
                        const p = errorState.lastPrompt!;
                        setSending(true);
                        void generateAndStoreReply({
                          promptText: p,
                          history: displayedMessages.map((m) => ({
                            role: m.role,
                            content: m.content,
                          })),
                          image: errorState.lastImage || null,
                          threadId: activeThreadId,
                          skipUserAppend: true,
                        });
                      }}
                      className="px-3 py-1.5 text-xs font-medium rounded-lg bg-white dark:bg-slate-900 border border-red-300 dark:border-red-800 text-slate-900 dark:text-white hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
                    >
                      Retry Request
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={onOpenHybridSettings}
                    className="px-3 py-1.5 text-xs font-medium rounded-lg border border-red-300 dark:border-red-800 text-red-800 dark:text-red-200 hover:bg-red-100/50 whitespace-nowrap"
                  >
                    Open Hybrid Runtime Setup
                  </button>
                </div>
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
                  Image ready for Firebase AI Logic multimodal analysis
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
                aria-label="Attach image"
                className="p-2.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors shrink-0"
              >
                <ImagePlus className="w-5 h-5" />
              </button>

              <button
                type="button"
                onClick={toggleVoiceRecording}
                disabled={transcribing}
                title={recording ? 'Stop recording and transcribe' : 'Dictate via microphone (server speech endpoint)'}
                aria-label={recording ? 'Stop recording' : 'Start voice dictation'}
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
                    : 'Message Nimo, attach an image, or dictate...'
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

      <LiveVoiceModal open={liveOpen} onClose={() => setLiveOpen(false)} mode="chat" />
    </div>
  );
}
