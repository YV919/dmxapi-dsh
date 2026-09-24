import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDmxapiDraft, type ProviderDraft, type ProviderProfile } from '../src/config.ts'
import { retryConfigurationCredential, saveConfiguration } from '../src/client/save-configuration.ts'
import { saveProvider, type SaveSnapshot } from '../src/client/save-provider.ts'

function unnamedDraft(id = 'dmxapi'): ProviderDraft {
  const draft = createDmxapiDraft()
  draft.id = id
  delete draft.profile.apiKeyEnv
  return draft
}

function fakeStore(failures = 0) {
  let revision = 4
  let attempts = 0
  const providers: Record<string, ProviderProfile> = {
    old: { apiKeyEnv: 'SHARED_OLD_KEY', displayName: 'Keep original' },
  }
  const credentials = new Map([['SHARED_OLD_KEY', 'old-secret']])
  const writes: string[] = []
  const snapshot = (): SaveSnapshot => ({ status: 'ready', writable: true, mode: 'host', revision, value: { providers } })
  return {
    providers, credentials, writes, snapshot,
    get revision() { return revision },
    bumpRevision() { revision++ },
    port: {
      snapshot,
      save: async (next: ProviderDraft, expected: number) => (await saveProvider(next, expected, {
        snapshot,
        mutate: async (_ns, ops, expectedRevision) => {
          assert.equal(expectedRevision, revision)
          const operation = ops[0]
          writes.push('provider')
          // Host materializes profile schema defaults when it returns effective settings.
          providers[operation.path[1]] = { defaultContextWindow: 1_000_000, ...structuredClone(operation.value as ProviderProfile) }
          revision++
          return { ok: true as const, value: { revision } }
        },
        accept: () => {},
      })).revision,
      setCredential: async (ref: string, value: string) => {
        writes.push(ref)
        if (attempts++ < failures) return { ok: false as const, error: 'test failure' }
        credentials.set(ref, value)
        return { ok: true as const }
      },
    },
  }
}

test('configuration receives a unique reference and only credential storage receives the trimmed key', async () => {
  const draft = unnamedDraft()
  const original = structuredClone(draft)
  const store = fakeStore()
  const result = await saveConfiguration(draft, store.revision, '  test-secret-only  ', store.port)
  const reference = result.draft.profile.apiKeyEnv!
  assert.match(reference, /^DSH_DMXAPI_[a-f0-9]{32}_API_KEY$/)
  assert.deepEqual(store.writes, ['provider', reference])
  assert.equal(store.credentials.get(reference), 'test-secret-only')
  assert.equal(JSON.stringify(store.providers).includes('test-secret-only'), false)
  assert.equal(JSON.stringify(result).includes('test-secret-only'), false)
  assert.equal(result.credential, 'saved')
  assert.equal(result.revision, 5)
  assert.deepEqual(draft, original)
})

test('direct input replaces an imported shared reference without changing the original provider or secret', async () => {
  const store = fakeStore()
  const originalProvider = structuredClone(store.providers.old)
  const references = []
  for (const id of ['new-route', 'new_route', 'other-route']) {
    const draft = unnamedDraft(id)
    draft.profile.apiKeyEnv = 'SHARED_OLD_KEY'
    const result = await saveConfiguration(draft, store.revision, 'new-secret', store.port)
    references.push(result.draft.profile.apiKeyEnv)
    assert.notEqual(result.draft.profile.apiKeyEnv, 'SHARED_OLD_KEY')
  }
  assert.equal(new Set(references).size, references.length)
  assert.equal(store.credentials.get('SHARED_OLD_KEY'), 'old-secret')
  assert.deepEqual(store.providers.old, originalProvider)
})

test('same route saved independently never derives or reuses an old credential reference', async () => {
  const references: string[] = []
  for (let run = 0; run < 3; run++) {
    const store = fakeStore()
    const result = await saveConfiguration(unnamedDraft(), store.revision, 'test-key', store.port)
    references.push(result.draft.profile.apiKeyEnv!)
  }
  assert.equal(new Set(references).size, 3)
})

test('blank key preserves only an explicitly imported reference and never writes credentials', async () => {
  for (const explicitRef of ['SHARED_OLD_KEY', undefined]) {
    const store = fakeStore()
    const draft = unnamedDraft()
    if (explicitRef) draft.profile.apiKeyEnv = explicitRef
    const result = await saveConfiguration(draft, store.revision, ' \t\n ', store.port)
    assert.equal(result.draft.profile.apiKeyEnv, explicitRef)
    assert.equal(result.credential, 'unchanged')
    assert.deepEqual(store.writes, ['provider'])
    assert.equal(store.credentials.get('SHARED_OLD_KEY'), 'old-secret')
  }
})

test('existing provider and invalid configuration are rejected before either write', async () => {
  const store = fakeStore()
  await assert.rejects(saveConfiguration(unnamedDraft('old'), store.revision, 'new-secret', store.port), /已经存在/)
  const invalid = unnamedDraft()
  invalid.profile.apiKeyEnv = 'invalid-reference'
  await assert.rejects(saveConfiguration(invalid, store.revision, 'new-secret', store.port))
  assert.deepEqual(store.writes, [])
  assert.equal(store.credentials.get('SHARED_OLD_KEY'), 'old-secret')
})

test('nonblank keys containing controls are refused without echoing them', async () => {
  for (const key of ['test-key\nsecond-line', '\ntest-key', 'test-key\u0000', 'test-key\u007f', 'test-key\u2028line']) {
    const store = fakeStore()
    await assert.rejects(saveConfiguration(unnamedDraft(), store.revision, key, store.port),
      error => error instanceof Error && !error.message.includes('test-key'))
    assert.deepEqual(store.writes, [])
  }
})

test('configuration failure prevents credential mutation', async () => {
  await assert.rejects(saveConfiguration(unnamedDraft(), 3, 'test-key', {
    save: async () => { throw new Error('configuration-conflict') },
    setCredential: async () => { assert.fail('failed configuration must not write a credential') },
  }), /configuration-conflict/)
})

for (const failure of ['result', 'throw'] as const) {
  test(`credential ${failure} failure retries only its own newly created credential`, async () => {
    const store = fakeStore(1)
    if (failure === 'throw') {
      const originalSet = store.port.setCredential
      store.port.setCredential = async (ref, value) => {
        const result = await originalSet(ref, value)
        if (!result.ok) throw new Error('test-secret-must-not-surface')
        return result
      }
    }
    const first = await saveConfiguration(unnamedDraft(), store.revision, 'test-secret-must-not-surface', store.port)
    assert.equal(first.credential, 'failed')
    const revision = store.revision
    const providerBefore = structuredClone(store.providers)
    const retried = await retryConfigurationCredential(first, 'test-secret-must-not-surface', store.port)
    assert.equal(retried.credential, 'saved')
    assert.equal(retried.revision, revision)
    assert.equal(store.revision, revision)
    assert.deepEqual(store.providers, providerBefore)
    assert.deepEqual(store.writes, ['provider', first.draft.profile.apiKeyEnv, first.draft.profile.apiKeyEnv])
    assert.equal(store.credentials.get('SHARED_OLD_KEY'), 'old-secret')
    assert.equal(JSON.stringify(first).includes('test-secret-must-not-surface'), false)
    await assert.rejects(retryConfigurationCredential(first, 'test-secret-must-not-surface', store.port), /失效/)
    await assert.rejects(retryConfigurationCredential(retried, 'test-secret-must-not-surface', store.port), /失效/)
  })
}

test('a failed retry remains retryable without creating another provider', async () => {
  const store = fakeStore(2)
  const first = await saveConfiguration(unnamedDraft(), store.revision, 'test-key', store.port)
  const second = await retryConfigurationCredential(first, 'test-key', store.port)
  assert.equal(second, first)
  assert.equal((await retryConfigurationCredential(second, 'test-key', store.port)).credential, 'saved')
  assert.equal(store.writes.filter(value => value === 'provider').length, 1)
})

test('forged, cloned, successful, and unchanged receipts cannot authorize a credential write', async () => {
  const store = fakeStore(1)
  const first = await saveConfiguration(unnamedDraft(), store.revision, 'test-key', store.port)
  for (const receipt of [structuredClone(first), { ...first }, { ...first, credential: 'saved' as const },
    { draft: unnamedDraft('old'), revision: store.revision, credential: 'failed' as const }]) {
    await assert.rejects(retryConfigurationCredential(receipt, 'test-key', store.port), /失效/)
  }
  assert.equal(store.writes.length, 2)
})

test('a retry cannot replace the original key, and the error never echoes either key', async () => {
  const store = fakeStore(1)
  const first = await saveConfiguration(unnamedDraft(), store.revision, 'test-key', store.port)
  await assert.rejects(retryConfigurationCredential(first, 'different-secret', store.port),
    error => error instanceof Error && !error.message.includes('different-secret') && !error.message.includes('test-key'))
  assert.equal(store.writes.length, 2)
  assert.equal((await retryConfigurationCredential(first, 'test-key', store.port)).credential, 'saved')
})

test('mutating an authentic receipt cannot redirect a retry or fabricate the result', async () => {
  for (const change of ['id', 'reference', 'revision'] as const) {
    const store = fakeStore(1)
    const first = await saveConfiguration(unnamedDraft(), store.revision, 'test-key', store.port)
    if (change === 'id') first.draft.id = 'old'
    if (change === 'reference') first.draft.profile.apiKeyEnv = 'SHARED_OLD_KEY'
    if (change === 'revision') first.revision++
    await assert.rejects(retryConfigurationCredential(first, 'test-key', store.port), /失效/)
    assert.equal(store.writes.length, 2)
    assert.equal(store.credentials.get('SHARED_OLD_KEY'), 'old-secret')
  }
})

for (const change of ['revision', 'reference', 'profile', 'deleted', 'loading', 'read-only', 'memory'] as const) {
  test(`retry refuses ${change} changes without any additional write`, async () => {
    const store = fakeStore(1)
    const first = await saveConfiguration(unnamedDraft(), store.revision, 'test-key', store.port)
    if (change === 'revision') store.bumpRevision()
    if (change === 'reference') store.providers.dmxapi.apiKeyEnv = 'SHARED_OLD_KEY'
    if (change === 'profile') store.providers.dmxapi.displayName = 'Changed elsewhere'
    if (change === 'deleted') delete store.providers.dmxapi
    const snapshot = store.snapshot()
    if (change === 'loading') snapshot.status = 'loading'
    if (change === 'read-only') snapshot.writable = false
    if (change === 'memory') snapshot.mode = 'memory'
    await assert.rejects(retryConfigurationCredential(first, 'test-key', {
      ...store.port, snapshot: () => snapshot,
    }), /配置已发生变化/)
    assert.equal(store.writes.length, 2)
    assert.equal(store.credentials.get('SHARED_OLD_KEY'), 'old-secret')
  })
}

test('parallel retry clicks issue exactly one credential write', async () => {
  const store = fakeStore(1)
  const first = await saveConfiguration(unnamedDraft(), store.revision, 'test-key', store.port)
  let finish!: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  let retryWrites = 0
  const port = { ...store.port, setCredential: async () => { retryWrites++; await gate; return { ok: true as const } } }
  const pending = retryConfigurationCredential(first, 'test-key', port)
  await assert.rejects(retryConfigurationCredential(first, 'test-key', port), /正在进行/)
  finish()
  assert.equal((await pending).credential, 'saved')
  assert.equal(retryWrites, 1)
})

test('a settings change while the first credential RPC is pending keeps its own revision and prevents retry', async () => {
  const store = fakeStore()
  let start!: () => void
  let finish!: () => void
  const started = new Promise<void>(resolve => { start = resolve })
  const gate = new Promise<void>(resolve => { finish = resolve })
  const pending = saveConfiguration(unnamedDraft(), store.revision, 'test-key', {
    ...store.port, setCredential: async () => { start(); await gate; return { ok: false, error: 'rejected' } },
  })
  await started
  store.bumpRevision()
  finish()
  const result = await pending
  assert.equal(result.revision, 5)
  assert.equal(store.revision, 6)
  await assert.rejects(retryConfigurationCredential(result, 'test-key', store.port), /配置已发生变化/)
  assert.deepEqual(store.writes, ['provider'])
})
