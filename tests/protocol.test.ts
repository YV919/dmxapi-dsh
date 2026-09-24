import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDmxapiDraft } from '../src/config.ts';
import { normalizeProtocolDraft } from '../src/protocol.ts';
import { saveConfiguration } from '../src/client/save-configuration.ts';

test('Responses removes only incompatible DeepSeek switches and leaves the authored draft intact', () => {
  const source = createDmxapiDraft();
  source.profile.api = 'openai-responses';
  const before = structuredClone(source);
  const result = normalizeProtocolDraft(source);
  assert.deepEqual(result.draft.profile.compat, { supportsDeveloperRole: false });
  assert.equal(result.removedCompat.length, 3);
  assert.equal(result.baseURLChanged, false);
  assert.deepEqual(source, before);
  assert.deepEqual(result.draft.profile.models, source.profile.models);
  assert.equal(result.draft.profile.apiKeyEnv, source.profile.apiKeyEnv);
});

test('Anthropic removes DeepSeek compat and fixes the exact DMXAPI SDK base address', () => {
  const source = createDmxapiDraft();
  source.profile.api = 'anthropic-messages';
  source.profile.compat!.forceAdaptiveThinking = true;
  source.profile.compat!.supportsTemperature = false;
  source.profile.headers = { 'x-custom': 'keep-value' };
  const result = normalizeProtocolDraft(source);
  assert.deepEqual(result.draft.profile.compat, { forceAdaptiveThinking: true, supportsTemperature: false });
  assert.equal(result.removedCompat.length, 4);
  assert.equal(result.draft.profile.baseURL, 'https://www.dmxapi.cn');
  assert.equal(result.baseURLChanged, true);
  assert.deepEqual(result.draft.profile.headers, source.profile.headers);
  assert.deepEqual(result.draft.profile.models, source.profile.models);
});

test('model and override compat are cleaned with valid target settings and unknown fields preserved', () => {
  const source = createDmxapiDraft();
  source.profile.api = 'openai-responses';
  source.profile.models![0].compat = { thinkingFormat: 'deepseek', supportsStrictMode: false, unknownTypo: true };
  source.profile.modelOverrides = { example: { compat: { forceAdaptiveThinking: true, supportsMaxOutputTokens: false } } };
  const result = normalizeProtocolDraft(source);
  assert.deepEqual(result.draft.profile.models![0].compat, { supportsStrictMode: false, unknownTypo: true });
  assert.deepEqual(result.draft.profile.modelOverrides, { example: { compat: { supportsMaxOutputTokens: false } } });
  assert.ok(result.removedCompat.includes('models[0].compat.thinkingFormat'));
  assert.ok(result.removedCompat.includes('modelOverrides.example.compat.forceAdaptiveThinking'));
});

test('unknown or withheld compat names stay visible to Host validation', () => {
  const source = createDmxapiDraft();
  source.profile.api = 'anthropic-messages';
  source.profile.compat = { thinkingFormats: 'typo', supportsMidConvoEffort: true };
  assert.deepEqual(normalizeProtocolDraft(source).draft.profile.compat, source.profile.compat);
});

test('Completions retains its preset, and changing an unsaved API back does not lose its settings', () => {
  const source = createDmxapiDraft();
  assert.deepEqual(normalizeProtocolDraft(source).draft, source);
  source.profile.api = 'anthropic-messages';
  normalizeProtocolDraft(source);
  source.profile.api = 'openai-completions';
  assert.deepEqual(normalizeProtocolDraft(source).draft, createDmxapiDraft());
});

test('normalization is idempotent and reverses only exact DMXAPI base URLs', () => {
  for (const api of ['openai-completions', 'openai-responses', 'anthropic-messages']) {
    const source = createDmxapiDraft();
    source.profile.api = api;
    for (const baseURL of ['https://www.dmxapi.cn', 'https://www.dmxapi.cn/', 'https://www.dmxapi.cn/v1', 'https://www.dmxapi.cn/v1/']) {
      source.profile.baseURL = baseURL;
      const normalized = normalizeProtocolDraft(source).draft;
      assert.equal(normalized.profile.baseURL, api === 'anthropic-messages' ? 'https://www.dmxapi.cn' : 'https://www.dmxapi.cn/v1');
      assert.deepEqual(normalizeProtocolDraft(normalized), { draft: normalized, removedCompat: [], baseURLChanged: false });
    }
    for (const baseURL of ['https://gateway.example/v1', 'http://127.0.0.1:1234/proxy', 'https://www.dmxapi.cn/custom/v1', 'https://www.dmxapi.cn/v1?route=test']) {
      source.profile.baseURL = baseURL;
      assert.equal(normalizeProtocolDraft(source).draft.profile.baseURL, baseURL);
    }
  }
});

test('unhandled protocols and missing api keep their configuration for Host interpretation', () => {
  for (const api of ['openai-codex-responses', undefined]) {
    const source = createDmxapiDraft();
    source.profile.api = api;
    assert.deepEqual(normalizeProtocolDraft(source), { draft: source, removedCompat: [], baseURLChanged: false });
  }
});

test('saveConfiguration also normalizes old broken drafts without changing credentials or effort mappings', async () => {
  for (const api of ['openai-responses', 'anthropic-messages']) {
    const source = createDmxapiDraft();
    source.profile.api = api;
    source.profile.models![0].reasoningEfforts = { off: null, high: 'custom-wire-effort' };
    const expected = normalizeProtocolDraft(source).draft;
    const result = await saveConfiguration(source, 4, '', {
      save: async (next, revision) => { assert.deepEqual(next, expected); assert.equal(revision, 4); return 5; },
      setCredential: async () => { assert.fail('blank input must preserve existing credentials'); },
    });
    assert.deepEqual(result, { draft: expected, revision: 5, credential: 'unchanged' });
  }
});
