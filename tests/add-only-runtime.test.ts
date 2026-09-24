import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'
import { createDmxapiProtocolDraft, type ProviderDraft, type ProviderProfile } from '../src/config.ts'
import { saveProvider, type SaveSnapshot } from '../src/client/save-provider.ts'
import { retryConfigurationCredential, saveConfiguration } from '../src/client/save-configuration.ts'

test('real Host settings preserve user and inherited routes; partial credential retry never rewrites settings', async t => {
  const tempRoot = resolve(tmpdir())
  const directory = await mkdtemp(join(tempRoot, 'dsh-dmxapi-add-only-'))
  const ctx = new Context()
  t.after(async () => {
    await ctx.fiber.dispose()
    const target = resolve(directory)
    assert.ok(target.startsWith(tempRoot + sep), 'remove only this allocated temporary fixture')
    await rm(target, { recursive: true, force: true })
  })
  await ctx.plugin(LlmRuntime)
  const path = join(directory, 'settings.yaml')
  await ctx.plugin(FileSettingsProvider, { path, watch: false })
  const inherited = createDmxapiProtocolDraft('chat')
  inherited.profile.apiKeyEnv = 'SHARED_FIXTURE_KEY'
  await ctx.plugin(LlmPiAi, { providers: { [inherited.id]: inherited.profile as PiAiProviderProfile } })
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
})
