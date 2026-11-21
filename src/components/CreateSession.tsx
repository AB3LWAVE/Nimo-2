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
  Code2,
  Copy,
  FileEdit,
  ImagePlus,
  Lightbulb,
  Loader2,
  Play,
  Plus,
  Save,
  Sparkles,
  Trash2,
  Wrench,
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
import { InferenceBadge } from './InferenceBadge';
import { MarkdownRenderer } from './MarkdownRenderer';

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
  body { font-family: system-ui, sans-serif; padding: 24px; background: #f8fafc; color: #0f172a; }
  .card { max-width: 340px; background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px; }
  .price { font-size: 2rem; font-weight: 700; margin: 8px 0; }
  button { background: #0284c7; color: #fff; border: 0; border-radius: 8px; padding: 10px 16px; cursor: pointer; }
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
  return 0;
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
  const [subMode, setSubMode] = useState<CreateSubMode>('write');

  // Shared Create Drafts from Firestore
  const [drafts, setDrafts] = useState<CreateDraft[]>([]);
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('Hybrid AI Launch Brief');
  const [draftPrompt, setDraftPrompt] = useState(
    'Draft a crisp 1-page product launch announcement explaining how local on-device AI plus cloud fallback improves privacy and speed.'
  );
  const [draftContent, setDraftContent] = useState('');
  const [draftCategory, setDraftCategory] = useState<CreateDraftCategory>('writing');
  const [writeTone, setWriteTone] = useState<'Clear' | 'Executive' | 'Technical' | 'Creative'>('Clear');
  const [writeAction, setWriteAction] = useState<'draft' | 'rewrite' | 'condense' | 'expand' | 'polish'>('draft');
  const [draftSource, setDraftSource] = useState<HybridInferenceSource | undefined>(undefined);
  const [draftModel, setDraftModel] = useState('');
  const [draftLatency, setDraftLatency] = useState<number | undefined>(undefined);
  const [draftLoading, setDraftLoading] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [draftSaveMsg, setDraftSaveMsg] = useState<string | null>(null);
  const [copiedDraft, setCopiedDraft] = useState(false);

  // Brainstorm & Plan state
  const [planTopic, setPlanTopic] = useState('Weekend Hackathon Demo & QA Checklist');
  const [planType, setPlanType] = useState<'brainstorm' | 'plan'>('plan');
  const [planConstraints, setPlanConstraints] = useState(
    '3-person team, 48 hours, focus on hybrid AI reliability and security testing.'
  );

  // Coding Studio state
  const [snippets, setSnippets] = useState<CodeSnippet[]>([]);
  const [activeSnippetId, setActiveSnippetId] = useState<string | null>(null);
  const [codeTitle, setCodeTitle] = useState(STARTER_SNIPPETS.javascript.title);
  const [language, setLanguage] = useState('javascript');
  const [code, setCode] = useState(STARTER_SNIPPETS.javascript.code);
  const [output, setOutput] = useState('');
  const [htmlPreview, setHtmlPreview] = useState<string | null>(null);
  const [savingCode, setSavingCode] = useState(false);
  const [saveCodeNotice, setSaveCodeNotice] = useState<string | null>(null);

  const [mentorPrompt, setMentorPrompt] = useState('');
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

  useEffect(() => {
    if (!user) {
      setSnippets([]);
      setDrafts([]);
      setActiveSnippetId(null);
      setActiveDraftId(null);
      return;
    }

    const unsubSnippets = onSnapshot(
      query(collection(db, 'codeSnippets'), where('ownerId', '==', user.uid)),
      (snap) => {
        const list = snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as Omit<CodeSnippet, 'id'>) }))
          .sort((a, b) => getTimestampMillis(b.updatedAt) - getTimestampMillis(a.updatedAt));
        setSnippets(list);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'codeSnippets')
    );

    const unsubDrafts = onSnapshot(
      query(collection(db, 'createDrafts'), where('ownerId', '==', user.uid)),
      (snap) => {
        const list = snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as Omit<CreateDraft, 'id'>) }))
          .sort((a, b) => getTimestampMillis(b.updatedAt) - getTimestampMillis(a.updatedAt));
        setDrafts(list);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'createDrafts')
    );

    return () => {
      unsubSnippets();
      unsubDrafts();
    };
  }, [user]);

  const runWritingStudio = async () => {
    if (!draftPrompt.trim() && !draftContent.trim()) return;
    setDraftError(null);
    setDraftLoading(true);

    const isRewrite = writeAction !== 'draft' && draftContent.trim().length > 0;
    const category: CreateDraftCategory = isRewrite ? 'rewrite' : 'writing';
    setDraftCategory(category);

    const actionDirective: Record<typeof writeAction, string> = {
      draft: `Write a polished, original ${writeTone.toLowerCase()} draft based on the user's request.`,
      rewrite: `Rewrite the provided text in a ${writeTone.toLowerCase()} tone while preserving key meaning.`,
      condense: `Condense the provided text into a crisp, high-impact ${writeTone.toLowerCase()} version.`,
      expand: `Expand the provided text with clear examples, transitions, and detail in a ${writeTone.toLowerCase()} tone.`,
      polish: `Proofread and edit the provided text for grammar, flow, clarity, and impact (${writeTone.toLowerCase()} tone).`,
    };

    const fullPrompt = isRewrite
      ? `${actionDirective[writeAction]}\n\nAdditional instruction: ${draftPrompt || 'None'}\n\nSource text:\n${draftContent}`
      : `${actionDirective.draft}\n\nTopic / Brief:\n${draftPrompt}`;

    try {
      const result = await generateHybridText({
        prompt: fullPrompt,
        mode: inferenceMode,
        systemInstruction:
          'You are NIMO AI, an editorial writing partner. Return clean markdown ready to publish or edit, without meta preamble.',
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
          'You are NIMO AI, a strategic product planner and creative partner. Output crisp markdown sections and checklists.',
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

    setOutput('Tracing expected output via NIMO AI Hybrid Inference...');
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
          'You are NIMO AI, a senior staff software engineer and coding mentor. Be precise and provide clean fenced code blocks.',
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

  return (
    <div className="flex-1 bg-slate-50 dark:bg-slate-950">
      <div className="max-w-[1440px] mx-auto px-4 sm:px-8 py-6 space-y-5">
        {/* Create Header + Internal Experience Switcher */}
        <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-200 dark:border-slate-800">
          <div className="space-y-1">
            <h1 className="text-2xl font-bold font-display text-slate-900 dark:text-white">
              Create Studio
            </h1>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Write &amp; rewrite content, brainstorm plans, and build or debug code using Firebase AI Logic Hybrid Inference.
            </p>
          </div>

          <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-200/70 dark:bg-slate-800 overflow-x-auto">
            <button
              type="button"
              onClick={() => setSubMode('write')}
              className={`inline-flex items-center gap-2 px-3.5 py-2 text-sm font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                subMode === 'write'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <FileEdit className="w-4 h-4" />
              Write &amp; Rewrite
            </button>
            <button
              type="button"
              onClick={() => setSubMode('brainstorm')}
              className={`inline-flex items-center gap-2 px-3.5 py-2 text-sm font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                subMode === 'brainstorm'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <Lightbulb className="w-4 h-4" />
              Brainstorm &amp; Plan
            </button>
            <button
              type="button"
              onClick={() => setSubMode('code')}
              className={`inline-flex items-center gap-2 px-3.5 py-2 text-sm font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                subMode === 'code'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <Code2 className="w-4 h-4" />
              Code Studio
            </button>
          </div>
        </div>

        {/* SUB-MODE 1 & 2: WRITE / REWRITE / BRAINSTORM / PLAN */}
        {(subMode === 'write' || subMode === 'brainstorm') && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-8 space-y-4">
              {subMode === 'write' ? (
                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4">
                  <div className="grid sm:grid-cols-3 gap-3">
                    <div className="sm:col-span-1">
                      <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                        Draft Title
                      </label>
                      <input
                        type="text"
                        value={draftTitle}
                        onChange={(e) => setDraftTitle(e.target.value)}
                        className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                        Action
                      </label>
                      <select
                        value={writeAction}
                        onChange={(e) =>
                          setWriteAction(e.target.value as typeof writeAction)
                        }
                        className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white"
                      >
                        <option value="draft">Draft from Prompt</option>
                        <option value="rewrite">Rewrite Existing Text</option>
                        <option value="condense">Condense &amp; Tighten</option>
                        <option value="expand">Expand with Detail</option>
                        <option value="polish">Proofread &amp; Polish</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                        Tone
                      </label>
                      <select
                        value={writeTone}
                        onChange={(e) => setWriteTone(e.target.value as typeof writeTone)}
                        className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white"
                      >
                        <option value="Clear">Clear &amp; Direct</option>
                        <option value="Executive">Executive</option>
                        <option value="Technical">Technical</option>
                        <option value="Creative">Creative</option>
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                      Prompt or Editing Instructions
                    </label>
                    <textarea
                      rows={3}
                      value={draftPrompt}
                      onChange={(e) => setDraftPrompt(e.target.value)}
                      placeholder="Describe what to write or how to edit the draft below..."
                      className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white"
                    />
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        setActiveDraftId(null);
                        setDraftTitle('New Draft');
                        setDraftContent('');
                        setDraftSource(undefined);
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      Clear Canvas
                    </button>

                    <button
                      type="button"
                      onClick={runWritingStudio}
                      disabled={draftLoading}
                      className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-sky-600 hover:bg-sky-700 disabled:opacity-40 text-white whitespace-nowrap"
                    >
                      {draftLoading ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Sparkles className="w-4 h-4" />
                      )}
                      {writeAction === 'draft' ? 'Generate Draft' : 'Apply AI Edit'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4">
                  <div className="grid sm:grid-cols-3 gap-3">
                    <div className="sm:col-span-2">
                      <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                        Goal, Project, or Topic
                      </label>
                      <input
                        type="text"
                        value={planTopic}
                        onChange={(e) => setPlanTopic(e.target.value)}
                        className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                        Format
                      </label>
                      <select
                        value={planType}
                        onChange={(e) => setPlanType(e.target.value as 'brainstorm' | 'plan')}
                        className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white"
                      >
                        <option value="plan">Structured Plan &amp; Checklist</option>
                        <option value="brainstorm">Idea Brainstorm</option>
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                      Constraints, Audience, or Timeline
                    </label>
                    <input
                      type="text"
                      value={planConstraints}
                      onChange={(e) => setPlanConstraints(e.target.value)}
                      className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white"
                    />
                  </div>

                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={runBrainstormStudio}
                      disabled={draftLoading}
                      className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-sky-600 hover:bg-sky-700 disabled:opacity-40 text-white whitespace-nowrap"
                    >
                      {draftLoading ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Lightbulb className="w-4 h-4" />
                      )}
                      {planType === 'brainstorm' ? 'Brainstorm Ideas' : 'Build Execution Plan'}
                    </button>
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
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4">
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
                      className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-lg bg-slate-900 dark:bg-sky-600 text-white hover:bg-slate-800 dark:hover:bg-sky-700 disabled:opacity-40 whitespace-nowrap"
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
                  placeholder="Generated output appears here, or paste existing text to rewrite/polish..."
                  className="w-full p-3.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 font-sans text-sm leading-relaxed text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500"
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

            {/* Saved Create Drafts Sidebar */}
            <aside className="lg:col-span-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4 h-fit">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold font-display text-slate-900 dark:text-white">
                  Saved Drafts &amp; Plans
                </h2>
                <span className="text-xs font-mono tabular-nums text-slate-500">
                  {drafts.length}
                </span>
              </div>

              {!user ? (
                <div className="space-y-2.5 text-xs text-slate-600 dark:text-slate-400">
                  <p>Sign in with Google to save drafts, rewrites, brainstorms, and plans to Firestore.</p>
                  <button
                    type="button"
                    onClick={onRequireSignIn}
                    className="px-3 py-1.5 font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800"
                  >
                    Sign in with Google
                  </button>
                </div>
              ) : drafts.length === 0 ? (
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  No saved creations yet. Generate a draft or plan and click Save to Firestore.
                </p>
              ) : (
                <div className="space-y-2">
                  {drafts.map((d) => (
                    <div
                      key={d.id}
                      className={`flex items-center justify-between gap-2 p-2.5 rounded-lg border transition-colors ${
                        activeDraftId === d.id
                          ? 'border-sky-500 bg-sky-50/50 dark:bg-sky-950/30'
                          : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setActiveDraftId(d.id);
                          setDraftTitle(d.title);
                          setDraftContent(d.content);
                          setDraftCategory(d.category);
                          setDraftSource(d.inferenceSource);
                        }}
                        className="flex-1 text-left min-w-0"
                      >
                        <p className="text-sm font-medium text-slate-800 dark:text-slate-200 truncate">
                          {d.title}
                        </p>
                        <p className="text-xs text-slate-500 dark:text-slate-400 capitalize">
                          {d.category}
                        </p>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteDraft(d.id)}
                        aria-label={`Delete ${d.title}`}
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

        {/* SUB-MODE 3: CODE STUDIO */}
        {subMode === 'code' && (
          <div className="space-y-4">
            {/* Top Workbench Controls */}
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2.5 flex-1 min-w-[260px]">
                <Code2 className="w-4 h-4 text-sky-600 dark:text-sky-400 shrink-0" />
                <input
                  type="text"
                  value={codeTitle}
                  onChange={(e) => setCodeTitle(e.target.value)}
                  aria-label="Snippet title"
                  className="px-3 py-1.5 text-sm font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white w-56"
                />
                <select
                  value={language}
                  onChange={(e) => handleLanguageChange(e.target.value)}
                  className="px-3 py-1.5 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-800 dark:text-slate-100"
                >
                  <option value="javascript">JavaScript</option>
                  <option value="typescript">TypeScript</option>
                  <option value="html">HTML / CSS</option>
                  <option value="python">Python</option>
                  <option value="sql">SQL</option>
                  <option value="go">Go</option>
                  <option value="rust">Rust</option>
                </select>

                {user && snippets.length > 0 && (
                  <select
                    value={activeSnippetId || ''}
                    onChange={(e) => {
                      const found = snippets.find((s) => s.id === e.target.value);
                      if (found) {
                        setActiveSnippetId(found.id);
                        setCodeTitle(found.title);
                        setLanguage(found.language);
                        setCode(found.code);
                        setOutput(found.lastOutput || '');
                        setHtmlPreview(null);
                      }
                    }}
                    className="px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 max-w-[200px]"
                  >
                    <option value="">Load Saved Snippet...</option>
                    {snippets.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.title} ({s.language})
                      </option>
                    ))}
                  </select>
                )}
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
                    onClick={async () => {
                      try {
                        await deleteDoc(doc(db, 'codeSnippets', activeSnippetId));
                        handleNewSnippet();
                      } catch (err) {
                        handleFirestoreError(
                          err,
                          OperationType.DELETE,
                          `codeSnippets/${activeSnippetId}`
                        );
                      }
                    }}
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
                  className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium rounded-lg bg-sky-600 hover:bg-sky-700 text-white transition-colors whitespace-nowrap"
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
                    className="select-none py-4 px-3 text-right font-mono text-xs leading-6 text-slate-600 bg-slate-900/70 border-r border-slate-800 tabular-nums"
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
                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
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

              {/* Right 5 Cols: NIMO AI Coding Mentor */}
              <div className="lg:col-span-5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl flex flex-col min-h-[540px]">
                <div className="p-4 border-b border-slate-200 dark:border-slate-800 space-y-3">
                  <div>
                    <h2 className="text-base font-semibold font-display text-slate-900 dark:text-white">
                      NIMO AI Coding Assistant
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
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-sky-200 dark:border-sky-800 bg-sky-50 dark:bg-sky-950/50 text-sky-700 dark:text-sky-300 hover:bg-sky-100 dark:hover:bg-sky-900/50 whitespace-nowrap"
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
                      <Loader2 className="w-4 h-4 animate-spin text-sky-600" />
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
                            className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-sky-600 whitespace-nowrap"
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
                              className="font-medium text-sky-600 dark:text-sky-400 hover:underline whitespace-nowrap"
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
                      Select an action above, attach an error/UI screenshot, or ask NIMO AI about your code.
                    </p>
                  )}
                </div>

                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    runMentorAction(attachedImage ? 'image_to_code' : 'custom');
                  }}
                  className="p-3.5 border-t border-slate-200 dark:border-slate-800 space-y-2"
                >
                  {attachedImage && (
                    <div className="flex items-center justify-between gap-2 p-2 rounded-lg bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs">
                      <div className="flex items-center gap-2">
                        <img
                          src={attachedImage.previewUrl}
                          alt="Code screenshot"
                          referrerPolicy="no-referrer"
                          className="w-10 h-10 rounded object-cover"
                        />
                        <span className="text-slate-600 dark:text-slate-300">
                          Screenshot attached
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setAttachedImage(null)}
                        className="text-slate-400 hover:text-slate-700 dark:hover:text-white"
                      >
                        Remove
                      </button>
                    </div>
                  )}

                  <div className="flex items-center gap-2">
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
                      className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0"
                    >
                      <ImagePlus className="w-4 h-4" />
                    </button>
                    <input
                      type="text"
                      value={mentorPrompt}
                      onChange={(e) => setMentorPrompt(e.target.value)}
                      placeholder="Ask NIMO AI about this snippet..."
                      className="flex-1 px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white"
                    />
                    <button
                      type="submit"
                      disabled={mentorLoading || (!mentorPrompt.trim() && !attachedImage)}
                      className="px-3.5 py-2 text-sm font-medium rounded-lg bg-sky-600 hover:bg-sky-700 disabled:opacity-40 text-white whitespace-nowrap"
                    >
                      Ask
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
