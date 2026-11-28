import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DRAFT_STORAGE_KEYS,
  readDraft,
  removeDraft,
  writeDraft,
} from '../src/utils/draftStorage.ts';

function createMemoryStorage(options?: { throwOnSet?: boolean; throwOnGet?: boolean }): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      if (options?.throwOnGet) throw new Error('Storage denied');
      return map.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      if (options?.throwOnSet) throw new Error('QuotaExceededError');
      map.set(key, value);
    },
  };
}

test('writeDraft and readDraft persist and merge draft fields cleanly', () => {
  const storage = createMemoryStorage();
  const defaults = {
    input: '',
    activeThreadId: null as string | null,
    subMode: 'write',
  };

  assert.equal(writeDraft(DRAFT_STORAGE_KEYS.chat, { input: 'Hello Nimo' }, storage), true);

  const restored = readDraft(DRAFT_STORAGE_KEYS.chat, defaults, storage);
  assert.equal(restored.input, 'Hello Nimo');
  assert.equal(restored.activeThreadId, null);
  assert.equal(restored.subMode, 'write');
});

test('readDraft falls back safely on malformed JSON or non-object payloads', () => {
  const storage = createMemoryStorage();
  const defaults = { input: 'default prompt', count: 3 };

  storage.setItem(DRAFT_STORAGE_KEYS.learn, '{not-valid-json');
  assert.deepEqual(readDraft(DRAFT_STORAGE_KEYS.learn, defaults, storage), defaults);

  storage.setItem(DRAFT_STORAGE_KEYS.learn, '["array"]');
  assert.deepEqual(readDraft(DRAFT_STORAGE_KEYS.learn, defaults, storage), defaults);
});

test('draftStorage handles storage quota errors and removal safely', () => {
  const failingStorage = createMemoryStorage({ throwOnSet: true, throwOnGet: true });
  assert.equal(writeDraft('k', { a: 1 }, failingStorage), false);
  assert.deepEqual(readDraft('k', { a: 2 }, failingStorage), { a: 2 });

  const storage = createMemoryStorage();
  writeDraft('k', { a: 99 }, storage);
  removeDraft('k', storage);
  assert.deepEqual(readDraft('k', { a: 2 }, storage), { a: 2 });
});
