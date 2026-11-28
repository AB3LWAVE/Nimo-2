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
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  PhoneCall,
  RefreshCw,
  Search,
  Send,
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
import {
  DRAFT_STORAGE_KEYS,
  readDraft,
  useAutoSaveDraft,
} from '../utils/draftStorage';
import {
  getTimestampMillis,
  sortByMostRecentTimestamp,
} from '../utils/historyUtils';
import { AutoResizeTextarea } from './AutoResizeTextarea';
import { InferenceBadge } from './InferenceBadge';
import { LiveVoiceModal } from './LiveVoiceModal';
import { MarkdownRenderer } from './MarkdownRenderer';

interface ChatSessionProps {
  user: User | null;
  onRequireSignIn: () => void;
  inferenceMode: InferenceModePreference;
  onOpenHybridSettings: () => void;
}

const STARTER_PROMPTS = [
  'Explain how async/await works in JavaScript with a clean example.',
  'Create a 5-day Spanish travel phrase practice plan for me.',
  'Walk me through solving quadratic equations step by step.',
];

function formatMessageTime(ts: unknown): string {
  const ms = getTimestampMillis(ts);
  if (!ms) return '';
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatThreadDate(ts: unknown): string {
  const ms = getTimestampMillis(ts);
  if (!ms) return '';
  return new Date(ms).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

export function ChatSession({
  user,
  onRequireSignIn,
  inferenceMode,
  onOpenHybridSettings,
}: ChatSessionProps) {
  const [initialChatDraft] = useState(() =>
    readDraft(DRAFT_STORAGE_KEYS.chat, {
      input: '',
      activeThreadId: null as string | null,
    })
  );

  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [threadsLoaded, setThreadsLoaded] = useState(() => !user);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(
    () => initialChatDraft.activeThreadId
  );
  const restoredThreadIdRef = useRef<string | null>(initialChatDraft.activeThreadId);
  const justCreatedThreadIdRef = useRef<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [guestMessages, setGuestMessages] = useState<ChatMessage[]>([]);
  const [guestThreadTitle, setGuestThreadTitle] = useState('Guest Chat');

  // History Notice Board visibility & Gemini-inspired sliding drawer state
  const [desktopHistoryOpen, setDesktopHistoryOpen] = useState(true);
  const [mobileThreadsOpen, setMobileThreadsOpen] = useState(false);

  // Chat search & message indexing
  const [searchQuery, setSearchQuery] = useState('');
  const [threadMessageCache, setThreadMessageCache] = useState<Record<string, string[]>>({});
  const indexedThreadIdsRef = useRef<Set<string>>(new Set());

  // Inline thread rename state
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [savingRename, setSavingRename] = useState(false);

  const [input, setInput] = useState(() =>
    typeof initialChatDraft.input === 'string' ? initialChatDraft.input : ''
  );
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
  const activeThreadButtonRef = useRef<HTMLButtonElement | null>(null);

  useAutoSaveDraft(DRAFT_STORAGE_KEYS.chat, {
    input,
    activeThreadId: activeThreadId ?? restoredThreadIdRef.current,
  });

  // Sync user chat threads from Firestore
  useEffect(() => {
    if (!user) {
      setThreads([]);
      setThreadsLoaded(true);
      setActiveThreadId(null);
      setMessages([]);
      setThreadMessageCache({});
      indexedThreadIdsRef.current.clear();
      return;
    }

    setThreadsLoaded(false);
    const q = query(collection(db, 'chatThreads'), where('ownerId', '==', user.uid));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const rawList = snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<ChatThread, 'id'>),
        }));
        const list = sortByMostRecentTimestamp(rawList);
        setThreads(list);
        setThreadsLoaded(true);
        setActiveThreadId((prev) => {
          const candidate = prev || restoredThreadIdRef.current;
          restoredThreadIdRef.current = null;
          if (candidate && list.some((t) => t.id === candidate)) return candidate;
          return list[0]?.id || null;
        });
      },
      (err) => {
        setThreadsLoaded(true);
        handleFirestoreError(err, OperationType.LIST, 'chatThreads');
      }
    );

    return () => unsub();
  }, [user]);

  // Sync active thread messages from Firestore & cache text for search
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
        indexedThreadIdsRef.current.add(activeThreadId);
        setThreadMessageCache((prev) => ({
          ...prev,
          [activeThreadId]: list.map((m) => m.content),
        }));
      },
      (err) => handleFirestoreError(err, OperationType.LIST, path)
    );

    return () => unsub();
  }, [user, activeThreadId]);

  // Index remaining threads' messages lazily when user searches in chat history
  useEffect(() => {
    const trimmed = searchQuery.trim();
    if (!user || !trimmed) return;
    const uncached = threads.filter((t) => !indexedThreadIdsRef.current.has(t.id));
    if (uncached.length === 0) return;

    let cancelled = false;
    const indexThreads = async () => {
      for (const t of uncached.slice(0, 20)) {
        if (cancelled) break;
        indexedThreadIdsRef.current.add(t.id);
        try {
          const snap = await getDocs(
            query(collection(db, `chatThreads/${t.id}/messages`), where('ownerId', '==', user.uid))
          );
          if (cancelled) break;
          const texts = snap.docs.map((d) => String((d.data() as { content?: string }).content || ''));
          setThreadMessageCache((prev) => ({
            ...prev,
            [t.id]: texts,
          }));
        } catch {
          // Allow retry later if transient
          indexedThreadIdsRef.current.delete(t.id);
        }
      }
    };
    void indexThreads();
    return () => {
      cancelled = true;
    };
  }, [user, searchQuery, threads]);

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
    setEditingThreadId(null);
    if (!user) {
      setGuestMessages([]);
      setGuestThreadTitle('Guest Chat');
      return null;
    }
    const threadRef = doc(collection(db, 'chatThreads'));
    try {
      justCreatedThreadIdRef.current = threadRef.id;
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
      justCreatedThreadIdRef.current = null;
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
      if (editingThreadId === threadId) {
        setEditingThreadId(null);
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `chatThreads/${threadId}`);
    }
  };

  const startEditingThread = (threadId: string, currentTitle: string) => {
    setEditingThreadId(threadId);
    setEditingTitle(currentTitle);
  };

  const cancelEditingThread = () => {
    setEditingThreadId(null);
    setEditingTitle('');
  };

  const handleRenameThread = async (threadId: string) => {
    const cleanTitle = editingTitle.trim().slice(0, 140);
    if (!cleanTitle) {
      cancelEditingThread();
      return;
    }

    if (!user) {
      setGuestThreadTitle(cleanTitle);
      cancelEditingThread();
      return;
    }

    const existing = threads.find((t) => t.id === threadId);
    const validModelMode: InferenceModePreference =
      existing?.modelMode === 'prefer_on_device' ||
      existing?.modelMode === 'only_on_device' ||
      existing?.modelMode === 'prefer_in_cloud' ||
      existing?.modelMode === 'only_in_cloud'
        ? existing.modelMode
        : inferenceMode;

    setSavingRename(true);
    try {
      await updateDoc(doc(db, 'chatThreads', threadId), {
        title: cleanTitle,
        modelMode: validModelMode,
        updatedAt: serverTimestamp(),
      });
      setThreads((prev) =>
        prev.map((t) => (t.id === threadId ? { ...t, title: cleanTitle } : t))
      );
      cancelEditingThread();
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `chatThreads/${threadId}`);
    } finally {
      setSavingRename(false);
    }
  };

  const historyScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!justCreatedThreadIdRef.current) return;
    if (threads.some((t) => t.id === justCreatedThreadIdRef.current)) {
      justCreatedThreadIdRef.current = null;
      requestAnimationFrame(() => {
        historyScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
      });
    }
  }, [threads]);

  const ensureValidSelectionOnHistoryOpen = () => {
    if (user && threads.length > 0) {
      if (!activeThreadId || !threads.some((t) => t.id === activeThreadId)) {
        setActiveThreadId(threads[0].id);
        setTimeout(() => {
          historyScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
        }, 90);
      } else if (threads[0]?.id === activeThreadId) {
        setTimeout(() => {
          historyScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
        }, 90);
      } else {
        setTimeout(() => {
          activeThreadButtonRef.current?.scrollIntoView({
            block: 'nearest',
            behavior: 'smooth',
          });
        }, 90);
      }
    } else {
      setTimeout(() => {
        historyScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
      }, 90);
    }
  };

  const toggleDesktopHistory = () => {
    setDesktopHistoryOpen((prev) => {
      const next = !prev;
      if (next) ensureValidSelectionOnHistoryOpen();
      return next;
    });
  };

  const openMobileHistory = () => {
    ensureValidSelectionOnHistoryOpen();
    setMobileThreadsOpen(true);
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
          const existingTitle = threads.find((t) => t.id === threadId)?.title;
          const newTitle =
            existingTitle && existingTitle !== 'New Nimo Chat'
              ? existingTitle
              : displayedMessages.length === 0
                ? promptText.slice(0, 80) || 'Image Analysis'
                : existingTitle || 'Nimo Chat';
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
          const currentTitle = threads.find((t) => t.id === threadId)?.title;
          await updateDoc(doc(db, 'chatThreads', threadId), {
            title: (
              currentTitle && currentTitle !== 'New Nimo Chat'
                ? currentTitle
                : promptText.slice(0, 80) || 'Nimo Chat'
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

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const filteredThreads = threads
    .map((thread) => {
      if (!normalizedQuery) {
        return { thread, matchSnippet: null as string | null };
      }
      const titleMatch = thread.title.toLowerCase().includes(normalizedQuery);
      const cachedTexts = threadMessageCache[thread.id] || [];
      const matchedMsg = cachedTexts.find((txt) => txt.toLowerCase().includes(normalizedQuery));
      if (!titleMatch && !matchedMsg) return null;
      return {
        thread,
        matchSnippet: !titleMatch && matchedMsg ? matchedMsg : null,
      };
    })
    .filter((item): item is { thread: ChatThread; matchSnippet: string | null } => item !== null);

  const activeThread = threads.find((t) => t.id === activeThreadId) || null;
  const activeConversationTitle = user
    ? activeThread?.title || 'New Conversation'
    : guestThreadTitle;

  const threadListContent = (
    <div className="flex flex-col h-fit max-h-full w-72 md:w-68 shrink-0 bg-white dark:bg-[#161C24] border-r border-b border-slate-200 dark:border-slate-800 rounded-br-2xl shadow-xs overflow-hidden">
      <div className="p-3.5 border-b border-slate-200 dark:border-slate-800 space-y-2.5 shrink-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <History className="w-4 h-4 text-orange-600 dark:text-amber-400" />
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-300">
              Chat History
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={toggleDesktopHistory}
              aria-label="Hide chat history"
              title="Hide history"
              className="hidden md:inline-flex p-1.5 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              <PanelLeftClose className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => setMobileThreadsOpen(false)}
              aria-label="Close chat history"
              className="md:hidden p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="relative">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search chats..."
            aria-label="Search chat history"
            className="w-full pl-8 pr-7 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/80 text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-orange-500"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              aria-label="Clear chat search"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 dark:hover:text-white"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <button
          type="button"
          onClick={createNewThread}
          className="w-full inline-flex items-center justify-center gap-2 px-3.5 py-2 text-sm font-medium rounded-lg bg-orange-600 hover:bg-orange-500 text-white transition-colors whitespace-nowrap"
        >
          <MessageSquarePlus className="w-4 h-4" />
          New Chat
        </button>
      </div>

      <div ref={historyScrollRef} className="flex-1 min-h-0 overflow-y-auto p-2.5 space-y-1">
        {user && !threadsLoaded ? (
          <div className="space-y-1.5 py-1" aria-label="Loading conversations">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-10 rounded-lg bg-slate-100 dark:bg-slate-800/70 animate-pulse"
              />
            ))}
          </div>
        ) : !user ? (
          <div className="space-y-2.5">
            {(!normalizedQuery ||
              guestThreadTitle.toLowerCase().includes(normalizedQuery) ||
              guestMessages.some((m) => m.content.toLowerCase().includes(normalizedQuery))) && (
              <div className="p-2.5 rounded-lg bg-orange-50/70 dark:bg-orange-950/35 border border-orange-200/80 dark:border-orange-800/60 flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium text-orange-800 dark:text-amber-200 truncate">
                    {guestThreadTitle}
                  </p>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    Current guest session
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => startEditingThread('guest', guestThreadTitle)}
                  title="Rename current chat"
                  aria-label="Rename current chat"
                  className="p-1 text-slate-400 hover:text-orange-600 dark:hover:text-amber-400"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {editingThreadId === 'guest' && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void handleRenameThread('guest');
                }}
                className="p-2 rounded-lg border border-orange-400 dark:border-orange-600 bg-orange-50/60 dark:bg-orange-950/30 space-y-1.5"
              >
                <input
                  type="text"
                  autoFocus
                  maxLength={140}
                  value={editingTitle}
                  onChange={(e) => setEditingTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      cancelEditingThread();
                    }
                  }}
                  aria-label="Conversation title"
                  className="w-full px-2 py-1 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-orange-500"
                />
                <div className="flex items-center justify-end gap-1.5">
                  <button
                    type="button"
                    onClick={cancelEditingThread}
                    className="px-2 py-0.5 text-[11px] rounded border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={!editingTitle.trim()}
                    className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded bg-orange-600 text-white"
                  >
                    <Check className="w-3 h-3" />
                    Save
                  </button>
                </div>
              </form>
            )}

            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800 space-y-2.5">
              <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                Sign in with Google to save, search, and rename your Nimo conversations in Firestore.
              </p>
              <button
                type="button"
                onClick={onRequireSignIn}
                className="w-full px-3 py-1.5 text-xs font-medium rounded-md border border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
              >
                Sign in to Sync
              </button>
            </div>
          </div>
        ) : threads.length === 0 ? (
          <div className="px-3 py-4 text-center space-y-1">
            <p className="text-xs font-medium text-slate-600 dark:text-slate-300">
              No saved conversations yet
            </p>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              Start a conversation with Nimo and it will appear here.
            </p>
          </div>
        ) : filteredThreads.length === 0 ? (
          <div className="px-3 py-8 text-center space-y-2">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              No conversations match &ldquo;{searchQuery.trim()}&rdquo;.
            </p>
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="text-xs font-medium text-orange-600 dark:text-amber-400 hover:underline"
            >
              Clear search
            </button>
          </div>
        ) : (
          filteredThreads.map(({ thread, matchSnippet }) => {
            const active = thread.id === activeThreadId;
            const isEditing = editingThreadId === thread.id;

            if (isEditing) {
              return (
                <form
                  key={thread.id}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void handleRenameThread(thread.id);
                  }}
                  className="p-2 rounded-lg border border-orange-400 dark:border-orange-600 bg-orange-50/60 dark:bg-orange-950/30 space-y-1.5"
                >
                  <input
                    type="text"
                    autoFocus
                    maxLength={140}
                    value={editingTitle}
                    onChange={(e) => setEditingTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.preventDefault();
                        cancelEditingThread();
                      }
                    }}
                    aria-label="Conversation title"
                    className="w-full px-2 py-1 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-orange-500"
                  />
                  <div className="flex items-center justify-end gap-1.5">
                    <button
                      type="button"
                      onClick={cancelEditingThread}
                      className="px-2 py-0.5 text-[11px] rounded border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={savingRename || !editingTitle.trim()}
                      className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded bg-orange-600 hover:bg-orange-500 disabled:opacity-40 text-white"
                    >
                      <Check className="w-3 h-3" />
                      Save
                    </button>
                  </div>
                </form>
              );
            }

            return (
              <div
                key={thread.id}
                className={`group flex items-start justify-between gap-1.5 px-2.5 py-2 rounded-lg text-sm transition-colors ${
                  active
                    ? 'bg-orange-50 dark:bg-orange-950/40 text-orange-800 dark:text-amber-200 font-medium border border-orange-200/80 dark:border-orange-800/60'
                    : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/70 border border-transparent'
                }`}
              >
                <button
                  ref={active ? activeThreadButtonRef : null}
                  type="button"
                  onClick={() => {
                    setActiveThreadId(thread.id);
                    setMobileThreadsOpen(false);
                  }}
                  className="flex-1 text-left min-w-0"
                >
                  <p className="truncate text-[13px]">{thread.title}</p>
                  {matchSnippet ? (
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate mt-0.5">
                      Match: {matchSnippet}
                    </p>
                  ) : (
                    formatThreadDate(thread.updatedAt) && (
                      <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5">
                        {formatThreadDate(thread.updatedAt)}
                      </p>
                    )
                  )}
                </button>
                <div className="flex items-center gap-0.5 shrink-0 pt-0.5">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      startEditingThread(thread.id, thread.title);
                    }}
                    title="Rename conversation"
                    aria-label={`Rename ${thread.title}`}
                    className="opacity-75 md:opacity-0 md:group-hover:opacity-100 focus:opacity-100 p-1 text-slate-400 hover:text-orange-600 dark:hover:text-amber-400 transition-opacity"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleDeleteThread(thread.id);
                    }}
                    title="Delete conversation"
                    aria-label={`Delete ${thread.title}`}
                    className="opacity-75 md:opacity-0 md:group-hover:opacity-100 focus:opacity-100 p-1 text-slate-400 hover:text-red-600 dark:hover:text-red-400 transition-opacity"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );

  const lastAssistantIdx = (() => {
    for (let i = displayedMessages.length - 1; i >= 0; i--) {
      if (displayedMessages[i].role === 'assistant') return i;
    }
    return -1;
  })();

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden bg-[#F8F9FB] dark:bg-[#0F1419] relative">
      {/* Desktop Collapsible Space-Efficient History Notice Board */}
      <aside
        aria-label="Chat history notice board"
        aria-hidden={!desktopHistoryOpen}
        className={`hidden md:flex shrink-0 flex-col bg-transparent overflow-hidden transition-[width,opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
          desktopHistoryOpen
            ? 'w-68 opacity-100 translate-x-0'
            : 'w-0 opacity-0 -translate-x-3 pointer-events-none'
        }`}
      >
        {threadListContent}
      </aside>

      {/* Mobile Slide-Over History Drawer (space-efficient height) */}
      <div
        className={`fixed inset-0 z-40 md:hidden flex items-start transition-opacity duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
          mobileThreadsOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
        aria-hidden={!mobileThreadsOpen}
      >
        <div
          className="fixed inset-0 bg-slate-950/55 transition-opacity duration-300"
          onClick={() => setMobileThreadsOpen(false)}
        />
        <aside
          className={`relative z-10 w-72 max-w-[85vw] max-h-[85dvh] flex flex-col bg-transparent transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
            mobileThreadsOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          {threadListContent}
        </aside>
      </div>

      {/* Main Chat Workspace */}
      <section className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* Workspace Toolbar */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 sm:px-6 py-2.5 bg-white dark:bg-[#161C24] border-b border-slate-200 dark:border-slate-800 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <button
              type="button"
              onClick={openMobileHistory}
              aria-label="Show chat history"
              className="md:hidden inline-flex items-center gap-1 h-7 px-2 text-[11px] font-medium rounded-md border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:border-orange-300 dark:hover:border-orange-700 whitespace-nowrap"
            >
              <History className="w-3 h-3 text-orange-600 dark:text-amber-400" />
              History
            </button>

            <button
              type="button"
              onClick={toggleDesktopHistory}
              title={desktopHistoryOpen ? 'Hide chat history' : 'Show chat history'}
              aria-label={desktopHistoryOpen ? 'Hide chat history' : 'Show chat history'}
              className="hidden md:inline-flex items-center gap-1 h-7 px-2 text-[11px] font-medium rounded-md border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:border-orange-300 dark:hover:border-orange-700 hover:bg-orange-50/50 dark:hover:bg-orange-950/30 transition-colors whitespace-nowrap"
            >
              {desktopHistoryOpen ? (
                <>
                  <PanelLeftClose className="w-3 h-3 text-orange-600 dark:text-amber-400" />
                  Hide
                </>
              ) : (
                <>
                  <PanelLeftOpen className="w-3 h-3 text-orange-600 dark:text-amber-400" />
                  Show History
                </>
              )}
            </button>

            {/* Active Conversation Title + Inline Rename */}
            {(activeThread || !user) && (
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-800 max-w-[240px]">
                <span className="text-xs font-medium text-slate-800 dark:text-slate-200 truncate">
                  {activeConversationTitle}
                </span>
                {(activeThread || !user) && (
                  <button
                    type="button"
                    onClick={() => {
                      if (!desktopHistoryOpen) setDesktopHistoryOpen(true);
                      if (activeThread) {
                        startEditingThread(activeThread.id, activeThread.title);
                      } else {
                        startEditingThread('guest', guestThreadTitle);
                      }
                    }}
                    title="Rename current conversation"
                    aria-label="Rename current conversation"
                    className="p-0.5 text-slate-400 hover:text-orange-600 dark:hover:text-amber-400 shrink-0"
                  >
                    <Pencil className="w-3 h-3" />
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">

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
              className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-lg border border-orange-200 dark:border-orange-800/80 bg-orange-50 dark:bg-orange-950/40 text-orange-700 dark:text-amber-300 hover:bg-orange-100 dark:hover:bg-orange-900/50 transition-colors whitespace-nowrap shrink-0"
            >
              <PhoneCall className="w-3.5 h-3.5" />
              Live Voice
            </button>
          </div>
        </div>

        {/* Scrollable Message Thread */}
        <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-8 pt-6 pb-6">
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
                      className="text-left p-4 rounded-xl bg-white dark:bg-[#161C24] border border-slate-200 dark:border-slate-800 hover:border-orange-400 dark:hover:border-orange-500 transition-colors text-sm text-slate-700 dark:text-slate-200 leading-relaxed"
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
                          ? 'bg-orange-600 text-white'
                          : 'bg-white dark:bg-[#161C24] border border-slate-200 dark:border-slate-800 text-slate-800 dark:text-slate-100'
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
                          className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-orange-600 dark:text-slate-400 dark:hover:text-amber-400 transition-colors whitespace-nowrap"
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
                          className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-orange-600 dark:text-slate-400 dark:hover:text-amber-400 transition-colors whitespace-nowrap"
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
                            className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-orange-600 dark:text-slate-400 dark:hover:text-amber-400 transition-colors whitespace-nowrap disabled:opacity-40"
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
                <Loader2 className="w-4 h-4 animate-spin text-orange-600 dark:text-amber-400" />
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

        {/* Stationary ChatGPT-Style Rounded Composer */}
        <div className="shrink-0 px-3 sm:px-6 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] bg-[#F8F9FB]/95 dark:bg-[#0F1419]/95 backdrop-blur-xs">
          <div className="max-w-3xl mx-auto">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                sendMessage();
              }}
              className="rounded-2xl border border-slate-200 dark:border-slate-700/90 bg-white dark:bg-[#161C24] shadow-sm focus-within:border-orange-500 focus-within:ring-2 focus-within:ring-orange-500/20 px-3 pt-2.5 pb-2 transition-colors space-y-2"
            >
              {attachedImage && (
                <div className="inline-flex items-center gap-3 p-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800">
                  <img
                    src={attachedImage.previewUrl}
                    alt="Attachment preview"
                    referrerPolicy="no-referrer"
                    className="h-11 w-11 rounded-lg object-cover"
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

              <AutoResizeTextarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onSubmit={() => sendMessage()}
                maxHeightPx={168}
                placeholder={
                  recording
                    ? 'Recording audio... click Stop to transcribe'
                    : 'Message Nimo, attach an image, or dictate...'
                }
                aria-label="Message Nimo"
                className="w-full bg-transparent px-1 py-1 text-sm leading-relaxed text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none"
              />

              <div className="flex items-center justify-between gap-2 pt-1">
                <div className="flex items-center gap-1.5">
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
                    className="p-2 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors shrink-0"
                  >
                    <ImagePlus className="w-4 h-4" />
                  </button>

                  <button
                    type="button"
                    onClick={toggleVoiceRecording}
                    disabled={transcribing}
                    title={recording ? 'Stop recording and transcribe' : 'Dictate via microphone'}
                    aria-label={recording ? 'Stop recording' : 'Start voice dictation'}
                    className={`p-2 rounded-xl border transition-colors shrink-0 ${
                      recording
                        ? 'border-red-500 bg-red-50 dark:bg-red-950/50 text-red-600 dark:text-red-400'
                        : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                    }`}
                  >
                    {transcribing ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : recording ? (
                      <Square className="w-4 h-4" />
                    ) : (
                      <Mic className="w-4 h-4" />
                    )}
                  </button>
                </div>

                <div className="flex items-center gap-2.5">
                  <span className="hidden sm:inline text-[11px] text-slate-400 dark:text-slate-500 select-none">
                    Enter to send · Shift+Enter newline
                  </span>
                  <button
                    type="submit"
                    disabled={sending || (!input.trim() && !attachedImage)}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-orange-600 hover:bg-orange-500 disabled:opacity-40 text-white text-xs sm:text-sm font-medium transition-colors whitespace-nowrap shrink-0 shadow-xs"
                  >
                    <Send className="w-3.5 h-3.5" />
                    <span>Send</span>
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      </section>

      <LiveVoiceModal open={liveOpen} onClose={() => setLiveOpen(false)} mode="chat" />
    </div>
  );
}
