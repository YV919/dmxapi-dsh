import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDmxapiProtocolDraft } from '../src/config.ts';
import { assertExistingModelEdit, redactHiddenYamlFields, restoreHiddenYamlFields } from '../src/model-edit.ts';

test('existing route model and default effort edits leave provider fields untouched', () => {
  const before = createDmxapiProtocolDraft('chat');
  before.profile.apiKeyEnv = 'EXISTING_DMXAPI_KEY';
  before.profile.headers = { 'x-request-tag': 'preserved' };
  const after = structuredClone(before);
  after.profile.models![0]!.contextWindow = 524_288;
  after.profile.models!.push({ id: 'added-model', input: ['text', 'image'] });
  after.profile.reasoning = 'low';
  assert.doesNotThrow(() => assertExistingModelEdit(before, after, false));
  assert.equal(before.profile.models!.length + 1, after.profile.models!.length);
  assert.equal(before.profile.apiKeyEnv, after.profile.apiKeyEnv);
});

test('existing route edit rejects provider identity and configuration changes', () => {
  const before = createDmxapiProtocolDraft('chat');
  const renamed = structuredClone(before);
  renamed.id = 'dmxapi-chat-2';
  assert.throws(() => assertExistingModelEdit(before, renamed, false), /不能修改服务商标识/);

  for (const field of ['displayName', 'baseURL', 'apiKeyEnv'] as const) {
    const changed = structuredClone(before);
    changed.profile[field] = 'unexpected-change';
    assert.throws(() => assertExistingModelEdit(before, changed, false), /只能修改模型和默认思考等级/, field);
  }
});

test('YAML model rename cannot silently lose a hidden request header', () => {
  const before = createDmxapiProtocolDraft('chat');
  before.profile.models = [{ id: 'old-model', input: ['text'], headers: { authorization: 'Bearer private' } }];
  const renamed = structuredClone(before);
  renamed.profile.models![0]!.id = 'new-model';
  delete renamed.profile.models![0]!.headers;
  assert.throws(() => assertExistingModelEdit(before, renamed, true), /隐藏字段/);

  const editedInForm = structuredClone(before);
  editedInForm.profile.models![0]!.id = 'new-model';
  assert.doesNotThrow(() => assertExistingModelEdit(before, editedInForm, false));

  const sameIdInYaml = structuredClone(before);
  sameIdInYaml.profile.models![0]!.name = 'Updated display name';
  assert.doesNotThrow(() => assertExistingModelEdit(before, sameIdInYaml, true));
});

test('YAML round-trip restores every redacted field on unchanged model IDs', () => {
  const original: { models: Array<{ id: string; name?: string; headers?: Record<string, string>; secret?: string; custom: Record<string, unknown> }> } = {
    models: [
      { id: 'first', name: 'Before', headers: { authorization: 'Bearer fixture' }, custom: { token: 'fixture-token', option: 1 } },
      { id: 'second', secret: 'fixture-secret', custom: { keep: true } },
    ],
  };
  const visible = redactHiddenYamlFields(original) as typeof original;
  assert.equal(visible.models[0]!.headers, undefined);
  assert.equal(visible.models[0]!.custom.token, undefined);
  assert.equal(visible.models[1]!.secret, undefined);
  visible.models[0]!.name = 'After';
  const restored = restoreHiddenYamlFields(visible, original) as typeof original;
  assert.equal(restored.models[0]!.name, 'After');
  assert.deepEqual(restored.models[0]!.headers, original.models[0]!.headers);
  assert.equal(restored.models[0]!.custom.token, 'fixture-token');
  assert.equal(restored.models[1]!.secret, 'fixture-secret');
  assert.deepEqual(original.models[0]!.custom, { token: 'fixture-token', option: 1 });
});

test('YAML cannot rename a model with any hidden field', () => {
  const before = createDmxapiProtocolDraft('chat');
  before.profile.models = [{ id: 'old-model', input: ['text'], custom: { token: 'fixture-token' } }];
  const renamed = structuredClone(before);
  renamed.profile.models![0]!.id = 'new-model';
  delete (renamed.profile.models![0]!.custom as Record<string, unknown>).token;
  assert.throws(() => assertExistingModelEdit(before, renamed, true), /隐藏字段/);
});

test('YAML cannot delete or replace an ancestor of a hidden field', () => {
  const original = { models: [{ id: 'kept-id', custom: { token: 'fixture-token', option: 1 } }] };
  const deletedParent = { models: [{ id: 'kept-id' }] };
  assert.throws(() => restoreHiddenYamlFields(deletedParent, original), /隐藏字段/);
  const replacedParent = { models: [{ id: 'kept-id', custom: null }] };
  assert.throws(() => restoreHiddenYamlFields(replacedParent, original), /隐藏字段/);
  assert.deepEqual(original.models[0]!.custom, { token: 'fixture-token', option: 1 });
});

test('YAML cannot discard or remap a hidden field in an unkeyed nested array', () => {
  const original = { models: [{ id: 'kept-id', custom: { items: [
    { token: 'fixture-token', option: 1 }, { option: 2 },
  ] } }] };
  const unchanged = redactHiddenYamlFields(original);
  assert.deepEqual(restoreHiddenYamlFields(unchanged, original), original);
  const deleted = { models: [{ id: 'kept-id', custom: { items: [{ option: 2 }] } }] };
  assert.throws(() => restoreHiddenYamlFields(deleted, original), /隐藏字段/);
  const reordered = { models: [{ id: 'kept-id', custom: { items: [{ option: 2 }, { option: 1 }] } }] };
  assert.throws(() => restoreHiddenYamlFields(reordered, original), /隐藏字段/);
});
