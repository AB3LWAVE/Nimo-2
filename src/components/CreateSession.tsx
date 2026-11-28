import React, { useEffect, useRef, useState } from 'react';
import { User } from 'firebase/auth';
import {
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
  AlertCircle,
  Check,
  ChevronDown,
  Code2,
  Copy,
  FileEdit,
  History,
  ImagePlus,
  Keyboard,
  Lightbulb,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  Save,
  Send,
  Sparkles,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../firebase';
import { generateHybridText } from '../services/hybridAi';
import {
  CodeSnippet,
  CreateDraft,
  CreateDraftCategory,
  CreateSubMode,
  HybridInferenceSource,
  InferenceModePreference,
} from '../types';
import {
  ACTION_SUGGESTIONS,
  TONE_SUGGESTIONS,
  buildWritingStudioPrompt,
} from '../utils/createCombobox';
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
import { MarkdownRenderer } from './MarkdownRenderer';
import { SearchableCombobox } from './SearchableCombobox';

interface CreateSessionProps {
  user: User | null;
  onRequireSignIn: () => void;
  inferenceMode: InferenceModePreference;
}

const STARTER_SNIPPETS: Record<string, { title: string; code: string }> = {
  javascript: {
    title: 'Binary Search Utility',
    code: `function binarySearch(sortedArr, target) {
  let left = 0;
  let right = sortedArr.length - 1;

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    if (sortedArr[mid] === target) return mid;
    if (sortedArr[mid] < target) left = mid + 1;
    else right = mid - 1;
  }
  return -1;
}

const nums = [3, 8, 14, 21, 34, 55, 89];
console.log("Index of 34:", binarySearch(nums, 34));
console.log("Index of 10:", binarySearch(nums, 10));`,
  },
  html: {
    title: 'Responsive Pricing Card',
    code: `<style>
  body { font-family: system-ui, sans-serif; padding: 24px; background: #f8f9fb; color: #0f172a; }
  .card { max-width: 340px; background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px; }
  .price { font-size: 2rem; font-weight: 700; margin: 8px 0; }
  button { background: #ea580c; color: #fff; border: 0; border-radius: 8px; padding: 10px 16px; cursor: pointer; }
</style>
<div class="card">
  <h3>Studio Membership</h3>
  <div class="price">$18 / month</div>
  <p>Full access to live audio tutoring and coding sandboxes.</p>
  <button onclick="document.querySelector('p').textContent = 'Membership selected!'">Select Plan</button>
</div>`,
  },
  typescript: {
    title: 'Typed Result Helper',
    code: `type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

function divide(a: number, b: number): Result<number, string> {
  if (b === 0) return { ok: false, error: "Division by zero" };
  return { ok: true, value: a / b };
}

console.log(divide(42, 6));`,
  },
  python: {
    title: 'Fibonacci Memoization',
    code: `from functools import lru_cache

@lru_cache(maxsize=None)
def fib(n: int) -> int:
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)

print([fib(i) for i in range(10)])`,
  },
  sql: {
    title: 'Top Learners Query',
    code: `SELECT
  learner_id,
  COUNT(*) AS completed_quizzes,
  ROUND(AVG(score * 100.0 / total_questions), 1) AS avg_percent
FROM quiz_attempts
GROUP BY learner_id
HAVING COUNT(*) >= 3
ORDER BY avg_percent DESC;`,
  },
};

function formatHistoryDate(ts: unknown): string {
  const millis = getTimestampMillis(ts);
  if (!millis) return '';
  return new Date(millis).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

function extractFirstCodeBlock(markdown: string): string | null {
  const match = markdown.match(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/);
  return match ? match[1].trimEnd() : null;
}

function formatValue(val: unknown): string {
  if (typeof val === 'string') return val;
  try {
    return JSON.stringify(val);
  } catch {
    return String(val);
  }
}

export function CreateSession({
  user,
  onRequireSignIn,
  inferenceMode,
}: CreateSessionProps) {
  const [initialCreateDraft] = useState(() =>
    readDraft(DRAFT_STORAGE_KEYS.create, {
      subMode: 'write' as CreateSubMode,
      draftTitle: 'Hybrid AI Launch Brief',
      draftPrompt:
        'Draft a crisp 1-page product launch announcement explaining how local on-device AI plus cloud fallback improves privacy and speed.',
      draftContent: '',
      draftCategory: 'writing' as CreateDraftCategory,
      writeTone: 'professional',
      writeAction: 'generate',
      planTopic: 'Weekend Hackathon Demo & QA Checklist',
      planType: 'plan' as 'brainstorm' | 'plan',
      planConstraints:
        '3-person team, 48 hours, focus on hybrid AI reliability and security testing.',
      codeTitle: STARTER_SNIPPETS.javascript.title,
      language: 'javascript',
      code: STARTER_SNIPPETS.javascript.code,
      mentorPrompt: '',
    })
  );

  const [subMode, setSubMode] = useState<CreateSubMode>(() =>
    initialCreateDraft.subMode === 'write' ||
    initialCreateDraft.subMode === 'brainstorm' ||
    initialCreateDraft.subMode === 'code'
      ? initialCreateDraft.subMode
      : 'write'
  );
  const [promptBarHidden, setPromptBarHidden] = useState(false);

  // History Notice Board visibility & filter
  const [desktopHistoryOpen, setDesktopHistoryOpen] = useState(true);
  const [mobileHistoryOpen, setMobileHistoryOpen] = useState(false);
  const [historyFilter, setHistoryFilter] = useState<'all' | 'drafts' | 'code'>('all');
  const [createLoadedFlags, setCreateLoadedFlags] = useState(() => ({
    snippets: !user,
    drafts: !user,
  }));
  const activeHistoryItemRef = useRef<HTMLButtonElement | null>(null);
  const createHistoryScrollRef = useRef<HTMLDivElement | null>(null);
  const justCreatedCreateRef = useRef(false);

  // Shared Create Drafts from Firestore
  const [drafts, setDrafts] = useState<CreateDraft[]>([]);
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState(() => initialCreateDraft.draftTitle);
  const [draftPrompt, setDraftPrompt] = useState(() => initialCreateDraft.draftPrompt);
  const [draftContent, setDraftContent] = useState(() => initialCreateDraft.draftContent);
  const [draftCategory, setDraftCategory] = useState<CreateDraftCategory>(
    () => initialCreateDraft.draftCategory
  );
  const [writeTone, setWriteTone] = useState<string>(
    () => initialCreateDraft.writeTone || 'professional'
  );
  const [writeAction, setWriteAction] = useState<string>(
    () => initialCreateDraft.writeAction || 'generate'
  );
  const [comboboxCloseSignal, setComboboxCloseSignal] = useState(0);
  const [draftSource, setDraftSource] = useState<HybridInferenceSource | undefined>(undefined);
  const [draftModel, setDraftModel] = useState('');
  const [draftLatency, setDraftLatency] = useState<number | undefined>(undefined);
  const [draftLoading, setDraftLoading] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [draftSaveMsg, setDraftSaveMsg] = useState<string | null>(null);
  const [copiedDraft, setCopiedDraft] = useState(false);

  // Brainstorm & Plan state
  const [planTopic, setPlanTopic] = useState(() => initialCreateDraft.planTopic);
  const [planType, setPlanType] = useState<'brainstorm' | 'plan'>(
    () => initialCreateDraft.planType
  );
  const [planConstraints, setPlanConstraints] = useState(
    () => initialCreateDraft.planConstraints
  );

  // Coding Studio state
  const [snippets, setSnippets] = useState<CodeSnippet[]>([]);
  const [activeSnippetId, setActiveSnippetId] = useState<string | null>(null);
  const [codeTitle, setCodeTitle] = useState(() => initialCreateDraft.codeTitle);
  const [language, setLanguage] = useState(() => initialCreateDraft.language);
  const [code, setCode] = useState(() => initialCreateDraft.code);
  const [output, setOutput] = useState('');
  const [htmlPreview, setHtmlPreview] = useState<string | null>(null);
  const [savingCode, setSavingCode] = useState(false);
  const [saveCodeNotice, setSaveCodeNotice] = useState<string | null>(null);

  const [mentorPrompt, setMentorPrompt] = useState(() => initialCreateDraft.mentorPrompt);
  const [mentorLoading, setMentorLoading] = useState(false);
  const [mentorReply, setMentorReply] = useState('');
  const [mentorModel, setMentorModel] = useState('');
  const [mentorSource, setMentorSource] = useState<HybridInferenceSource | undefined>(undefined);
  const [mentorLatency, setMentorLatency] = useState<number | undefined>(undefined);
  const [mentorError, setMentorError] = useState<string | null>(null);
  const [copiedReply, setCopiedReply] = useState(false);

  const [attachedImage, setAttachedImage] = useState<{
    base64: string;
    mimeType: string;
    previewUrl: string;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useAutoSaveDraft(DRAFT_STORAGE_KEYS.create, {
    subMode,
    draftTitle,
    draftPrompt,
    draftContent,
    draftCategory,
    writeTone,
    writeAction,
    planTopic,
    planType,
    planConstraints,
    codeTitle,
    language,
    code,
    mentorPrompt,
  });

  useEffect(() => {
    if (!user) {
      setSnippets([]);
      setDrafts([]);
      setActiveSnippetId(null);
      setActiveDraftId(null);
      setCreateLoadedFlags({ snippets: true, drafts: true });
      return;
    }

    setCreateLoadedFlags({ snippets: false, drafts: false });

    const unsubSnippets = onSnapshot(
      query(collection(db, 'codeSnippets'), where('ownerId', '==', user.uid)),
      (snap) => {
        const list = sortByMostRecentTimestamp(
          snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<CodeSnippet, 'id'>) }))
        );
        setSnippets(list);
        setCreateLoadedFlags((prev) => ({ ...prev, snippets: true }));
      },
      (err) => {
        setCreateLoadedFlags((prev) => ({ ...prev, snippets: true }));
        handleFirestoreError(err, OperationType.LIST, 'codeSnippets');
      }
    );

    const unsubDrafts = onSnapshot(
      query(collection(db, 'createDrafts'), where('ownerId', '==', user.uid)),
      (snap) => {
        const list = sortByMostRecentTimestamp(
          snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<CreateDraft, 'id'>) }))
        );
        setDrafts(list);
        setCreateLoadedFlags((prev) => ({ ...prev, drafts: true }));
      },
      (err) => {
        setCreateLoadedFlags((prev) => ({ ...prev, drafts: true }));
        handleFirestoreError(err, OperationType.LIST, 'createDrafts');
      }
    );

    return () => {
      unsubSnippets();
      unsubDrafts();
    };
  }, [user]);

  const openSavedDraft = (draft: CreateDraft) => {
    setActiveDraftId(draft.id);
    setDraftTitle(draft.title);
    setDraftContent(draft.content);
    setDraftCategory(draft.category);
    setDraftSource(draft.inferenceSource);
    setDraftError(null);
    if (draft.category === 'brainstorm' || draft.category === 'plan') {
      setSubMode('brainstorm');
      setPlanType(draft.category);
      setPlanTopic(draft.title);
    } else {
      setSubMode('write');
    }
    setMobileHistoryOpen(false);
  };

  const openSavedSnippet = (snippet: CodeSnippet) => {
    setActiveSnippetId(snippet.id);
    setCodeTitle(snippet.title);
    setLanguage(snippet.language);
    setCode(snippet.code);
    setOutput(snippet.lastOutput || '');
    setHtmlPreview(null);
    setSubMode('code');
    setMobileHistoryOpen(false);
  };

  const ensureValidCreateSelectionOnHistoryOpen = () => {
    const hasActiveDraft = Boolean(
      subMode !== 'code' && activeDraftId && drafts.some((d) => d.id === activeDraftId)
    );
    const hasActiveSnippet = Boolean(
      subMode === 'code' && activeSnippetId && snippets.some((s) => s.id === activeSnippetId)
    );

    if (hasActiveDraft || hasActiveSnippet) {
      setTimeout(() => {
        activeHistoryItemRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }, 90);
      return;
    }

    const scrollTop = () => {
      setTimeout(() => {
        createHistoryScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
      }, 90);
    };

    if (subMode === 'code') {
      if (snippets.length > 0) {
        openSavedSnippet(snippets[0]);
        scrollTop();
      } else if (drafts.length > 0) {
        setActiveDraftId(drafts[0].id);
        scrollTop();
      }
      return;
    }

    if (drafts.length > 0) {
      openSavedDraft(drafts[0]);
      scrollTop();
    } else if (snippets.length > 0) {
      setActiveSnippetId(snippets[0].id);
      scrollTop();
    }
  };

  const toggleDesktopHistory = () => {
    setDesktopHistoryOpen((prev) => {
      const next = !prev;
      if (next) ensureValidCreateSelectionOnHistoryOpen();
      return next;
    });
  };

  const openMobileHistory = () => {
    ensureValidCreateSelectionOnHistoryOpen();
    setMobileHistoryOpen(true);
  };

  const runWritingStudio = async () => {
    setComboboxCloseSignal((n) => n + 1);
    if (!draftPrompt.trim() && !draftContent.trim()) return;
    setDraftError(null);
    setDraftLoading(true);

    const { category, prompt: fullPrompt } = buildWritingStudioPrompt({
      action: writeAction,
      tone: writeTone,
      instructions: draftPrompt,
      sourceText: draftContent,
    });
    setDraftCategory(category);

    try {
      const result = await generateHybridText({
        prompt: fullPrompt,
        mode: inferenceMode,
        systemInstruction:
          'You are Nimo, an editorial writing partner. Return clean markdown ready to publish or edit, without meta preamble.',
        requestKey: 'create-write',
      });
      setDraftContent(result.text.slice(0, 30000));
      setDraftSource(result.inferenceSource);
      setDraftModel(result.modelUsed);
      setDraftLatency(result.latencyMs);
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : 'Unable to generate draft.');
    } finally {
      setDraftLoading(false);
    }
  };

  const runBrainstormStudio = async () => {
    if (!planTopic.trim()) return;
    setDraftError(null);
    setDraftLoading(true);
    setDraftCategory(planType);
    setDraftTitle(planTopic.slice(0, 160));

    const prompt =
      planType === 'brainstorm'
        ? `Brainstorm 8 distinct, practical angles or ideas for "${planTopic}". Constraints/Context: ${planConstraints || 'None'}. Group ideas clearly with why each matters and an immediate first step.`
        : `Build a clear, realistic execution plan for "${planTopic}". Constraints/Context: ${planConstraints || 'None'}. Include Milestones, Owner/Role Breakdown, Risks & Mitigations, and an Actionable Checklist.`;

    try {
      const result = await generateHybridText({
        prompt,
        mode: inferenceMode,
        systemInstruction:
          'You are Nimo, a strategic product planner and creative partner. Output crisp markdown sections and checklists.',
        requestKey: 'create-brainstorm',
      });
      setDraftContent(result.text.slice(0, 30000));
      setDraftSource(result.inferenceSource);
      setDraftModel(result.modelUsed);
      setDraftLatency(result.latencyMs);
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : 'Unable to generate plan.');
    } finally {
      setDraftLoading(false);
    }
  };

  const handleSaveDraft = async () => {
    if (!user) {
      onRequireSignIn();
      return;
    }
    if (!draftContent.trim()) {
      setDraftError('Generate or enter content before saving.');
      return;
    }
    setDraftSaveMsg(null);
    const safeTitle = (draftTitle.trim() || 'Untitled Draft').slice(0, 160);
    const safeContent = draftContent.slice(0, 30000);

    try {
      if (activeDraftId) {
        await updateDoc(doc(db, 'createDrafts', activeDraftId), {
          category: draftCategory,
          title: safeTitle,
          content: safeContent,
          ...(draftSource ? { inferenceSource: draftSource } : {}),
          updatedAt: serverTimestamp(),
        });
      } else {
        const ref = doc(collection(db, 'createDrafts'));
        justCreatedCreateRef.current = true;
        await setDoc(ref, {
          ownerId: user.uid,
          category: draftCategory,
          title: safeTitle,
          content: safeContent,
          ...(draftSource ? { inferenceSource: draftSource } : {}),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        setActiveDraftId(ref.id);
      }
      setDraftSaveMsg('Saved');
      setTimeout(() => setDraftSaveMsg(null), 2000);
    } catch (err) {
      justCreatedCreateRef.current = false;
      handleFirestoreError(err, OperationType.WRITE, 'createDrafts');
    }
  };

  const handleDeleteDraft = async (id: string) => {
    if (!user) return;
    try {
      await deleteDoc(doc(db, 'createDrafts', id));
      if (activeDraftId === id) {
        setActiveDraftId(null);
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `createDrafts/${id}`);
    }
  };

  // Code Studio handlers
  const handleLanguageChange = (nextLang: string) => {
    setLanguage(nextLang);
    setHtmlPreview(null);
    setOutput('');
    if (!activeSnippetId && STARTER_SNIPPETS[nextLang]) {
      setCodeTitle(STARTER_SNIPPETS[nextLang].title);
      setCode(STARTER_SNIPPETS[nextLang].code);
    }
  };

  const handleRunCode = async () => {
    setOutput('');
    setHtmlPreview(null);

    if (language === 'html') {
      setHtmlPreview(code);
      return;
    }

    if (language === 'javascript') {
      const logs: string[] = [];
      const customConsole = {
        log: (...args: unknown[]) => logs.push(args.map((a) => formatValue(a)).join(' ')),
        warn: (...args: unknown[]) =>
          logs.push(`[warn] ${args.map((a) => formatValue(a)).join(' ')}`),
        error: (...args: unknown[]) =>
          logs.push(`[error] ${args.map((a) => formatValue(a)).join(' ')}`),
      };
      try {
        const fn = new Function('console', code);
        const result = fn(customConsole);
        if (result !== undefined) {
          logs.push(`=> ${formatValue(result)}`);
        }
        setOutput(logs.length > 0 ? logs.join('\n') : '(Executed with no console output)');
      } catch (err) {
        setOutput(`Runtime Error: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    setOutput('Tracing expected output via Nimo Hybrid Inference...');
    try {
      const result = await generateHybridText({
        prompt: `Trace this ${language} snippet and show the exact expected console/query output concisely.\n\n\`\`\`${language}\n${code}\n\`\`\``,
        mode: inferenceMode,
        systemInstruction:
          'You are a precise code execution tracer. Show exact expected output and note any errors concisely.',
        requestKey: 'create-code-trace',
      });
      setOutput(result.text);
    } catch (err) {
      setOutput(`Trace Error: ${err instanceof Error ? err.message : 'Unable to trace code.'}`);
    }
  };

  const handleSaveSnippet = async () => {
    if (!user) {
      onRequireSignIn();
      return;
    }
    setSavingCode(true);
    setSaveCodeNotice(null);
    const safeTitle = (codeTitle.trim() || 'Untitled Snippet').slice(0, 140);
    const safeLang = language.slice(0, 32);
    const safeCode = code.slice(0, 40000);
    const safeOutput = output.slice(0, 10000);

    try {
      if (activeSnippetId) {
        await updateDoc(doc(db, 'codeSnippets', activeSnippetId), {
          title: safeTitle,
          language: safeLang,
          code: safeCode,
          lastOutput: safeOutput,
          updatedAt: serverTimestamp(),
        });
      } else {
        const ref = doc(collection(db, 'codeSnippets'));
        justCreatedCreateRef.current = true;
        await setDoc(ref, {
          ownerId: user.uid,
          title: safeTitle,
          language: safeLang,
          code: safeCode,
          lastOutput: safeOutput,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        setActiveSnippetId(ref.id);
      }
      setSaveCodeNotice('Saved');
      setTimeout(() => setSaveCodeNotice(null), 2000);
    } catch (err) {
      justCreatedCreateRef.current = false;
      handleFirestoreError(err, OperationType.WRITE, 'codeSnippets');
    } finally {
      setSavingCode(false);
    }
  };

  const handleNewSnippet = () => {
    setActiveSnippetId(null);
    const preset = STARTER_SNIPPETS[language] || STARTER_SNIPPETS.javascript;
    setCodeTitle('Untitled Snippet');
    setCode(preset.code);
    setOutput('');
    setHtmlPreview(null);
    setMentorReply('');
  };

  const handleDeleteSnippet = async (id: string) => {
    if (!user) return;
    try {
      await deleteDoc(doc(db, 'codeSnippets', id));
      if (activeSnippetId === id) {
        handleNewSnippet();
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `codeSnippets/${id}`);
    }
  };

  const runMentorAction = async (
    action: 'quick_fix' | 'explain' | 'debug_deep' | 'refactor' | 'image_to_code' | 'custom'
  ) => {
    setMentorError(null);
    setMentorLoading(true);

    const actionPrompts: Record<string, string> = {
      quick_fix: `Provide a concise, fast fix for any syntax or logic bugs in this ${language} code. Show the corrected code in a fenced code block.`,
      explain: `Explain how this ${language} code works step by step, highlighting key patterns and complexity.`,
      debug_deep: `Perform a thorough root-cause debugging and edge-case audit on this ${language} code. Identify subtle bugs or failure modes and provide a clean fixed version in a fenced code block.`,
      refactor: `Refactor this ${language} code for clarity, maintainability, and best practices without changing behavior.`,
      image_to_code: `Analyze the attached screenshot or diagram and write clean ${language} code (or diagnose the error shown).`,
      custom: mentorPrompt || `Help me with this ${language} code.`,
    };

    const fullPrompt = `${actionPrompts[action]}\n\n${
      mentorPrompt && action !== 'custom' ? `User note: ${mentorPrompt}\n\n` : ''
    }Language: ${language}\n${
      output ? `Latest Output / Error:\n${output}\n\n` : ''
    }Code:\n\`\`\`${language}\n${code}\n\`\`\``;

    try {
      const result = await generateHybridText({
        prompt: fullPrompt,
        mode: inferenceMode,
        systemInstruction:
          'You are Nimo, a senior staff software engineer and coding mentor. Be precise and provide clean fenced code blocks.',
        image: attachedImage
          ? { base64: attachedImage.base64, mimeType: attachedImage.mimeType }
          : undefined,
        requestKey: 'create-code-mentor',
      });
      setMentorReply(result.text);
      setMentorModel(result.modelUsed);
      setMentorSource(result.inferenceSource);
      setMentorLatency(result.latencyMs);
      if (action === 'custom' || action === 'image_to_code') setMentorPrompt('');
    } catch (err) {
      setMentorError(err instanceof Error ? err.message : 'Coding mentor request failed.');
    } finally {
      setMentorLoading(false);
    }
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setMentorError('Please choose a valid image file.');
      return;
    }
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const base64 = result.includes(',') ? result.split(',')[1] : '';
      if (base64) {
        setAttachedImage({ base64, mimeType: file.type, previewUrl: result });
      }
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const lineCount = code.split('\n').length;
  const suggestedCode = mentorReply ? extractFirstCodeBlock(mentorReply) : null;
  const normalizedAction = writeAction.trim().toLowerCase();
  const isFreshAction =
    normalizedAction === 'generate' ||
    normalizedAction === 'draft' ||
    draftContent.trim().length === 0;
  const primaryWriteLabel = isFreshAction
    ? 'Generate Draft'
    : `Apply ${writeAction.trim() || 'AI Edit'}`;

  const createHistoryLoading = Boolean(
    user && (!createLoadedFlags.snippets || !createLoadedFlags.drafts)
  );

  useEffect(() => {
    if (!justCreatedCreateRef.current) return;
    justCreatedCreateRef.current = false;
    requestAnimationFrame(() => {
      createHistoryScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }, [drafts.length, snippets.length]);

  const showDraftsInHistory = historyFilter === 'all' || historyFilter === 'drafts';
  const showCodeInHistory = historyFilter === 'all' || historyFilter === 'code';
  const totalCreateHistoryCount = drafts.length + snippets.length;

  const createHistoryContent = (
    <div className="flex flex-col h-fit max-h-full w-72 md:w-72 shrink-0 bg-white dark:bg-[#161C24] border-r border-b border-slate-200 dark:border-slate-800 rounded-br-2xl shadow-xs overflow-hidden">
      <div className="p-3.5 border-b border-slate-200 dark:border-slate-800 space-y-2.5 shrink-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <History className="w-4 h-4 text-orange-600 dark:text-amber-400" />
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-300">
              Create History
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={toggleDesktopHistory}
              aria-label="Hide create history"
              title="Hide history"
              className="hidden md:inline-flex p-1.5 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              <PanelLeftClose className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => setMobileHistoryOpen(false)}
              aria-label="Close create history"
              className="md:hidden p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800">
          {(
            [
              { id: 'all', label: 'All' },
              { id: 'drafts', label: 'Drafts' },
              { id: 'code', label: 'Code' },
            ] as const
          ).map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setHistoryFilter(f.id)}
              className={`py-1 text-[11px] font-medium rounded transition-colors ${
                historyFilter === f.id
                  ? 'bg-white dark:bg-slate-900 text-orange-600 dark:text-amber-400 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div ref={createHistoryScrollRef} className="flex-1 min-h-0 overflow-y-auto p-3 space-y-4">
        {createHistoryLoading ? (
          <div className="space-y-1.5 py-1" aria-label="Loading create history">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-11 rounded-lg bg-slate-100 dark:bg-slate-800/70 animate-pulse"
              />
            ))}
          </div>
        ) : !user ? (
          <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/60 space-y-2.5 text-xs text-slate-600 dark:text-slate-400">
            <p>
              Sign in with Google to save and reopen your writing drafts, brainstorm plans, and code snippets across sessions.
            </p>
            <button
              type="button"
              onClick={onRequireSignIn}
              className="w-full px-3 py-1.5 font-medium rounded-lg bg-orange-600 hover:bg-orange-500 text-white transition-colors"
            >
              Sign in with Google
            </button>
          </div>
        ) : totalCreateHistoryCount === 0 ? (
          <div className="px-2 py-4 text-center space-y-1">
            <p className="text-xs font-medium text-slate-600 dark:text-slate-300">
              No saved creations yet
            </p>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              Save a draft, brainstorm plan, or code snippet to access it quickly from here.
            </p>
          </div>
        ) : (
          <>
            {showDraftsInHistory && (
              <div className="space-y-2">
                <div className="flex items-center justify-between px-1">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                    Drafts &amp; Plans ({drafts.length})
                  </span>
                </div>
                {drafts.length === 0 ? (
                  <p className="px-1 text-xs text-slate-500 dark:text-slate-400">
                    No saved drafts or plans yet.
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    {drafts.map((d) => {
                      const isActive = subMode !== 'code' && activeDraftId === d.id;
                      const dateLabel = formatHistoryDate(d.updatedAt);
                      return (
                        <div
                          key={d.id}
                          className={`flex items-center justify-between gap-2 p-2.5 rounded-lg border transition-colors ${
                            isActive
                              ? 'border-orange-300 dark:border-orange-700 bg-orange-50/70 dark:bg-orange-950/35'
                              : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50'
                          }`}
                        >
                          <button
                            ref={isActive ? activeHistoryItemRef : null}
                            type="button"
                            onClick={() => openSavedDraft(d)}
                            className="flex-1 text-left min-w-0"
                          >
                            <p className="text-xs font-medium text-slate-800 dark:text-slate-200 truncate">
                              {d.title}
                            </p>
                            <p className="text-[11px] text-slate-500 dark:text-slate-400 capitalize truncate">
                              {d.category}
                              {dateLabel ? ` · ${dateLabel}` : ''}
                            </p>
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDeleteDraft(d.id)}
                            aria-label={`Delete ${d.title}`}
                            className="p-1 text-slate-400 hover:text-red-600 shrink-0"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {showCodeInHistory && (
              <div className="space-y-2">
                <div className="flex items-center justify-between px-1">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                    Code Snippets ({snippets.length})
                  </span>
                </div>
                {snippets.length === 0 ? (
                  <p className="px-1 text-xs text-slate-500 dark:text-slate-400">
                    No saved code snippets yet.
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    {snippets.map((s) => {
                      const isActive = subMode === 'code' && activeSnippetId === s.id;
                      const dateLabel = formatHistoryDate(s.updatedAt);
                      return (
                        <div
                          key={s.id}
                          className={`flex items-center justify-between gap-2 p-2.5 rounded-lg border transition-colors ${
                            isActive
                              ? 'border-orange-300 dark:border-orange-700 bg-orange-50/70 dark:bg-orange-950/35'
                              : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50'
                          }`}
                        >
                          <button
                            ref={isActive ? activeHistoryItemRef : null}
                            type="button"
                            onClick={() => openSavedSnippet(s)}
                            className="flex-1 text-left min-w-0"
                          >
                            <p className="text-xs font-medium text-slate-800 dark:text-slate-200 truncate">
                              {s.title}
                            </p>
                            <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                              {s.language}
                              {dateLabel ? ` · ${dateLabel}` : ''}
                            </p>
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDeleteSnippet(s.id)}
                            aria-label={`Delete ${s.title}`}
                            className="p-1 text-slate-400 hover:text-red-600 shrink-0"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden bg-[#F8F9FB] dark:bg-[#0F1419] relative">
      {/* Desktop Collapsible Space-Efficient Create History Notice Board */}
      <aside
        aria-label="Create history notice board"
        aria-hidden={!desktopHistoryOpen}
        className={`hidden md:flex shrink-0 flex-col bg-transparent overflow-hidden transition-[width,opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
          desktopHistoryOpen
            ? 'w-72 opacity-100 translate-x-0'
            : 'w-0 opacity-0 -translate-x-3 pointer-events-none'
        }`}
      >
        {createHistoryContent}
      </aside>

      {/* Mobile Slide-Over Create History Drawer (space-efficient height) */}
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
          {createHistoryContent}
        </aside>
      </div>

      {/* Main Create Workspace */}
      <section className="flex-1 flex flex-col min-w-0 min-h-0 relative">
        {/* Top Create Workspace Toolbar */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 sm:px-6 py-2.5 bg-white dark:bg-[#161C24] border-b border-slate-200 dark:border-slate-800 shrink-0">
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <button
              type="button"
              onClick={openMobileHistory}
              aria-label="Show create history"
              className="md:hidden inline-flex items-center gap-1 h-7 px-2 text-[11px] font-medium rounded-md border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:border-orange-300 dark:hover:border-orange-700 whitespace-nowrap"
            >
              <History className="w-3 h-3 text-orange-600 dark:text-amber-400" />
              History
            </button>

            <button
              type="button"
              onClick={toggleDesktopHistory}
              title={desktopHistoryOpen ? 'Hide create history' : 'Show create history'}
              aria-label={desktopHistoryOpen ? 'Hide create history' : 'Show create history'}
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

            <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800 overflow-x-auto">
              <button
                type="button"
                onClick={() => setSubMode('write')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  subMode === 'write'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                <FileEdit className="w-3.5 h-3.5" />
                Write &amp; Rewrite
              </button>
              <button
                type="button"
                onClick={() => setSubMode('brainstorm')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  subMode === 'brainstorm'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                <Lightbulb className="w-3.5 h-3.5" />
                Brainstorm &amp; Plan
              </button>
              <button
                type="button"
                onClick={() => setSubMode('code')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  subMode === 'code'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                <Code2 className="w-3.5 h-3.5" />
                Code Studio
              </button>
            </div>
          </div>

          <span className="hidden xl:inline text-xs text-slate-500 dark:text-slate-400">
            Hybrid AI Writing, Strategy &amp; Code Workbench
          </span>
        </div>

        {/* Scrollable Studio Canvas */}
        <div
          className={`flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 pt-5 ${
            promptBarHidden ? 'pb-20' : 'pb-6'
          }`}
        >
          <div className="max-w-6xl mx-auto space-y-5">
            {/* SUB-MODE 1 & 2: WRITE / REWRITE / BRAINSTORM / PLAN */}
            {(subMode === 'write' || subMode === 'brainstorm') && (
              <div className="space-y-4">
                {subMode === 'write' ? (
                  <div className="bg-white dark:bg-[#161C24] border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5 space-y-3">
                    <div className="grid sm:grid-cols-3 gap-3 items-end">
                      <div className="sm:col-span-1">
                        <label
                          htmlFor="create-draft-title"
                          className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5"
                        >
                          Draft Title
                        </label>
                        <input
                          id="create-draft-title"
                          type="text"
                          value={draftTitle}
                          onChange={(e) => setDraftTitle(e.target.value)}
                          className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-orange-500/40 focus:border-orange-500"
                        />
                      </div>

                      <SearchableCombobox
                        label="Action"
                        value={writeAction}
                        onChange={setWriteAction}
                        suggestions={ACTION_SUGGESTIONS}
                        placeholder="Type any action (e.g. rewrite, summarize)..."
                        closeSignal={comboboxCloseSignal}
                      />

                      <SearchableCombobox
                        label="Tone"
                        value={writeTone}
                        onChange={setWriteTone}
                        suggestions={TONE_SUGGESTIONS}
                        placeholder="Type any tone (e.g. professional, friendly)..."
                        closeSignal={comboboxCloseSignal}
                      />
                    </div>

                    <div className="flex items-center justify-between gap-3 pt-1">
                      <span className="text-xs text-slate-500 dark:text-slate-400">
                        Use the stationary prompt composer below to generate or transform your draft.
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setActiveDraftId(null);
                          setDraftTitle('New Draft');
                          setDraftContent('');
                          setDraftSource(undefined);
                        }}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        Clear Canvas
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="bg-white dark:bg-[#161C24] border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5 space-y-3">
                    <div className="grid sm:grid-cols-3 gap-3">
                      <div>
                        <label
                          htmlFor="create-plan-format"
                          className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5"
                        >
                          Format
                        </label>
                        <select
                          id="create-plan-format"
                          value={planType}
                          onChange={(e) => setPlanType(e.target.value as 'brainstorm' | 'plan')}
                          className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-orange-500/40 focus:border-orange-500"
                        >
                          <option value="plan">Structured Plan &amp; Checklist</option>
                          <option value="brainstorm">Idea Brainstorm</option>
                        </select>
                      </div>
                      <div className="sm:col-span-2">
                        <label
                          htmlFor="create-plan-constraints"
                          className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5"
                        >
                          Constraints, Audience, or Timeline
                        </label>
                        <input
                          id="create-plan-constraints"
                          type="text"
                          value={planConstraints}
                          onChange={(e) => setPlanConstraints(e.target.value)}
                          className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-orange-500/40 focus:border-orange-500"
                        />
                      </div>
                    </div>
                  </div>
                )}

                {draftError && (
                  <div className="p-3.5 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-xs text-red-700 dark:text-red-300 flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>{draftError}</span>
                  </div>
                )}

                {/* Output & Editable Canvas */}
                <div className="bg-white dark:bg-[#161C24] border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-200 dark:border-slate-800">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-slate-900 dark:text-white">
                        Document Canvas
                      </span>
                      {draftSource && (
                        <InferenceBadge
                          source={draftSource}
                          modelUsed={draftModel}
                          latencyMs={draftLatency}
                        />
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={async () => {
                          if (!draftContent) return;
                          try {
                            await navigator.clipboard.writeText(draftContent);
                            setCopiedDraft(true);
                            setTimeout(() => setCopiedDraft(false), 1600);
                          } catch {
                            // ignore
                          }
                        }}
                        disabled={!draftContent}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap"
                      >
                        {copiedDraft ? (
                          <Check className="w-3.5 h-3.5 text-emerald-500" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                        {copiedDraft ? 'Copied' : 'Copy'}
                      </button>
                      <button
                        type="button"
                        onClick={handleSaveDraft}
                        disabled={!draftContent.trim()}
                        className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-lg bg-slate-900 dark:bg-orange-600 text-white hover:bg-slate-800 dark:hover:bg-orange-500 disabled:opacity-40 transition-colors whitespace-nowrap"
                      >
                        <Save className="w-3.5 h-3.5" />
                        {draftSaveMsg || 'Save to Firestore'}
                      </button>
                    </div>
                  </div>

                  <textarea
                    rows={10}
                    value={draftContent}
                    onChange={(e) => setDraftContent(e.target.value)}
                    placeholder="Generated output appears here, or paste existing text to rewrite/transform..."
                    className="w-full p-3.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0F1419] font-sans text-sm leading-relaxed text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-orange-500/40 focus:border-orange-500"
                  />

                  {draftContent && (
                    <div className="pt-3 border-t border-slate-100 dark:border-slate-800">
                      <p className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-2">
                        Formatted Preview
                      </p>
                      <MarkdownRenderer content={draftContent} />
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* SUB-MODE 3: CODE STUDIO */}
            {subMode === 'code' && (
              <div className="space-y-4">
                {/* Top Workbench Controls */}
                <div className="bg-white dark:bg-[#161C24] border border-slate-200 dark:border-slate-800 rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2.5 flex-1 min-w-[240px]">
                    <Code2 className="w-4 h-4 text-orange-600 dark:text-amber-400 shrink-0" />
                    <input
                      type="text"
                      value={codeTitle}
                      onChange={(e) => setCodeTitle(e.target.value)}
                      aria-label="Snippet title"
                      className="px-3 py-1.5 text-sm font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white w-56 focus:outline-none focus:ring-2 focus:ring-orange-500/40"
                    />
                    <select
                      value={language}
                      onChange={(e) => handleLanguageChange(e.target.value)}
                      aria-label="Programming language"
                      className="px-3 py-1.5 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-orange-500/40"
                    >
                      <option value="javascript">JavaScript</option>
                      <option value="typescript">TypeScript</option>
                      <option value="html">HTML / CSS</option>
                      <option value="python">Python</option>
                      <option value="sql">SQL</option>
                      <option value="go">Go</option>
                      <option value="rust">Rust</option>
                    </select>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={handleNewSnippet}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      New
                    </button>

                    {activeSnippetId && user && (
                      <button
                        type="button"
                        onClick={() => void handleDeleteSnippet(activeSnippetId)}
                        aria-label="Delete snippet"
                        className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-red-600 dark:hover:text-red-400"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={handleSaveSnippet}
                      disabled={savingCode}
                      className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap"
                    >
                      <Save className="w-3.5 h-3.5" />
                      {saveCodeNotice || (savingCode ? 'Saving...' : 'Save')}
                    </button>

                    <button
                      type="button"
                      onClick={handleRunCode}
                      className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium rounded-lg bg-orange-600 hover:bg-orange-500 text-white transition-colors whitespace-nowrap"
                    >
                      <Play className="w-3.5 h-3.5" />
                      {language === 'javascript' || language === 'html' ? 'Run' : 'Trace Output'}
                    </button>
                  </div>
                </div>

                {/* Two-Pane Workbench */}
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-stretch">
                  {/* Left 7 Cols: Editor + Output */}
                  <div className="lg:col-span-7 flex flex-col gap-4">
                    <div className="bg-slate-950 border border-slate-800 rounded-xl overflow-hidden flex min-h-[380px]">
                      <div
                        aria-hidden="true"
                        className="select-none py-4 px-3 text-right font-mono text-xs leading-6 text-slate-500 bg-slate-900/80 border-r border-slate-800 tabular-nums"
                      >
                        {Array.from({ length: lineCount }).map((_, idx) => (
                          <div key={idx}>{idx + 1}</div>
                        ))}
                      </div>
                      <textarea
                        aria-label="Code editor"
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Tab') {
                            e.preventDefault();
                            const el = e.currentTarget;
                            const start = el.selectionStart;
                            const end = el.selectionEnd;
                            const next = `${code.slice(0, start)}  ${code.slice(end)}`;
                            setCode(next);
                            requestAnimationFrame(() => {
                              el.selectionStart = el.selectionEnd = start + 2;
                            });
                          }
                        }}
                        spellCheck={false}
                        className="flex-1 p-4 bg-slate-950 text-slate-100 font-mono text-[13px] leading-6 focus:outline-none resize-y min-h-[380px]"
                      />
                    </div>

                    {/* Output / Preview Panel */}
                    <div className="bg-white dark:bg-[#161C24] border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
                      <div className="px-4 py-2.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between text-xs text-slate-600 dark:text-slate-400">
                        <span className="font-medium text-slate-800 dark:text-slate-200">
                          {htmlPreview ? 'Live HTML Preview' : 'Output Console'}
                        </span>
                        <span>{language}</span>
                      </div>
                      {htmlPreview ? (
                        <iframe
                          title="HTML Code Preview"
                          sandbox="allow-scripts"
                          srcDoc={htmlPreview}
                          className="w-full h-56 bg-white border-0"
                        />
                      ) : (
                        <pre className="p-4 text-xs font-mono text-slate-700 dark:text-slate-200 whitespace-pre-wrap min-h-[120px] max-h-64 overflow-y-auto">
                          {output ||
                            'Click Run to execute JavaScript/HTML or Trace Output for other languages.'}
                        </pre>
                      )}
                    </div>
                  </div>

                  {/* Right 5 Cols: Nimo Coding Mentor */}
                  <div className="lg:col-span-5 bg-white dark:bg-[#161C24] border border-slate-200 dark:border-slate-800 rounded-xl flex flex-col min-h-[540px]">
                    <div className="p-4 border-b border-slate-200 dark:border-slate-800 space-y-3">
                      <div>
                        <h2 className="text-base font-semibold font-display text-slate-900 dark:text-white">
                          Nimo Coding Assistant
                        </h2>
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                          Quick fixes, step-by-step explanation, deep debugging, refactoring, or screenshot-to-code via Firebase AI Logic Hybrid Inference.
                        </p>
                      </div>

                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => runMentorAction('quick_fix')}
                          disabled={mentorLoading}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap"
                        >
                          <Wrench className="w-3.5 h-3.5" />
                          Quick Fix
                        </button>
                        <button
                          type="button"
                          onClick={() => runMentorAction('explain')}
                          disabled={mentorLoading}
                          className="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap"
                        >
                          Explain
                        </button>
                        <button
                          type="button"
                          onClick={() => runMentorAction('debug_deep')}
                          disabled={mentorLoading}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-orange-200 dark:border-orange-800 bg-orange-50 dark:bg-orange-950/40 text-orange-700 dark:text-amber-300 hover:bg-orange-100 dark:hover:bg-orange-900/50 whitespace-nowrap"
                        >
                          <Sparkles className="w-3.5 h-3.5" />
                          Debug Deeply
                        </button>
                        <button
                          type="button"
                          onClick={() => runMentorAction('refactor')}
                          disabled={mentorLoading}
                          className="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap"
                        >
                          Refactor
                        </button>
                      </div>
                    </div>

                    <div className="flex-1 overflow-y-auto p-4 space-y-4">
                      {mentorError && (
                        <div className="p-3.5 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-xs text-red-700 dark:text-red-300 flex items-start gap-2">
                          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                          <span>{mentorError}</span>
                        </div>
                      )}

                      {mentorLoading ? (
                        <div className="flex items-center gap-2 text-sm text-slate-500 py-8 justify-center">
                          <Loader2 className="w-4 h-4 animate-spin text-orange-600 dark:text-amber-400" />
                          <span>Analyzing code via Hybrid Inference...</span>
                        </div>
                      ) : mentorReply ? (
                        <div className="space-y-3">
                          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
                            <InferenceBadge
                              source={mentorSource}
                              modelUsed={mentorModel}
                              latencyMs={mentorLatency}
                            />
                            <div className="flex items-center gap-3">
                              <button
                                type="button"
                                onClick={async () => {
                                  try {
                                    await navigator.clipboard.writeText(mentorReply);
                                    setCopiedReply(true);
                                    setTimeout(() => setCopiedReply(false), 1600);
                                  } catch {
                                    // ignore
                                  }
                                }}
                                className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-orange-600 dark:hover:text-amber-400 whitespace-nowrap"
                              >
                                {copiedReply ? (
                                  <Check className="w-3.5 h-3.5 text-emerald-500" />
                                ) : (
                                  <Copy className="w-3.5 h-3.5" />
                                )}
                                {copiedReply ? 'Copied' : 'Copy'}
                              </button>
                              {suggestedCode && (
                                <button
                                  type="button"
                                  onClick={() => setCode(suggestedCode)}
                                  className="font-medium text-orange-600 dark:text-amber-400 hover:underline whitespace-nowrap"
                                >
                                  Apply Code to Editor
                                </button>
                              )}
                            </div>
                          </div>
                          <MarkdownRenderer content={mentorReply} />
                        </div>
                      ) : (
                        <p className="text-sm text-slate-500 dark:text-slate-400 py-10 text-center">
                          Select an action above, attach an error/UI screenshot, or ask Nimo about your code in the bottom composer.
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Stationary ChatGPT-Style Rounded Collapsible Bottom Prompt Composer */}
        {!promptBarHidden && (
          <div className="shrink-0 px-3 sm:px-6 pt-1.5 pb-[max(0.75rem,env(safe-area-inset-bottom))] bg-[#F8F9FB]/95 dark:bg-[#0F1419]/95 backdrop-blur-xs border-t border-slate-200/70 dark:border-slate-800/80">
            <div className="max-w-3xl mx-auto space-y-1.5">
              <div className="flex items-center justify-between gap-2 px-1">
                <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400 truncate">
                  {subMode === 'write'
                    ? 'Write & Rewrite'
                    : subMode === 'brainstorm'
                      ? 'Brainstorm & Plan'
                      : 'Code Assistant'}
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
            {subMode === 'write' && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void runWritingStudio();
                }}
                className="rounded-2xl border border-slate-200 dark:border-slate-700/90 bg-white dark:bg-[#161C24] shadow-sm focus-within:border-orange-500 focus-within:ring-2 focus-within:ring-orange-500/20 px-3 pt-2.5 pb-2 transition-colors space-y-2"
              >
                <AutoResizeTextarea
                  id="create-draft-prompt"
                  value={draftPrompt}
                  onChange={(e) => setDraftPrompt(e.target.value)}
                  onFocus={() => setComboboxCloseSignal((n) => n + 1)}
                  onSubmit={() => {
                    if (!draftLoading && (draftPrompt.trim() || draftContent.trim())) {
                      void runWritingStudio();
                    }
                  }}
                  maxHeightPx={156}
                  placeholder="Describe what to write or how to transform the draft above..."
                  aria-label="Prompt or editing instructions"
                  className="w-full bg-transparent px-1 py-1 text-sm leading-relaxed text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none"
                />

                <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                  <span className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                    Action: <strong className="font-medium text-slate-700 dark:text-slate-200 capitalize">{writeAction.trim() || 'generate'}</strong> · Tone:{' '}
                    <strong className="font-medium text-slate-700 dark:text-slate-200 capitalize">{writeTone.trim() || 'neutral'}</strong>
                  </span>

                  <div className="flex items-center gap-2.5 ml-auto">
                    <span className="hidden sm:inline text-[11px] text-slate-400 dark:text-slate-500 select-none">
                      Enter to run · Shift+Enter newline
                    </span>
                    <button
                      type="submit"
                      disabled={draftLoading || (!draftPrompt.trim() && !draftContent.trim())}
                      className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs sm:text-sm font-medium rounded-xl bg-orange-600 hover:bg-orange-500 disabled:opacity-40 text-white transition-colors whitespace-nowrap shrink-0 shadow-xs"
                    >
                      {draftLoading ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="w-3.5 h-3.5" />
                      )}
                      <span className="capitalize">{primaryWriteLabel}</span>
                    </button>
                  </div>
                </div>
              </form>
            )}

            {subMode === 'brainstorm' && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void runBrainstormStudio();
                }}
                className="rounded-2xl border border-slate-200 dark:border-slate-700/90 bg-white dark:bg-[#161C24] shadow-sm focus-within:border-orange-500 focus-within:ring-2 focus-within:ring-orange-500/20 px-3 pt-2.5 pb-2 transition-colors space-y-2"
              >
                <AutoResizeTextarea
                  id="create-plan-topic"
                  value={planTopic}
                  onChange={(e) => setPlanTopic(e.target.value)}
                  onSubmit={() => {
                    if (!draftLoading && planTopic.trim()) {
                      void runBrainstormStudio();
                    }
                  }}
                  maxHeightPx={156}
                  placeholder="Enter a goal, project, or topic to brainstorm or plan..."
                  aria-label="Goal, project, or topic"
                  className="w-full bg-transparent px-1 py-1 text-sm leading-relaxed text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none"
                />

                <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                  <span className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                    {planType === 'brainstorm' ? 'Idea Brainstorm' : 'Structured Plan & Checklist'}
                  </span>

                  <div className="flex items-center gap-2.5 ml-auto">
                    <span className="hidden sm:inline text-[11px] text-slate-400 dark:text-slate-500 select-none">
                      Enter to run · Shift+Enter newline
                    </span>
                    <button
                      type="submit"
                      disabled={draftLoading || !planTopic.trim()}
                      className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs sm:text-sm font-medium rounded-xl bg-orange-600 hover:bg-orange-500 disabled:opacity-40 text-white transition-colors whitespace-nowrap shrink-0 shadow-xs"
                    >
                      {draftLoading ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Lightbulb className="w-3.5 h-3.5" />
                      )}
                      {planType === 'brainstorm' ? 'Brainstorm Ideas' : 'Build Execution Plan'}
                    </button>
                  </div>
                </div>
              </form>
            )}

            {subMode === 'code' && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void runMentorAction(attachedImage ? 'image_to_code' : 'custom');
                }}
                className="rounded-2xl border border-slate-200 dark:border-slate-700/90 bg-white dark:bg-[#161C24] shadow-sm focus-within:border-orange-500 focus-within:ring-2 focus-within:ring-orange-500/20 px-3 pt-2.5 pb-2 transition-colors space-y-2"
              >
                {attachedImage && (
                  <div className="inline-flex items-center gap-3 p-2 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs">
                    <img
                      src={attachedImage.previewUrl}
                      alt="Code screenshot"
                      referrerPolicy="no-referrer"
                      className="w-10 h-10 rounded-lg object-cover"
                    />
                    <span className="text-slate-600 dark:text-slate-300">
                      Screenshot attached
                    </span>
                    <button
                      type="button"
                      onClick={() => setAttachedImage(null)}
                      aria-label="Remove screenshot"
                      className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-white"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                )}

                <AutoResizeTextarea
                  value={mentorPrompt}
                  onChange={(e) => setMentorPrompt(e.target.value)}
                  onSubmit={() => {
                    if (!mentorLoading && (mentorPrompt.trim() || attachedImage)) {
                      void runMentorAction(attachedImage ? 'image_to_code' : 'custom');
                    }
                  }}
                  maxHeightPx={156}
                  placeholder="Ask Nimo about this code, paste an error, or attach a screenshot..."
                  aria-label="Ask Nimo coding assistant"
                  className="w-full bg-transparent px-1 py-1 text-sm leading-relaxed text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none"
                />

                <div className="flex items-center justify-between gap-2 pt-1">
                  <div className="flex items-center gap-1.5">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      onChange={handleImageUpload}
                      className="hidden"
                    />
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      title="Upload UI mockup or error screenshot"
                      aria-label="Attach screenshot"
                      className="p-2 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0"
                    >
                      <ImagePlus className="w-4 h-4" />
                    </button>
                  </div>

                  <div className="flex items-center gap-2.5">
                    <span className="hidden sm:inline text-[11px] text-slate-400 dark:text-slate-500 select-none">
                      Enter to ask · Shift+Enter newline
                    </span>
                    <button
                      type="submit"
                      disabled={mentorLoading || (!mentorPrompt.trim() && !attachedImage)}
                      className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs sm:text-sm font-medium rounded-xl bg-orange-600 hover:bg-orange-500 disabled:opacity-40 text-white transition-colors whitespace-nowrap shrink-0 shadow-xs"
                    >
                      {mentorLoading ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Send className="w-3.5 h-3.5" />
                      )}
                      <span>Ask</span>
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
    </div>
  );
}
