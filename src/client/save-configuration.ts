import { validateDraft, type ProviderDraft } from '../config.ts'
import { normalizeProtocolDraft } from '../protocol.ts'
import type { SaveSnapshot } from './save-provider.ts'

export interface SaveConfigurationResult {
  draft: ProviderDraft
  revision: number
  credential: 'unchanged' | 'saved' | 'failed'
}

interface CredentialPort {
  setCredential(ref: string, value: string): Promise<
    { ok: true; value?: void } | { ok: false; error: unknown }
  >
}

interface RetryState {
  id: string
  draft: ProviderDraft
  revision: number
  reference: string
  provider: unknown
  originalKey: string
  inFlight: boolean
}

// Object identity binds a retry to a configuration created by this live client.
// No raw key or retry authority is exposed in YAML, settings, or the public result.
const pendingCredentials = new WeakMap<SaveConfigurationResult, RetryState>()

function keyValue(apiKey: string): string {
  const value = apiKey.trim()
  if (value.length > 0 && /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(apiKey)) {
    throw new Error('API 密钥不能包含换行或控制字符，请只填写密钥。')
  }
  return value
}

function sameJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  const a = left as Record<string, unknown>
  const b = right as Record<string, unknown>
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length
    && keys.every(key => Object.hasOwn(b, key) && sameJson(a[key], b[key]))
}

function committedProvider(snapshot: SaveSnapshot, id: string, revision: number, reference: string): unknown {
  if (snapshot.status !== 'ready' || !snapshot.writable || snapshot.mode !== 'host'
    || snapshot.revision !== revision || !snapshot.value?.providers
    || !Object.hasOwn(snapshot.value.providers, id)) return undefined
  const provider = snapshot.value.providers[id]
  return provider && typeof provider === 'object'
    && (provider as Record<string, unknown>).apiKeyEnv === reference ? provider : undefined
}

async function writeCredential(reference: string, value: string, port: CredentialPort): Promise<'saved' | 'failed'> {
  try {
    return (await port.setCredential(reference, value)).ok ? 'saved' : 'failed'
  } catch {
    // A transport diagnostic may contain the attempted secret. Never surface it.
    return 'failed'
  }
}

/** Create public configuration first; a directly entered key always gets its own reference. */
export async function saveConfiguration(
  draft: ProviderDraft,
  revision: number,
  apiKey: string,
  port: CredentialPort & {
    save(draft: ProviderDraft, revision: number): Promise<number>
    snapshot?(): SaveSnapshot
  },
): Promise<SaveConfigurationResult> {
  validateDraft(draft)
  const next = normalizeProtocolDraft(draft).draft
  validateDraft(next)
  const value = keyValue(apiKey)
  // Never set the reference imported from YAML: it may belong to an older provider.
  const reference = value ? `DSH_DMXAPI_${crypto.randomUUID().replaceAll('-', '')}_API_KEY` : undefined
  if (reference) next.profile.apiKeyEnv = reference
  validateDraft(next)
  const savedRevision = await port.save(next, revision)
  if (!reference) return { draft: next, revision: savedRevision, credential: 'unchanged' }
  const snapshot = port.snapshot?.()
  const provider = snapshot && committedProvider(snapshot, next.id, savedRevision, reference)
  const providerAtCommit = provider === undefined ? undefined : structuredClone(provider)
  const credential = await writeCredential(reference, value, port)
  const result: SaveConfigurationResult = { draft: next, revision: savedRevision, credential }
  if (credential === 'failed' && providerAtCommit !== undefined) {
    pendingCredentials.set(result, {
      id: next.id, draft: structuredClone(next), revision: savedRevision, reference,
      provider: providerAtCommit, originalKey: value, inFlight: false,
    })
  }
  return result
}

/** Retry only this live client's failed credential write; never write a provider again. */
export async function retryConfigurationCredential(
  receipt: SaveConfigurationResult,
  apiKey: string,
  port: CredentialPort & { snapshot(): SaveSnapshot },
): Promise<SaveConfigurationResult> {
  const state = pendingCredentials.get(receipt)
  if (!state || receipt.credential !== 'failed' || state.inFlight
    || receipt.revision !== state.revision || !sameJson(receipt.draft, state.draft)) {
    throw new Error('此密钥重试已失效或正在进行，请继续新建；已有配置不会被覆盖。')
  }
  const value = keyValue(apiKey)
  if (value !== state.originalKey) throw new Error('请使用本次新增时填写的密钥重试。')
  const provider = committedProvider(port.snapshot(), state.id, state.revision, state.reference)
  if (provider === undefined || !sameJson(provider, state.provider)) {
    pendingCredentials.delete(receipt)
    throw new Error('配置已发生变化，已停止密钥重试。请在 Harness 原生模型设置中处理本次新增的服务商。')
  }
  state.inFlight = true
  try {
    const credential = await writeCredential(state.reference, value, port)
    if (credential === 'failed') return receipt
    pendingCredentials.delete(receipt)
    return { draft: structuredClone(state.draft), revision: state.revision, credential: 'saved' }
  } finally {
    state.inFlight = false
  }
}
