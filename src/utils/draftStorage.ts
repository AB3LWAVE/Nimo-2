import { useEffect, useRef } from 'react';

export const DRAFT_STORAGE_KEYS = {
  app: 'nimo:draft:v1:app',
  chat: 'nimo:draft:v1:chat',
  learn: 'nimo:draft:v1:learn',
  create: 'nimo:draft:v1:create',
} as const;

function getStorage(storage?: Storage | null): Storage | null {
  if (storage !== undefined) return storage;
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readDraft<T extends Record<string, unknown>>(
  key: string,
  defaults: T,
  storage?: Storage | null
): T {
  const target = getStorage(storage);
  if (!target) return { ...defaults };

  try {
    const raw = target.getItem(key);
    if (!raw) return { ...defaults };
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...defaults };
    }
    return {
      ...defaults,
      ...(parsed as Partial<T>),
    };
  } catch {
    return { ...defaults };
  }
}

export function writeDraft<T>(
  key: string,
  value: T,
  storage?: Storage | null
): boolean {
  const target = getStorage(storage);
  if (!target) return false;

  try {
    target.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function removeDraft(key: string, storage?: Storage | null): void {
  const target = getStorage(storage);
  if (!target) return;

  try {
    target.removeItem(key);
  } catch {
    // Ignore storage removal failures
  }
}

/**
 * Automatically persists the latest draft state to localStorage with a short debounce,
 * and flushes synchronously on component unmount or page unload/hide so switching tabs
 * or refreshing the browser never drops recent keystrokes.
 */
export function useAutoSaveDraft<T>(
  key: string,
  value: T,
  delayMs = 200
): void {
  const latestRef = useRef<T>(value);
  latestRef.current = value;

  useEffect(() => {
    const timer = setTimeout(() => {
      writeDraft(key, latestRef.current);
    }, delayMs);

    return () => {
      clearTimeout(timer);
      writeDraft(key, latestRef.current);
    };
  }, [key, value, delayMs]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const flush = () => {
      writeDraft(key, latestRef.current);
    };
    window.addEventListener('beforeunload', flush);
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      window.removeEventListener('pagehide', flush);
    };
  }, [key]);
}
