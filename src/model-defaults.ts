import type { Context } from '@deepseek-ai/cordis';
import type { LlmAdapter, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm';
import { dmxapiProtocolForProvider, presetReasoningDefault } from './config.ts';

const ACTIVE = Symbol.for('dsh-dmxapi.model-defaults.owner.v1');
type Snapshot = { models: { getModel(provider: string, id: string): { api?: string } | undefined } };
type Adapter = Pick<LlmAdapter, 'resolveModel' | 'prepareCall'> & { current?: () => Snapshot };
type HostLlm = {
  adapters?: Map<string, { adapter?: Adapter }>;
  [ACTIVE]?: object;
};

/** Keep Host IDs stable; only defaults and user-facing switch labels change. */
export function withPresetModelDefaults(info: LlmResolvedModelInfo, api: string | undefined): LlmResolvedModelInfo {
  const recommended = presetReasoningDefault(info.provider, info.id, api);
  if (!recommended || !info.reasoning) return info;
  const reasoning = info.reasoning;
  // A user may remove the preset's preferred level. An always-thinking model
  // still needs an offered level: omitting it can make pi-ai emit disabled.
  const preferred = reasoning.efforts.find(effort => effort.id === recommended) ??
    (!reasoning.efforts.some(effort => effort.id === 'off')
      ? reasoning.efforts.find(effort => effort.id !== 'off') : undefined);
  const fallback = reasoning.defaultEffort === undefined
    ? preferred?.id : undefined;
  const isSwitch = dmxapiProtocolForProvider(info.provider) === 'chat' && info.id === 'mimo-v2.6-pro' &&
    reasoning.efforts.some(effort => effort.id === 'high') &&
    reasoning.efforts.every(effort => effort.id === 'off' || effort.id === 'high');
  if (!fallback && !isSwitch) return info;
  return { ...info, reasoning: {
    ...reasoning,
    ...(fallback ? { defaultEffort: fallback } : {}),
    ...(isSwitch ? { efforts: reasoning.efforts.map(effort => ({
      ...effort, name: effort.id === 'off' ? '关闭' : '开启',
    })) } : {}),
  } };
}

/** Decorate public metadata seams before Host freezes a prepared call's config. */
export function installPresetModelDefaults(ctx: Context): () => void {
  const llm = ctx.llm as unknown as HostLlm;
  if (llm[ACTIVE]) throw new Error('DMXAPI 模型默认配置已安装，不能重复加载。');
  const owner = {};
  const states = new Map<Adapter, {
    resolve: Adapter['resolveModel']; prepare: Adapter['prepareCall'];
    resolveWrapper: Adapter['resolveModel']; prepareWrapper: Adapter['prepareCall'];
  }>();
  const attach = () => {
    if (!(llm.adapters instanceof Map)) throw new Error('Harness LLM 适配器注册表已变化，DMXAPI 模型默认配置无法启用。');
    for (const [route, entry] of llm.adapters) {
      if (!dmxapiProtocolForProvider(route)) continue;
      const adapter = entry.adapter;
      if (!adapter || states.has(adapter) || adapter.constructor.name !== 'PiAiAdapter' ||
        typeof adapter.resolveModel !== 'function' || typeof adapter.prepareCall !== 'function' ||
        typeof adapter.current !== 'function') continue;
      const resolve = adapter.resolveModel;
      const prepare = adapter.prepareCall;
      const decorate = (info: LlmResolvedModelInfo, snapshot: Snapshot | undefined, receiver: Adapter) => {
        // Resolve is asynchronous while prepare captures a snapshot synchronously.
        // If settings changed during either operation, leave Host metadata alone.
        if (!snapshot || receiver.current?.() !== snapshot || typeof snapshot.models?.getModel !== 'function') return info;
        return withPresetModelDefaults(info, snapshot.models.getModel(info.provider, info.id)?.api);
      };
      const resolveWrapper: Adapter['resolveModel'] = async function (this: Adapter, ...args) {
        const snapshot = this.current?.();
        return decorate(await resolve.apply(this, args), snapshot, this);
      };
      const prepareWrapper: Adapter['prepareCall'] = async function (this: Adapter, ...args) {
        const snapshot = this.current?.();
        const prepared = await prepare.apply(this, args);
        const model = decorate(prepared.model, snapshot, this);
        return model === prepared.model ? prepared : { ...prepared, model };
      };
      adapter.resolveModel = resolveWrapper;
      adapter.prepareCall = prepareWrapper;
      states.set(adapter, { resolve, prepare, resolveWrapper, prepareWrapper });
    }
  };
  attach();
  const unlisten = ctx.on('llm/adapters-updated', attach);
  llm[ACTIVE] = owner;
  return () => {
    if (typeof unlisten === 'function') unlisten();
    for (const [adapter, state] of states) {
      if (adapter.resolveModel === state.resolveWrapper) adapter.resolveModel = state.resolve;
      if (adapter.prepareCall === state.prepareWrapper) adapter.prepareCall = state.prepare;
    }
    if (llm[ACTIVE] === owner) delete llm[ACTIVE];
  };
}
