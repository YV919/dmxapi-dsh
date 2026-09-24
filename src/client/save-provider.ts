import { validateDraft, type ProviderDraft } from '../config.ts'

export interface SaveSnapshot {
  status: 'loading' | 'ready' | 'unavailable'
  revision?: number
  writable: boolean
  mode: 'host' | 'memory'
  /** Effective providers include both user configuration and composition/inherited routes. */
  value?: { providers?: Record<string, unknown> }
  /** Clearing a user value reveals this inherited composition layer. */
  base?: unknown
}

export type ProviderPathOp =
  | { op: 'set'; path: string[]; value: unknown }
  | { op: 'unset'; path: string[] }

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
    throw new Error(`服务商标识“${draft.id}”已经存在。当前是新建独立配置，请换一个标识；原配置不会被覆盖。`)
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

/** Edit only model-related paths on an existing route; never replace its credentials or provider settings. */
export async function saveProviderModels<T>(
  draft: ProviderDraft,
  revision: number,
  port: {
    snapshot(): SaveSnapshot
    mutate(ns: string, ops: ProviderPathOp[], revision: number): Promise<
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
  const profile = current.value.providers?.[draft.id]
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new Error(`服务商“${draft.id}”已不存在，请重新载入配置。`)
  }
  if ((profile as Record<string, unknown>).api !== draft.profile.api) {
    throw new Error('此服务商的接口协议已变化，请重新载入配置。')
  }
  const overrides = (profile as Record<string, unknown>).modelOverrides
  if (overrides && typeof overrides === 'object' && Object.keys(overrides).length > 0) {
    throw new Error('此服务商使用 modelOverrides，不能同时保存 models。请在 Harness 的“设置 → 模型”中处理覆盖项。')
  }
  const baseProviders = current.base && typeof current.base === 'object' && !Array.isArray(current.base)
    ? (current.base as Record<string, unknown>).providers : undefined
  const baseProfile = baseProviders && typeof baseProviders === 'object' && !Array.isArray(baseProviders)
    ? (baseProviders as Record<string, unknown>)[draft.id] : undefined
  const baseReasoning = baseProfile && typeof baseProfile === 'object' && !Array.isArray(baseProfile)
    ? (baseProfile as Record<string, unknown>).reasoning : undefined
  if (draft.profile.reasoning === undefined && baseReasoning !== undefined) {
    throw new Error('此服务商继承了默认思考等级；清空用户层会恢复继承值。请选一个所有模型都支持的等级，或先调整 Harness 的继承配置。')
  }
  const path = ['providers', draft.id]
  const ops: ProviderPathOp[] = [
    { op: 'set', path: [...path, 'models'], value: structuredClone(draft.profile.models) },
  ]
  if (draft.profile.reasoning !== (profile as Record<string, unknown>).reasoning) {
    ops.push(draft.profile.reasoning === undefined
      ? { op: 'unset', path: [...path, 'reasoning'] }
      : { op: 'set', path: [...path, 'reasoning'], value: draft.profile.reasoning })
  }
  const result = await port.mutate('llm-pi-ai', ops, revision)
  if (!result.ok) {
    if (result.error.code === 'settings/conflict') {
      throw new Error('保存遇到版本冲突。你的草稿仍保留，请先备份草稿，再重新载入配置。')
    }
    throw new Error(`模型配置未保存：${result.error.message}`)
  }
  port.accept(result.value)
  return result.value
}
