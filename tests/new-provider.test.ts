import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDmxapiProtocolDraft } from '../src/config.ts';
import { createNewProviderDraft, makeProviderDraftUnique } from '../src/new-provider.ts';

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
