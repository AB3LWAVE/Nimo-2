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
  CheckCircle2,
  Eye,
  EyeOff,
  GraduationCap,
  Headphones,
  Languages,
  Loader2,
  Mic,
  PhoneCall,
  RefreshCw,
  Square,
  Trash2,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../firebase';
import {
  LearnSubMode,
  ListeningExercise,
  ProficiencyLevel,
  PronunciationEvaluation,
  QuizAttempt,
  QuizQuestion,
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
import { MarkdownRenderer } from './MarkdownRenderer';
import { LiveVoiceModal } from './LiveVoiceModal';

interface LearnSessionProps {
  user: User | null;
  onRequireSignIn: () => void;
}

type LanguageActivity = 'speaking' | 'vocabulary' | 'listening';
type GeneralActivity = 'notes' | 'quiz';

const LEVELS: ProficiencyLevel[] = ['Beginner', 'Intermediate', 'Advanced'];
const SPEEDS = [0.75, 1.0, 1.25, 1.5];

function getTimestampMillis(ts: unknown): number {
  if (!ts) return 0;
  if (typeof ts === 'object' && ts !== null && 'toMillis' in ts && typeof (ts as { toMillis: () => number }).toMillis === 'function') {
    return (ts as { toMillis: () => number }).toMillis();
  }
  return 0;
}

export function LearnSession({ user, onRequireSignIn }: LearnSessionProps) {
  const [subMode, setSubMode] = useState<LearnSubMode>('language');

  // Language Learning State
  const [languageActivity, setLanguageActivity] = useState<LanguageActivity>('speaking');
  const [targetLanguage, setTargetLanguage] = useState('Spanish');
  const [customLanguage, setCustomLanguage] = useState('');
  const [level, setLevel] = useState<ProficiencyLevel>('Beginner');
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1.0);
  const [audioStatusMsg, setAudioStatusMsg] = useState<string | null>(null);
  const [ttsRetryPayload, setTtsRetryPayload] = useState<{ text: string; language: string } | null>(null);
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
    }>
  >([]);
  const [convInput, setConvInput] = useState('');
  const [convLoading, setConvLoading] = useState(false);
  const [convRecording, setConvRecording] = useState(false);

  const [drillPhrase, setDrillPhrase] = useState('Buenos días, ¿cómo estás hoy?');
  const [drillRecording, setDrillRecording] = useState(false);
  const [drillLoading, setDrillLoading] = useState(false);
  const [pronunciationResult, setPronunciationResult] = useState<PronunciationEvaluation | null>(null);
  const [lastClipForRetry, setLastClipForRetry] = useState<{
    base64: string;
    mimeType: string;
    transcript: string;
  } | null>(null);
  const [drillBillingRetry, setDrillBillingRetry] = useState(false);

  // Vocabulary State
  const [vocabTopic, setVocabTopic] = useState('Daily Greetings & Cafe');
  const [vocabGenerating, setVocabGenerating] = useState(false);
  const [savedVocab, setSavedVocab] = useState<VocabItem[]>([]);
  const [guestVocab, setGuestVocab] = useState<VocabItem[]>([]);

  // Listening State
  const [listeningTopic, setListeningTopic] = useState('Ordering lunch at a local market');
  const [listeningLoading, setListeningLoading] = useState(false);
  const [listeningExercise, setListeningExercise] = useState<ListeningExercise | null>(null);
  const [showTranscript, setShowTranscript] = useState(false);
  const [listeningAnswers, setListeningAnswers] = useState<Record<number, number>>({});
  const [listeningChecked, setListeningChecked] = useState(false);

  // General Learning & Quiz State
  const [generalActivity, setGeneralActivity] = useState<GeneralActivity>('quiz');
  const [subject, setSubject] = useState('Computer Science');
  const [studyTopic, setStudyTopic] = useState('Recursion and Dynamic Programming');
  const [studyDifficulty, setStudyDifficulty] = useState<ProficiencyLevel>('Intermediate');
  const [deepThinkingNotes, setDeepThinkingNotes] = useState(false);
  const [notesLoading, setNotesLoading] = useState(false);
  const [activeNote, setActiveNote] = useState<{ title: string; summaryMarkdown: string; modelUsed?: string } | null>(null);
  const [savedNotes, setSavedNotes] = useState<StudyNote[]>([]);
  const [notesError, setNotesError] = useState<{ message: string; canRetryStandard?: boolean; action?: 'study_notes' | 'explain_step_by_step' } | null>(null);

  // Quiz State
  const [quizTopic, setQuizTopic] = useState('Cellular Respiration & ATP');
  const [quizDifficulty, setQuizDifficulty] = useState<ProficiencyLevel>('Intermediate');
  const [quizCount, setQuizCount] = useState(4);
  const [quizLoading, setQuizLoading] = useState(false);
  const [quizTitle, setQuizTitle] = useState('');
  const [quizQuestions, setQuizQuestions] = useState<QuizQuestion[]>([]);
  const [mcqSelections, setMcqSelections] = useState<Record<string, number>>({});
  const [shortAnswers, setShortAnswers] = useState<Record<string, string>>({});
  const [shortGrades, setShortGrades] = useState<Record<string, { isCorrect: boolean; feedback: string }>>({});
  const [quizSubmitted, setQuizSubmitted] = useState(false);
  const [quizScore, setQuizScore] = useState<number>(0);
  const [quizAttempts, setQuizAttempts] = useState<QuizAttempt[]>([]);
  const [deepExplainMap, setDeepExplainMap] = useState<Record<string, string>>({});
  const [deepExplainLoadingId, setDeepExplainLoadingId] = useState<string | null>(null);

  const activeRecordingRef = useRef<ActiveRecording | null>(null);
  const audioSupport = checkAudioSupport();

  const activeLanguage =
    targetLanguage === '__custom__' ? customLanguage.trim() || 'Spanish' : targetLanguage;

  // Sync Firestore Vocab, StudyNotes, QuizAttempts
  useEffect(() => {
    if (!user) {
      setSavedVocab([]);
      setSavedNotes([]);
      setQuizAttempts([]);
      return;
    }

    const unsubVocab = onSnapshot(
      query(collection(db, 'vocabItems'), where('ownerId', '==', user.uid)),
      (snap) => {
        const list = snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as Omit<VocabItem, 'id'>) }))
          .sort((a, b) => getTimestampMillis(b.createdAt) - getTimestampMillis(a.createdAt));
        setSavedVocab(list);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'vocabItems')
    );

    const unsubNotes = onSnapshot(
      query(collection(db, 'studyNotes'), where('ownerId', '==', user.uid)),
      (snap) => {
        const list = snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as Omit<StudyNote, 'id'>) }))
          .sort((a, b) => getTimestampMillis(b.createdAt) - getTimestampMillis(a.createdAt));
        setSavedNotes(list);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'studyNotes')
    );

    const unsubQuizzes = onSnapshot(
      query(collection(db, 'quizAttempts'), where('ownerId', '==', user.uid)),
      (snap) => {
        const list = snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as Omit<QuizAttempt, 'id'>) }))
          .sort((a, b) => getTimestampMillis(b.createdAt) - getTimestampMillis(a.createdAt));
        setQuizAttempts(list);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'quizAttempts')
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
      const msg = err instanceof Error ? err.message : 'Unable to play audio.';
      setAudioStatusMsg(msg);
      setTtsRetryPayload({ text, language: lang });
    }
  };

  // Speaking Practice: Conversational Turn
  const sendConversationTurn = async (textToSend?: string) => {
    const message = (textToSend ?? convInput).trim();
    if (!message) return;
    setAudioStatusMsg(null);
    if (!textToSend) setConvInput('');

    const userMsgId = `u-${Date.now()}`;
    const updatedHistory = [...convHistory, { id: userMsgId, role: 'user' as const, text: message }];
    setConvHistory(updatedHistory);
    setConvLoading(true);

    try {
      const res = await fetch('/api/learn/language', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'conversation',
          targetLanguage: activeLanguage,
          level,
          history: updatedHistory.map((m) => ({ role: m.role, content: m.text })),
          userMessage: message,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || 'Tutor request failed.');

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
        },
      ]);

      handlePlayAudio(assistantId, combinedReply, activeLanguage);
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
        const { transcript } = await transcribeAudioClip(clip.base64, clip.mimeType, activeLanguage);
        if (!transcript) {
          setAudioStatusMsg('No speech detected. Speak clearly and try again.');
          setConvLoading(false);
          return;
        }
        await sendConversationTurn(transcript);
      } catch (err) {
        setAudioStatusMsg(err instanceof Error ? err.message : 'Voice transcription failed.');
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

  // Pronunciation Coach Drill
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
        const { transcript } = await transcribeAudioClip(clip.base64, clip.mimeType, activeLanguage);
        const saved = { base64: clip.base64, mimeType: clip.mimeType, transcript };
        setLastClipForRetry(saved);
        await evaluatePronunciationClip({ base64: clip.base64, mimeType: clip.mimeType }, transcript, false);
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

  // Vocabulary Generation
  const generateVocabLesson = async () => {
    setAudioStatusMsg(null);
    setVocabGenerating(true);
    try {
      const res = await fetch('/api/learn/language', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'vocab',
          targetLanguage: activeLanguage,
          level,
          topic: vocabTopic || 'Daily Essentials',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || 'Failed to generate vocabulary.');

      const items = (data.items || []) as Array<{
        term: string;
        translation: string;
        phonetic: string;
        exampleSentence: string;
        exampleTranslation: string;
      }>;

      if (user) {
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
      if (user && err instanceof Error && err.message.includes('Missing or insufficient permissions')) {
        handleFirestoreError(err, OperationType.CREATE, 'vocabItems');
      }
      setAudioStatusMsg(err instanceof Error ? err.message : 'Vocabulary generation failed.');
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

  // Listening Comprehension
  const generateListeningExercise = async () => {
    setAudioStatusMsg(null);
    setListeningLoading(true);
    setShowTranscript(false);
    setListeningAnswers({});
    setListeningChecked(false);
    try {
      const res = await fetch('/api/learn/language', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'listening',
          targetLanguage: activeLanguage,
          level,
          topic: listeningTopic || 'Everyday dialogue',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || 'Failed to generate listening exercise.');
      setListeningExercise(data.exercise);
    } catch (err) {
      setAudioStatusMsg(err instanceof Error ? err.message : 'Listening exercise failed.');
    } finally {
      setListeningLoading(false);
    }
  };

  // General Learning: Study Notes & Step-by-Step
  const runStudyAction = async (
    action: 'study_notes' | 'explain_step_by_step',
    fallbackToStandard = false
  ) => {
    if (!studyTopic.trim()) return;
    setNotesError(null);
    setNotesLoading(true);
    try {
      const res = await fetch('/api/learn/general', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          subject,
          topic: studyTopic,
          difficulty: studyDifficulty,
          deepMode: deepThinkingNotes,
          fallbackToStandard,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setNotesError({
          message: data.message || data.error || 'Failed to generate learning material.',
          canRetryStandard: Boolean(data.isBillingRequired),
          action,
        });
        return;
      }

      const title = data.title || `${subject}: ${studyTopic}`;
      const summaryMarkdown = (data.summaryMarkdown || data.explanation || '').slice(0, 25000);
      setActiveNote({ title, summaryMarkdown, modelUsed: data.modelUsed });

      if (user && summaryMarkdown) {
        try {
          await addDoc(collection(db, 'studyNotes'), {
            ownerId: user.uid,
            subject: subject.slice(0, 80),
            title: title.slice(0, 160),
            summaryMarkdown,
            createdAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.CREATE, 'studyNotes');
        }
      }
    } catch (err) {
      setNotesError({
        message: err instanceof Error ? err.message : 'Network error generating study notes.',
      });
    } finally {
      setNotesLoading(false);
    }
  };

  // General Learning: Quiz Generator & Grader
  const generateQuiz = async () => {
    if (!quizTopic.trim()) return;
    setNotesError(null);
    setQuizLoading(true);
    setQuizSubmitted(false);
    setMcqSelections({});
    setShortAnswers({});
    setShortGrades({});
    setDeepExplainMap({});
    try {
      const res = await fetch('/api/learn/general', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'generate_quiz',
          subject,
          topic: quizTopic,
          difficulty: quizDifficulty,
          questionCount: quizCount,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || 'Failed to create quiz.');
      setQuizTitle(data.title || quizTopic);
      setQuizQuestions(data.questions || []);
    } catch (err) {
      setNotesError({ message: err instanceof Error ? err.message : 'Quiz error.' });
    } finally {
      setQuizLoading(false);
    }
  };

  const submitQuiz = async () => {
    setQuizLoading(true);
    let score = 0;
    const updatedShortGrades: Record<string, { isCorrect: boolean; feedback: string }> = {};

    try {
      for (const q of quizQuestions) {
        if (q.type === 'mcq') {
          if (mcqSelections[q.id] === q.correctIndex) {
            score += 1;
          }
        } else {
          const ans = (shortAnswers[q.id] || '').trim();
          if (ans) {
            const res = await fetch('/api/learn/general', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'grade_short_answer',
                questionPrompt: q.prompt,
                sampleAnswer: q.sampleAnswer || q.explanation,
                userAnswer: ans,
              }),
            });
            const grade = await res.json();
            if (res.ok) {
              updatedShortGrades[q.id] = grade;
              if (grade.isCorrect) score += 1;
            }
          } else {
            updatedShortGrades[q.id] = { isCorrect: false, feedback: 'No answer entered.' };
          }
        }
      }

      setShortGrades(updatedShortGrades);
      setQuizScore(score);
      setQuizSubmitted(true);

      if (user && quizQuestions.length > 0) {
        try {
          await addDoc(collection(db, 'quizAttempts'), {
            ownerId: user.uid,
            topic: (quizTitle || quizTopic).slice(0, 140),
            difficulty: quizDifficulty,
            score,
            totalQuestions: quizQuestions.length,
            summaryText: `Scored ${score}/${quizQuestions.length} on ${quizTitle || quizTopic}`.slice(0, 4000),
            createdAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.CREATE, 'quizAttempts');
        }
      }
    } finally {
      setQuizLoading(false);
    }
  };

  const explainQuestionDeeply = async (q: QuizQuestion, fallbackToStandard = false) => {
    setDeepExplainLoadingId(q.id);
    setNotesError(null);
    try {
      const res = await fetch('/api/learn/general', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'explain_step_by_step',
          subject,
          difficulty: quizDifficulty,
          topic: `${q.prompt}\nExpected concept: ${q.explanation}`,
          fallbackToStandard,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setNotesError({
          message: data.message || data.error || 'Could not load deep explanation.',
          canRetryStandard: Boolean(data.isBillingRequired),
        });
        return;
      }
      setDeepExplainMap((prev) => ({ ...prev, [q.id]: data.explanation }));
    } finally {
      setDeepExplainLoadingId(null);
    }
  };

  const displayedVocab = user ? savedVocab : guestVocab;

  return (
    <div className="flex-1 bg-slate-50 dark:bg-slate-950">
      <div className="max-w-7xl mx-auto px-4 sm:px-8 py-6 space-y-6">
        {/* Learn Section Header + Internal Mode Switcher */}
        <div className="flex flex-wrap items-center justify-between gap-4 pb-5 border-b border-slate-200 dark:border-slate-800">
          <div className="space-y-1">
            <h1 className="text-2xl font-bold font-display text-slate-900 dark:text-white">
              Learn &amp; Quiz Studio
            </h1>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Interactive audio language tutoring alongside structured study notes and adaptive quizzes.
            </p>
          </div>

          <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-200/70 dark:bg-slate-800">
            <button
              type="button"
              onClick={() => setSubMode('language')}
              className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                subMode === 'language'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <Languages className="w-4 h-4" />
              Language Learning
            </button>
            <button
              type="button"
              onClick={() => setSubMode('general')}
              className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                subMode === 'general'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <GraduationCap className="w-4 h-4" />
              General Learning &amp; Quiz
            </button>
          </div>
        </div>

        {/* EXPERIENCE A: LANGUAGE LEARNING */}
        {subMode === 'language' && (
          <div className="space-y-6">
            {/* Controls Deck */}
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4">
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
                  <div className="grid grid-cols-3 gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800">
                    {LEVELS.map((lvl) => (
                      <button
                        key={lvl}
                        type="button"
                        onClick={() => setLevel(lvl)}
                        className={`px-2 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                          level === lvl
                            ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                            : 'text-slate-600 dark:text-slate-300'
                        }`}
                      >
                        {lvl}
                      </button>
                    ))}
                  </div>
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
                    className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-sky-600 hover:bg-sky-700 text-white transition-colors whitespace-nowrap"
                  >
                    <PhoneCall className="w-4 h-4" />
                    Live Voice Tutor
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-100 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400">
                <span>
                  {activeLanguage} · {level} · {playbackSpeed.toFixed(2).replace(/\.00$/, '.0')}x audio speed · Speech via Gemini TTS/STT &amp; Web Audio APIs; vocabulary synced to Firestore
                </span>
                <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800">
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
                <span>{audioStatusMsg || audioStatusNoticeText(audioSupport.reason)}</span>
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
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                {/* Left: Conversational Speaking Practice */}
                <div className="lg:col-span-7 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl flex flex-col min-h-[460px]">
                  <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                    <div>
                      <h2 className="text-base font-semibold font-display text-slate-900 dark:text-white">
                        Conversational Practice with Nimo
                      </h2>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        Speak via microphone or type in {activeLanguage}. Nimo replies aloud with corrections.
                      </p>
                    </div>
                  </div>

                  <div className="flex-1 overflow-y-auto p-5 space-y-4">
                    {convHistory.length === 0 ? (
                      <div className="py-10 text-center space-y-3">
                        <p className="text-sm text-slate-600 dark:text-slate-400">
                          Click the microphone to say hello in {activeLanguage}, or try a starter line.
                        </p>
                        <button
                          type="button"
                          onClick={() =>
                            sendConversationTurn(
                              `Hola Nimo! Let's practice ${level} ${activeLanguage} conversation.`
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
                                ? 'bg-sky-600 text-white'
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
                            <button
                              type="button"
                              onClick={() => handlePlayAudio(m.id, m.text, activeLanguage)}
                              className="mt-1 inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-sky-600 dark:text-slate-400 dark:hover:text-sky-400"
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
                          )}
                        </div>
                      ))
                    )}
                    {convLoading && (
                      <div className="flex items-center gap-2 text-xs text-slate-500">
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-600" />
                        <span>Nimo is responding...</span>
                      </div>
                    )}
                  </div>

                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      sendConversationTurn();
                    }}
                    className="p-4 border-t border-slate-200 dark:border-slate-800 flex items-center gap-2"
                  >
                    <button
                      type="button"
                      onClick={toggleConversationMic}
                      disabled={convLoading || !audioSupport.micSupported}
                      className={`inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
                        convRecording
                          ? 'border-red-500 bg-red-50 dark:bg-red-950/50 text-red-600 dark:text-red-400'
                          : 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'
                      }`}
                    >
                      {convRecording ? <Square className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
                      {convRecording ? 'Stop & Send' : 'Speak'}
                    </button>

                    <input
                      type="text"
                      value={convInput}
                      onChange={(e) => setConvInput(e.target.value)}
                      placeholder={`Reply in ${activeLanguage}...`}
                      className="flex-1 px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white"
                    />

                    <button
                      type="submit"
                      disabled={convLoading || !convInput.trim()}
                      className="px-4 py-2 text-sm font-medium rounded-lg bg-sky-600 hover:bg-sky-700 disabled:opacity-40 text-white transition-colors whitespace-nowrap"
                    >
                      Send
                    </button>
                  </form>
                </div>

                {/* Right: Pronunciation Coach Drill */}
                <div className="lg:col-span-5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4">
                  <div>
                    <h2 className="text-base font-semibold font-display text-slate-900 dark:text-white">
                      Pronunciation Coach
                    </h2>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      Listen to the target phrase, repeat it into your microphone, and receive phonetic feedback.
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
                            : 'bg-sky-600 hover:bg-sky-700 text-white'
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
                      Evaluate with Standard Model (gemini-4-hydrogen)
                    </button>
                  )}

                  {pronunciationResult && (
                    <div className="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-3 text-sm">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-slate-500 dark:text-slate-400">
                          Heard: &ldquo;{pronunciationResult.transcriptObserved}&rdquo;
                        </span>
                        <span className="font-mono tabular-nums text-sm font-semibold text-sky-700 dark:text-sky-300">
                          {pronunciationResult.accuracyScore}% match
                        </span>
                      </div>
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
                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 flex flex-wrap items-end gap-3">
                  <div className="flex-1 min-w-[220px]">
                    <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                      Lesson Theme or Topic
                    </label>
                    <input
                      type="text"
                      value={vocabTopic}
                      onChange={(e) => setVocabTopic(e.target.value)}
                      placeholder="e.g. Travel, Business Meetings, Ordering Food"
                      className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={generateVocabLesson}
                    disabled={vocabGenerating}
                    className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-sky-600 hover:bg-sky-700 disabled:opacity-40 text-white transition-colors whitespace-nowrap"
                  >
                    {vocabGenerating && <Loader2 className="w-4 h-4 animate-spin" />}
                    Generate {activeLanguage} Lesson
                  </button>
                  {!user && (
                    <button
                      type="button"
                      onClick={onRequireSignIn}
                      className="px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap"
                    >
                      Sign in to Save Deck
                    </button>
                  )}
                </div>

                {displayedVocab.length === 0 ? (
                  <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-10 text-center text-sm text-slate-500 dark:text-slate-400">
                    Generate a {activeLanguage} vocabulary lesson above to practice words, translations, contextual examples, and audio pronunciation.
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {displayedVocab.map((item) => (
                      <div
                        key={item.id}
                        className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 flex flex-col justify-between gap-4"
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
                              className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 text-sky-600 dark:text-sky-400 hover:bg-sky-50 dark:hover:bg-sky-950/50 transition-colors"
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
                                className="p-1 text-slate-400 hover:text-sky-600 dark:hover:text-sky-400 shrink-0"
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
                            className="text-xs font-medium text-sky-600 dark:text-sky-400 hover:underline whitespace-nowrap"
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
                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 flex flex-wrap items-end gap-3">
                  <div className="flex-1 min-w-[220px]">
                    <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                      Listening Scenario ({activeLanguage} · {level})
                    </label>
                    <input
                      type="text"
                      value={listeningTopic}
                      onChange={(e) => setListeningTopic(e.target.value)}
                      className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={generateListeningExercise}
                    disabled={listeningLoading}
                    className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-sky-600 hover:bg-sky-700 disabled:opacity-40 text-white transition-colors whitespace-nowrap"
                  >
                    {listeningLoading ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Headphones className="w-4 h-4" />
                    )}
                    New Listening Exercise
                  </button>
                </div>

                {listeningExercise && (
                  <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-6">
                    <div className="flex flex-wrap items-center justify-between gap-4">
                      <div>
                        <h3 className="text-lg font-semibold font-display text-slate-900 dark:text-white">
                          {listeningExercise.title}
                        </h3>
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                          Listen at {playbackSpeed}x speed before checking comprehension questions.
                        </p>
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            handlePlayAudio('listening-passage', listeningExercise.passageText, activeLanguage)
                          }
                          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-sky-600 hover:bg-sky-700 text-white transition-colors whitespace-nowrap"
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
                                  'border-sky-600 bg-sky-50 dark:bg-sky-950/40 text-sky-800 dark:text-sky-200';
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
                        className="px-4 py-2 text-sm font-medium rounded-lg bg-sky-600 hover:bg-sky-700 text-white transition-colors"
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
          <div className="space-y-6">
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
              <div className="p-4 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-sm text-red-700 dark:text-red-300 space-y-2">
                <div className="flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{notesError.message}</span>
                </div>
                {notesError.canRetryStandard && notesError.action && (
                  <button
                    type="button"
                    onClick={() => runStudyAction(notesError.action!, true)}
                    className="px-3 py-1.5 text-xs font-medium rounded-lg bg-white dark:bg-slate-900 border border-red-300 dark:border-red-800 text-slate-900 dark:text-white"
                  >
                    Retry with Standard Model (gemini-4-hydrogen)
                  </button>
                )}
              </div>
            )}

            {/* General Learning: Quiz Runner */}
            {generalActivity === 'quiz' && (
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                <div className="lg:col-span-8 space-y-5">
                  <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
                    <div className="sm:col-span-2">
                      <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                        Quiz Topic
                      </label>
                      <input
                        type="text"
                        value={quizTopic}
                        onChange={(e) => setQuizTopic(e.target.value)}
                        placeholder="e.g. Linear Algebra, World War II, Python Lists"
                        className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                        Difficulty &amp; Count
                      </label>
                      <div className="flex gap-1.5">
                        <select
                          value={quizDifficulty}
                          onChange={(e) => setQuizDifficulty(e.target.value as ProficiencyLevel)}
                          className="flex-1 px-2 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white"
                        >
                          {LEVELS.map((l) => (
                            <option key={l} value={l}>
                              {l}
                            </option>
                          ))}
                        </select>
                        <select
                          value={quizCount}
                          onChange={(e) => setQuizCount(Number(e.target.value))}
                          className="w-16 px-2 py-2 text-xs font-mono tabular-nums rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white"
                        >
                          <option value={3}>3 Q</option>
                          <option value={4}>4 Q</option>
                          <option value={6}>6 Q</option>
                          <option value={8}>8 Q</option>
                        </select>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={generateQuiz}
                      disabled={quizLoading}
                      className="inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-sky-600 hover:bg-sky-700 disabled:opacity-40 text-white transition-colors whitespace-nowrap"
                    >
                      {quizLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                      Generate Quiz
                    </button>
                  </div>

                  {quizQuestions.length === 0 ? (
                    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-10 text-center text-sm text-slate-500 dark:text-slate-400">
                      Choose any topic and difficulty above to generate interactive multiple-choice and short-answer practice questions.
                    </div>
                  ) : (
                    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-6">
                      <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-slate-200 dark:border-slate-800">
                        <div>
                          <h2 className="text-lg font-semibold font-display text-slate-900 dark:text-white">
                            {quizTitle}
                          </h2>
                          <p className="text-xs text-slate-500 dark:text-slate-400">
                            {quizDifficulty} · {quizQuestions.length} questions
                          </p>
                        </div>
                        {quizSubmitted && (
                          <div className="text-sm font-semibold font-mono tabular-nums text-sky-700 dark:text-sky-300">
                            Score: {quizScore} / {quizQuestions.length}
                          </div>
                        )}
                      </div>

                      <div className="space-y-6">
                        {quizQuestions.map((q, idx) => (
                          <div
                            key={q.id || idx}
                            className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 space-y-3"
                          >
                            <p className="text-sm font-medium text-slate-900 dark:text-white">
                              {idx + 1}. {q.prompt}
                            </p>

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
                                      'border-sky-600 bg-sky-50 dark:bg-sky-950/40 text-sky-800 dark:text-sky-200';
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
                                    setShortAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))
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
                                  className="inline-flex items-center gap-1.5 text-xs font-medium text-sky-600 dark:text-sky-400 hover:underline"
                                >
                                  {deepExplainLoadingId === q.id && (
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                  )}
                                  Teach Step-by-Step (Deep Thinking)
                                </button>
                                {deepExplainMap[q.id] && (
                                  <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/70 border border-slate-200 dark:border-slate-700">
                                    <MarkdownRenderer content={deepExplainMap[q.id]} />
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>

                      {!quizSubmitted && (
                        <div className="flex justify-end">
                          <button
                            type="button"
                            onClick={submitQuiz}
                            disabled={quizLoading}
                            className="px-5 py-2 text-sm font-medium rounded-lg bg-sky-600 hover:bg-sky-700 disabled:opacity-40 text-white transition-colors"
                          >
                            {quizLoading ? 'Grading...' : 'Submit Quiz'}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Recent Quiz Attempts Sidebar */}
                <aside className="lg:col-span-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4 h-fit">
                  <h3 className="text-base font-semibold font-display text-slate-900 dark:text-white">
                    Quiz History
                  </h3>
                  {!user ? (
                    <div className="space-y-2.5 text-xs text-slate-600 dark:text-slate-400">
                      <p>Sign in with Google to save your quiz scores and review history.</p>
                      <button
                        type="button"
                        onClick={onRequireSignIn}
                        className="px-3 py-1.5 font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800"
                      >
                        Sign in with Google
                      </button>
                    </div>
                  ) : quizAttempts.length === 0 ? (
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      No completed quizzes yet. Submit a quiz to record your progress.
                    </p>
                  ) : (
                    <div className="divide-y divide-slate-100 dark:divide-slate-800">
                      {quizAttempts.map((att) => (
                        <div key={att.id} className="py-3 flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-slate-800 dark:text-slate-200 truncate">
                              {att.topic}
                            </p>
                            <p className="text-xs text-slate-500 dark:text-slate-400">
                              {att.difficulty}
                            </p>
                          </div>
                          <span className="font-mono tabular-nums text-sm font-semibold text-sky-600 dark:text-sky-400 shrink-0">
                            {att.score}/{att.totalQuestions}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </aside>
              </div>
            )}

            {/* General Learning: Study Notes & Step-by-Step */}
            {generalActivity === 'notes' && (
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                <div className="lg:col-span-8 space-y-5">
                  <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4">
                    <div className="grid sm:grid-cols-3 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                          Subject
                        </label>
                        <input
                          type="text"
                          value={subject}
                          onChange={(e) => setSubject(e.target.value)}
                          className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                          Topic or Concept
                        </label>
                        <input
                          type="text"
                          value={studyTopic}
                          onChange={(e) => setStudyTopic(e.target.value)}
                          className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                          Level
                        </label>
                        <select
                          value={studyDifficulty}
                          onChange={(e) => setStudyDifficulty(e.target.value as ProficiencyLevel)}
                          className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white"
                        >
                          {LEVELS.map((l) => (
                            <option key={l} value={l}>
                              {l}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <label className="inline-flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={deepThinkingNotes}
                          onChange={(e) => setDeepThinkingNotes(e.target.checked)}
                          className="rounded border-slate-300 text-sky-600 focus:ring-sky-500"
                        />
                        Use Deep Thinking (gemini-4-carbon)
                      </label>

                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => runStudyAction('study_notes')}
                          disabled={notesLoading}
                          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-sky-600 hover:bg-sky-700 disabled:opacity-40 text-white transition-colors whitespace-nowrap"
                        >
                          {notesLoading ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <BookOpen className="w-4 h-4" />
                          )}
                          Generate Study Notes
                        </button>
                        <button
                          type="button"
                          onClick={() => runStudyAction('explain_step_by_step')}
                          disabled={notesLoading}
                          className="px-4 py-2 text-sm font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
                        >
                          Teach Step-by-Step
                        </button>
                      </div>
                    </div>
                  </div>

                  {activeNote && (
                    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
                      <div className="flex items-start justify-between gap-3 pb-3 border-b border-slate-200 dark:border-slate-800">
                        <div>
                          <h2 className="text-lg font-semibold font-display text-slate-900 dark:text-white">
                            {activeNote.title}
                          </h2>
                          {activeNote.modelUsed && (
                            <p className="text-xs font-mono text-slate-500 dark:text-slate-400">
                              {activeNote.modelUsed}
                            </p>
                          )}
                        </div>
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
                      <MarkdownRenderer content={activeNote.summaryMarkdown} />
                    </div>
                  )}
                </div>

                {/* Saved Study Notes Sidebar */}
                <aside className="lg:col-span-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4 h-fit">
                  <h3 className="text-base font-semibold font-display text-slate-900 dark:text-white">
                    Saved Study Notes
                  </h3>
                  {!user ? (
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      Sign in with Google to save generated notes and summaries.
                    </p>
                  ) : savedNotes.length === 0 ? (
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      Your saved study guides will appear here.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {savedNotes.map((note) => (
                        <div
                          key={note.id}
                          className="flex items-center justify-between gap-2 p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60"
                        >
                          <button
                            type="button"
                            onClick={() =>
                              setActiveNote({
                                title: note.title,
                                summaryMarkdown: note.summaryMarkdown,
                              })
                            }
                            className="flex-1 text-left min-w-0"
                          >
                            <p className="text-sm font-medium text-slate-800 dark:text-slate-200 truncate">
                              {note.title}
                            </p>
                            <p className="text-xs text-slate-500 dark:text-slate-400">{note.subject}</p>
                          </button>
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                await deleteDoc(doc(db, 'studyNotes', note.id));
                              } catch (err) {
                                handleFirestoreError(err, OperationType.DELETE, `studyNotes/${note.id}`);
                              }
                            }}
                            aria-label={`Delete ${note.title}`}
                            className="p-1 text-slate-400 hover:text-red-600"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </aside>
              </div>
            )}
          </div>
        )}
      </div>

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
