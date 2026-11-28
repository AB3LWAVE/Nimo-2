import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getMostRecentTimestampMillis,
  getTimestampMillis,
  shouldSubmitComposerKey,
  sortByMostRecentTimestamp,
} from '../src/utils/historyUtils';

test('getTimestampMillis handles numbers, Dates, Firestore-like timestamps, and empty values', () => {
  assert.equal(getTimestampMillis(null), 0);
  assert.equal(getTimestampMillis(undefined), 0);
  assert.equal(getTimestampMillis(1700000000000), 1700000000000);
  assert.equal(getTimestampMillis(new Date(1700000005000)), 1700000005000);
  assert.equal(
    getTimestampMillis({ toMillis: () => 1700000010000 }),
    1700000010000
  );
});

test('sortByMostRecentTimestamp places newest/most recently updated item first', () => {
  const older = { id: 'old', createdAt: 1000, updatedAt: 1000 };
  const updatedOld = { id: 'revisited', createdAt: 500, updatedAt: 5000 };
  const newestCreated = { id: 'new', createdAt: 4000 };

  const sorted = sortByMostRecentTimestamp([older, newestCreated, updatedOld]);
  assert.deepEqual(
    sorted.map((x) => x.id),
    ['revisited', 'new', 'old']
  );
  assert.equal(getMostRecentTimestampMillis(updatedOld), 5000);
});

test('shouldSubmitComposerKey submits on plain Enter and keeps Shift+Enter or IME composition as newline/noop', () => {
  assert.equal(
    shouldSubmitComposerKey({ key: 'Enter', shiftKey: false, isComposing: false }),
    true
  );
  assert.equal(
    shouldSubmitComposerKey({ key: 'Enter', shiftKey: true, isComposing: false }),
    false
  );
  assert.equal(
    shouldSubmitComposerKey({ key: 'Enter', shiftKey: false, isComposing: true }),
    false
  );
  assert.equal(
    shouldSubmitComposerKey({ key: 'a', shiftKey: false, isComposing: false }),
    false
  );
});
