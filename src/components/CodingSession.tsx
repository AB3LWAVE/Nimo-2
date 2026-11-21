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
  Code2,
  ImagePlus,
  Loader2,
  Play,
  Plus,
  Save,
  Sparkles,
  Trash2,
  Wrench,
} from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../firebase';
import { CodeSnippet } from '../types';
import { MarkdownRenderer } from './MarkdownRenderer';

interface CodingSessionProps {
  user: User | null;
  onRequireSignIn: () => void;
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
  if (typeof ts === 'object' && ts !== null && 'toMillis' in ts && typeof (ts as { toMillis: () => number }).toMillis === 'function') {
    return (ts as { toMillis: () => number }).toMillis();
  }
  return 0;
}

function extractFirstCodeBlock(markdown: string): string | null {
  const match = markdown.match(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/);
  return match ? match[1].trimEnd() : null;
}

export function CodingSession({ user, onRequireSignIn }: CodingSessionProps) {
  const [snippets, setSnippets] = useState<CodeSnippet[]>([]);
  const [activeSnippetId, setActiveSnippetId] = useState<string | null>(null);

  const [title, setTitle] = useState(STARTER_SNIPPETS.javascript.title);
  const [language, setLanguage] = useState('javascript');
  const [code, setCode] = useState(STARTER_SNIPPETS.javascript.code);
  const [output, setOutput] = useState('');
  const [htmlPreview, setHtmlPreview] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);

  const [mentorPrompt, setMentorPrompt] = useState('');
  const [mentorLoading, setMentorLoading] = useState(false);
  const [mentorReply, setMentorReply] = useState('');
  const [mentorModel, setMentorModel] = useState('');
  const [mentorError, setMentorError] = useState<{
    message: string;
    canRetryStandard?: boolean;
    lastAction?: 'quick_fix' | 'explain' | 'debug_deep' | 'refactor' | 'image_to_code' | 'custom';
  } | null>(null);

  const [attachedImage, setAttachedImage] = useState<{
    base64: string;
    mimeType: string;
    previewUrl: string;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!user) {
      setSnippets([]);
      setActiveSnippetId(null);
      return;
    }

    const unsub = onSnapshot(
      query(collection(db, 'codeSnippets'), where('ownerId', '==', user.uid)),
      (snap) => {
        const list = snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as Omit<CodeSnippet, 'id'>) }))
          .sort((a, b) => getTimestampMillis(b.updatedAt) - getTimestampMillis(a.updatedAt));
        setSnippets(list);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'codeSnippets')
    );

    return () => unsub();
  }, [user]);

  const handleLanguageChange = (nextLang: string) => {
    setLanguage(nextLang);
    setHtmlPreview(null);
    setOutput('');
    if (!activeSnippetId && STARTER_SNIPPETS[nextLang]) {
      setTitle(STARTER_SNIPPETS[nextLang].title);
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
        warn: (...args: unknown[]) => logs.push(`[warn] ${args.map((a) => formatValue(a)).join(' ')}`),
        error: (...args: unknown[]) => logs.push(`[error] ${args.map((a) => formatValue(a)).join(' ')}`),
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

    // For Python, TypeScript, SQL, Go, Rust: trace expected output with Nimo
    setOutput('Tracing execution with Nimo...');
    try {
      const res = await fetch('/api/coding/assist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'custom',
          language,
          code,
          prompt: `Trace this ${language} snippet and show the exact expected console/query output concisely.`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || 'Trace failed.');
      setOutput(data.reply);
    } catch (err) {
      setOutput(`Trace Error: ${err instanceof Error ? err.message : 'Unable to trace code.'}`);
    }
  };

  const handleSaveSnippet = async () => {
    if (!user) {
      onRequireSignIn();
      return;
    }
    setSaving(true);
    setSaveNotice(null);
    const safeTitle = (title.trim() || 'Untitled Snippet').slice(0, 140);
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
      setSaveNotice('Saved to Firestore');
      setTimeout(() => setSaveNotice(null), 2000);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'codeSnippets');
    } finally {
      setSaving(false);
    }
  };

  const handleNewSnippet = () => {
    setActiveSnippetId(null);
    const preset = STARTER_SNIPPETS[language] || STARTER_SNIPPETS.javascript;
    setTitle('Untitled Snippet');
    setCode(preset.code);
    setOutput('');
    setHtmlPreview(null);
    setMentorReply('');
  };

  const runMentorAction = async (
    action: 'quick_fix' | 'explain' | 'debug_deep' | 'refactor' | 'image_to_code' | 'custom',
    fallbackToStandard = false
  ) => {
    setMentorError(null);
    setMentorLoading(true);
    try {
      const res = await fetch('/api/coding/assist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          language,
          code,
          prompt: mentorPrompt,
          runtimeOutput: output,
          image: attachedImage ? { data: attachedImage.base64, mimeType: attachedImage.mimeType } : undefined,
          fallbackToStandard,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMentorError({
          message: data.message || data.error || 'Coding mentor request failed.',
          canRetryStandard: Boolean(data.isBillingRequired),
          lastAction: action,
        });
        return;
      }
      setMentorReply(data.reply || '');
      setMentorModel(data.modelUsed || '');
      if (action === 'custom') setMentorPrompt('');
    } catch (err) {
      setMentorError({
        message: err instanceof Error ? err.message : 'Network error contacting Nimo.',
      });
    } finally {
      setMentorLoading(false);
    }
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
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
      <div className="max-w-[1440px] mx-auto px-4 sm:px-6 py-5 space-y-4">
        {/* Top Workbench Controls */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2.5 flex-1 min-w-[260px]">
            <Code2 className="w-4 h-4 text-sky-600 dark:text-sky-400 shrink-0" />
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
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
                    setTitle(found.title);
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
                    handleFirestoreError(err, OperationType.DELETE, `codeSnippets/${activeSnippetId}`);
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
              disabled={saving}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap"
            >
              <Save className="w-3.5 h-3.5" />
              {saveNotice || (saving ? 'Saving...' : 'Save')}
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
                  {output || 'Click Run to execute JavaScript/HTML or Trace Output for other languages.'}
                </pre>
              )}
            </div>
          </div>

          {/* Right 5 Cols: Nimo Coding Mentor */}
          <div className="lg:col-span-5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl flex flex-col min-h-[540px]">
            <div className="p-4 border-b border-slate-200 dark:border-slate-800 space-y-3">
              <div>
                <h2 className="text-base font-semibold font-display text-slate-900 dark:text-white">
                  Nimo Coding Mentor
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Fast quick-fixes, deep root-cause debugging, refactoring, or screenshot-to-code.
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
                <div className="p-3.5 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-xs text-red-700 dark:text-red-300 space-y-2">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>{mentorError.message}</span>
                  </div>
                  {mentorError.canRetryStandard && mentorError.lastAction && (
                    <button
                      type="button"
                      onClick={() => runMentorAction(mentorError.lastAction!, true)}
                      className="px-3 py-1.5 text-xs font-medium rounded-md bg-white dark:bg-slate-900 border border-red-300 dark:border-red-800 text-slate-900 dark:text-white"
                    >
                      Retry with Balanced Model (gemini-4-hydrogen)
                    </button>
                  )}
                </div>
              )}

              {mentorLoading ? (
                <div className="flex items-center gap-2 text-sm text-slate-500 py-8 justify-center">
                  <Loader2 className="w-4 h-4 animate-spin text-sky-600" />
                  <span>Nimo is analyzing your code...</span>
                </div>
              ) : mentorReply ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                    <span>Nimo · {mentorModel}</span>
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
                  <MarkdownRenderer content={mentorReply} />
                </div>
              ) : (
                <p className="text-sm text-slate-500 dark:text-slate-400 py-10 text-center">
                  Select an action above, attach an error/UI screenshot, or ask Nimo a question about your code.
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
                    <span className="text-slate-600 dark:text-slate-300">Screenshot attached</span>
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
                  className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0"
                >
                  <ImagePlus className="w-4 h-4" />
                </button>
                <input
                  type="text"
                  value={mentorPrompt}
                  onChange={(e) => setMentorPrompt(e.target.value)}
                  placeholder="Ask Nimo about this snippet..."
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
    </div>
  );
}

function formatValue(val: unknown): string {
  if (typeof val === 'string') return val;
  try {
    return JSON.stringify(val);
  } catch {
    return String(val);
  }
}
