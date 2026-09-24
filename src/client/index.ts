import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SettingsPathOpView, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { ProviderProfile, ProviderDraft } from '../config.ts'
import { DmxapiCard } from './Card.tsx'
import { saveProvider, saveProviderModels } from './save-provider.ts'
import { retryConfigurationCredential, saveConfiguration, type SaveConfigurationResult } from './save-configuration.ts'
import css from './styles.css'

export const inject = ['slots', 'settingsScope', 'remote', 'remote.settings', 'remote.credentials']

export function apply(ctx: Context): void {
  const scope = ctx.settingsScope.bind<{ providers?: Record<string, ProviderProfile> }>({ namespace: 'llm-pi-ai' })
  const mirror = ctx.settingsScope.describe()
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-dmxapi'
    style.textContent = css
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'dmxapi-settings: styles')

  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: 'llm-pi-ai',
    inject: () => ({
      store: {
        getSnapshot: () => scope.getSnapshot(),
        subscribe: (listener: () => void) => scope.subscribe(listener),
      },
      save: (draft: ProviderDraft, revision: number, apiKey: string) => saveConfiguration(draft, revision, apiKey, {
        snapshot: () => scope.getSnapshot(),
        save: async (next, expectedRevision) => (await saveProvider<SettingsNamespaceView>(next, expectedRevision, {
          snapshot: () => scope.getSnapshot(),
          mutate: (ns, ops, expected) => ctx.remote.settings.mutate(ns, ops as SettingsPathOpView[], expected),
          accept: view => mirror.acceptView(view),
        })).revision,
        setCredential: (ref, value) => ctx.remote.credentials.set(ref, value),
      }),
      updateModels: (draft: ProviderDraft, revision: number) => saveProviderModels<SettingsNamespaceView>(draft, revision, {
        snapshot: () => scope.getSnapshot(),
        mutate: (ns, ops, expected) => ctx.remote.settings.mutate(ns, ops as SettingsPathOpView[], expected),
        accept: view => mirror.acceptView(view),
      }),
      retryCredential: (receipt: SaveConfigurationResult, apiKey: string) => retryConfigurationCredential(receipt, apiKey, {
        snapshot: () => scope.getSnapshot(),
        setCredential: (ref, value) => ctx.remote.credentials.set(ref, value),
      }),
    }),
  }, DmxapiCard))
}
