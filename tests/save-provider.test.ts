import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDmxapiDraft } from '../src/config.ts'
import { saveProvider, type SaveSnapshot } from '../src/client/save-provider.ts'

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
    }), /已经存在.*仅新增/)
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
