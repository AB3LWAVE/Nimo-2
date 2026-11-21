import React from 'react';
import { Cloud, Cpu, Mic } from 'lucide-react';
import type { MessageInferenceSource } from '../types';

interface InferenceBadgeProps {
  source?: MessageInferenceSource;
  modelUsed?: string;
  latencyMs?: number;
}

export function InferenceBadge({ source, modelUsed, latencyMs }: InferenceBadgeProps) {
  if (!source || source === 'user') return null;

  const isServerFallback = Boolean(modelUsed && modelUsed.includes('(server fallback)'));
  const displayModel = modelUsed?.replace(/\s*\(server fallback\)$/, '');

  const config =
    source === 'on_device'
      ? {
          label: 'Firebase On-device',
          sdkLabel: 'ON_DEVICE',
          icon: <Cpu className="w-3 h-3" />,
          cls: 'border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300',
        }
      : source === 'server_multimodal'
        ? {
            label: 'Server Speech / Multimodal',
            sdkLabel: 'SERVER_MULTIMODAL',
            icon: <Mic className="w-3 h-3" />,
            cls: 'border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300',
          }
        : isServerFallback
          ? {
              label: 'Server Cloud Fallback',
              sdkLabel: 'IN_CLOUD',
              icon: <Cloud className="w-3 h-3" />,
              cls: 'border-indigo-200 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-950/50 text-indigo-700 dark:text-indigo-300',
            }
          : {
              label: 'Firebase Cloud',
              sdkLabel: 'IN_CLOUD',
              icon: <Cloud className="w-3 h-3" />,
              cls: 'border-sky-200 dark:border-sky-800 bg-sky-50 dark:bg-sky-950/50 text-sky-700 dark:text-sky-300',
            };

  return (
    <span
      data-inference-source={config.sdkLabel}
      title={`Inference source: ${config.sdkLabel}${isServerFallback ? ' (Express server Gemini fallback)' : ''}`}
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border text-[11px] font-medium whitespace-nowrap ${config.cls}`}
    >
      {config.icon}
      <span>
        {config.label} ({config.sdkLabel})
      </span>
      {displayModel && <span className="font-mono opacity-80">· {displayModel}</span>}
      {typeof latencyMs === 'number' && latencyMs > 0 && (
        <span className="font-mono tabular-nums opacity-80">· {latencyMs} ms</span>
      )}
    </span>
  );
}
