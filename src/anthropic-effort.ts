import type { Context } from '@deepseek-ai/cordis';
import type { Api, Context as PiContext, Model, Provider, SimpleStreamOptions } from '@earendil-works/pi-ai';
import { dmxapiProtocolForProvider } from './config.ts';

// This bridge targets the Host 0.1.5-rc.2 snapshot seam verified by the tests.
// It never imports a second runtime copy of llm-pi-ai from the plugin package.
const PATCH = Symbol.for('dsh-dmxapi.anthropic-enabled-effort.v1');
const ACTIVE = Symbol.for('dsh-dmxapi.anthropic-enabled-effort.owner.v1');

type StreamSimple = Provider['streamSimple'];
type PatchedProvider = Provider & {
  [PATCH]?: { original: StreamSimple; wrapper: StreamSimple };
};
type Snapshot = {
  profiles: ReadonlyMap<string, { api?: string; baseURL?: string }>;
  models: { getProvider(id: string): Provider | undefined };
};
type HostAdapter = { current?: (...args: unknown[]) => unknown };
type HostLlm = {
  adapters?: Map<string, { adapter?: HostAdapter }>;
  [ACTIVE]?: object;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSnapshot(value: unknown): value is Snapshot {
  return isRecord(value) && value.profiles instanceof Map &&
    isRecord(value.models) && typeof value.models.getProvider === 'function';
}

/** Only the DeepSeek Anthropic compatibility dialect needs this correction. */
function optedIn(model: Model<Api>): boolean {
  return dmxapiProtocolForProvider(model.provider) === 'anthropic' && model.api === 'anthropic-messages' &&
    /^deepseek[-.]/i.test(model.id) && isRecord(model.compat) && model.compat.forceAdaptiveThinking === true;
}

export function enabledEffortPayload(value: unknown, model: Model<Api>, reasoning: string | undefined): unknown {
  if (!optedIn(model)) return value;
  if (!isRecord(value)) throw new Error('DMXAPI Anthropic 请求体格式发生变化，未发送未经校正的请求。');
  if (!reasoning) {
    // The Harness represents "off" by omitting the pi-ai reasoning option.
    return { ...value, thinking: { type: 'disabled' } };
  }
  const thinking = value.thinking;
  const output = value.output_config;
  if (!isRecord(thinking) || thinking.type !== 'adaptive' || !isRecord(output) ||
    typeof output.effort !== 'string' || !['low', 'high', 'max'].includes(output.effort)) {
    throw new Error('DMXAPI Anthropic 思考参数不符合已验证的格式，已停止请求以避免发送错误等级。');
  }
  return { ...value, thinking: { type: 'enabled' } };
}

function patchProvider(provider: PatchedProvider): void {
  if (provider[PATCH]) return;
  const original = provider.streamSimple;
  if (typeof original !== 'function') throw new Error('Harness pi-ai provider 缺少 streamSimple，DMXAPI Anthropic 适配无法启用。');
  const wrapper: StreamSimple = function (model, context: PiContext, options?: SimpleStreamOptions) {
    if (!optedIn(model)) return original.call(provider, model, context, options);
    const callerPayload = options?.onPayload;
    return original.call(provider, model, context, {
      ...options,
      onPayload: async (payload, requestModel) => {
        const changed = await callerPayload?.(payload, requestModel);
        return enabledEffortPayload(changed === undefined ? payload : changed, requestModel, options?.reasoning);
      },
    });
  };
  provider.streamSimple = wrapper;
  provider[PATCH] = { original, wrapper };
}

/** Patch only snapshots for the plugin's dedicated route; no global fetch hook. */
export function installAnthropicEffortBridge(ctx: Context): () => void {
  const llm = ctx.llm as unknown as HostLlm;
  if (llm[ACTIVE]) throw new Error('DMXAPI Anthropic 适配已安装，不能重复加载。');
  const owner = {};
  const patched = new Set<PatchedProvider>();
  const adapters = new Map<HostAdapter, { original: NonNullable<HostAdapter['current']>; wrapper: NonNullable<HostAdapter['current']> }>();
  const attach = () => {
    if (!(llm.adapters instanceof Map)) {
      throw new Error('Harness LLM 适配器注册表已变化，DMXAPI Anthropic 适配无法启用。');
    }
    for (const [route, entry] of llm.adapters) {
      if (dmxapiProtocolForProvider(route) !== 'anthropic') continue;
      const adapter = entry.adapter;
      if (!adapter || adapter.constructor.name !== 'PiAiAdapter' || typeof adapter.current !== 'function') {
        // A different route must not block an already serviceable adapter. The
        // request guard below still fails closed for the exact opted-in target.
        continue;
      }
      if (adapters.has(adapter)) continue;
      const original = adapter.current;
      const wrapper = function (this: unknown, ...args: unknown[]): unknown {
        const snapshot = original.apply(this, args);
        if (!isSnapshot(snapshot)) throw new Error('Harness pi-ai 快照格式已变化，DMXAPI Anthropic 适配无法启用。');
        for (const providerId of snapshot.profiles.keys()) {
          if (dmxapiProtocolForProvider(providerId) !== 'anthropic') continue;
          const provider = snapshot.models.getProvider(providerId) as PatchedProvider | undefined;
          if (provider?.getModels().some(optedIn)) {
            patchProvider(provider);
            patched.add(provider);
          }
        }
        return snapshot;
      };
      adapter.current = wrapper;
      adapters.set(adapter, { original, wrapper });
    }
  };
  // Topology notifications contain ordinary listener failures; keep the
  // public stream guard installed even if the first attachment cannot work.
  const tryAttach = () => { try { attach(); } catch { /* Rechecked on request. */ } };
  const unlisten = ctx.on('llm/adapters-updated', tryAttach);
  const isConfiguredForBridge = (route: string, modelId: string): boolean => {
    const section = ctx.settings.describe({ redactSecrets: true }).find(item => item.ns === 'llm-pi-ai');
    if (!isRecord(section?.value) || !isRecord(section.value.providers)) return false;
    const profile = section.value.providers[route];
    if (!isRecord(profile) || !Array.isArray(profile.models)) return false;
    const model = profile.models.find(item => isRecord(item) && item.id === modelId);
    return isRecord(model) && profile.api === 'anthropic-messages' &&
      ((isRecord(model.compat) ? model.compat.forceAdaptiveThinking : undefined) ??
        (isRecord(profile.compat) ? profile.compat.forceAdaptiveThinking : undefined)) === true;
  };
  const assertReady = (route: string, modelId: string) => {
    // Host contains ordinary topology-listener failures. Check again on the
    // request path so an incompatible future Host cannot silently send adaptive.
    attach();
    const adapter = llm.adapters?.get(route)?.adapter;
    const state = adapter && adapters.get(adapter);
    if (!state || adapter?.current !== state.wrapper) {
      throw new Error('DMXAPI DeepSeek Anthropic 思考适配未就绪，已停止请求。');
    }
    const snapshot = adapter.current();
    if (!isSnapshot(snapshot)) throw new Error('DMXAPI DeepSeek Anthropic 适配快照不可用，已停止请求。');
    const provider = snapshot.models.getProvider(route) as PatchedProvider | undefined;
    const model = provider?.getModels().find(item => item.id === modelId);
    if (!provider?.[PATCH] || provider.streamSimple !== provider[PATCH].wrapper || !model || !optedIn(model)) {
      throw new Error('DMXAPI DeepSeek Anthropic 模型适配未就绪，已停止请求。');
    }
  };
  const unguard = ctx.on('llm/stream', (options, next) => {
    if (dmxapiProtocolForProvider(options.provider) === 'anthropic' && /^deepseek[-.]/i.test(options.model) &&
      isConfiguredForBridge(options.provider, options.model)) assertReady(options.provider, options.model);
    return next();
  }, { global: true, prepend: true });
  llm[ACTIVE] = owner;
  tryAttach();
  return () => {
    if (typeof unlisten === 'function') unlisten();
    if (typeof unguard === 'function') unguard();
    for (const [adapter, state] of adapters) {
      if (adapter.current === state.wrapper) adapter.current = state.original;
    }
    for (const provider of patched) {
      const state = provider[PATCH];
      if (state && provider.streamSimple === state.wrapper) provider.streamSimple = state.original;
      delete provider[PATCH];
    }
    if (llm[ACTIVE] === owner) delete llm[ACTIVE];
  };
}
