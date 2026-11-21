import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkAudioSupport,
  getBcp47ForLanguage,
  mapMicrophoneError,
} from '../src/utils/audio.ts';

test('getBcp47ForLanguage returns accurate language tags and safe default', () => {
  assert.equal(getBcp47ForLanguage('Spanish'), 'es-ES');
  assert.equal(getBcp47ForLanguage('japanese'), 'ja-JP');
  assert.equal(getBcp47ForLanguage('Arabic'), 'ar-SA');
  assert.equal(getBcp47ForLanguage('UnknownLanguage'), 'en-US');
});

test('checkAudioSupport degrades cleanly outside browser DOM', () => {
  const status = checkAudioSupport();
  assert.equal(status.micSupported, false);
  assert.equal(status.browserTtsSupported, false);
  assert.ok(status.reason && status.reason.length > 0);
});

test('mapMicrophoneError translates DOMException permission and device errors cleanly', () => {
  const denied = new DOMException('Denied', 'NotAllowedError');
  assert.match(mapMicrophoneError(denied), /permission was denied/i);

  const notFound = new DOMException('No mic', 'NotFoundError');
  assert.match(mapMicrophoneError(notFound), /No microphone device was found/i);

  const inUse = new DOMException('Busy', 'NotReadableError');
  assert.match(mapMicrophoneError(inUse), /currently in use/i);
});
