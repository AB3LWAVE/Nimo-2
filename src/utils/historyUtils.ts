export function getTimestampMillis(ts: unknown): number {
  if (!ts) return 0;
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
  if (ts instanceof Date) return ts.getTime();
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

export function getMostRecentTimestampMillis(item: {
  updatedAt?: unknown;
  createdAt?: unknown;
}): number {
  return Math.max(getTimestampMillis(item.updatedAt), getTimestampMillis(item.createdAt));
}

export function sortByMostRecentTimestamp<
  T extends { updatedAt?: unknown; createdAt?: unknown },
>(items: T[]): T[] {
  return [...items].sort(
    (a, b) => getMostRecentTimestampMillis(b) - getMostRecentTimestampMillis(a)
  );
}

export function shouldSubmitComposerKey(e: {
  key: string;
  shiftKey: boolean;
  isComposing?: boolean;
}): boolean {
  if (e.isComposing) return false;
  return e.key === 'Enter' && !e.shiftKey;
}
