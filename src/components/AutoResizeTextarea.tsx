import React, { useEffect, useRef } from 'react';
import { shouldSubmitComposerKey } from '../utils/historyUtils';

interface AutoResizeTextareaProps
  extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'onSubmit'> {
  value: string;
  maxHeightPx?: number;
  onSubmit?: () => void;
}

export function AutoResizeTextarea({
  value,
  maxHeightPx = 168,
  onSubmit,
  onKeyDown,
  className = '',
  rows = 1,
  ...rest
}: AutoResizeTextareaProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const nextHeight = Math.min(el.scrollHeight, maxHeightPx);
    el.style.height = `${nextHeight}px`;
    el.style.overflowY = el.scrollHeight > maxHeightPx ? 'auto' : 'hidden';
  }, [value, maxHeightPx]);

  return (
    <textarea
      ref={textareaRef}
      rows={rows}
      value={value}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (e.defaultPrevented) return;
        if (
          onSubmit &&
          shouldSubmitComposerKey({
            key: e.key,
            shiftKey: e.shiftKey,
            isComposing: e.nativeEvent.isComposing,
          })
        ) {
          e.preventDefault();
          onSubmit();
        }
      }}
      className={`resize-none ${className}`}
      {...rest}
    />
  );
}
