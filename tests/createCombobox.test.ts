import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTION_SUGGESTIONS,
  TONE_SUGGESTIONS,
  buildWritingStudioPrompt,
  filterComboboxSuggestions,
} from '../src/utils/createCombobox.ts';

test('filterComboboxSuggestions returns all options on empty or whitespace query', () => {
  assert.deepEqual(filterComboboxSuggestions(TONE_SUGGESTIONS, ''), [...TONE_SUGGESTIONS]);
  assert.deepEqual(filterComboboxSuggestions(ACTION_SUGGESTIONS, '   '), [
    ...ACTION_SUGGESTIONS,
  ]);
});

test('filterComboboxSuggestions filters case-insensitively by substring', () => {
  assert.deepEqual(filterComboboxSuggestions(TONE_SUGGESTIONS, 'pro'), ['professional']);
  assert.deepEqual(filterComboboxSuggestions(TONE_SUGGESTIONS, 'CON'), [
    'conversational',
    'concise',
  ]);
  assert.deepEqual(filterComboboxSuggestions(ACTION_SUGGESTIONS, 'ri'), [
    'rewrite',
    'summarize',
  ]);
  assert.deepEqual(filterComboboxSuggestions(ACTION_SUGGESTIONS, 'umm'), ['summarize']);
  assert.deepEqual(filterComboboxSuggestions(ACTION_SUGGESTIONS, 'custom-xyz'), []);
});

test('buildWritingStudioPrompt generates fresh draft when action is generate or source is empty', () => {
  const res = buildWritingStudioPrompt({
    action: 'generate',
    tone: 'conversational',
    instructions: 'Launch post for NIMO hybrid AI',
    sourceText: '',
  });
  assert.equal(res.category, 'writing');
  assert.equal(res.isRewriteMode, false);
  assert.match(res.prompt, /conversational/i);
  assert.match(res.prompt, /Launch post for NIMO hybrid AI/);
});

test('buildWritingStudioPrompt applies custom tone and custom action when source text exists', () => {
  const res = buildWritingStudioPrompt({
    action: 'turn into release notes',
    tone: 'warm executive',
    instructions: 'Keep bullets tight',
    sourceText: 'We shipped App Check fixes and history drawers.',
  });
  assert.equal(res.category, 'rewrite');
  assert.equal(res.isRewriteMode, true);
  assert.match(res.prompt, /turn into release notes/);
  assert.match(res.prompt, /warm executive/);
  assert.match(res.prompt, /We shipped App Check fixes/);
});
