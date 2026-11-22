import assert from 'node:assert/strict';
import test from 'node:test';
import { AIError, AIErrorCode, InferenceMode } from 'firebase/ai';
import {
  DEFAULT_CLOUD_MODEL,
  getHybridRuntimeStatus,
  mapAiError,
  normalizeInferenceMode,
  shouldUseServerHybridFallback,
  toSdkInferenceMode,
} from '../src/services/hybridAi.ts';

test('toSdkInferenceMode maps Nimo preferences to official firebase/ai InferenceMode enum', () => {
  assert.equal(toSdkInferenceMode('prefer_on_device'), InferenceMode.PREFER_ON_DEVICE);
  assert.equal(toSdkInferenceMode('only_on_device'), InferenceMode.ONLY_ON_DEVICE);
  assert.equal(toSdkInferenceMode('prefer_in_cloud'), InferenceMode.PREFER_IN_CLOUD);
  assert.equal(toSdkInferenceMode('only_in_cloud'), InferenceMode.ONLY_IN_CLOUD);
});

test('normalizeInferenceMode maps legacy modes and defaults safely', () => {
  assert.equal(normalizeInferenceMode('fast'), 'prefer_on_device');
  assert.equal(normalizeInferenceMode('thinking'), 'only_in_cloud');
  assert.equal(normalizeInferenceMode('vision'), 'only_in_cloud');
  assert.equal(normalizeInferenceMode('only_on_device'), 'only_on_device');
  assert.equal(normalizeInferenceMode(undefined), 'prefer_on_device');
});

test('mapAiError handles ONLY_ON_DEVICE unavailability without falsely claiming cloud fallback', () => {
  const err = new AIError(AIErrorCode.UNSUPPORTED, 'LanguageModel unavailable');
  const mapped = mapAiError(err, 'only_on_device', true);
  assert.equal(mapped.retryable, false);
  assert.match(mapped.message, /On-device model is not ready/i);
});

test('mapAiError flags offline cloud failures clearly', () => {
  const mapped = mapAiError(new Error('Failed to fetch'), 'only_in_cloud', false);
  assert.equal(mapped.code, 'offline');
  assert.equal(mapped.retryable, true);
  assert.match(mapped.message, /offline/i);
});

test('mapAiError distinguishes API_NOT_ENABLED, 403 App Check, and 429 quota errors', () => {
  const apiDisabled = mapAiError(
    new AIError(AIErrorCode.API_NOT_ENABLED, 'firebaseai.googleapis.com disabled'),
    'prefer_on_device',
    true
  );
  assert.equal(apiDisabled.retryable, false);
  assert.match(apiDisabled.message, /Firebase AI Logic API is not enabled/i);

  const appCheckErr = mapAiError(new Error('403 App Check failed'), 'only_in_cloud', true);
  assert.equal(appCheckErr.code, 'app_check_or_403');
  assert.equal(appCheckErr.retryable, false);

  const quotaErr = mapAiError(new Error('429 RESOURCE_EXHAUSTED'), 'only_in_cloud', true);
  assert.equal(quotaErr.code, 'quota_429');
  assert.equal(quotaErr.retryable, true);
});

test('shouldUseServerHybridFallback strictly respects only_on_device and offline state', () => {
  const apiErr = new AIError(AIErrorCode.API_NOT_ENABLED, 'firebaseai.googleapis.com disabled');
  assert.equal(shouldUseServerHybridFallback(apiErr, 'only_on_device', true), false);
  assert.equal(shouldUseServerHybridFallback(apiErr, 'prefer_on_device', false), false);
  assert.equal(shouldUseServerHybridFallback(apiErr, 'prefer_on_device', true), true);
  assert.equal(shouldUseServerHybridFallback(new Error('403 App Check'), 'only_in_cloud', true), true);
});

test('hybridAi initializes gracefully with safe defaults when optional env vars are unset', () => {
  assert.equal(DEFAULT_CLOUD_MODEL, 'gemini-3.5-flash-lite');
  const status = getHybridRuntimeStatus();
  assert.equal(status.cloudModel, 'gemini-3.5-flash-lite');
  assert.equal(status.appCheckStatus, 'unconfigured-site-key');
  assert.equal(status.lastInferenceSource, null);
  assert.equal(status.lastModelUsed, null);
  assert.equal(status.lastLatencyMs, null);
});
