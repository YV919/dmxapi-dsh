import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { settingsFixture } from './settings-fixture.ts'
import { createDmxapiProtocolDraft, type ProviderDraft, type ProviderProfile } from '../src/config.ts'
import { saveProvider, saveProviderModels, type SaveSnapshot } from '../src/client/save-provider.ts'
import { retryConfigurationCredential, saveConfiguration } from '../src/client/save-configuration.ts'

test('real Host settings preserve user and inherited routes; partial credential retry never rewrites settings', async t => {
  const inherited = createDmxapiProtocolDraft('chat')
  inherited.profile.apiKeyEnv = 'SHARED_FIXTURE_KEY'
  const { ctx, settingsPath: path, start } = await settingsFixture(t, { [inherited.id]: inherited.profile })
  const section = () => ctx.settings.describe().find(item => item.ns === 'llm-pi-ai')!
  const snapshot = (): SaveSnapshot => ({
    status: 'ready', writable: true, mode: 'host', revision: section().revision,
    value: section().value as { providers: Record<string, ProviderProfile> },
  })
  const user = createDmxapiProtocolDraft('responses')
  user.id = 'existing-user-route'
  user.profile.apiKeyEnv = 'SHARED_FIXTURE_KEY'
  await ctx.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', user.id], value: user.profile }], section().revision)
  const before = structuredClone(section().value) as { providers: Record<string, ProviderProfile> }
  const fileBefore = await readFile(path, 'utf8')
  const credentials = new Map([['SHARED_FIXTURE_KEY', 'old-test-secret']])
  let settingsWrites = 0
  let credentialAttempts = 0
  const port = {
    snapshot,
    save: async (draft: ProviderDraft, revision: number) => (await saveProvider(draft, revision, {
      snapshot,
      mutate: async (namespace, ops, expected) => {
        settingsWrites++
        await ctx.settings.mutate(namespace, ops, expected)
        return { ok: true as const, value: section() }
      },
      accept: () => {},
    })).revision,
    setCredential: async (reference: string, key: string) => {
      if (credentialAttempts++ === 0) return { ok: false as const, error: 'temporary fixture failure' }
      credentials.set(reference, key)
      return { ok: true as const }
    },
  }
  for (const draft of [inherited, user]) {
    await assert.rejects(saveConfiguration(draft, section().revision, 'do-not-write-secret', port), /已经存在/)
  }
  assert.equal(settingsWrites, 0)
  assert.equal(credentialAttempts, 0)
  assert.equal(await readFile(path, 'utf8'), fileBefore)
  const newDraft = structuredClone(inherited)
  newDraft.id = 'dmxapi-chat-2'
  const receipt = await saveConfiguration(newDraft, section().revision, 'new-test-secret', port)
  assert.equal(receipt.credential, 'failed')
  assert.notEqual(receipt.draft.profile.apiKeyEnv, 'SHARED_FIXTURE_KEY')
  assert.deepEqual((section().value as typeof before).providers[inherited.id], before.providers[inherited.id])
  assert.deepEqual((section().value as typeof before).providers[user.id], before.providers[user.id])
  const fileAfterAddition = await readFile(path, 'utf8')
  assert.equal(fileAfterAddition.includes('new-test-secret'), false)
  const retry = await retryConfigurationCredential(receipt, 'new-test-secret', port)
  assert.equal(retry.credential, 'saved')
  assert.equal(settingsWrites, 1)
  assert.equal(await readFile(path, 'utf8'), fileAfterAddition)
  assert.equal(credentials.get('SHARED_FIXTURE_KEY'), 'old-test-secret')
  assert.equal(credentials.get(receipt.draft.profile.apiKeyEnv!), 'new-test-secret')
  assert.deepEqual(ctx.llm.listProviders().map(item => item.id), [inherited.id, user.id, newDraft.id])
  await ctx.fiber.dispose()
  const restarted = await start()
  assert.deepEqual(restarted.llm.listProviders().map(item => item.id), [inherited.id, user.id, newDraft.id])
  const persisted = restarted.settings.describe().find(item => item.ns === 'llm-pi-ai')!.value as typeof before
  assert.equal(persisted.providers[newDraft.id].apiKeyEnv, receipt.draft.profile.apiKeyEnv)
  assert.deepEqual(persisted.providers[user.id], before.providers[user.id])
})

test('real Host settings edit an existing preset models path without duplicating routes or credentials', async t => {
  const inherited = createDmxapiProtocolDraft('chat')
  inherited.profile.apiKeyEnv = 'INHERITED_KEY_REFERENCE'
  inherited.profile.models![0]!.unknownModelField = { keep: true }
  const inheritedDefault = createDmxapiProtocolDraft('responses')
  const { ctx, settingsPath } = await settingsFixture(t, {
    [inherited.id]: inherited.profile,
    [inheritedDefault.id]: inheritedDefault.profile,
  })
  const section = () => ctx.settings.describe().find(item => item.ns === 'llm-pi-ai')!
  const snapshot = (): SaveSnapshot => ({
    status: 'ready', writable: true, mode: 'host', revision: section().revision,
    value: section().value as { providers: Record<string, ProviderProfile> },
    base: section().base,
  })
  const user = createDmxapiProtocolDraft('responses')
  user.id = 'dmxapi-responses-2'
  user.profile.apiKeyEnv = 'USER_KEY_REFERENCE'
  await ctx.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', user.id], value: user.profile }], section().revision)
  const before = structuredClone(section().value) as { providers: Record<string, ProviderProfile> }
  const routeIds = Object.keys(before.providers)
  const ops: unknown[] = []
  const port = {
    snapshot,
    mutate: async (namespace: string, changes: Parameters<typeof ctx.settings.mutate>[1], expected: number) => {
      ops.push(changes)
      await ctx.settings.mutate(namespace, changes, expected)
      return { ok: true as const, value: section() }
    },
    accept: () => {},
  }

  const inheritedEdit: ProviderDraft = { id: inherited.id, profile: structuredClone(before.providers[inherited.id]!) }
  inheritedEdit.profile.models!.push({ id: 'new-chat-model', input: ['text'], reasoningEfforts: { low: 'low', high: 'high' } })
  await saveProviderModels(inheritedEdit, section().revision, port)
  assert.deepEqual(ops[0], [{ op: 'set', path: ['providers', inherited.id, 'models'], value: inheritedEdit.profile.models }])
  assert.deepEqual(Object.keys((section().value as typeof before).providers), routeIds)
  assert.equal((section().value as typeof before).providers[inherited.id]?.models?.at(-1)?.id, 'new-chat-model')
  assert.deepEqual((section().value as typeof before).providers[inherited.id]?.models?.[0]?.unknownModelField, { keep: true })
  assert.equal((section().value as typeof before).providers[inherited.id]?.apiKeyEnv, 'INHERITED_KEY_REFERENCE')
  assert.deepEqual((section().value as typeof before).providers[user.id], before.providers[user.id])

  const userEdit: ProviderDraft = { id: user.id, profile: structuredClone((section().value as typeof before).providers[user.id]!) }
  userEdit.profile.models![0]!.contextWindow = 262144
  userEdit.profile.reasoning = 'low'
  await saveProviderModels(userEdit, section().revision, port)
  assert.deepEqual(ops[1], [
    { op: 'set', path: ['providers', user.id, 'models'], value: userEdit.profile.models },
    { op: 'set', path: ['providers', user.id, 'reasoning'], value: 'low' },
  ])
  assert.deepEqual(Object.keys((section().value as typeof before).providers), routeIds)
  assert.equal((section().value as typeof before).providers[user.id]?.models?.[0]?.contextWindow, 262144)
  assert.equal((section().value as typeof before).providers[user.id]?.apiKeyEnv, 'USER_KEY_REFERENCE')
  assert.equal((section().value as typeof before).providers[inherited.id]?.models?.at(-1)?.id, 'new-chat-model')
  const withoutDefault: ProviderDraft = { id: user.id, profile: structuredClone((section().value as typeof before).providers[user.id]!) }
  delete withoutDefault.profile.reasoning
  await saveProviderModels(withoutDefault, section().revision, port)
  assert.deepEqual(ops[2], [
    { op: 'set', path: ['providers', user.id, 'models'], value: withoutDefault.profile.models },
    { op: 'unset', path: ['providers', user.id, 'reasoning'] },
  ])
  assert.equal((section().value as typeof before).providers[user.id]?.reasoning, undefined)
  const inheritedClear: ProviderDraft = { id: inheritedDefault.id,
    profile: structuredClone((section().value as typeof before).providers[inheritedDefault.id]!) }
  delete inheritedClear.profile.reasoning
  const beforeBlockedEdit = structuredClone(section().value)
  const fileBeforeBlockedEdit = await readFile(settingsPath, 'utf8')
  await assert.rejects(saveProviderModels(inheritedClear, section().revision, port), /继承了默认思考等级/)
  assert.deepEqual(section().value, beforeBlockedEdit)
  assert.equal(await readFile(settingsPath, 'utf8'), fileBeforeBlockedEdit)
  assert.deepEqual(ctx.llm.listProviders().map(item => item.id), routeIds)
})

test('real profile patch serialization refuses one of two saves sharing a stale revision', async t => {
  const { ctx, settingsPath } = await settingsFixture(t)
  const section = () => ctx.settings.describe().find(item => item.ns === 'llm-pi-ai')!
  const revision = section().revision
  const drafts = [createDmxapiProtocolDraft('chat'), createDmxapiProtocolDraft('responses')]
  const results = await Promise.allSettled(drafts.map(draft => ctx.settings.mutate('llm-pi-ai', [
    { op: 'set', path: ['providers', draft.id], value: draft.profile },
  ], revision)))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  const rejection = results.find(result => result.status === 'rejected')
  assert.ok(rejection?.status === 'rejected')
  assert.match(String(rejection.reason), /conflict|revision|changed/i)
  const accepted = drafts[results.findIndex(result => result.status === 'fulfilled')]
  const rejected = drafts[results.findIndex(result => result.status === 'rejected')]
  assert.deepEqual(ctx.llm.listProviders().map(provider => provider.id), [accepted.id])
  const file = await readFile(settingsPath, 'utf8')
  assert.ok(file.includes(accepted.id))
  assert.equal(file.includes(rejected.id), false)
})
