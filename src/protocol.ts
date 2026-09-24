import { ALWAYS_ON_PRESET_IDS, dmxapiProtocolForProvider, type ModelProfile, type ProviderDraft } from './config.ts';

export type ReasoningMode =
  | 'chat-deepseek' | 'chat-zai' | 'chat-effort' | 'chat-qwen-effort' | 'chat-qwen-budget' | 'chat-switch'
  | 'responses-effort'
  | 'anthropic-adaptive' | 'anthropic-deepseek' | 'anthropic-budget'
  | 'none' | 'custom';

export const REASONING_MODES: Record<string, readonly ReasoningMode[]> = {
  'openai-completions': ['chat-deepseek', 'chat-zai', 'chat-effort', 'chat-qwen-effort', 'chat-qwen-budget', 'chat-switch', 'none', 'custom'],
  'openai-responses': ['responses-effort', 'none', 'custom'],
  'anthropic-messages': ['anthropic-adaptive', 'anthropic-deepseek', 'anthropic-budget', 'none', 'custom'],
};

const FULL_EFFORTS = { off: null, low: 'low', high: 'high', max: 'max' } as const;
const ALWAYS_ON_EFFORTS = { low: 'low', high: 'high', max: 'max' } as const;
const QWEN_EFFORTS = { off: null, medium: 'medium', xhigh: 'xhigh' } as const;
const SWITCH_EFFORTS = { off: 'disabled', high: 'high' } as const;
const BUDGET_EFFORTS = { off: null, low: 'low', high: 'high' } as const;
const MODE_COMPAT_KEYS = [
  'thinkingFormat', 'supportsReasoningEffort', 'supportsThinkingTokenBudget',
  'thinkingTokenBudgetField', 'forceAdaptiveThinking',
] as const;
const isDeepseekModelId = (id: string): boolean => /^deepseek[-.]/i.test(id);

/** The same explicit route/model/compat condition used by the narrow payload bridge. */
export function deepseekAnthropicBridgeModels(draft: ProviderDraft): string[] {
  if (dmxapiProtocolForProvider(draft.id) !== 'anthropic' || draft.profile.api !== 'anthropic-messages') return [];
  return (draft.profile.models ?? [])
    .filter(model => isDeepseekModelId(model.id) &&
      (model.compat?.forceAdaptiveThinking ?? draft.profile.compat?.forceAdaptiveThinking) === true)
    .map(model => model.id);
}

/** Suggestions apply only to a newly typed model; existing model data stays untouched. */
export function recommendReasoningMode(api: string | undefined, providerId: string, modelId: string): ReasoningMode {
  if (api === 'openai-completions') {
    if (isDeepseekModelId(modelId)) return 'chat-deepseek';
    if (/^glm[-.]/i.test(modelId)) return 'chat-zai';
    if (/^qwen3\.8[-.]/i.test(modelId)) return 'chat-qwen-effort';
    if (/^qwen(?:[-.]|\d)/i.test(modelId)) return 'chat-qwen-budget';
    if (/^mimo[-.]/i.test(modelId)) return 'chat-switch';
    return 'chat-effort';
  }
  if (api === 'openai-responses') return 'responses-effort';
  if (api === 'anthropic-messages') {
    if (dmxapiProtocolForProvider(providerId) === 'anthropic' && isDeepseekModelId(modelId)) return 'anthropic-deepseek';
    if (/^claude-(?:opus-(?:4[.-]8|5)|(?:fable|mythos|sonnet)-5)/i.test(modelId)) return 'anthropic-adaptive';
    return 'anthropic-budget';
  }
  return 'custom';
}

/** Offer only relevant Anthropic dialects; keep a loaded legacy mode editable. */
export function visibleReasoningModes(api: string | undefined, providerId: string, model: ModelProfile): ReasoningMode[] {
  if (api !== 'anthropic-messages') return [...(REASONING_MODES[api ?? ''] ?? ['custom'])];
  const recommended = recommendReasoningMode(api, providerId, model.id);
  const current = inferReasoningMode(model, api, providerId);
  return [...new Set<ReasoningMode>([recommended, 'none', 'custom', current])];
}

/** Apply only mode-owned fields; preserve capabilities and other advanced compat. */
export function applyReasoningMode(model: ModelProfile, api: string | undefined, providerId: string, mode: ReasoningMode): ModelProfile {
  if (mode === 'custom') return structuredClone(model);
  if (!api || !REASONING_MODES[api]?.includes(mode)) throw new Error('该思考传输方式与当前接口协议不匹配。');
  if (mode === 'anthropic-deepseek' &&
    (dmxapiProtocolForProvider(providerId) !== 'anthropic' || !isDeepseekModelId(model.id))) {
    throw new Error('DeepSeek Anthropic 精确档位仅用于 DMXAPI Anthropic 预设中 ID 以 deepseek- 或 deepseek. 开头的模型。');
  }
  if (mode === 'anthropic-adaptive' && dmxapiProtocolForProvider(providerId) === 'anthropic' && isDeepseekModelId(model.id)) {
    throw new Error('此 DeepSeek 模型会使用 enabled + effort；请选“DeepSeek · enabled + effort”，不能选 Claude adaptive。');
  }
  const result = structuredClone(model);
  const compat: Record<string, unknown> = { ...(result.compat ?? {}) };
  for (const field of MODE_COMPAT_KEYS) delete compat[field];
  if (mode === 'none') {
    result.reasoningEfforts = false;
    if (api === 'openai-completions') {
      compat.thinkingFormat = 'openai';
      compat.supportsReasoningEffort = false;
      compat.supportsThinkingTokenBudget = false;
    }
    if (api === 'anthropic-messages') compat.forceAdaptiveThinking = false;
  } else if (mode === 'anthropic-budget' || mode === 'chat-qwen-budget') {
    // The installed pi-ai budget table clamps max to high for both protocols.
    result.reasoningEfforts = { ...BUDGET_EFFORTS };
    if (mode === 'anthropic-budget') compat.forceAdaptiveThinking = false;
    else {
      compat.thinkingFormat = 'qwen';
      compat.supportsReasoningEffort = false;
      compat.supportsThinkingTokenBudget = true;
      compat.thinkingTokenBudgetField = 'thinking_budget';
    }
  } else {
    result.reasoningEfforts = mode === 'chat-zai' ? { ...ALWAYS_ON_EFFORTS }
      : mode === 'chat-qwen-effort' ? { ...QWEN_EFFORTS }
      : mode === 'chat-switch' ? { ...SWITCH_EFFORTS }
      : mode === 'chat-deepseek' ? { ...FULL_EFFORTS, off: 'disabled' }
      : { ...FULL_EFFORTS };
    if (mode === 'chat-deepseek') {
      compat.thinkingFormat = 'deepseek';
      compat.supportsReasoningEffort = true;
    } else if (mode === 'chat-zai') {
      compat.thinkingFormat = 'zai';
      compat.supportsReasoningEffort = true;
    } else if (mode === 'chat-qwen-effort') {
      compat.thinkingFormat = 'qwen';
      compat.supportsReasoningEffort = true;
      compat.supportsThinkingTokenBudget = false;
    } else if (mode === 'chat-switch') {
      compat.thinkingFormat = 'deepseek';
      compat.supportsReasoningEffort = false;
    } else if (mode === 'chat-effort') {
      compat.thinkingFormat = 'openai';
      compat.supportsReasoningEffort = true;
    } else if (mode === 'anthropic-adaptive' || mode === 'anthropic-deepseek') {
      compat.forceAdaptiveThinking = true;
    }
  }
  if (ALWAYS_ON_PRESET_IDS.has(result.id) && result.reasoningEfforts && typeof result.reasoningEfforts === 'object') {
    delete result.reasoningEfforts.off;
  }
  if (Object.keys(compat).length) result.compat = compat;
  else delete result.compat;
  return result;
}

/** A label for the editable form, never a claim that an upstream model supports it. */
export function inferReasoningMode(model: ModelProfile, api: string | undefined, providerId: string): ReasoningMode {
  if (model.reasoningEfforts === false) return 'none';
  if (model.reasoningEfforts === undefined) return 'custom';
  if (api === 'openai-completions') {
    if (model.compat?.thinkingFormat === 'deepseek' && model.compat.supportsReasoningEffort === true) return 'chat-deepseek';
    if (model.compat?.thinkingFormat === 'zai' && model.compat.supportsReasoningEffort === true) return 'chat-zai';
    if (model.compat?.thinkingFormat === 'qwen' && model.compat.supportsReasoningEffort === true &&
      model.compat.supportsThinkingTokenBudget === false) return 'chat-qwen-effort';
    if (model.compat?.thinkingFormat === 'qwen' && model.compat.supportsThinkingTokenBudget === true) return 'chat-qwen-budget';
    if (model.compat?.thinkingFormat === 'deepseek' && model.compat.supportsReasoningEffort === false) return 'chat-switch';
    if (model.compat?.thinkingFormat === 'openai' && model.compat.supportsReasoningEffort === true) return 'chat-effort';
  }
  if (api === 'openai-responses') return 'responses-effort';
  if (api === 'anthropic-messages') {
    if (model.compat?.forceAdaptiveThinking === true) {
      return dmxapiProtocolForProvider(providerId) === 'anthropic' && isDeepseekModelId(model.id)
        ? 'anthropic-deepseek' : 'anthropic-adaptive';
    }
    if (model.compat?.forceAdaptiveThinking === false && !Object.hasOwn(model.reasoningEfforts, 'max')) return 'anthropic-budget';
  }
  return 'custom';
}

// Configurable fields exposed by dsh-llm-pi-ai 0.1.5-rc.2, not every field in pi-ai.
const COMPAT_FIELDS: Record<string, readonly string[]> = {
  'openai-completions': [
    'supportsStore', 'supportsDeveloperRole', 'supportsReasoningEffort',
    'supportsUsageInStreaming', 'supportsFinishReason', 'maxTokensField',
    'requiresToolResultName', 'requiresAssistantAfterToolResult', 'requiresThinkingAsText',
    'requiresReasoningContentOnAssistantMessages', 'thinkingFormat', 'chatTemplateKwargs',
    'chatTemplateArgs', 'supportsThinkingTokenBudget', 'thinkingTokenBudgetField',
    'vllmPriority', 'supportsStrictMode', 'cacheControlFormat', 'supportsLongCacheRetention',
  ],
  'openai-responses': [
    'supportsDeveloperRole', 'supportsMaxOutputTokens', 'supportsStrictMode', 'supportsLongCacheRetention',
  ],
  'anthropic-messages': [
    'supportsEagerToolInputStreaming', 'supportsLongCacheRetention', 'supportsCacheControlOnTools',
    'supportsTemperature', 'forceAdaptiveThinking', 'allowEmptySignature', 'supportsStrictTools',
  ],
};
const KNOWN_FIELDS = new Set(Object.values(COMPAT_FIELDS).flat());
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export interface ProtocolNormalization {
  draft: ProviderDraft;
  removedCompat: string[];
  baseURLChanged: boolean;
}

/** Normalize a copy at the commit/export boundary; never destroy an unsaved draft. */
export function normalizeProtocolDraft(source: ProviderDraft): ProtocolNormalization {
  const draft = structuredClone(source);
  const result: ProtocolNormalization = { draft, removedCompat: [], baseURLChanged: false };
  const api = draft.profile.api;
  const supported = api && Object.hasOwn(COMPAT_FIELDS, api) ? COMPAT_FIELDS[api] : undefined;
  if (!supported) return result;
  const allowed = new Set(supported);
  function clean(owner: Record<string, unknown>, path: string) {
    if (!isRecord(owner.compat)) return;
    for (const field of Object.keys(owner.compat)) {
      // Unknown/withheld fields still reach Host validation; typos must not vanish.
      if (KNOWN_FIELDS.has(field) && !allowed.has(field)) {
        delete owner.compat[field];
        result.removedCompat.push(`${path}.${field}`);
      }
    }
    if (Object.keys(owner.compat).length === 0) delete owner.compat;
  }
  clean(draft.profile, 'compat');
  if (Array.isArray(draft.profile.models)) draft.profile.models.forEach((model, index) => {
    if (isRecord(model)) clean(model, `models[${index}].compat`);
  });
  if (isRecord(draft.profile.modelOverrides)) for (const [id, model] of Object.entries(draft.profile.modelOverrides)) {
    if (isRecord(model)) clean(model, `modelOverrides.${id}.compat`);
  }

  // The Anthropic SDK appends /v1/messages; OpenAI's SDK appends /responses or
  // /chat/completions. Correct only our exact DMXAPI preset, never a custom path.
  const base = draft.profile.baseURL;
  if (typeof base === 'string' && /^https:\/\/www\.dmxapi\.cn(?:\/v1)?\/?$/.test(base)) {
    const expected = api === 'anthropic-messages' ? 'https://www.dmxapi.cn' : 'https://www.dmxapi.cn/v1';
    if (base !== expected) {
      draft.profile.baseURL = expected;
      result.baseURLChanged = true;
    }
  }
  return result;
}

export function protocolPathHint(api: string | undefined): string {
  if (api === 'anthropic-messages') return 'Anthropic 会追加 /v1/messages；DMXAPI 使用 https://www.dmxapi.cn。';
  if (api === 'openai-responses') return 'Responses 会追加 /responses；DMXAPI 使用 https://www.dmxapi.cn/v1。';
  if (api === 'openai-completions') return 'Chat Completions 会追加 /chat/completions；DMXAPI 使用 https://www.dmxapi.cn/v1。';
  return '';
}
