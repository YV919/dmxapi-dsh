import { validateDraft, type ProviderDraft } from '../config.ts'

export interface SaveSnapshot {
  status: 'loading' | 'ready' | 'unavailable'
  revision?: number
  writable: boolean
  mode: 'host' | 'memory'
  /** Effective providers include both user configuration and composition/inherited routes. */
  value?: { providers?: Record<string, unknown> }
}

/** Keep the revision captured when editing; never substitute a more recent revision. */
export async function saveProvider<T>(
  draft: ProviderDraft,
  revision: number,
  port: {
    snapshot(): SaveSnapshot
    mutate(ns: string, ops: { op: 'set'; path: string[]; value: unknown }[], revision: number): Promise<
      { ok: true; value: T } | { ok: false; error: { code: string; message: string } }
    >
    accept(view: T): void
  },
): Promise<T> {
  validateDraft(draft)
  const current = port.snapshot()
  if (current.status !== 'ready' || !current.writable || current.mode !== 'host' || !current.value) {
    throw new Error('当前连接不能保存配置。请从服务器本机打开 Harness，并确认配置可写。')
  }
  if (!Number.isSafeInteger(revision) || revision < 0 || current.revision !== revision) {
    throw new Error('配置已在其他页面更新。你的草稿仍保留，请先备份草稿，再重新载入配置。')
  }
  if (Object.hasOwn(current.value.providers ?? {}, draft.id)) {
    throw new Error(`服务商标识“${draft.id}”已经存在。此插件仅新增配置，请换一个标识；原配置不会被覆盖。`)
  }
  const result = await port.mutate('llm-pi-ai', [
    { op: 'set', path: ['providers', draft.id], value: structuredClone(draft.profile) },
  ], revision)
  if (!result.ok) {
    if (result.error.code === 'settings/conflict') {
      throw new Error('保存遇到版本冲突。你的草稿仍保留，请先备份草稿，再重新载入配置。')
    }
    throw new Error(`配置未保存：${result.error.message}`)
  }
  port.accept(result.value)
  return result.value
}
