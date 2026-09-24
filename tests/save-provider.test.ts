import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDmxapiDraft, createDmxapiProtocolDraft } from '../src/config.ts'
import { saveProvider, saveProviderModels, type ProviderPathOp, type SaveSnapshot } from '../src/client/save-provider.ts'

const snapshot = (revision = 7): SaveSnapshot => ({
  status: 'ready', writable: true, mode: 'host', revision, value: { providers: {} },
})

test('new save changes one provider path and retains the opened revision', async () => {
  let accepted: unknown
  const calls: unknown[] = []
  const draft = createDmxapiDraft()
  await saveProvider(draft, 7, {
    snapshot: () => snapshot(),
    mutate: async (...args) => { calls.push(args); return { ok: true, value: { revision: 8 } } },
    accept: view => { accepted = view },
  })
  assert.deepEqual(calls, [['llm-pi-ai', [{ op: 'set', path: ['providers', 'dmxapi'], value: draft.profile }], 7]])
  assert.deepEqual(accepted, { revision: 8 })
})

for (const failure of ['settings/conflict', 'settings/rejected']) {
  test(`${failure} is never reported as saved`, async () => {
    let accepted = false
    await assert.rejects(saveProvider(createDmxapiDraft(), 2, {
      snapshot: () => snapshot(2),
      mutate: async () => ({ ok: false, error: { code: failure, message: 'invalid model' } }),
      accept: () => { accepted = true },
    }))
    assert.equal(accepted, false)
  })
}

test('loading, unavailable, stale, memory, read-only and incomplete snapshots are refused before mutation', async () => {
  for (const change of [
    { revision: 3 }, { writable: false }, { mode: 'memory' },
    { status: 'loading' }, { status: 'unavailable' }, { value: undefined },
  ] as const) {
    await assert.rejects(saveProvider(createDmxapiDraft(), 2, {
      snapshot: () => ({ ...snapshot(2), ...change }),
      mutate: async () => { assert.fail('must not mutate') },
      accept: () => { assert.fail('must not accept') },
    }))
  }
})

test('an existing effective provider cannot be overwritten, including inherited and falsy own entries', async () => {
  for (const existing of [{ apiKeyEnv: 'KEEP_OLD_KEY' }, undefined, null]) {
    const current = { ...snapshot(), value: { providers: { dmxapi: existing } } }
    await assert.rejects(saveProvider(createDmxapiDraft(), 7, {
      snapshot: () => current,
      mutate: async () => { assert.fail('existing routes must not be mutated') },
      accept: () => { assert.fail('existing routes must not be accepted') },
    }), /已经存在.*新建独立配置/)
    assert.equal(current.value.providers.dmxapi, existing)
  }
})

test('concurrent additions with one captured revision cannot both commit', async () => {
  const initial = snapshot()
  let revision = 7
  let calls = 0
  const results = await Promise.allSettled([1, 2].map(() => saveProvider(createDmxapiDraft(), 7, {
    snapshot: () => initial,
    mutate: async (_ns, _ops, expected) => {
      calls++
      if (expected !== revision) return { ok: false as const, error: { code: 'settings/conflict', message: 'changed' } }
      revision++
      return { ok: true as const, value: { revision } }
    },
    accept: () => {},
  })))
  assert.equal(calls, 2)
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected'])
  assert.equal(revision, 8)
})

test('editing a preset sends only model path, retaining provider credentials and sibling routes', async () => {
  const draft = createDmxapiProtocolDraft('chat')
  draft.profile.models!.push({ id: 'my-new-model', input: ['text', 'image'], contextWindow: 262_144 })
  const original = {
    ...createDmxapiProtocolDraft('chat').profile,
    apiKeyEnv: 'OLD_DMXAPI_KEY',
    headers: { 'x-route-tag': 'keep' },
    customField: { enabled: true },
  }
  const sibling = createDmxapiProtocolDraft('responses').profile
  const providers = { [draft.id]: original, 'dmxapi-responses': sibling }
  const before = structuredClone(providers)
  const calls: [string, ProviderPathOp[], number][] = []
  let accepted: unknown

  await saveProviderModels(draft, 7, {
    snapshot: () => ({ ...snapshot(), value: { providers } }),
    mutate: async (...args) => {
      calls.push(args)
      return { ok: true, value: { revision: 8 } }
    },
    accept: view => { accepted = view },
  })

  assert.deepEqual(calls, [[
    'llm-pi-ai',
    [{ op: 'set', path: ['providers', draft.id, 'models'], value: draft.profile.models }],
    7,
  ]])
  assert.deepEqual(providers, before)
  assert.deepEqual(accepted, { revision: 8 })
  draft.profile.models![0]!.name = 'changed after save'
  assert.notEqual((calls[0]![1][0] as { value: typeof draft.profile.models }).value![0]!.name,
    'changed after save')
})

test('editing provider default effort sets or unsets only its reasoning path', async () => {
  const draft = createDmxapiProtocolDraft('responses')
  const initial = structuredClone(draft.profile)
  initial.reasoning = 'low'
  draft.profile.reasoning = 'max'
  const operations: ProviderPathOp[][] = []
  const port = {
    snapshot: () => ({ ...snapshot(), value: { providers: { [draft.id]: initial } } }),
    mutate: async (_namespace: string, ops: ProviderPathOp[]) => {
      operations.push(ops)
      return { ok: true as const, value: { revision: 8 } }
    },
    accept: () => {},
  }
  await saveProviderModels(draft, 7, port)
  assert.deepEqual(operations[0], [
    { op: 'set', path: ['providers', draft.id, 'models'], value: draft.profile.models },
    { op: 'set', path: ['providers', draft.id, 'reasoning'], value: 'max' },
  ])

  delete draft.profile.reasoning
  await saveProviderModels(draft, 7, port)
  assert.deepEqual(operations[1], [
    { op: 'set', path: ['providers', draft.id, 'models'], value: draft.profile.models },
    { op: 'unset', path: ['providers', draft.id, 'reasoning'] },
  ])
})

test('existing model edit refuses stale, unavailable, missing, protocol-changed and overridden routes', async () => {
  const draft = createDmxapiProtocolDraft('chat')
  const valid = { ...snapshot(), value: { providers: { [draft.id]: draft.profile } } }
  const invalid: SaveSnapshot[] = [
    { ...valid, revision: 9 },
    { ...valid, status: 'loading' },
    { ...valid, status: 'unavailable' },
    { ...valid, writable: false },
    { ...valid, mode: 'memory' },
    { ...valid, value: undefined },
    { ...valid, value: { providers: {} } },
    { ...valid, value: { providers: { [draft.id]: null } } },
    { ...valid, value: { providers: { [draft.id]: { ...draft.profile, api: 'openai-responses' } } } },
    { ...valid, value: { providers: { [draft.id]: { ...draft.profile,
      modelOverrides: { 'other-model': { name: 'modified' } } } } } },
  ]
  for (const current of invalid) {
    await assert.rejects(saveProviderModels(draft, 7, {
      snapshot: () => current,
      mutate: async () => { assert.fail('must not mutate invalid or stale route') },
      accept: () => { assert.fail('must not accept failed edit') },
    }))
  }
})

test('model edit reports a server conflict without accepting an uncommitted view', async () => {
  const draft = createDmxapiProtocolDraft('anthropic')
  let accepted = false
  await assert.rejects(saveProviderModels(draft, 7, {
    snapshot: () => ({ ...snapshot(), value: { providers: { [draft.id]: draft.profile } } }),
    mutate: async () => ({ ok: false, error: { code: 'settings/conflict', message: 'changed' } }),
    accept: () => { accepted = true },
  }), /版本冲突/)
  assert.equal(accepted, false)
})

test('clearing an inherited default effort is rejected instead of silently restoring it', async () => {
  const draft = createDmxapiProtocolDraft('responses')
  delete draft.profile.reasoning
  const inherited = { ...draft.profile, reasoning: 'high' }
  await assert.rejects(saveProviderModels(draft, 7, {
    snapshot: () => ({
      ...snapshot(),
      value: { providers: { [draft.id]: inherited } },
      base: { providers: { [draft.id]: inherited } },
    }),
    mutate: async () => { assert.fail('must not save a no-op unset over inherited reasoning') },
    accept: () => { assert.fail('must not accept a failed edit') },
  }), /继承了默认思考等级/)
})
