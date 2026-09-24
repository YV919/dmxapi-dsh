import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDmxapiProtocolDraft } from '../src/config.ts';
import {
  createNewProviderDraft, existingPresetProviderIds, makeProviderDraftUnique, selectProviderDraft,
} from '../src/new-provider.ts';

test('repeated preset creation allocates a free route and never loads existing profile data', () => {
  for (const kind of ['chat', 'responses', 'anthropic'] as const) {
    const base = `dmxapi-${kind}`;
    const providers = { [base]: { baseURL: 'https://previous.invalid', apiKeyEnv: 'OLD_SHARED_KEY' }, [`${base}-2`]: {} };
    const before = structuredClone(providers);
    const draft = createNewProviderDraft(kind, providers);
    assert.equal(draft.id, `${base}-3`);
    assert.notEqual(draft.profile.baseURL, providers[base]!.baseURL);
    assert.equal(draft.profile.apiKeyEnv, undefined);
    assert.deepEqual(providers, before);
  }
});

test('import keeps authored config but allocates canonical unused preset suffix without altering input', () => {
  const draft = createDmxapiProtocolDraft('chat');
  draft.id = 'dmxapi-chat-2';
  draft.profile.apiKeyEnv = 'IMPORTED_REFERENCE';
  draft.profile.models![0]!.contextWindow = 123456;
  const before = structuredClone(draft);
  const next = makeProviderDraftUnique(draft, { 'dmxapi-chat': {}, 'dmxapi-chat-2': {}, 'dmxapi-chat-4': {} });
  assert.equal(next.id, 'dmxapi-chat-3');
  assert.equal(next.profile.apiKeyEnv, 'IMPORTED_REFERENCE');
  assert.equal(next.profile.models![0]!.contextWindow, 123456);
  assert.deepEqual(draft, before);
});

test('free authored IDs are preserved and custom draft never receives old provider content', () => {
  const draft = { id: 'mine', profile: { api: 'openai-responses', models: [{ id: 'mine-model' }] } };
  assert.deepEqual(makeProviderDraftUnique(draft, { another: {} }), draft);
  assert.equal(makeProviderDraftUnique(draft, { mine: {}, 'mine-2': {} }).id, 'mine-3');
  const custom = createNewProviderDraft('custom', { mine: {} });
  assert.equal(custom.id, '');
  assert.deepEqual(custom.profile.models, [{ id: '', input: ['text'] }]);
});

test('a preset selects its existing route with its authored model list and credentials intact', () => {
  const existing = {
    ...createDmxapiProtocolDraft('chat').profile,
    apiKeyEnv: 'EXISTING_DMXAPI_KEY',
    headers: { 'x-user-label': 'kept' },
    models: [{ id: 'previous-model', name: 'User model', input: ['text'] as const }],
  };
  const providers = {
    'dmxapi-chat': existing,
    'dmxapi-responses': createDmxapiProtocolDraft('responses').profile,
  };
  const selected = selectProviderDraft('chat', providers);
  assert.equal(selected.existingId, 'dmxapi-chat');
  assert.equal(selected.draft.id, 'dmxapi-chat');
  assert.deepEqual(selected.draft.profile, existing);
  assert.notStrictEqual(selected.draft.profile, existing);
  selected.draft.profile.models!.push({ id: 'new-model' });
  assert.deepEqual(existing.models.map(model => model.id), ['previous-model']);
});

test('preset selection finds only matching protocols and can select a historical copy exactly', () => {
  const chat = createDmxapiProtocolDraft('chat').profile;
  const providers = {
    'dmxapi-chat-10': { ...chat, displayName: 'Tenth copy' },
    'dmxapi-chat-3': { ...chat, displayName: 'Third copy' },
    'dmxapi-chat': { ...chat, displayName: 'Original' },
    'dmxapi-chat-2': createDmxapiProtocolDraft('responses').profile,
    'dmxapi-responses': createDmxapiProtocolDraft('responses').profile,
    'someone-else': chat,
  };
  assert.deepEqual(existingPresetProviderIds('chat', providers), [
    'dmxapi-chat', 'dmxapi-chat-3', 'dmxapi-chat-10',
  ]);
  assert.equal(selectProviderDraft('chat', providers, 'dmxapi-chat-3').draft.profile.displayName, 'Third copy');
  assert.equal(selectProviderDraft('chat', providers).draft.profile.displayName, 'Original');
  assert.throws(() => selectProviderDraft('chat', providers, 'dmxapi-chat-2'), /协议已变化/);
});

test('explicit creation remains available even when a matching preset route exists', () => {
  for (const kind of ['chat', 'responses', 'anthropic'] as const) {
    const base = `dmxapi-${kind}`;
    const providers = { [base]: createDmxapiProtocolDraft(kind).profile };
    const selected = selectProviderDraft(kind, providers, '');
    assert.equal(selected.existingId, null);
    assert.equal(selected.draft.id, `${base}-2`);
    assert.equal(selected.draft.profile.apiKeyEnv, undefined);
    assert.equal(selectProviderDraft(kind, {})?.draft.id, base);
  }
  const custom = selectProviderDraft('custom', { 'dmxapi-chat': createDmxapiProtocolDraft('chat').profile });
  assert.equal(custom.existingId, null);
  assert.equal(custom.draft.id, '');
});
