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
  updateDoc,
  where,
} from 'firebase/firestore';
import {
  AlertCircle,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  Eye,
  EyeOff,
  FileUp,
  GraduationCap,
  Headphones,
  History,
  Keyboard,
  Languages,
  Loader2,
  Mic,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  PhoneCall,
  RefreshCw,
  RotateCcw,
  Send,
  Square,
  Trash2,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../firebase';
import { generateHybridJson, generateHybridText } from '../services/hybridAi';
import {
  GeneratedQuiz,
  HybridInferenceSource,
  InferenceModePreference,
  LanguageConversationReply,
  LearnSubMode,
  ListeningExercise,
  ProficiencyLevel,
  PronunciationEvaluation,
  QuizAttempt,
  QuizQuestion,
  ShortAnswerGrade,
  StudyNote,
  VocabItem,
} from '../types';
import {
  ActiveRecording,
  checkAudioSupport,
  playBrowserSpeechFallback,
  playGeminiTTS,
  PRESET_LANGUAGES,
  startMicRecording,
  stopCurrentAudio,
  transcribeAudioClip,
} from '../utils/audio';
import {
  scoreMcqQuestions,
  validateLanguageConversationReply,
  validateListeningExercise,
  validateQuizPayload,
  validateShortAnswerGrade,
  validateVocabItems,
  type VocabLessonItemDraft,
} from '../utils/validation';
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

interface LearnSessionProps {
  user: User | null;
  onRequireSignIn: () => void;
  inferenceMode: InferenceModePreference;
}

type LanguageActivity = 'speaking' | 'vocabulary' | 'listening';
type GeneralActivity = 'notes' | 'quiz';

const LEVELS: ProficiencyLevel[] = ['Beginner', 'Intermediate', 'Advanced'];
const SPEEDS = [0.75, 1.0, 1.25, 1.5];

function formatAttemptDate(ts: unknown): string {
  const ms = getTimestampMillis(ts);
  if (!ms) return '';
  return new Date(ms).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function sanitizeQuestionsForStorage(questions: QuizQuestion[]): QuizQuestion[] {
  return questions.map((q) =>
    q.type === 'mcq'
      ? {
          id: q.id,
          type: 'mcq',
          prompt: q.prompt,
          options: q.options || [],
          correctIndex: typeof q.correctIndex === 'number' ? q.correctIndex : 0,
          explanation: q.explanation,
        }
      : {
          id: q.id,
          type: 'short',
          prompt: q.prompt,
          sampleAnswer: q.sampleAnswer || q.explanation,
          explanation: q.explanation,
        }
  );
}

interface HybridMetaTag {
  inferenceSource: HybridInferenceSource;
  modelUsed: string;
  latencyMs: number;
}

export function LearnSession({
  user,
  onRequireSignIn,
  inferenceMode,
}: LearnSessionProps) {
  const [initialLearnDraft] = useState(() =>
    readDraft(DRAFT_STORAGE_KEYS.learn, {
      subMode: 'language' as LearnSubMode,
      languageActivity: 'speaking' as LanguageActivity,
      targetLanguage: 'Spanish',
      customLanguage: '',
      level: 'Beginner' as ProficiencyLevel,
      convInput: '',
      drillPhrase: 'Buenos días, ¿cómo estás hoy?',
      vocabTopic: 'Daily Greetings & Cafe',
      listeningTopic: 'Ordering lunch at a local market',
      generalActivity: 'quiz' as GeneralActivity,
      subject: 'Computer Science',
      studyTopic: 'Recursion and Dynamic Programming',
      studyDifficulty: 'Intermediate' as ProficiencyLevel,
      noteFollowUpInput: '',
      quizTopic: 'Cellular Respiration & ATP',
      quizDifficulty: 'Intermediate' as ProficiencyLevel,
      quizCount: '4',
      quizInstructions: '',
      quizTitle: '',
      quizQuestions: [] as QuizQuestion[],
      mcqSelections: {} as Record<string, number>,
      shortAnswers: {} as Record<string, string>,
    })
  );

  const [subMode, setSubMode] = useState<LearnSubMode>(() =>
    initialLearnDraft.subMode === 'language' || initialLearnDraft.subMode === 'general'
      ? initialLearnDraft.subMode
      : 'language'
  );

  // Language Learning State
  const [languageActivity, setLanguageActivity] = useState<LanguageActivity>(() =>
    initialLearnDraft.languageActivity === 'speaking' ||
    initialLearnDraft.languageActivity === 'vocabulary' ||
    initialLearnDraft.languageActivity === 'listening'
      ? initialLearnDraft.languageActivity
      : 'speaking'
  );
  const [targetLanguage, setTargetLanguage] = useState(
    () => initialLearnDraft.targetLanguage
  );
  const [customLanguage, setCustomLanguage] = useState(
    () => initialLearnDraft.customLanguage
  );
  const [level, setLevel] = useState<ProficiencyLevel>(() => initialLearnDraft.level);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1.0);
  const [audioStatusMsg, setAudioStatusMsg] = useState<string | null>(null);
  const [ttsRetryPayload, setTtsRetryPayload] = useState<{
    text: string;
    language: string;
  } | null>(null);
  const [playingAudioKey, setPlayingAudioKey] = useState<string | null>(null);
  const [liveTutorOpen, setLiveTutorOpen] = useState(false);

  // Speaking & Conversation + Pronunciation Drill
  const [convHistory, setConvHistory] = useState<
    Array<{
      id: string;
      role: 'user' | 'assistant';
      text: string;
      translation?: string;
      correction?: string;
      meta?: HybridMetaTag;
    }>
  >([]);
  const [convInput, setConvInput] = useState(() => initialLearnDraft.convInput);
  const [convLoading, setConvLoading] = useState(false);
  const [convRecording, setConvRecording] = useState(false);

  const [drillPhrase, setDrillPhrase] = useState(() => initialLearnDraft.drillPhrase);
  const [drillRecording, setDrillRecording] = useState(false);
  const [drillLoading, setDrillLoading] = useState(false);
  const [pronunciationResult, setPronunciationResult] =
    useState<PronunciationEvaluation | null>(null);
  const [lastClipForRetry, setLastClipForRetry] = useState<{
    base64: string;
    mimeType: string;
    transcript: string;
  } | null>(null);
  const [drillBillingRetry, setDrillBillingRetry] = useState(false);

  // Vocabulary State
  const [vocabTopic, setVocabTopic] = useState(() => initialLearnDraft.vocabTopic);
  const [vocabGenerating, setVocabGenerating] = useState(false);
  const [vocabMeta, setVocabMeta] = useState<HybridMetaTag | null>(null);
  const [savedVocab, setSavedVocab] = useState<VocabItem[]>([]);
  const [guestVocab, setGuestVocab] = useState<VocabItem[]>([]);

  // Listening State
  const [listeningTopic, setListeningTopic] = useState(
    () => initialLearnDraft.listeningTopic
  );
  const [listeningLoading, setListeningLoading] = useState(false);
  const [listeningExercise, setListeningExercise] = useState<ListeningExercise | null>(null);
  const [listeningMeta, setListeningMeta] = useState<HybridMetaTag | null>(null);
  const [showTranscript, setShowTranscript] = useState(false);
  const [listeningAnswers, setListeningAnswers] = useState<Record<number, number>>({});
  const [listeningChecked, setListeningChecked] = useState(false);

  // General Learning & Quiz State
  const [generalActivity, setGeneralActivity] = useState<GeneralActivity>(() =>
    initialLearnDraft.generalActivity === 'notes' ||
    initialLearnDraft.generalActivity === 'quiz'
      ? initialLearnDraft.generalActivity
      : 'quiz'
  );
  const [subject, setSubject] = useState(() => initialLearnDraft.subject);
  const [studyTopic, setStudyTopic] = useState(() => initialLearnDraft.studyTopic);
  const [studyDifficulty, setStudyDifficulty] = useState<ProficiencyLevel>(
    () => initialLearnDraft.studyDifficulty
  );
  const [notesLoading, setNotesLoading] = useState(false);
  const [activeNote, setActiveNote] = useState<{
    title: string;
    summaryMarkdown: string;
    meta?: HybridMetaTag;
  } | null>(null);
  const [noteFollowUpInput, setNoteFollowUpInput] = useState(
    () => initialLearnDraft.noteFollowUpInput
  );
  const [noteFollowUpLoading, setNoteFollowUpLoading] = useState(false);
  const [copiedNote, setCopiedNote] = useState(false);
  const [savedNotes, setSavedNotes] = useState<StudyNote[]>([]);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [activeVocabId, setActiveVocabId] = useState<string | null>(null);
  const [notesError, setNotesError] = useState<string | null>(null);

  // Learn History Notice Board & Collapsible Stationary Prompt Bar
  const [desktopHistoryOpen, setDesktopHistoryOpen] = useState(true);
  const [mobileHistoryOpen, setMobileHistoryOpen] = useState(false);
  const [historyFilter, setHistoryFilter] = useState<'all' | 'notes' | 'quizzes' | 'vocab'>('all');
  const [editingLearnItem, setEditingLearnItem] = useState<{
    kind: 'quiz' | 'note' | 'vocab';
    id: string;
  } | null>(null);
  const [editingLearnTitle, setEditingLearnTitle] = useState('');
  const [savingLearnRename, setSavingLearnRename] = useState(false);
  const [promptBarHidden, setPromptBarHidden] = useState(false);
  const [quizOptionsExpanded, setQuizOptionsExpanded] = useState(false);
  const [learnLoadedFlags, setLearnLoadedFlags] = useState(() => ({
    vocab: !user,
    notes: !user,
    quizzes: !user,
  }));
  const justCreatedLearnRef = useRef(false);

  // Quiz State
  const [quizTopic, setQuizTopic] = useState(() => initialLearnDraft.quizTopic);
  const [quizDifficulty, setQuizDifficulty] = useState<ProficiencyLevel>(
    () => initialLearnDraft.quizDifficulty
  );
  const [quizCount, setQuizCount] = useState<string>(() => initialLearnDraft.quizCount);
  const [quizInstructions, setQuizInstructions] = useState(
    () => initialLearnDraft.quizInstructions
  );
  const [quizFiles, setQuizFiles] = useState<
    Array<{
      id: string;
      name: string;
      kind: 'text' | 'binary';
      textContent?: string;
      base64?: string;
      mimeType?: string;
    }>
  >([]);
  const quizFileInputRef = useRef<HTMLInputElement | null>(null);
  const [quizLoading, setQuizLoading] = useState(false);
  const [quizTitle, setQuizTitle] = useState(() => initialLearnDraft.quizTitle);
  const [quizMeta, setQuizMeta] = useState<HybridMetaTag | null>(null);
  const [quizQuestions, setQuizQuestions] = useState<QuizQuestion[]>(() =>
    Array.isArray(initialLearnDraft.quizQuestions) ? initialLearnDraft.quizQuestions : []
  );
  const [mcqSelections, setMcqSelections] = useState<Record<string, number>>(
    () => initialLearnDraft.mcqSelections || {}
  );
  const [shortAnswers, setShortAnswers] = useState<Record<string, string>>(
    () => initialLearnDraft.shortAnswers || {}
  );
  const [shortGrades, setShortGrades] = useState<Record<string, ShortAnswerGrade>>({});
  const [quizSubmitted, setQuizSubmitted] = useState(false);
  const [quizScore, setQuizScore] = useState<number>(0);
  const [quizAttempts, setQuizAttempts] = useState<QuizAttempt[]>([]);
  const [guestQuizAttempts, setGuestQuizAttempts] = useState<QuizAttempt[]>([]);
  const [activeAttemptId, setActiveAttemptId] = useState<string | null>(null);
  const [reviewFilter, setReviewFilter] = useState<'all' | 'mistakes'>('all');
  const [deepExplainMap, setDeepExplainMap] = useState<
    Record<string, { text: string; meta: HybridMetaTag }>
  >({});
  const [deepExplainLoadingId, setDeepExplainLoadingId] = useState<string | null>(null);

  const activeRecordingRef = useRef<ActiveRecording | null>(null);
  const activeHistoryItemRef = useRef<HTMLButtonElement | null>(null);
  const learnHistoryScrollRef = useRef<HTMLDivElement | null>(null);
  const audioSupport = checkAudioSupport();

  const activeLanguage =
    targetLanguage === '__custom__' ? customLanguage.trim() || 'Spanish' : targetLanguage;

  useAutoSaveDraft(DRAFT_STORAGE_KEYS.learn, {
    subMode,
    languageActivity,
    targetLanguage,
    customLanguage,
    level,
    convInput,
    drillPhrase,
    vocabTopic,
    listeningTopic,
    generalActivity,
    subject,
    studyTopic,
    studyDifficulty,
    noteFollowUpInput,
    quizTopic,
    quizDifficulty,
    quizCount,
    quizInstructions,
    quizTitle: !quizSubmitted && quizQuestions.length > 0 ? quizTitle : '',
    quizQuestions: !quizSubmitted && quizQuestions.length > 0 ? quizQuestions : [],
    mcqSelections: !quizSubmitted && quizQuestions.length > 0 ? mcqSelections : {},
    shortAnswers: !quizSubmitted && quizQuestions.length > 0 ? shortAnswers : {},
  });

  // Sync Firestore Vocab, StudyNotes, QuizAttempts
  useEffect(() => {
    if (!user) {
      setSavedVocab([]);
      setSavedNotes([]);
      setQuizAttempts([]);
      setLearnLoadedFlags({ vocab: true, notes: true, quizzes: true });
      return;
    }

    setLearnLoadedFlags({ vocab: false, notes: false, quizzes: false });

    const unsubVocab = onSnapshot(
      query(collection(db, 'vocabItems'), where('ownerId', '==', user.uid)),
      (snap) => {
        const list = sortByMostRecentTimestamp(
          snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<VocabItem, 'id'>) }))
        );
        setSavedVocab(list);
        setLearnLoadedFlags((prev) => ({ ...prev, vocab: true }));
      },
      (err) => {
        setLearnLoadedFlags((prev) => ({ ...prev, vocab: true }));
        handleFirestoreError(err, OperationType.LIST, 'vocabItems');
      }
    );

    const unsubNotes = onSnapshot(
      query(collection(db, 'studyNotes'), where('ownerId', '==', user.uid)),
      (snap) => {
        const list = sortByMostRecentTimestamp(
          snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<StudyNote, 'id'>) }))
        );
        setSavedNotes(list);
        setLearnLoadedFlags((prev) => ({ ...prev, notes: true }));
      },
      (err) => {
        setLearnLoadedFlags((prev) => ({ ...prev, notes: true }));
        handleFirestoreError(err, OperationType.LIST, 'studyNotes');
      }
    );

    const unsubQuizzes = onSnapshot(
      query(collection(db, 'quizAttempts'), where('ownerId', '==', user.uid)),
      (snap) => {
        const list = sortByMostRecentTimestamp(
          snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<QuizAttempt, 'id'>) }))
        );
        setQuizAttempts(list);
        setLearnLoadedFlags((prev) => ({ ...prev, quizzes: true }));
      },
      (err) => {
        setLearnLoadedFlags((prev) => ({ ...prev, quizzes: true }));
        handleFirestoreError(err, OperationType.LIST, 'quizAttempts');
      }
    );

    return () => {
      unsubVocab();
      unsubNotes();
      unsubQuizzes();
    };
  }, [user]);

  useEffect(() => {
    return () => {
      stopCurrentAudio();
      activeRecordingRef.current?.cancel();
    };
  }, []);

  const handlePlayAudio = async (key: string, text: string, lang: string) => {
    setAudioStatusMsg(null);
    setTtsRetryPayload(null);

    if (playingAudioKey === key) {
      stopCurrentAudio();
      setPlayingAudioKey(null);
      return;
    }

    setPlayingAudioKey(key);
    try {
      await playGeminiTTS({
        text,
        language: lang,
        speed: playbackSpeed,
        onEnd: () => setPlayingAudioKey(null),
      });
    } catch (err) {
      setPlayingAudioKey(null);
      const msg = err instanceof Error ? err.message : 'Unable to play server TTS audio.';
      setAudioStatusMsg(msg);
      setTtsRetryPayload({ text, language: lang });
    }
  };

  // Speaking Practice: Conversational Turn via Firebase AI Logic Hybrid Inference
  const sendConversationTurn = async (textToSend?: string) => {
    if (convLoading) return;
    const message = (textToSend ?? convInput).trim();
    if (!message) return;
    setAudioStatusMsg(null);
    if (!textToSend) setConvInput('');

    const userMsgId = `u-${Date.now()}`;
    const updatedHistory = [
      ...convHistory,
      { id: userMsgId, role: 'user' as const, text: message },
    ];
    setConvHistory(updatedHistory);
    setConvLoading(true);

    const recentText = updatedHistory
      .slice(-8)
      .map((m) => `${m.role === 'user' ? 'Learner' : 'Nimo'}: ${m.text}`)
      .join('\n');

    const prompt = `Target language: ${activeLanguage}
Learner proficiency level: ${level}
Recent conversation:
${recentText}

Respond naturally in ${activeLanguage} appropriate for ${level} level.
Return ONLY valid JSON with exact keys:
{
  "replyTargetLanguage": "string (natural response in ${activeLanguage})",
  "replyEnglishTranslation": "string (accurate English translation)",
  "gentleCorrection": "string (helpful grammar/phrasing tip, or empty string if spotless)",
  "followUpPrompt": "string (engaging follow-up question in ${activeLanguage})"
}`;

    try {
      const { data, meta } = await generateHybridJson<LanguageConversationReply>({
        prompt,
        mode: inferenceMode,
        systemInstruction:
          'You are Nimo, a supportive multilingual conversational language tutor. Return strict JSON only.',
        validator: validateLanguageConversationReply,
        requestKey: 'learn-lang-conv',
      });

      const combinedReply = `${data.replyTargetLanguage} ${data.followUpPrompt || ''}`.trim();
      const assistantId = `a-${Date.now()}`;
      setConvHistory((prev) => [
        ...prev,
        {
          id: assistantId,
          role: 'assistant',
          text: combinedReply,
          translation: data.replyEnglishTranslation,
          correction: data.gentleCorrection,
          meta: {
            inferenceSource: meta.inferenceSource,
            modelUsed: meta.modelUsed,
            latencyMs: meta.latencyMs,
          },
        },
      ]);

      void handlePlayAudio(assistantId, combinedReply, activeLanguage);
    } catch (err) {
      setAudioStatusMsg(err instanceof Error ? err.message : 'Conversation error.');
    } finally {
      setConvLoading(false);
    }
  };

  const toggleConversationMic = async () => {
    setAudioStatusMsg(null);
    if (convRecording && activeRecordingRef.current) {
      setConvRecording(false);
      setConvLoading(true);
      try {
        const clip = await activeRecordingRef.current.stop();
        activeRecordingRef.current = null;
        const { transcript } = await transcribeAudioClip(
          clip.base64,
          clip.mimeType,
          activeLanguage
        );
        if (!transcript) {
          setAudioStatusMsg('No speech detected. Speak clearly or type your reply.');
          setConvLoading(false);
          return;
        }
        setConvLoading(false);
        await sendConversationTurn(transcript);
      } catch (err) {
        setAudioStatusMsg(
          err instanceof Error
            ? `${err.message} You can still type your response below.`
            : 'Voice transcription failed.'
        );
        setConvLoading(false);
      }
      return;
    }

    try {
      const rec = await startMicRecording();
      activeRecordingRef.current = rec;
      setConvRecording(true);
    } catch (err) {
      setAudioStatusMsg(err instanceof Error ? err.message : 'Microphone unavailable.');
    }
  };

  // Pronunciation Coach Drill (Multimodal Audio Endpoint)
  const evaluatePronunciationClip = async (
    clip: { base64: string; mimeType: string },
    transcript: string,
    fallbackToStandard = false
  ) => {
    setDrillLoading(true);
    setDrillBillingRetry(false);
    setAudioStatusMsg(null);
    try {
      const res = await fetch('/api/learn/language', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'pronunciation',
          targetLanguage: activeLanguage,
          level,
          targetPhrase: drillPhrase,
          spokenTranscript: transcript,
          audioBase64: clip.base64,
          audioMimeType: clip.mimeType,
          fallbackToStandard,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.isBillingRequired) {
          setDrillBillingRetry(true);
        }
        throw new Error(data.message || data.error || 'Pronunciation check failed.');
      }
      setPronunciationResult(data);
    } catch (err) {
      setAudioStatusMsg(err instanceof Error ? err.message : 'Pronunciation evaluation error.');
    } finally {
      setDrillLoading(false);
    }
  };

  const toggleDrillMic = async () => {
    setAudioStatusMsg(null);
    if (drillRecording && activeRecordingRef.current) {
      setDrillRecording(false);
      setDrillLoading(true);
      try {
        const clip = await activeRecordingRef.current.stop();
        activeRecordingRef.current = null;
        const { transcript } = await transcribeAudioClip(
          clip.base64,
          clip.mimeType,
          activeLanguage
        );
        const saved = { base64: clip.base64, mimeType: clip.mimeType, transcript };
        setLastClipForRetry(saved);
        await evaluatePronunciationClip(
          { base64: clip.base64, mimeType: clip.mimeType },
          transcript,
          false
        );
      } catch (err) {
        setAudioStatusMsg(err instanceof Error ? err.message : 'Recording failed.');
        setDrillLoading(false);
      }
      return;
    }

    try {
      const rec = await startMicRecording();
      activeRecordingRef.current = rec;
      setDrillRecording(true);
    } catch (err) {
      setAudioStatusMsg(err instanceof Error ? err.message : 'Microphone unavailable.');
    }
  };

  // Vocabulary Generation via Firebase AI Logic Hybrid Inference
  const generateVocabLesson = async () => {
    if (vocabGenerating) return;
    setAudioStatusMsg(null);
    setVocabGenerating(true);

    const prompt = `Create 6 practical ${level}-level ${activeLanguage} vocabulary items on the topic "${vocabTopic || 'Daily Essentials'}".
Return ONLY a valid JSON array of 6 objects with exact keys:
[
  {
    "term": "word or phrase in ${activeLanguage}",
    "translation": "English meaning",
    "phonetic": "learner-friendly pronunciation guide",
    "exampleSentence": "natural example sentence in ${activeLanguage}",
    "exampleTranslation": "English translation of the example sentence"
  }
]`;

    try {
      const { data: items, meta } = await generateHybridJson<VocabLessonItemDraft[]>({
        prompt,
        mode: inferenceMode,
        systemInstruction:
          'You are Nimo, an expert multilingual vocabulary coach. Return valid JSON array only.',
        validator: validateVocabItems,
        requestKey: 'learn-vocab',
      });

      setVocabMeta({
        inferenceSource: meta.inferenceSource,
        modelUsed: meta.modelUsed,
        latencyMs: meta.latencyMs,
      });

      if (user) {
        justCreatedLearnRef.current = true;
        for (const item of items) {
          await addDoc(collection(db, 'vocabItems'), {
            ownerId: user.uid,
            language: activeLanguage.slice(0, 60),
            level,
            term: item.term.slice(0, 160),
            translation: item.translation.slice(0, 200),
            phonetic: (item.phonetic || '').slice(0, 200),
            exampleSentence: (item.exampleSentence || '').slice(0, 400),
            exampleTranslation: (item.exampleTranslation || '').slice(0, 400),
            mastered: false,
            createdAt: serverTimestamp(),
          });
        }
      } else {
        setGuestVocab((prev) => [
          ...items.map((item, idx) => ({
            id: `gv-${Date.now()}-${idx}`,
            ownerId: 'guest',
            language: activeLanguage,
            level,
            term: item.term,
            translation: item.translation,
            phonetic: item.phonetic,
            exampleSentence: item.exampleSentence,
            exampleTranslation: item.exampleTranslation,
            mastered: false,
          })),
          ...prev,
        ]);
      }
    } catch (err) {
      if (
        user &&
        err instanceof Error &&
        err.message.includes('Missing or insufficient permissions')
      ) {
        handleFirestoreError(err, OperationType.CREATE, 'vocabItems');
      }
      setAudioStatusMsg(
        err instanceof Error ? err.message : 'Vocabulary generation failed.'
      );
    } finally {
      setVocabGenerating(false);
    }
  };

  const toggleVocabMastered = async (item: VocabItem) => {
    if (!user) {
      setGuestVocab((prev) =>
        prev.map((v) => (v.id === item.id ? { ...v, mastered: !v.mastered } : v))
      );
      return;
    }
    try {
      await updateDoc(doc(db, 'vocabItems', item.id), { mastered: !item.mastered });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `vocabItems/${item.id}`);
    }
  };

  const deleteVocabItem = async (id: string) => {
    if (!user) {
      setGuestVocab((prev) => prev.filter((v) => v.id !== id));
      return;
    }
    try {
      await deleteDoc(doc(db, 'vocabItems', id));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `vocabItems/${id}`);
    }
  };

  // Listening Comprehension via Firebase AI Logic Hybrid Inference
  const generateListeningExercise = async () => {
    if (listeningLoading) return;
    setAudioStatusMsg(null);
    setListeningLoading(true);
    setShowTranscript(false);
    setListeningAnswers({});
    setListeningChecked(false);

    const topicText = listeningTopic || 'Everyday dialogue';
    const prompt = `Generate a ${level}-level ${activeLanguage} listening comprehension exercise about "${topicText}".
Return ONLY a valid JSON object with exact structure:
{
  "title": "short descriptive title",
  "passageText": "4 to 6 natural spoken sentences entirely in ${activeLanguage}",
  "questions": [
    {
      "question": "English comprehension question about a detail in the passage",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "correctIndex": 0,
      "explanation": "Brief explanation referencing the passage"
    }
  ]
}
Include exactly 3 questions with 4 options each.`;

    try {
      const { data, meta } = await generateHybridJson<ListeningExercise>({
        prompt,
        mode: inferenceMode,
        systemInstruction:
          'You are Nimo, a language curriculum designer. Return strict JSON only.',
        validator: (raw) => validateListeningExercise(raw, `${activeLanguage}: ${topicText}`),
        requestKey: 'learn-listening',
      });
      setListeningExercise(data);
      setListeningMeta({
        inferenceSource: meta.inferenceSource,
        modelUsed: meta.modelUsed,
        latencyMs: meta.latencyMs,
      });
    } catch (err) {
      setAudioStatusMsg(
        err instanceof Error ? err.message : 'Listening exercise generation failed.'
      );
    } finally {
      setListeningLoading(false);
    }
  };

  // General Learning: Study Notes & Step-by-Step via Firebase AI Logic Hybrid Inference
  const runStudyAction = async (action: 'study_notes' | 'explain_step_by_step') => {
    if (!studyTopic.trim() || notesLoading) return;
    setNotesError(null);
    setNotesLoading(true);

    const prompt =
      action === 'study_notes'
        ? `Create comprehensive ${studyDifficulty}-level study notes and a structured summary for:\nSubject: ${subject}\nTopic: ${studyTopic}\nUse clean markdown headings, bulleted key concepts, a worked example, and a concise summary.`
        : `Teach me step by step (${studyDifficulty} level, subject: ${subject}): "${studyTopic}".\nBreak down the concept into numbered logical steps, build intuition, and note common mistakes.`;

    try {
      const result = await generateHybridText({
        prompt,
        mode: inferenceMode,
        systemInstruction:
          'You are Nimo, a patient academic tutor. Produce crisp, accurate markdown study guides and step-by-step explanations.',
        requestKey: 'learn-study',
      });

      const title = `${subject}: ${studyTopic}`.slice(0, 160);
      const summaryMarkdown = result.text.slice(0, 25000);
      setActiveNote({
        title,
        summaryMarkdown,
        meta: {
          inferenceSource: result.inferenceSource,
          modelUsed: result.modelUsed,
          latencyMs: result.latencyMs,
        },
      });

      if (user && summaryMarkdown) {
        try {
          justCreatedLearnRef.current = true;
          const noteRef = await addDoc(collection(db, 'studyNotes'), {
            ownerId: user.uid,
            subject: subject.slice(0, 80),
            title,
            summaryMarkdown,
            createdAt: serverTimestamp(),
          });
          setActiveNoteId(noteRef.id);
        } catch (err) {
          justCreatedLearnRef.current = false;
          handleFirestoreError(err, OperationType.CREATE, 'studyNotes');
        }
      } else {
        setActiveNoteId(null);
      }
    } catch (err) {
      setNotesError(
        err instanceof Error ? err.message : 'Failed to generate study material.'
      );
    } finally {
      setNotesLoading(false);
    }
  };

  const askNoteFollowUp = async () => {
    if (!activeNote || !noteFollowUpInput.trim() || noteFollowUpLoading) return;
    setNotesError(null);
    setNoteFollowUpLoading(true);
    const question = noteFollowUpInput.trim();
    setNoteFollowUpInput('');

    try {
      const result = await generateHybridText({
        prompt: `Based on these study notes titled "${activeNote.title}":\n\n${activeNote.summaryMarkdown.slice(0, 4000)}\n\nAnswer the student's follow-up question clearly:\n${question}`,
        mode: inferenceMode,
        systemInstruction:
          'You are Nimo, answering a student follow-up question clearly and concisely.',
        requestKey: 'learn-study-followup',
      });
      setActiveNote((prev) =>
        prev
          ? {
              ...prev,
              summaryMarkdown: `${prev.summaryMarkdown}\n\n---\n\n### Follow-up: ${question}\n\n${result.text}`.slice(
                0,
                25000
              ),
              meta: {
                inferenceSource: result.inferenceSource,
                modelUsed: result.modelUsed,
                latencyMs: result.latencyMs,
              },
            }
          : prev
      );
    } catch (err) {
      setNotesError(
        err instanceof Error ? err.message : 'Unable to answer follow-up question.'
      );
    } finally {
      setNoteFollowUpLoading(false);
    }
  };

  const handleQuizFilesSelected = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setNotesError(null);
    const textExtensions = [
      '.txt',
      '.md',
      '.markdown',
      '.csv',
      '.json',
      '.js',
      '.ts',
      '.tsx',
      '.jsx',
      '.py',
      '.html',
      '.css',
      '.xml',
      '.yaml',
      '.yml',
      '.sql',
      '.log',
    ];

    const added: Array<{
      id: string;
      name: string;
      kind: 'text' | 'binary';
      textContent?: string;
      base64?: string;
      mimeType?: string;
    }> = [];

    for (const file of Array.from(fileList)) {
      const lowerName = file.name.toLowerCase();
      const isTextFile =
        file.type.startsWith('text/') ||
        textExtensions.some((ext) => lowerName.endsWith(ext));
      const isBinarySupported =
        file.type.startsWith('image/') ||
        file.type === 'application/pdf' ||
        lowerName.endsWith('.pdf');

      try {
        if (isTextFile) {
          const textContent = (await file.text()).slice(0, 60000);
          added.push({
            id: `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            name: file.name,
            kind: 'text',
            textContent,
          });
        } else if (isBinarySupported) {
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(new Error(`Failed to read ${file.name}.`));
            reader.readAsDataURL(file);
          });
          const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
          const mimeType =
            file.type || (lowerName.endsWith('.pdf') ? 'application/pdf' : 'image/png');
          added.push({
            id: `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            name: file.name,
            kind: 'binary',
            base64,
            mimeType,
          });
        } else {
          const fallbackText = (await file.text()).slice(0, 60000);
          added.push({
            id: `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            name: file.name,
            kind: 'text',
            textContent: fallbackText,
          });
        }
      } catch (err) {
        setNotesError(
          err instanceof Error ? err.message : `Could not read uploaded file ${file.name}.`
        );
      }
    }

    if (added.length > 0) {
      setQuizFiles((prev) => [...prev, ...added]);
    }
    if (quizFileInputRef.current) {
      quizFileInputRef.current.value = '';
    }
  };

  const runQuizGeneration = async (
    topicValue: string,
    difficultyValue: ProficiencyLevel,
    useCurrentFiles = true
  ) => {
    const trimmedTopic = topicValue.trim();
    const activeFiles = useCurrentFiles ? quizFiles : [];
    if ((!trimmedTopic && activeFiles.length === 0) || quizLoading) return;

    setNotesError(null);
    setQuizLoading(true);
    setQuizSubmitted(false);
    setMcqSelections({});
    setShortAnswers({});
    setShortGrades({});
    setDeepExplainMap({});
    setActiveAttemptId(null);
    setReviewFilter('all');

    const parsedCount = Math.floor(Number(quizCount));
    const requestedCount =
      Number.isFinite(parsedCount) && parsedCount >= 1 ? parsedCount : 4;
    const topicLabel =
      trimmedTopic ||
      (activeFiles.length > 0 ? activeFiles.map((f) => f.name).join(', ') : 'Study Quiz');

    const textAttachments = activeFiles
      .filter((f) => f.kind === 'text' && f.textContent)
      .map((f) => `--- Uploaded File: ${f.name} ---\n${f.textContent}`)
      .join('\n\n');
    const binaryAttachment = activeFiles.find(
      (f) => f.kind === 'binary' && f.base64 && f.mimeType
    );

    const prompt = [
      `Generate a ${requestedCount}-question ${difficultyValue}-level quiz${
        trimmedTopic
          ? ` on "${trimmedTopic}"`
          : ' based on the uploaded study material'
      } (subject: ${subject}).`,
      quizInstructions.trim()
        ? `Additional instructions from the user on how to generate the questions:\n${quizInstructions.trim()}`
        : 'Mix multiple-choice ("mcq", exactly 4 options) and 1 short-answer ("short") practice question.',
      textAttachments
        ? `Reference material from uploaded file(s):\n${textAttachments}`
        : '',
      binaryAttachment
        ? `Use the attached file (${binaryAttachment.name}) as primary source material when creating questions.`
        : '',
      `Return ONLY valid JSON with exact structure:
{
  "title": "Quiz title",
  "questions": [
    {
      "id": "q1",
      "type": "mcq",
      "prompt": "Question text",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "correctIndex": 0,
      "explanation": "Why the correct option is right"
    },
    {
      "id": "q2",
      "type": "short",
      "prompt": "Short-answer question",
      "sampleAnswer": "Expected key points",
      "explanation": "Clear explanation"
    }
  ]
}`,
    ]
      .filter(Boolean)
      .join('\n\n');

    try {
      const { data, meta } = await generateHybridJson<GeneratedQuiz>({
        prompt,
        mode: inferenceMode,
        systemInstruction:
          'You are Nimo, an educational assessment designer. Return strict valid JSON only.',
        image:
          binaryAttachment?.base64 && binaryAttachment?.mimeType
            ? { base64: binaryAttachment.base64, mimeType: binaryAttachment.mimeType }
            : undefined,
        timeoutMs: requestedCount > 15 ? 120000 : 45000,
        validator: (raw) => validateQuizPayload(raw, topicLabel),
        requestKey: 'learn-quiz-gen',
      });
      setQuizTitle(data.title);
      setQuizQuestions(data.questions);
      setQuizMeta({
        inferenceSource: meta.inferenceSource,
        modelUsed: meta.modelUsed,
        latencyMs: meta.latencyMs,
      });
    } catch (err) {
      setNotesError(err instanceof Error ? err.message : 'Quiz generation error.');
    } finally {
      setQuizLoading(false);
    }
  };

  // General Learning: Quiz Generator & Grader via Firebase AI Logic Hybrid Inference
  const generateQuiz = () => {
    void runQuizGeneration(quizTopic, quizDifficulty, true);
  };

  const retrySameQuiz = () => {
    setMcqSelections({});
    setShortAnswers({});
    setShortGrades({});
    setQuizSubmitted(false);
    setQuizScore(0);
    setDeepExplainMap({});
    setActiveAttemptId(null);
    setReviewFilter('all');
  };

  const reviewQuizAttempt = (att: QuizAttempt, mistakesOnly = false) => {
    if (!att.questions || att.questions.length === 0) {
      setQuizTopic(att.topic);
      setQuizDifficulty(att.difficulty);
      void runQuizGeneration(att.topic, att.difficulty, false);
      return;
    }
    setNotesError(null);
    setQuizTitle(att.topic);
    setQuizDifficulty(att.difficulty);
    setQuizQuestions(att.questions);
    setMcqSelections(att.mcqSelections || {});
    setShortAnswers(att.shortAnswers || {});
    setShortGrades(att.shortGrades || {});
    setQuizScore(att.score);
    setQuizSubmitted(true);
    setDeepExplainMap({});
    setQuizMeta(null);
    setActiveAttemptId(att.id);
    setReviewFilter(mistakesOnly ? 'mistakes' : 'all');
  };

  const retakeQuizAttempt = (att: QuizAttempt) => {
    if (!att.questions || att.questions.length === 0) {
      setQuizTopic(att.topic);
      setQuizDifficulty(att.difficulty);
      void runQuizGeneration(att.topic, att.difficulty, false);
      return;
    }
    setNotesError(null);
    setQuizTitle(att.topic);
    setQuizDifficulty(att.difficulty);
    setQuizQuestions(att.questions);
    setMcqSelections({});
    setShortAnswers({});
    setShortGrades({});
    setQuizScore(0);
    setQuizSubmitted(false);
    setDeepExplainMap({});
    setQuizMeta(null);
    setActiveAttemptId(null);
    setReviewFilter('all');
  };

  const deleteQuizAttempt = async (att: QuizAttempt) => {
    if (user) {
      try {
        await deleteDoc(doc(db, 'quizAttempts', att.id));
      } catch (err) {
        handleFirestoreError(err, OperationType.DELETE, `quizAttempts/${att.id}`);
        return;
      }
    } else {
      setGuestQuizAttempts((prev) => prev.filter((item) => item.id !== att.id));
    }
    if (activeAttemptId === att.id) {
      setActiveAttemptId(null);
    }
  };

  const isQuestionCorrect = (q: QuizQuestion): boolean => {
    if (q.type === 'mcq') {
      return mcqSelections[q.id] === q.correctIndex;
    }
    return Boolean(shortGrades[q.id]?.isCorrect);
  };

  const submitQuiz = async () => {
    if (quizQuestions.length === 0 || quizLoading) return;
    setQuizLoading(true);
    setNotesError(null);

    const { mcqScore } = scoreMcqQuestions(quizQuestions, mcqSelections);
    let score = mcqScore;
    const updatedShortGrades: Record<string, ShortAnswerGrade> = {};

    try {
      for (const q of quizQuestions) {
        if (q.type === 'short') {
          const ans = (shortAnswers[q.id] || '').trim();
          if (ans) {
            const { data: grade } = await generateHybridJson<ShortAnswerGrade>({
              prompt: `Question: ${q.prompt}\nReference answer: ${q.sampleAnswer || q.explanation}\nStudent answer: ${ans}\nReturn ONLY valid JSON: { "isCorrect": true/false, "feedback": "1-2 sentence grading feedback" }`,
              mode: inferenceMode,
              systemInstruction: 'Grade the student answer fairly. Return strict JSON only.',
              validator: validateShortAnswerGrade,
            });
            updatedShortGrades[q.id] = grade;
            if (grade.isCorrect) score += 1;
          } else {
            updatedShortGrades[q.id] = { isCorrect: false, feedback: 'No answer entered.' };
          }
        }
      }

      setShortGrades(updatedShortGrades);
      setQuizScore(score);
      setQuizSubmitted(true);
      setReviewFilter('all');

      const sanitizedQuestions = sanitizeQuestionsForStorage(quizQuestions);
      const cleanMcqSelections = { ...mcqSelections };
      const cleanShortAnswers = { ...shortAnswers };
      const cleanShortGrades = { ...updatedShortGrades };
      const resolvedTopic = (quizTitle || quizTopic || 'Study Quiz').slice(0, 140);
      const summaryText = `Scored ${score}/${quizQuestions.length} on ${resolvedTopic}`.slice(
        0,
        4000
      );

      if (user && quizQuestions.length > 0) {
        try {
          const payload: Record<string, unknown> = {
            ownerId: user.uid,
            topic: resolvedTopic,
            difficulty: quizDifficulty,
            score,
            totalQuestions: quizQuestions.length,
            summaryText,
            createdAt: serverTimestamp(),
          };
          if (sanitizedQuestions.length <= 1000) {
            payload.questions = sanitizedQuestions;
            payload.mcqSelections = cleanMcqSelections;
            payload.shortAnswers = cleanShortAnswers;
            payload.shortGrades = cleanShortGrades;
          }
          justCreatedLearnRef.current = true;
          const ref = await addDoc(collection(db, 'quizAttempts'), payload);
          setActiveAttemptId(ref.id);
        } catch (err) {
          justCreatedLearnRef.current = false;
          handleFirestoreError(err, OperationType.CREATE, 'quizAttempts');
        }
      } else if (quizQuestions.length > 0) {
        const guestAttempt: QuizAttempt = {
          id: `guest-quiz-${Date.now()}`,
          ownerId: 'guest',
          topic: resolvedTopic,
          difficulty: quizDifficulty,
          score,
          totalQuestions: quizQuestions.length,
          summaryText,
          questions: sanitizedQuestions,
          mcqSelections: cleanMcqSelections,
          shortAnswers: cleanShortAnswers,
          shortGrades: cleanShortGrades,
          createdAt: Date.now(),
        };
        setGuestQuizAttempts((prev) => [guestAttempt, ...prev]);
        setActiveAttemptId(guestAttempt.id);
      }
    } catch (err) {
      setNotesError(err instanceof Error ? err.message : 'Unable to finish quiz grading.');
    } finally {
      setQuizLoading(false);
    }
  };

  const explainQuestionDeeply = async (q: QuizQuestion) => {
    setDeepExplainLoadingId(q.id);
    setNotesError(null);
    try {
      const result = await generateHybridText({
        prompt: `Teach step by step (${quizDifficulty} level, subject: ${subject}):\nQuestion: ${q.prompt}\nCore concept: ${q.explanation}`,
        mode: inferenceMode,
        systemInstruction:
          'You are Nimo, a patient step-by-step teacher explaining why the answer works.',
        requestKey: `learn-explain-${q.id}`,
      });
      setDeepExplainMap((prev) => ({
        ...prev,
        [q.id]: {
          text: result.text,
          meta: {
            inferenceSource: result.inferenceSource,
            modelUsed: result.modelUsed,
            latencyMs: result.latencyMs,
          },
        },
      }));
    } catch (err) {
      setNotesError(err instanceof Error ? err.message : 'Could not load step-by-step guide.');
    } finally {
      setDeepExplainLoadingId(null);
    }
  };

  const displayedVocab = user ? savedVocab : guestVocab;
  const masteredVocabCount = displayedVocab.filter((v) => v.mastered).length;
  const displayedQuizAttempts = user ? quizAttempts : guestQuizAttempts;
  const avgQuizPct =
    displayedQuizAttempts.length > 0
      ? Math.round(
          (displayedQuizAttempts.reduce(
            (acc, a) => acc + (a.totalQuestions > 0 ? a.score / a.totalQuestions : 0),
            0
          ) /
            displayedQuizAttempts.length) *
            100
        )
      : 0;
  const mistakeCount = quizSubmitted
    ? quizQuestions.filter((q) => !isQuestionCorrect(q)).length
    : 0;

  const totalLearnHistoryCount =
    savedNotes.length + displayedQuizAttempts.length + displayedVocab.length;

  const openStudyNote = (note: StudyNote) => {
    setSubMode('general');
    setGeneralActivity('notes');
    setActiveNoteId(note.id);
    setActiveNote({
      title: note.title,
      summaryMarkdown: note.summaryMarkdown,
    });
    setMobileHistoryOpen(false);
  };

  const openQuizAttempt = (att: QuizAttempt, mistakesOnly = false) => {
    setSubMode('general');
    setGeneralActivity('quiz');
    reviewQuizAttempt(att, mistakesOnly);
    setMobileHistoryOpen(false);
  };

  const openVocabItem = (item: VocabItem) => {
    setSubMode('language');
    setLanguageActivity('vocabulary');
    setActiveVocabId(item.id);
    setMobileHistoryOpen(false);
  };

  const ensureValidLearnSelectionOnHistoryOpen = () => {
    const hasActiveNote = Boolean(
      subMode === 'general' &&
        generalActivity === 'notes' &&
        activeNoteId &&
        savedNotes.some((n) => n.id === activeNoteId)
    );
    const hasActiveQuiz = Boolean(
      subMode === 'general' &&
        generalActivity === 'quiz' &&
        activeAttemptId &&
        displayedQuizAttempts.some((a) => a.id === activeAttemptId)
    );
    const hasActiveVocab = Boolean(
      subMode === 'language' &&
        languageActivity === 'vocabulary' &&
        activeVocabId &&
        displayedVocab.some((v) => v.id === activeVocabId)
    );

    if (hasActiveNote || hasActiveQuiz || hasActiveVocab) {
      setTimeout(() => {
        activeHistoryItemRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }, 90);
      return;
    }

    const scrollTop = () => {
      setTimeout(() => {
        learnHistoryScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
      }, 90);
    };

    if (subMode === 'general' && generalActivity === 'notes' && savedNotes.length > 0) {
      openStudyNote(savedNotes[0]);
      scrollTop();
      return;
    }
    if (subMode === 'general' && generalActivity === 'quiz' && displayedQuizAttempts.length > 0) {
      openQuizAttempt(displayedQuizAttempts[0], false);
      scrollTop();
      return;
    }
    if (subMode === 'language' && languageActivity === 'vocabulary' && displayedVocab.length > 0) {
      openVocabItem(displayedVocab[0]);
      scrollTop();
      return;
    }

    if (displayedQuizAttempts.length > 0) {
      setActiveAttemptId(displayedQuizAttempts[0].id);
      if (subMode === 'general' && generalActivity === 'quiz' && quizQuestions.length === 0) {
        openQuizAttempt(displayedQuizAttempts[0], false);
      }
      scrollTop();
    } else if (savedNotes.length > 0) {
      setActiveNoteId(savedNotes[0].id);
      if (subMode === 'general' && !activeNote) {
        openStudyNote(savedNotes[0]);
      }
      scrollTop();
    } else if (displayedVocab.length > 0) {
      setActiveVocabId(displayedVocab[0].id);
      scrollTop();
    }
  };

  const toggleDesktopHistory = () => {
    setDesktopHistoryOpen((prev) => {
      const next = !prev;
      if (next) ensureValidLearnSelectionOnHistoryOpen();
      return next;
    });
  };

  const openMobileHistory = () => {
    ensureValidLearnSelectionOnHistoryOpen();
    setMobileHistoryOpen(true);
  };

  const startEditingLearnItem = (
    kind: 'quiz' | 'note' | 'vocab',
    id: string,
    currentTitle: string
  ) => {
    setEditingLearnItem({ kind, id });
    setEditingLearnTitle(currentTitle);
  };

  const cancelEditingLearnItem = () => {
    setEditingLearnItem(null);
    setEditingLearnTitle('');
  };

  const handleRenameLearnItem = async (
    kind: 'quiz' | 'note' | 'vocab',
    id: string
  ) => {
    const trimmed = editingLearnTitle.trim();
    if (!trimmed || savingLearnRename) return;
    setSavingLearnRename(true);
    try {
      if (kind === 'quiz') {
        const safeTopic = trimmed.slice(0, 140);
        if (user) {
          await updateDoc(doc(db, 'quizAttempts', id), { topic: safeTopic });
        } else {
          setGuestQuizAttempts((prev) =>
            prev.map((att) => (att.id === id ? { ...att, topic: safeTopic } : att))
          );
        }
        if (activeAttemptId === id) {
          setQuizTitle(safeTopic);
        }
      } else if (kind === 'note') {
        const safeTitle = trimmed.slice(0, 160);
        if (user) {
          await updateDoc(doc(db, 'studyNotes', id), { title: safeTitle });
        }
        if (activeNoteId === id) {
          setActiveNote((prev) => (prev ? { ...prev, title: safeTitle } : prev));
        }
      } else if (kind === 'vocab') {
        const safeTerm = trimmed.slice(0, 160);
        if (user) {
          await updateDoc(doc(db, 'vocabItems', id), { term: safeTerm });
        } else {
          setGuestVocab((prev) =>
            prev.map((v) => (v.id === id ? { ...v, term: safeTerm } : v))
          );
        }
      }
      setEditingLearnItem(null);
      setEditingLearnTitle('');
    } catch (err) {
      const collectionName =
        kind === 'quiz' ? 'quizAttempts' : kind === 'note' ? 'studyNotes' : 'vocabItems';
      handleFirestoreError(err, OperationType.UPDATE, `${collectionName}/${id}`);
    } finally {
      setSavingLearnRename(false);
    }
  };

  const historyLoading = Boolean(
    user && (!learnLoadedFlags.vocab || !learnLoadedFlags.notes || !learnLoadedFlags.quizzes)
  );

  useEffect(() => {
    if (!justCreatedLearnRef.current) return;
    justCreatedLearnRef.current = false;
    requestAnimationFrame(() => {
      learnHistoryScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }, [savedNotes.length, quizAttempts.length, savedVocab.length]);

  const showNotesInHistory = historyFilter === 'all' || historyFilter === 'notes';
  const showQuizzesInHistory = historyFilter === 'all' || historyFilter === 'quizzes';
  const showVocabInHistory = historyFilter === 'all' || historyFilter === 'vocab';

  const learnHistoryContent = (
    <div className="flex flex-col h-fit max-h-full w-72 md:w-72 shrink-0 bg-white dark:bg-[#161C24] border-r border-b border-slate-200 dark:border-slate-800 rounded-br-2xl shadow-xs overflow-hidden">
      <div className="p-3.5 border-b border-slate-200 dark:border-slate-800 space-y-2.5 shrink-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <History className="w-4 h-4 text-orange-600 dark:text-amber-400" />
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-300">
              Learn History
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={toggleDesktopHistory}
              aria-label="Hide learn history"
              title="Hide history"
              className="hidden md:inline-flex p-1.5 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              <PanelLeftClose className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => setMobileHistoryOpen(false)}
              aria-label="Close learn history"
              className="md:hidden p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-4 gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800">
          {(
            [
              { id: 'all', label: 'All' },
              { id: 'quizzes', label: 'Quizzes' },
              { id: 'notes', label: 'Notes' },
              { id: 'vocab', label: 'Vocab' },
            ] as const
          ).map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setHistoryFilter(f.id)}
              className={`py-1 text-[11px] font-medium rounded-md transition-colors ${
                historyFilter === f.id
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div ref={learnHistoryScrollRef} className="flex-1 min-h-0 overflow-y-auto p-3 space-y-4">
        {historyLoading ? (
          <div className="space-y-1.5 py-1" aria-label="Loading learn history">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-11 rounded-lg bg-slate-100 dark:bg-slate-800/70 animate-pulse"
              />
            ))}
          </div>
        ) : (
          <>
            {!user && (
              <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800 space-y-2">
                <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                  Sign in with Google to save study notes, quiz history, and vocabulary decks across sessions.
                </p>
                <button
                  type="button"
                  onClick={onRequireSignIn}
                  className="w-full px-3 py-1.5 text-xs font-medium rounded-md border border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
                >
                  Sign in to Sync
                </button>
              </div>
            )}

            {totalLearnHistoryCount === 0 ? (
              <div className="px-3 py-4 text-center space-y-1">
                <p className="text-xs font-medium text-slate-600 dark:text-slate-300">
                  No saved learning activities yet
                </p>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  Complete a quiz, generate study notes, or build a vocabulary deck to see your history here.
                </p>
              </div>
            ) : (
          <>
            {showQuizzesInHistory && (
              <div className="space-y-2">
                <div className="flex items-center justify-between px-1">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                    Quizzes ({displayedQuizAttempts.length})
                  </span>
                  {displayedQuizAttempts.length > 0 && (
                    <span className="text-[11px] font-mono tabular-nums text-orange-600 dark:text-amber-400">
                      {avgQuizPct}% avg
                    </span>
                  )}
                </div>
                {displayedQuizAttempts.length === 0 ? (
                  <p className="px-1 text-xs text-slate-500 dark:text-slate-400">
                    No completed quizzes yet.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {displayedQuizAttempts.map((att) => {
                      const hasSavedQuestions = Boolean(att.questions && att.questions.length > 0);
                      const hasMistakes = att.score < att.totalQuestions;
                      const isActive = activeAttemptId === att.id;
                      const isEditing =
                        editingLearnItem?.kind === 'quiz' && editingLearnItem.id === att.id;
                      const pct =
                        att.totalQuestions > 0
                          ? Math.round((att.score / att.totalQuestions) * 100)
                          : 0;
                      const dateLabel = formatAttemptDate(att.createdAt);

                      if (isEditing) {
                        return (
                          <form
                            key={att.id}
                            onSubmit={(e) => {
                              e.preventDefault();
                              void handleRenameLearnItem('quiz', att.id);
                            }}
                            className="p-2 rounded-lg border border-orange-400 dark:border-orange-600 bg-orange-50/60 dark:bg-orange-950/30 space-y-1.5"
                          >
                            <input
                              type="text"
                              autoFocus
                              maxLength={140}
                              value={editingLearnTitle}
                              onChange={(e) => setEditingLearnTitle(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Escape') {
                                  e.preventDefault();
                                  cancelEditingLearnItem();
                                }
                              }}
                              aria-label="Quiz title"
                              className="w-full px-2 py-1 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-orange-500"
                            />
                            <div className="flex items-center justify-end gap-1.5">
                              <button
                                type="button"
                                onClick={cancelEditingLearnItem}
                                className="px-2 py-0.5 text-[11px] rounded border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                              >
                                Cancel
                              </button>
                              <button
                                type="submit"
                                disabled={savingLearnRename || !editingLearnTitle.trim()}
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
                          key={att.id}
                          className={`group p-2.5 rounded-lg border transition-colors space-y-2 ${
                            isActive
                              ? 'border-orange-300 dark:border-orange-700 bg-orange-50/70 dark:bg-orange-950/35'
                              : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50'
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <button
                              ref={isActive ? activeHistoryItemRef : null}
                              type="button"
                              onClick={() => openQuizAttempt(att, false)}
                              className="min-w-0 flex-1 text-left"
                            >
                              <p className="text-xs font-medium text-slate-800 dark:text-slate-200 truncate hover:text-orange-600 dark:hover:text-amber-400">
                                {att.topic}
                              </p>
                              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                                {att.difficulty}
                                {dateLabel ? ` · ${dateLabel}` : ''}
                              </p>
                            </button>
                            <div className="flex items-center gap-1 shrink-0">
                              <span className="font-mono tabular-nums text-[11px] font-semibold text-orange-600 dark:text-amber-400">
                                {att.score}/{att.totalQuestions} ({pct}%)
                              </span>
                              <button
                                type="button"
                                onClick={() => startEditingLearnItem('quiz', att.id, att.topic)}
                                title="Rename quiz"
                                aria-label={`Rename ${att.topic}`}
                                className="p-0.5 text-slate-400 hover:text-orange-600 dark:hover:text-amber-400"
                              >
                                <Pencil className="w-3 h-3" />
                              </button>
                              <button
                                type="button"
                                onClick={() => void deleteQuizAttempt(att)}
                                aria-label={`Delete ${att.topic}`}
                                className="p-0.5 text-slate-400 hover:text-red-600"
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            </div>
                          </div>

                          <div className="flex flex-wrap items-center gap-1">
                            {hasSavedQuestions ? (
                              <>
                                <button
                                  type="button"
                                  onClick={() => openQuizAttempt(att, false)}
                                  className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                                >
                                  <Eye className="w-3 h-3" />
                                  Review
                                </button>
                                {hasMistakes && (
                                  <button
                                    type="button"
                                    onClick={() => openQuizAttempt(att, true)}
                                    className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded border border-red-200 dark:border-red-900/70 bg-red-50/70 dark:bg-red-950/30 text-red-700 dark:text-red-300 hover:bg-red-100/70"
                                  >
                                    <AlertCircle className="w-3 h-3" />
                                    Mistakes
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => {
                                    setSubMode('general');
                                    setGeneralActivity('quiz');
                                    retakeQuizAttempt(att);
                                    setMobileHistoryOpen(false);
                                  }}
                                  className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded bg-orange-600 hover:bg-orange-500 text-white transition-colors"
                                >
                                  <RotateCcw className="w-3 h-3" />
                                  Retake
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                onClick={() => {
                                  setSubMode('general');
                                  setGeneralActivity('quiz');
                                  retakeQuizAttempt(att);
                                  setMobileHistoryOpen(false);
                                }}
                                className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                              >
                                <RotateCcw className="w-3 h-3" />
                                New Quiz
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {showNotesInHistory && (
              <div className="space-y-2">
                <div className="flex items-center justify-between px-1">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                    Study Notes ({savedNotes.length})
                  </span>
                </div>
                {savedNotes.length === 0 ? (
                  <p className="px-1 text-xs text-slate-500 dark:text-slate-400">
                    No saved study notes yet.
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    {savedNotes.map((note) => {
                      const isActive = activeNoteId === note.id;
                      const isEditing =
                        editingLearnItem?.kind === 'note' && editingLearnItem.id === note.id;

                      if (isEditing) {
                        return (
                          <form
                            key={note.id}
                            onSubmit={(e) => {
                              e.preventDefault();
                              void handleRenameLearnItem('note', note.id);
                            }}
                            className="p-2 rounded-lg border border-orange-400 dark:border-orange-600 bg-orange-50/60 dark:bg-orange-950/30 space-y-1.5"
                          >
                            <input
                              type="text"
                              autoFocus
                              maxLength={160}
                              value={editingLearnTitle}
                              onChange={(e) => setEditingLearnTitle(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Escape') {
                                  e.preventDefault();
                                  cancelEditingLearnItem();
                                }
                              }}
                              aria-label="Study note title"
                              className="w-full px-2 py-1 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-orange-500"
                            />
                            <div className="flex items-center justify-end gap-1.5">
                              <button
                                type="button"
                                onClick={cancelEditingLearnItem}
                                className="px-2 py-0.5 text-[11px] rounded border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                              >
                                Cancel
                              </button>
                              <button
                                type="submit"
                                disabled={savingLearnRename || !editingLearnTitle.trim()}
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
                          key={note.id}
                          className={`group flex items-center justify-between gap-2 p-2.5 rounded-lg border transition-colors ${
                            isActive
                              ? 'border-orange-300 dark:border-orange-700 bg-orange-50/70 dark:bg-orange-950/35'
                              : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50'
                          }`}
                        >
                          <button
                            ref={isActive ? activeHistoryItemRef : null}
                            type="button"
                            onClick={() => openStudyNote(note)}
                            className="flex-1 text-left min-w-0"
                          >
                            <p className="text-xs font-medium text-slate-800 dark:text-slate-200 truncate">
                              {note.title}
                            </p>
                            <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                              {note.subject}
                            </p>
                          </button>
                          <div className="flex items-center gap-0.5 shrink-0">
                            <button
                              type="button"
                              onClick={() => startEditingLearnItem('note', note.id, note.title)}
                              title="Rename study note"
                              aria-label={`Rename ${note.title}`}
                              className="p-1 text-slate-400 hover:text-orange-600 dark:hover:text-amber-400"
                            >
                              <Pencil className="w-3 h-3" />
                            </button>
                            <button
                              type="button"
                              onClick={async () => {
                                try {
                                  await deleteDoc(doc(db, 'studyNotes', note.id));
                                  if (activeNoteId === note.id) setActiveNoteId(null);
                                } catch (err) {
                                  handleFirestoreError(
                                    err,
                                    OperationType.DELETE,
                                    `studyNotes/${note.id}`
                                  );
                                }
                              }}
                              aria-label={`Delete ${note.title}`}
                              className="p-1 text-slate-400 hover:text-red-600"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {showVocabInHistory && (
              <div className="space-y-2">
                <div className="flex items-center justify-between px-1">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                    Vocabulary ({displayedVocab.length})
                  </span>
                  {displayedVocab.length > 0 && (
                    <span className="text-[11px] font-mono tabular-nums text-emerald-600 dark:text-emerald-400">
                      {masteredVocabCount}/{displayedVocab.length}
                    </span>
                  )}
                </div>
                {displayedVocab.length === 0 ? (
                  <p className="px-1 text-xs text-slate-500 dark:text-slate-400">
                    No vocabulary items saved yet.
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    {displayedVocab.slice(0, 20).map((item) => {
                      const isActive = activeVocabId === item.id;
                      const isEditing =
                        editingLearnItem?.kind === 'vocab' && editingLearnItem.id === item.id;

                      if (isEditing) {
                        return (
                          <form
                            key={item.id}
                            onSubmit={(e) => {
                              e.preventDefault();
                              void handleRenameLearnItem('vocab', item.id);
                            }}
                            className="p-2 rounded-lg border border-orange-400 dark:border-orange-600 bg-orange-50/60 dark:bg-orange-950/30 space-y-1.5"
                          >
                            <input
                              type="text"
                              autoFocus
                              maxLength={160}
                              value={editingLearnTitle}
                              onChange={(e) => setEditingLearnTitle(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Escape') {
                                  e.preventDefault();
                                  cancelEditingLearnItem();
                                }
                              }}
                              aria-label="Vocabulary term"
                              className="w-full px-2 py-1 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-orange-500"
                            />
                            <div className="flex items-center justify-end gap-1.5">
                              <button
                                type="button"
                                onClick={cancelEditingLearnItem}
                                className="px-2 py-0.5 text-[11px] rounded border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                              >
                                Cancel
                              </button>
                              <button
                                type="submit"
                                disabled={savingLearnRename || !editingLearnTitle.trim()}
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
                          key={item.id}
                          className={`group flex items-center justify-between gap-2 p-2 rounded-lg border transition-colors ${
                            isActive
                              ? 'border-orange-300 dark:border-orange-700 bg-orange-50/70 dark:bg-orange-950/35'
                              : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50'
                          }`}
                        >
                          <button
                            ref={isActive ? activeHistoryItemRef : null}
                            type="button"
                            onClick={() => openVocabItem(item)}
                            className="flex-1 text-left min-w-0"
                          >
                            <p className="text-xs font-medium text-slate-800 dark:text-slate-200 truncate">
                              {item.term}
                            </p>
                            <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                              {item.translation} · {item.language}
                            </p>
                          </button>
                          <div className="flex items-center gap-0.5 shrink-0">
                            <button
                              type="button"
                              onClick={() => startEditingLearnItem('vocab', item.id, item.term)}
                              title="Rename term"
                              aria-label={`Rename ${item.term}`}
                              className="p-1 text-slate-400 hover:text-orange-600 dark:hover:text-amber-400"
                            >
                              <Pencil className="w-3 h-3" />
                            </button>
                            <button
                              type="button"
                              onClick={() => deleteVocabItem(item.id)}
                              aria-label={`Remove ${item.term}`}
                              className="p-1 text-slate-400 hover:text-red-600"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </>
        )}
          </>
        )}
      </div>
    </div>
  );

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden bg-[#F8F9FB] dark:bg-[#0F1419] relative">
      {/* Desktop Collapsible Space-Efficient Learn History Notice Board */}
      <aside
        aria-label="Learn history notice board"
        aria-hidden={!desktopHistoryOpen}
        className={`hidden md:flex shrink-0 flex-col bg-transparent overflow-hidden transition-[width,opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
          desktopHistoryOpen
            ? 'w-72 opacity-100 translate-x-0'
            : 'w-0 opacity-0 -translate-x-3 pointer-events-none'
        }`}
      >
        {learnHistoryContent}
      </aside>

      {/* Mobile Slide-Over Learn History Drawer (space-efficient height) */}
      <div
        className={`fixed inset-0 z-40 md:hidden flex items-start transition-opacity duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
          mobileHistoryOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
        aria-hidden={!mobileHistoryOpen}
      >
        <div
          className="fixed inset-0 bg-slate-950/55 transition-opacity duration-300"
          onClick={() => setMobileHistoryOpen(false)}
        />
        <aside
          className={`relative z-10 w-72 max-w-[85vw] max-h-[85dvh] flex flex-col bg-transparent transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
            mobileHistoryOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          {learnHistoryContent}
        </aside>
      </div>

      {/* Main Learn Workspace: Toolbar + Independent Scrollable Content + Stationary Bottom Prompt Bar */}
      <section className="flex-1 flex flex-col min-w-0 min-h-0 relative">
        {/* Top Learn Workspace Toolbar */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 sm:px-6 py-2.5 bg-white dark:bg-[#161C24] border-b border-slate-200 dark:border-slate-800 shrink-0">
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <button
              type="button"
              onClick={openMobileHistory}
              aria-label="Show learn history"
              className="md:hidden inline-flex items-center gap-1 h-7 px-2 text-[11px] font-medium rounded-md border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:border-orange-300 dark:hover:border-orange-700 whitespace-nowrap"
            >
              <History className="w-3 h-3 text-orange-600 dark:text-amber-400" />
              History
            </button>

            <button
              type="button"
              onClick={toggleDesktopHistory}
              title={desktopHistoryOpen ? 'Hide learn history' : 'Show learn history'}
              aria-label={desktopHistoryOpen ? 'Hide learn history' : 'Show learn history'}
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

            <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800">
              <button
                type="button"
                onClick={() => setSubMode('language')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  subMode === 'language'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                <Languages className="w-3.5 h-3.5" />
                Language Learning
              </button>
              <button
                type="button"
                onClick={() => setSubMode('general')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  subMode === 'general'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                <GraduationCap className="w-3.5 h-3.5" />
                General Learning &amp; Quiz
              </button>
            </div>
          </div>
        </div>

        {/* Independent Scrollable Workspace Content */}
        <div
          className={`flex-1 min-h-0 overflow-y-auto px-4 sm:px-8 pt-5 ${
            promptBarHidden ? 'pb-20' : 'pb-6'
          }`}
        >
          <div className="max-w-5xl mx-auto space-y-5">
            {/* EXPERIENCE A: LANGUAGE LEARNING */}
            {subMode === 'language' && (
              <div className="space-y-5">
                {/* Controls Deck */}
                <div className="bg-white dark:bg-[#161C24] border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5 space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                        Target Language
                      </label>
                      <select
                        value={targetLanguage}
                        onChange={(e) => setTargetLanguage(e.target.value)}
                        className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white"
                      >
                        {PRESET_LANGUAGES.map((l) => (
                          <option key={l.name} value={l.name}>
                            {l.name} ({l.nativeName})
                          </option>
                        ))}
                        <option value="__custom__">Custom Language...</option>
                      </select>
                      {targetLanguage === '__custom__' && (
                        <input
                          type="text"
                          value={customLanguage}
                          onChange={(e) => setCustomLanguage(e.target.value)}
                          placeholder="e.g. Swahili, Hindi, Dutch"
                          className="mt-2 w-full px-3 py-1.5 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white"
                        />
                      )}
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                        Proficiency Level
                      </label>
                      <select
                        aria-label="Proficiency Level"
                        value={level}
                        onChange={(e) => setLevel(e.target.value as ProficiencyLevel)}
                        className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white"
                      >
                        {LEVELS.map((lvl) => (
                          <option key={lvl} value={lvl}>
                            {lvl}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                        Speech Playback Speed
                      </label>
                      <div className="grid grid-cols-4 gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800">
                        {SPEEDS.map((spd) => (
                          <button
                            key={spd}
                            type="button"
                            onClick={() => setPlaybackSpeed(spd)}
                            className={`px-2 py-1.5 text-xs font-mono tabular-nums font-medium rounded-md transition-colors whitespace-nowrap ${
                              playbackSpeed === spd
                                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                                : 'text-slate-600 dark:text-slate-300'
                            }`}
                          >
                            {spd}x
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="flex flex-col justify-end">
                      <button
                        type="button"
                        onClick={() => setLiveTutorOpen(true)}
                        className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-orange-600 hover:bg-orange-500 text-white transition-colors whitespace-nowrap"
                      >
                        <PhoneCall className="w-4 h-4" />
                        Live Voice Tutor
                      </button>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-100 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400">
                    <span>
                      {activeLanguage} · {level} · Text lessons use Firebase AI Logic Hybrid Inference; audio uses browser Web Speech &amp; Gemini audio endpoints.
                    </span>
                    <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800 overflow-x-auto">
                      {(
                        [
                          { id: 'speaking', label: 'Speaking & Pronunciation' },
                          { id: 'vocabulary', label: 'Vocabulary Lessons' },
                          { id: 'listening', label: 'Listening Comprehension' },
                        ] as const
                      ).map((act) => (
                        <button
                          key={act.id}
                          type="button"
                          onClick={() => setLanguageActivity(act.id)}
                          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                            languageActivity === act.id
                              ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                              : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                          }`}
                        >
                          {act.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {!audioSupport.micSupported && (
                  <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 text-sm text-amber-800 dark:text-amber-200 flex items-start gap-2.5">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>
                      {audioStatusNoticeText(audioSupport.reason)} Typed practice, audio playback, vocabulary decks, and listening exercises remain fully available.
                    </span>
                  </div>
                )}

                {audioStatusMsg && (
                  <div className="p-4 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-sm text-red-700 dark:text-red-300 space-y-2.5">
                    <div className="flex items-start gap-2.5">
                      <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                      <span>{audioStatusMsg}</span>
                    </div>
                    {ttsRetryPayload && audioSupport.browserTtsSupported && (
                      <button
                        type="button"
                        onClick={() => {
                          playBrowserSpeechFallback({
                            text: ttsRetryPayload.text,
                            language: ttsRetryPayload.language,
                            speed: playbackSpeed,
                          });
                        }}
                        className="px-3 py-1.5 text-xs font-medium rounded-lg bg-white dark:bg-slate-900 border border-red-300 dark:border-red-800 text-slate-800 dark:text-slate-100 hover:bg-slate-50 transition-colors whitespace-nowrap"
                      >
                        Use Browser Speech Fallback
                      </button>
                    )}
                  </div>
                )}

                {/* Activity 1: Speaking & Pronunciation */}
                {languageActivity === 'speaking' && (
                  <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
                    {/* Left: Conversational Speaking Practice Transcript */}
                    <div className="lg:col-span-7 bg-white dark:bg-[#161C24] border border-slate-200 dark:border-slate-800 rounded-xl flex flex-col min-h-[340px]">
                      <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800">
                        <h2 className="text-base font-semibold font-display text-slate-900 dark:text-white">
                          Conversational Practice with Nimo
                        </h2>
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                          Speak via microphone or type in {activeLanguage} using the bottom bar. Nimo replies with translations, tips, and audio.
                        </p>
                      </div>

                      <div className="flex-1 p-5 space-y-4">
                        {convHistory.length === 0 ? (
                          <div className="py-10 text-center space-y-3">
                            <p className="text-sm text-slate-600 dark:text-slate-400">
                              Click the microphone or type in the prompt bar below to practice {activeLanguage} conversation.
                            </p>
                            <button
                              type="button"
                              onClick={() =>
                                sendConversationTurn(
                                  `Hello Nimo! Let's practice ${level} ${activeLanguage} conversation.`
                                )
                              }
                              className="px-4 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                            >
                              Start Guided Dialogue
                            </button>
                          </div>
                        ) : (
                          convHistory.map((m) => (
                            <div
                              key={m.id}
                              className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}
                            >
                              <div
                                className={`max-w-[85%] rounded-xl px-4 py-3 text-sm space-y-1.5 ${
                                  m.role === 'user'
                                    ? 'bg-orange-600 text-white'
                                    : 'bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100'
                                }`}
                              >
                                <p className="leading-relaxed">{m.text}</p>
                                {m.translation && (
                                  <p className="text-xs text-slate-500 dark:text-slate-400">
                                    Meaning: {m.translation}
                                  </p>
                                )}
                                {m.correction && (
                                  <p className="text-xs text-emerald-700 dark:text-emerald-300 pt-1">
                                    Tip: {m.correction}
                                  </p>
                                )}
                              </div>
                              {m.role === 'assistant' && (
                                <div className="mt-1.5 flex flex-wrap items-center gap-2.5">
                                  <button
                                    type="button"
                                    onClick={() => handlePlayAudio(m.id, m.text, activeLanguage)}
                                    className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-orange-600 dark:text-slate-400 dark:hover:text-amber-400"
                                  >
                                    {playingAudioKey === m.id ? (
                                      <>
                                        <VolumeX className="w-3.5 h-3.5" />
                                        Stop Audio
                                      </>
                                    ) : (
                                      <>
                                        <Volume2 className="w-3.5 h-3.5" />
                                        Listen ({playbackSpeed}x)
                                      </>
                                    )}
                                  </button>
                                  {m.meta && (
                                    <InferenceBadge
                                      source={m.meta.inferenceSource}
                                      latencyMs={m.meta.latencyMs}
                                    />
                                  )}
                                </div>
                              )}
                            </div>
                          ))
                        )}
                        {convLoading && (
                          <div className="flex items-center gap-2 text-xs text-slate-500">
                            <Loader2 className="w-3.5 h-3.5 animate-spin text-orange-600 dark:text-amber-400" />
                            <span>Nimo is responding...</span>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Right: Pronunciation Coach Drill */}
                    <div className="lg:col-span-5 bg-white dark:bg-[#161C24] border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4 h-fit">
                      <div>
                        <h2 className="text-base font-semibold font-display text-slate-900 dark:text-white">
                          Pronunciation Coach
                        </h2>
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                          Listen to the target phrase, repeat it into your microphone, and receive acoustic phonetic feedback.
                        </p>
                      </div>

                      <div className="space-y-2">
                        <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                          Target Phrase ({activeLanguage})
                        </label>
                        <textarea
                          rows={2}
                          value={drillPhrase}
                          onChange={(e) => setDrillPhrase(e.target.value)}
                          className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white"
                        />
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => handlePlayAudio('drill-phrase', drillPhrase, activeLanguage)}
                            className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
                          >
                            {playingAudioKey === 'drill-phrase' ? (
                              <VolumeX className="w-3.5 h-3.5" />
                            ) : (
                              <Volume2 className="w-3.5 h-3.5" />
                            )}
                            Hear Native Model ({playbackSpeed}x)
                          </button>

                          <button
                            type="button"
                            onClick={toggleDrillMic}
                            disabled={drillLoading || !audioSupport.micSupported}
                            className={`inline-flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
                              drillRecording
                                ? 'bg-red-600 hover:bg-red-700 text-white'
                                : 'bg-orange-600 hover:bg-orange-500 text-white disabled:opacity-40'
                            }`}
                          >
                            {drillLoading ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : drillRecording ? (
                              <Square className="w-3.5 h-3.5" />
                            ) : (
                              <Mic className="w-3.5 h-3.5" />
                            )}
                            {drillRecording ? 'Stop & Evaluate' : 'Record Attempt'}
                          </button>
                        </div>
                      </div>

                      {drillBillingRetry && lastClipForRetry && (
                        <button
                          type="button"
                          onClick={() =>
                            evaluatePronunciationClip(
                              { base64: lastClipForRetry.base64, mimeType: lastClipForRetry.mimeType },
                              lastClipForRetry.transcript,
                              true
                            )
                          }
                          className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                          Evaluate with Standard Server Model
                        </button>
                      )}

                      {pronunciationResult && (
                        <div className="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-3 text-sm">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <InferenceBadge
                              source="server_multimodal"
                              modelUsed={pronunciationResult.modelUsed}
                            />
                            <span className="font-mono tabular-nums text-sm font-semibold text-orange-600 dark:text-amber-400">
                              {pronunciationResult.accuracyScore}% match
                            </span>
                          </div>
                          <p className="text-xs text-slate-500 dark:text-slate-400">
                            Heard: &ldquo;{pronunciationResult.transcriptObserved}&rdquo;
                          </p>
                          <p className="text-slate-700 dark:text-slate-200 leading-relaxed">
                            {pronunciationResult.pronunciationFeedback}
                          </p>
                          <p className="text-xs font-mono text-slate-600 dark:text-slate-400">
                            Phonetic guide: {pronunciationResult.phoneticGuide}
                          </p>
                          {pronunciationResult.corrections?.length > 0 && (
                            <ul className="space-y-1 text-xs text-slate-600 dark:text-slate-300 list-disc pl-4">
                              {pronunciationResult.corrections.map((c, idx) => (
                                <li key={idx}>{c}</li>
                              ))}
                            </ul>
                          )}
                          <p className="text-xs text-emerald-700 dark:text-emerald-300">
                            Practice tip: {pronunciationResult.practiceTip}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Activity 2: Vocabulary Lessons */}
                {languageActivity === 'vocabulary' && (
                  <div className="space-y-5">
                    {(displayedVocab.length > 0 || vocabMeta) && (
                      <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-slate-600 dark:text-slate-400">
                        <span className="font-mono tabular-nums">
                          Mastered: {masteredVocabCount} / {displayedVocab.length} cards
                        </span>
                        {vocabMeta && (
                          <InferenceBadge
                            source={vocabMeta.inferenceSource}
                            modelUsed={vocabMeta.modelUsed}
                            latencyMs={vocabMeta.latencyMs}
                          />
                        )}
                      </div>
                    )}

                    {displayedVocab.length === 0 ? (
                      <div className="bg-white dark:bg-[#161C24] border border-slate-200 dark:border-slate-800 rounded-xl p-10 text-center text-sm text-slate-500 dark:text-slate-400">
                        Use the bottom prompt bar to enter a theme and generate a {activeLanguage} vocabulary lesson with translations, examples, and audio pronunciation.
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {displayedVocab.map((item) => (
                          <div
                            key={item.id}
                            className={`bg-white dark:bg-[#161C24] border rounded-xl p-5 flex flex-col justify-between gap-4 transition-colors ${
                              activeVocabId === item.id
                                ? 'border-orange-500'
                                : 'border-slate-200 dark:border-slate-800'
                            }`}
                          >
                            <div className="space-y-2.5">
                              <div className="flex items-start justify-between gap-2">
                                <div>
                                  <p className="text-xs text-slate-500 dark:text-slate-400">
                                    {item.language} · {item.level}
                                  </p>
                                  <h3 className="text-lg font-semibold font-display text-slate-900 dark:text-white mt-0.5">
                                    {item.term}
                                  </h3>
                                  <p className="text-xs font-mono text-slate-500 dark:text-slate-400">
                                    {item.phonetic}
                                  </p>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => handlePlayAudio(`vw-${item.id}`, item.term, item.language)}
                                  title="Hear word pronunciation"
                                  aria-label={`Play pronunciation for ${item.term}`}
                                  className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 text-orange-600 dark:text-amber-400 hover:bg-orange-50 dark:hover:bg-orange-950/40 transition-colors"
                                >
                                  {playingAudioKey === `vw-${item.id}` ? (
                                    <VolumeX className="w-4 h-4" />
                                  ) : (
                                    <Volume2 className="w-4 h-4" />
                                  )}
                                </button>
                              </div>

                              <p className="text-sm font-medium text-slate-800 dark:text-slate-200">
                                {item.translation}
                              </p>

                              <div className="pt-2 border-t border-slate-100 dark:border-slate-800 space-y-1">
                                <div className="flex items-start justify-between gap-2">
                                  <p className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed">
                                    {item.exampleSentence}
                                  </p>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      handlePlayAudio(`vs-${item.id}`, item.exampleSentence, item.language)
                                    }
                                    title="Hear example sentence"
                                    aria-label="Hear example sentence"
                                    className="p-1 text-slate-400 hover:text-orange-600 dark:hover:text-amber-400 shrink-0"
                                  >
                                    <Volume2 className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                                <p className="text-xs text-slate-500 dark:text-slate-400">
                                  {item.exampleTranslation}
                                </p>
                              </div>
                            </div>

                            <div className="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-slate-800">
                              <button
                                type="button"
                                onClick={() => {
                                  setDrillPhrase(item.term);
                                  setLanguageActivity('speaking');
                                }}
                                className="text-xs font-medium text-orange-600 dark:text-amber-400 hover:underline whitespace-nowrap"
                              >
                                Practice Speaking
                              </button>
                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => toggleVocabMastered(item)}
                                  className={`inline-flex items-center gap-1 text-xs font-medium whitespace-nowrap ${
                                    item.mastered
                                      ? 'text-emerald-600 dark:text-emerald-400'
                                      : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                                  }`}
                                >
                                  <CheckCircle2 className="w-3.5 h-3.5" />
                                  {item.mastered ? 'Mastered' : 'Mark Mastered'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => deleteVocabItem(item.id)}
                                  aria-label={`Remove ${item.term}`}
                                  className="p-1 text-slate-400 hover:text-red-600 dark:hover:text-red-400"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Activity 3: Listening Comprehension */}
                {languageActivity === 'listening' && (
                  <div className="space-y-5">
                    {!listeningExercise ? (
                      <div className="bg-white dark:bg-[#161C24] border border-slate-200 dark:border-slate-800 rounded-xl p-10 text-center text-sm text-slate-500 dark:text-slate-400">
                        Enter a scenario in the bottom prompt bar to generate a {level} {activeLanguage} listening comprehension passage and questions.
                      </div>
                    ) : (
                      <div className="bg-white dark:bg-[#161C24] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-6">
                        <div className="flex flex-wrap items-center justify-between gap-4">
                          <div className="space-y-1">
                            <h3 className="text-lg font-semibold font-display text-slate-900 dark:text-white">
                              {listeningExercise.title}
                            </h3>
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-xs text-slate-500 dark:text-slate-400">
                                Listen at {playbackSpeed}x speed before checking answers.
                              </span>
                              {listeningMeta && (
                                <InferenceBadge
                                  source={listeningMeta.inferenceSource}
                                  modelUsed={listeningMeta.modelUsed}
                                  latencyMs={listeningMeta.latencyMs}
                                />
                              )}
                            </div>
                          </div>

                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() =>
                                handlePlayAudio(
                                  'listening-passage',
                                  listeningExercise.passageText,
                                  activeLanguage
                                )
                              }
                              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-orange-600 hover:bg-orange-500 text-white transition-colors whitespace-nowrap"
                            >
                              {playingAudioKey === 'listening-passage' ? (
                                <>
                                  <VolumeX className="w-4 h-4" />
                                  Stop Audio
                                </>
                              ) : (
                                <>
                                  <Volume2 className="w-4 h-4" />
                                  Play Passage ({playbackSpeed}x)
                                </>
                              )}
                            </button>

                            <button
                              type="button"
                              onClick={() => setShowTranscript((v) => !v)}
                              className="inline-flex items-center gap-2 px-3.5 py-2 text-sm font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap"
                            >
                              {showTranscript ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                              {showTranscript ? 'Hide Transcript' : 'Show Transcript'}
                            </button>
                          </div>
                        </div>

                        {showTranscript && (
                          <div className="p-4 rounded-lg bg-slate-50 dark:bg-slate-800/70 border border-slate-200 dark:border-slate-700 text-sm text-slate-800 dark:text-slate-200 leading-relaxed">
                            {listeningExercise.passageText}
                          </div>
                        )}

                        <div className="space-y-5">
                          {listeningExercise.questions.map((q, qIdx) => (
                            <div
                              key={qIdx}
                              className="p-4 rounded-lg border border-slate-200 dark:border-slate-800 space-y-3"
                            >
                              <p className="text-sm font-medium text-slate-900 dark:text-white">
                                {qIdx + 1}. {q.question}
                              </p>
                              <div className="grid sm:grid-cols-2 gap-2">
                                {q.options.map((opt, oIdx) => {
                                  const selected = listeningAnswers[qIdx] === oIdx;
                                  const isCorrect = q.correctIndex === oIdx;
                                  let cls =
                                    'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800';
                                  if (listeningChecked) {
                                    if (isCorrect) {
                                      cls =
                                        'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-200';
                                    } else if (selected && !isCorrect) {
                                      cls =
                                        'border-red-500 bg-red-50 dark:bg-red-950/40 text-red-800 dark:text-red-200';
                                    }
                                  } else if (selected) {
                                    cls =
                                      'border-orange-500 bg-orange-50 dark:bg-orange-950/40 text-orange-800 dark:text-amber-200';
                                  }

                                  return (
                                    <button
                                      key={oIdx}
                                      type="button"
                                      disabled={listeningChecked}
                                      onClick={() =>
                                        setListeningAnswers((prev) => ({ ...prev, [qIdx]: oIdx }))
                                      }
                                      className={`text-left px-3.5 py-2 text-sm rounded-lg border transition-colors ${cls}`}
                                    >
                                      {opt}
                                    </button>
                                  );
                                })}
                              </div>
                              {listeningChecked && (
                                <p className="text-xs text-slate-600 dark:text-slate-300">
                                  {q.explanation}
                                </p>
                              )}
                            </div>
                          ))}
                        </div>

                        <div className="flex justify-end">
                          <button
                            type="button"
                            onClick={() => setListeningChecked(true)}
                            className="px-4 py-2 text-sm font-medium rounded-lg bg-orange-600 hover:bg-orange-500 text-white transition-colors"
                          >
                            Check Listening Answers
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* EXPERIENCE B: GENERAL LEARNING & QUIZ */}
            {subMode === 'general' && (
              <div className="space-y-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-200/70 dark:bg-slate-800">
                    <button
                      type="button"
                      onClick={() => setGeneralActivity('quiz')}
                      className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                        generalActivity === 'quiz'
                          ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                          : 'text-slate-600 dark:text-slate-300'
                      }`}
                    >
                      Quizzes &amp; Practice Questions
                    </button>
                    <button
                      type="button"
                      onClick={() => setGeneralActivity('notes')}
                      className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                        generalActivity === 'notes'
                          ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                          : 'text-slate-600 dark:text-slate-300'
                      }`}
                    >
                      Study Notes &amp; Step-by-Step Tutor
                    </button>
                  </div>
                </div>

                {notesError && (
                  <div className="p-4 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-sm text-red-700 dark:text-red-300 flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>{notesError}</span>
                  </div>
                )}

                {/* General Learning: Quiz Runner */}
                {generalActivity === 'quiz' && (
                  <div className="space-y-5">
                    {quizQuestions.length === 0 ? (
                      <div className="bg-white dark:bg-[#161C24] border border-slate-200 dark:border-slate-800 rounded-xl p-10 text-center space-y-2 text-sm text-slate-500 dark:text-slate-400">
                        <p className="font-medium text-slate-700 dark:text-slate-200">
                          Ready to test your knowledge
                        </p>
                        <p>
                          Enter any topic or upload study files in the prompt bar below to generate validated multiple-choice and short-answer practice questions.
                        </p>
                      </div>
                    ) : (
                      <div className="bg-white dark:bg-[#161C24] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-6">
                        <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-slate-200 dark:border-slate-800">
                          <div className="space-y-1">
                            <h2 className="text-lg font-semibold font-display text-slate-900 dark:text-white">
                              {quizTitle}
                            </h2>
                            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                              <span>
                                {quizDifficulty} · {quizQuestions.length} questions
                              </span>
                              {quizMeta && (
                                <InferenceBadge
                                  source={quizMeta.inferenceSource}
                                  modelUsed={quizMeta.modelUsed}
                                  latencyMs={quizMeta.latencyMs}
                                />
                              )}
                            </div>
                          </div>

                          {quizSubmitted && (
                            <div className="flex flex-wrap items-center gap-2.5">
                              <div className="text-sm font-semibold font-mono tabular-nums text-orange-600 dark:text-amber-400">
                                Score: {quizScore} / {quizQuestions.length}
                              </div>
                              <div className="flex items-center gap-1 p-0.5 rounded-lg bg-slate-100 dark:bg-slate-800">
                                <button
                                  type="button"
                                  onClick={() => setReviewFilter('all')}
                                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                                    reviewFilter === 'all'
                                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                                      : 'text-slate-600 dark:text-slate-300'
                                  }`}
                                >
                                  All ({quizQuestions.length})
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setReviewFilter('mistakes')}
                                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                                    reviewFilter === 'mistakes'
                                      ? 'bg-white dark:bg-slate-900 text-red-600 dark:text-red-400 shadow-xs'
                                      : 'text-slate-600 dark:text-slate-300'
                                  }`}
                                >
                                  Mistakes ({mistakeCount})
                                </button>
                              </div>
                              <button
                                type="button"
                                onClick={retrySameQuiz}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap"
                              >
                                <RotateCcw className="w-3.5 h-3.5" />
                                Retry Same Quiz
                              </button>
                            </div>
                          )}
                        </div>

                        {quizSubmitted && reviewFilter === 'mistakes' && mistakeCount === 0 ? (
                          <div className="p-6 rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50/70 dark:bg-emerald-950/30 text-center space-y-2">
                            <p className="text-sm font-medium text-emerald-800 dark:text-emerald-200">
                              Perfect score! You got every question right — no mistakes to review.
                            </p>
                            <button
                              type="button"
                              onClick={() => setReviewFilter('all')}
                              className="text-xs font-medium text-emerald-700 dark:text-emerald-300 underline"
                            >
                              Show all questions
                            </button>
                          </div>
                        ) : (
                          <div className="space-y-6">
                            {quizQuestions.map((q, idx) => {
                              const correct = quizSubmitted ? isQuestionCorrect(q) : false;
                              if (quizSubmitted && reviewFilter === 'mistakes' && correct) {
                                return null;
                              }
                              const selectedIdx = mcqSelections[q.id];
                              const hasMcqSelection = typeof selectedIdx === 'number';
                              return (
                                <div
                                  key={q.id || idx}
                                  className={`p-4 rounded-xl border space-y-3 ${
                                    quizSubmitted && !correct
                                      ? 'border-red-200 dark:border-red-900/70 bg-red-50/20 dark:bg-red-950/10'
                                      : 'border-slate-200 dark:border-slate-800'
                                  }`}
                                >
                                  <div className="flex items-start justify-between gap-3">
                                    <p className="text-sm font-medium text-slate-900 dark:text-white">
                                      {idx + 1}. {q.prompt}
                                    </p>
                                    {quizSubmitted && (
                                      <span
                                        className={`shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium ${
                                          correct
                                            ? 'bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300'
                                            : 'bg-red-100 dark:bg-red-950/60 text-red-700 dark:text-red-300'
                                        }`}
                                      >
                                        {correct ? (
                                          <>
                                            <CheckCircle2 className="w-3 h-3" />
                                            Correct
                                          </>
                                        ) : q.type === 'mcq' && !hasMcqSelection ? (
                                          'Unanswered'
                                        ) : (
                                          'Missed'
                                        )}
                                      </span>
                                    )}
                                  </div>

                                  {q.type === 'mcq' && q.options ? (
                                    <div className="grid sm:grid-cols-2 gap-2">
                                      {q.options.map((opt, oIdx) => {
                                        const selected = mcqSelections[q.id] === oIdx;
                                        const isCorrect = q.correctIndex === oIdx;
                                        let cls =
                                          'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800';
                                        if (quizSubmitted) {
                                          if (isCorrect) {
                                            cls =
                                              'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-200';
                                          } else if (selected && !isCorrect) {
                                            cls =
                                              'border-red-500 bg-red-50 dark:bg-red-950/40 text-red-800 dark:text-red-200';
                                          }
                                        } else if (selected) {
                                          cls =
                                            'border-orange-500 bg-orange-50 dark:bg-orange-950/40 text-orange-800 dark:text-amber-200';
                                        }
                                        return (
                                          <button
                                            key={oIdx}
                                            type="button"
                                            disabled={quizSubmitted}
                                            onClick={() =>
                                              setMcqSelections((prev) => ({ ...prev, [q.id]: oIdx }))
                                            }
                                            className={`text-left px-3.5 py-2 text-sm rounded-lg border transition-colors ${cls}`}
                                          >
                                            {opt}
                                          </button>
                                        );
                                      })}
                                    </div>
                                  ) : (
                                    <div className="space-y-2">
                                      <textarea
                                        rows={2}
                                        disabled={quizSubmitted}
                                        value={shortAnswers[q.id] || ''}
                                        onChange={(e) =>
                                          setShortAnswers((prev) => ({
                                            ...prev,
                                            [q.id]: e.target.value,
                                          }))
                                        }
                                        placeholder="Write your short answer..."
                                        className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white"
                                      />
                                      {quizSubmitted && shortGrades[q.id] && (
                                        <p
                                          className={`text-xs font-medium ${
                                            shortGrades[q.id].isCorrect
                                              ? 'text-emerald-600 dark:text-emerald-400'
                                              : 'text-amber-600 dark:text-amber-400'
                                          }`}
                                        >
                                          {shortGrades[q.id].isCorrect ? 'Correct' : 'Needs Review'}:{' '}
                                          {shortGrades[q.id].feedback}
                                        </p>
                                      )}
                                      {quizSubmitted && q.sampleAnswer && (
                                        <p className="text-xs text-slate-500 dark:text-slate-400">
                                          Sample answer: {q.sampleAnswer}
                                        </p>
                                      )}
                                    </div>
                                  )}

                                  {quizSubmitted && (
                                    <div className="pt-2 border-t border-slate-100 dark:border-slate-800 space-y-2">
                                      <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                                        {q.explanation}
                                      </p>
                                      <button
                                        type="button"
                                        onClick={() => explainQuestionDeeply(q)}
                                        disabled={deepExplainLoadingId === q.id}
                                        className="inline-flex items-center gap-1.5 text-xs font-medium text-orange-600 dark:text-amber-400 hover:underline"
                                      >
                                        {deepExplainLoadingId === q.id && (
                                          <Loader2 className="w-3 h-3 animate-spin" />
                                        )}
                                        Teach Step-by-Step
                                      </button>
                                      {deepExplainMap[q.id] && (
                                        <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/70 border border-slate-200 dark:border-slate-700 space-y-2">
                                          <InferenceBadge
                                            source={deepExplainMap[q.id].meta.inferenceSource}
                                            modelUsed={deepExplainMap[q.id].meta.modelUsed}
                                            latencyMs={deepExplainMap[q.id].meta.latencyMs}
                                          />
                                          <MarkdownRenderer content={deepExplainMap[q.id].text} />
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}

                        {!quizSubmitted && (
                          <div className="flex justify-end">
                            <button
                              type="button"
                              onClick={submitQuiz}
                              disabled={quizLoading}
                              className="px-5 py-2 text-sm font-medium rounded-lg bg-orange-600 hover:bg-orange-500 disabled:opacity-40 text-white transition-colors"
                            >
                              {quizLoading ? 'Grading...' : 'Submit Quiz'}
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* General Learning: Study Notes & Step-by-Step */}
                {generalActivity === 'notes' && (
                  <div className="space-y-5">
                    {!activeNote ? (
                      <div className="bg-white dark:bg-[#161C24] border border-slate-200 dark:border-slate-800 rounded-xl p-10 text-center space-y-2 text-sm text-slate-500 dark:text-slate-400">
                        <p className="font-medium text-slate-700 dark:text-slate-200">
                          Study Notes &amp; Step-by-Step Tutor
                        </p>
                        <p>
                          Enter a subject and topic in the stationary prompt bar below to generate study notes or step-by-step explanations, or pick a saved note from Learn History.
                        </p>
                      </div>
                    ) : (
                      <div className="bg-white dark:bg-[#161C24] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
                        <div className="flex flex-wrap items-start justify-between gap-3 pb-3 border-b border-slate-200 dark:border-slate-800">
                          <div className="space-y-1">
                            <h2 className="text-lg font-semibold font-display text-slate-900 dark:text-white">
                              {activeNote.title}
                            </h2>
                            {activeNote.meta && (
                              <InferenceBadge
                                source={activeNote.meta.inferenceSource}
                                modelUsed={activeNote.meta.modelUsed}
                                latencyMs={activeNote.meta.latencyMs}
                              />
                            )}
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={async () => {
                                try {
                                  await navigator.clipboard.writeText(activeNote.summaryMarkdown);
                                  setCopiedNote(true);
                                  setTimeout(() => setCopiedNote(false), 1600);
                                } catch {
                                  // ignore
                                }
                              }}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap"
                            >
                              {copiedNote ? (
                                <Check className="w-3.5 h-3.5 text-emerald-500" />
                              ) : (
                                <Copy className="w-3.5 h-3.5" />
                              )}
                              {copiedNote ? 'Copied' : 'Copy'}
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                handlePlayAudio('study-note', activeNote.summaryMarkdown, 'English')
                              }
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap"
                            >
                              {playingAudioKey === 'study-note' ? (
                                <>
                                  <VolumeX className="w-3.5 h-3.5" />
                                  Stop Reading
                                </>
                              ) : (
                                <>
                                  <Volume2 className="w-3.5 h-3.5" />
                                  Read Aloud
                                </>
                              )}
                            </button>
                          </div>
                        </div>

                        <MarkdownRenderer content={activeNote.summaryMarkdown} />

                        {/* Inline Follow-up Composer */}
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            void askNoteFollowUp();
                          }}
                          className="pt-4 border-t border-slate-100 dark:border-slate-800 flex items-center gap-2"
                        >
                          <input
                            type="text"
                            value={noteFollowUpInput}
                            onChange={(e) => setNoteFollowUpInput(e.target.value)}
                            placeholder="Ask a follow-up question about these notes..."
                            className="flex-1 px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-orange-500"
                          />
                          <button
                            type="submit"
                            disabled={noteFollowUpLoading || !noteFollowUpInput.trim()}
                            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg bg-orange-600 hover:bg-orange-500 disabled:opacity-40 text-white whitespace-nowrap"
                          >
                            {noteFollowUpLoading ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Send className="w-3.5 h-3.5" />
                            )}
                            Ask Follow-up
                          </button>
                        </form>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Stationary ChatGPT-Style Rounded Collapsible Bottom Prompt Bar */}
        {!promptBarHidden && (
          <div className="shrink-0 px-3 sm:px-6 pt-1.5 pb-[max(0.75rem,env(safe-area-inset-bottom))] bg-[#F8F9FB]/95 dark:bg-[#0F1419]/95 backdrop-blur-xs border-t border-slate-200/70 dark:border-slate-800/80">
            <div className="max-w-3xl mx-auto space-y-1.5">
              <div className="flex items-center justify-between gap-2 px-1">
                <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                  {subMode === 'language'
                    ? languageActivity === 'speaking'
                      ? `${activeLanguage} Conversation`
                      : languageActivity === 'vocabulary'
                        ? `${activeLanguage} Vocabulary`
                        : `${activeLanguage} Listening`
                    : generalActivity === 'quiz'
                      ? 'Quiz Generator'
                      : 'Study Notes & Tutor'}
                </span>
                <button
                  type="button"
                  onClick={() => setPromptBarHidden(true)}
                  aria-label="Hide prompt bar"
                  title="Hide prompt bar"
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#161C24] text-slate-700 dark:text-slate-200 hover:border-orange-300 dark:hover:border-orange-700 hover:text-orange-600 dark:hover:text-amber-400 transition-colors whitespace-nowrap shrink-0"
                >
                  <ChevronDown className="w-3.5 h-3.5" />
                  <span>Hide</span>
                </button>
              </div>

              {/* Language -> Speaking Prompt Bar */}
              {subMode === 'language' && languageActivity === 'speaking' && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void sendConversationTurn();
                  }}
                  className="rounded-2xl border border-slate-200 dark:border-slate-700/90 bg-white dark:bg-[#161C24] shadow-sm focus-within:border-orange-500 focus-within:ring-2 focus-within:ring-orange-500/20 px-3 pt-2.5 pb-2 transition-colors space-y-2"
                >
                  <AutoResizeTextarea
                    value={convInput}
                    onChange={(e) => setConvInput(e.target.value)}
                    onSubmit={() => void sendConversationTurn()}
                    maxHeightPx={150}
                    placeholder={`Reply in ${activeLanguage} (or English)...`}
                    aria-label={`Reply in ${activeLanguage}`}
                    className="w-full bg-transparent px-1 py-1 text-sm leading-relaxed text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none"
                  />

                  <div className="flex items-center justify-between gap-2 pt-1">
                    <button
                      type="button"
                      onClick={toggleConversationMic}
                      disabled={convLoading || !audioSupport.micSupported}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-xl border transition-colors whitespace-nowrap shrink-0 ${
                        convRecording
                          ? 'border-red-500 bg-red-50 dark:bg-red-950/50 text-red-600 dark:text-red-400'
                          : 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'
                      }`}
                    >
                      {convRecording ? <Square className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
                      <span className="hidden sm:inline">{convRecording ? 'Stop & Send' : 'Speak'}</span>
                    </button>

                    <button
                      type="submit"
                      disabled={convLoading || !convInput.trim()}
                      className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs sm:text-sm font-medium rounded-xl bg-orange-600 hover:bg-orange-500 disabled:opacity-40 text-white transition-colors whitespace-nowrap shrink-0 shadow-xs"
                    >
                      <Send className="w-3.5 h-3.5" />
                      <span>Send</span>
                    </button>
                  </div>
                </form>
              )}

              {/* Language -> Vocabulary Prompt Bar */}
              {subMode === 'language' && languageActivity === 'vocabulary' && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void generateVocabLesson();
                  }}
                  className="rounded-2xl border border-slate-200 dark:border-slate-700/90 bg-white dark:bg-[#161C24] shadow-sm focus-within:border-orange-500 focus-within:ring-2 focus-within:ring-orange-500/20 px-3 pt-2.5 pb-2 transition-colors space-y-2"
                >
                  <AutoResizeTextarea
                    value={vocabTopic}
                    onChange={(e) => setVocabTopic(e.target.value)}
                    onSubmit={() => void generateVocabLesson()}
                    maxHeightPx={140}
                    placeholder="Vocabulary theme (e.g. Travel, Business Meetings, Ordering Food)"
                    aria-label="Vocabulary lesson theme or topic"
                    className="w-full bg-transparent px-1 py-1 text-sm leading-relaxed text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none"
                  />

                  <div className="flex items-center justify-end gap-2 pt-1">
                    <button
                      type="submit"
                      disabled={vocabGenerating}
                      className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs sm:text-sm font-medium rounded-xl bg-orange-600 hover:bg-orange-500 disabled:opacity-40 text-white transition-colors whitespace-nowrap shrink-0 shadow-xs"
                    >
                      {vocabGenerating && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                      Generate {activeLanguage} Lesson
                    </button>
                  </div>
                </form>
              )}

              {/* Language -> Listening Prompt Bar */}
              {subMode === 'language' && languageActivity === 'listening' && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void generateListeningExercise();
                  }}
                  className="rounded-2xl border border-slate-200 dark:border-slate-700/90 bg-white dark:bg-[#161C24] shadow-sm focus-within:border-orange-500 focus-within:ring-2 focus-within:ring-orange-500/20 px-3 pt-2.5 pb-2 transition-colors space-y-2"
                >
                  <AutoResizeTextarea
                    value={listeningTopic}
                    onChange={(e) => setListeningTopic(e.target.value)}
                    onSubmit={() => void generateListeningExercise()}
                    maxHeightPx={140}
                    placeholder={`Listening scenario (${activeLanguage} · ${level})`}
                    aria-label="Listening scenario"
                    className="w-full bg-transparent px-1 py-1 text-sm leading-relaxed text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none"
                  />

                  <div className="flex items-center justify-end gap-2 pt-1">
                    <button
                      type="submit"
                      disabled={listeningLoading}
                      className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs sm:text-sm font-medium rounded-xl bg-orange-600 hover:bg-orange-500 disabled:opacity-40 text-white transition-colors whitespace-nowrap shrink-0 shadow-xs"
                    >
                      {listeningLoading ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Headphones className="w-3.5 h-3.5" />
                      )}
                      New Listening Exercise
                    </button>
                  </div>
                </form>
              )}

              {/* General -> Quiz Stationary Prompt Bar */}
              {subMode === 'general' && generalActivity === 'quiz' && (
                <>
                  {quizOptionsExpanded && (
                    <div className="p-3 rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#161C24] shadow-sm space-y-2.5">
                      <div className="grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-end">
                        <div className="sm:col-span-3">
                          <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-400 mb-1">
                            Difficulty
                          </label>
                          <select
                            value={quizDifficulty}
                            onChange={(e) => setQuizDifficulty(e.target.value as ProficiencyLevel)}
                            className="w-full px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-white"
                          >
                            {LEVELS.map((l) => (
                              <option key={l} value={l}>
                                {l}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="sm:col-span-2">
                          <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-400 mb-1">
                            Questions
                          </label>
                          <input
                            type="number"
                            min={1}
                            step={1}
                            aria-label="Number of quiz questions"
                            value={quizCount}
                            onChange={(e) => setQuizCount(e.target.value)}
                            className="w-full px-2.5 py-1.5 text-xs font-mono tabular-nums rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-white"
                          />
                        </div>
                        <div className="sm:col-span-7">
                          <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-400 mb-1">
                            Additional Instructions (Optional)
                          </label>
                          <input
                            type="text"
                            value={quizInstructions}
                            onChange={(e) => setQuizInstructions(e.target.value)}
                            placeholder="e.g. Make all questions multiple-choice, test edge cases..."
                            className="w-full px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-white"
                          />
                        </div>
                      </div>
                      {quizFiles.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {quizFiles.map((file) => (
                            <span
                              key={file.id}
                              className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-[11px] text-slate-700 dark:text-slate-200"
                            >
                              <span className="truncate max-w-[180px]">{file.name}</span>
                              <button
                                type="button"
                                aria-label={`Remove ${file.name}`}
                                onClick={() =>
                                  setQuizFiles((prev) => prev.filter((f) => f.id !== file.id))
                                }
                                className="text-slate-400 hover:text-red-500"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      generateQuiz();
                    }}
                    className="rounded-2xl border border-slate-200 dark:border-slate-700/90 bg-white dark:bg-[#161C24] shadow-sm focus-within:border-orange-500 focus-within:ring-2 focus-within:ring-orange-500/20 px-3 pt-2.5 pb-2 transition-colors space-y-2"
                  >
                    <input
                      ref={quizFileInputRef}
                      type="file"
                      multiple
                      accept=".txt,.md,.markdown,.csv,.json,.pdf,.py,.js,.ts,.tsx,.jsx,.html,.css,.xml,.yaml,.yml,.sql,.log,image/*"
                      onChange={(e) => void handleQuizFilesSelected(e.target.files)}
                      className="hidden"
                    />

                    <AutoResizeTextarea
                      value={quizTopic}
                      onChange={(e) => setQuizTopic(e.target.value)}
                      onSubmit={() => generateQuiz()}
                      maxHeightPx={140}
                      placeholder="Quiz topic (or leave blank with uploaded files)..."
                      aria-label="Quiz topic"
                      className="w-full bg-transparent px-1 py-1 text-sm leading-relaxed text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none"
                    />

                    <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => quizFileInputRef.current?.click()}
                          title="Upload study files (.txt, .md, .pdf, images)"
                          aria-label="Upload study files"
                          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-xl border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
                        >
                          <FileUp className="w-3.5 h-3.5" />
                          <span className="hidden md:inline">Files</span>
                          {quizFiles.length > 0 && (
                            <span className="font-mono tabular-nums text-[11px] text-orange-600 dark:text-amber-400">
                              ({quizFiles.length})
                            </span>
                          )}
                        </button>

                        <button
                          type="button"
                          onClick={() => setQuizOptionsExpanded((v) => !v)}
                          aria-expanded={quizOptionsExpanded}
                          title="Quiz difficulty, count, and instructions"
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-xl border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
                        >
                          {quizOptionsExpanded ? (
                            <ChevronDown className="w-3.5 h-3.5" />
                          ) : (
                            <ChevronUp className="w-3.5 h-3.5" />
                          )}
                          <span>
                            {quizDifficulty} · {quizCount || '4'}q
                          </span>
                        </button>
                      </div>

                      <button
                        type="submit"
                        disabled={quizLoading || (!quizTopic.trim() && quizFiles.length === 0)}
                        className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs sm:text-sm font-medium rounded-xl bg-orange-600 hover:bg-orange-500 disabled:opacity-40 text-white transition-colors whitespace-nowrap shrink-0 shadow-xs"
                      >
                        {quizLoading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                        Generate Quiz
                      </button>
                    </div>
                  </form>
                </>
              )}

              {/* General -> Study Notes Stationary Prompt Bar */}
              {subMode === 'general' && generalActivity === 'notes' && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void runStudyAction('study_notes');
                  }}
                  className="rounded-2xl border border-slate-200 dark:border-slate-700/90 bg-white dark:bg-[#161C24] shadow-sm focus-within:border-orange-500 focus-within:ring-2 focus-within:ring-orange-500/20 px-3 pt-2.5 pb-2 transition-colors space-y-2"
                >
                  <AutoResizeTextarea
                    value={studyTopic}
                    onChange={(e) => setStudyTopic(e.target.value)}
                    onSubmit={() => void runStudyAction('study_notes')}
                    maxHeightPx={140}
                    placeholder="Topic or concept for study notes..."
                    aria-label="Study topic or concept"
                    className="w-full bg-transparent px-1 py-1 text-sm leading-relaxed text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none"
                  />

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <input
                        type="text"
                        value={subject}
                        onChange={(e) => setSubject(e.target.value)}
                        placeholder="Subject"
                        aria-label="Study subject"
                        className="w-28 sm:w-36 px-2.5 py-1.5 text-xs rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white"
                      />
                      <select
                        value={studyDifficulty}
                        onChange={(e) => setStudyDifficulty(e.target.value as ProficiencyLevel)}
                        aria-label="Study level"
                        className="px-2.5 py-1.5 text-xs rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white"
                      >
                        {LEVELS.map((l) => (
                          <option key={l} value={l}>
                            {l}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => void runStudyAction('explain_step_by_step')}
                        disabled={notesLoading || !studyTopic.trim()}
                        className="px-3 py-1.5 text-xs font-medium rounded-xl border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0"
                      >
                        Step-by-Step
                      </button>
                      <button
                        type="submit"
                        disabled={notesLoading || !studyTopic.trim()}
                        className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs sm:text-sm font-medium rounded-xl bg-orange-600 hover:bg-orange-500 disabled:opacity-40 text-white transition-colors whitespace-nowrap shrink-0 shadow-xs"
                      >
                        {notesLoading ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <BookOpen className="w-3.5 h-3.5" />
                        )}
                        Study Notes
                      </button>
                    </div>
                  </div>
                </form>
              )}
            </div>
          </div>
        )}

        {/* Stationary Small Keyboard Restore Button when Prompt Bar is Hidden */}
        {promptBarHidden && (
          <button
            type="button"
            onClick={() => setPromptBarHidden(false)}
            aria-label="Show prompt bar"
            title="Show prompt bar"
            className="absolute bottom-[max(1rem,env(safe-area-inset-bottom))] right-4 z-30 inline-flex items-center justify-center w-9 h-9 rounded-lg bg-orange-600 hover:bg-orange-500 text-white shadow-md border border-orange-500/40 transition-transform active:scale-95"
          >
            <Keyboard className="w-4 h-4" />
          </button>
        )}
      </section>

      <LiveVoiceModal
        open={liveTutorOpen}
        onClose={() => setLiveTutorOpen(false)}
        mode="language"
        language={activeLanguage}
        level={level}
      />
    </div>
  );
}

function audioStatusNoticeText(reason?: string) {
  return reason || 'Microphone capture is unavailable in this browser.';
}
