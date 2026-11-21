import React, { useState } from 'react';
import { Check, Copy } from 'lucide-react';

interface MarkdownRendererProps {
  content: string;
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Ignore clipboard failures
    }
  };

  return (
    <div className="my-3 rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden bg-slate-950 text-slate-100">
      <div className="flex items-center justify-between px-3 py-1.5 bg-slate-900 border-b border-slate-800 text-xs text-slate-400">
        <span className="font-mono">{lang || 'code'}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1.5 text-slate-300 hover:text-white transition-colors whitespace-nowrap"
        >
          {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <pre className="p-3 overflow-x-auto text-xs leading-relaxed font-mono">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function renderInline(text: string): React.ReactNode[] {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.map((part, idx) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
      return (
        <code
          key={idx}
          className="px-1.5 py-0.5 mx-0.5 rounded bg-slate-100 dark:bg-slate-800 font-mono text-[0.85em] text-slate-800 dark:text-slate-200"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length >= 4) {
      return (
        <strong key={idx} className="font-semibold text-slate-900 dark:text-white">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return <React.Fragment key={idx}>{part}</React.Fragment>;
  });
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  const segments = content.split(/(```[\s\S]*?```)/g);

  return (
    <div className="space-y-2.5 text-[15px] leading-relaxed text-slate-700 dark:text-slate-200 break-words">
      {segments.map((segment, segIdx) => {
        if (segment.startsWith('```') && segment.endsWith('```')) {
          const inner = segment.slice(3, -3);
          const firstNewline = inner.indexOf('\n');
          const lang = firstNewline >= 0 ? inner.slice(0, firstNewline).trim() : '';
          const code = firstNewline >= 0 ? inner.slice(firstNewline + 1) : inner;
          return <CodeBlock key={segIdx} lang={lang} code={code} />;
        }

        const lines = segment.split('\n');
        return (
          <div key={segIdx} className="space-y-1.5">
            {lines.map((line, lineIdx) => {
              const trimmed = line.trim();
              if (!trimmed) return <div key={lineIdx} className="h-1" />;

              if (trimmed.startsWith('### ')) {
                return (
                  <h4 key={lineIdx} className="text-base font-semibold font-display text-slate-900 dark:text-white pt-2">
                    {renderInline(trimmed.slice(4))}
                  </h4>
                );
              }
              if (trimmed.startsWith('## ')) {
                return (
                  <h3 key={lineIdx} className="text-lg font-semibold font-display text-slate-900 dark:text-white pt-2.5">
                    {renderInline(trimmed.slice(3))}
                  </h3>
                );
              }
              if (trimmed.startsWith('# ')) {
                return (
                  <h2 key={lineIdx} className="text-xl font-bold font-display text-slate-900 dark:text-white pt-3">
                    {renderInline(trimmed.slice(2))}
                  </h2>
                );
              }
              if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
                return (
                  <div key={lineIdx} className="flex items-start gap-2 pl-2">
                    <span className="text-sky-600 dark:text-sky-400 mt-1.5 text-xs select-none">•</span>
                    <span className="flex-1">{renderInline(trimmed.slice(2))}</span>
                  </div>
                );
              }
              const numberedMatch = trimmed.match(/^(\d+\.)\s+(.*)$/);
              if (numberedMatch) {
                return (
                  <div key={lineIdx} className="flex items-start gap-2 pl-1">
                    <span className="font-mono text-xs font-semibold text-sky-600 dark:text-sky-400 mt-1 tabular-nums">
                      {numberedMatch[1]}
                    </span>
                    <span className="flex-1">{renderInline(numberedMatch[2])}</span>
                  </div>
                );
              }
              return <p key={lineIdx}>{renderInline(line)}</p>;
            })}
          </div>
        );
      })}
    </div>
  );
}
