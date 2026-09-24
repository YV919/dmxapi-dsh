import { dump, JSON_SCHEMA, load } from 'js-yaml';

export const EFFORT_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export type ModelProfile = {
  id: string;
  name?: string;
  input?: ('text' | 'image')[];
  reasoningEfforts?: false | Record<string, string | null>;
  contextWindow?: number;
  maxTokens?: number;
  compat?: Record<string, unknown>;
  [key: string]: unknown;
};

export type ProviderProfile = Record<string, unknown> & {
  displayName?: string;
  apiKeyEnv?: string;
  api?: string;
  baseURL?: string;
  reasoning?: string;
  models?: ModelProfile[];
  compat?: Record<string, unknown>;
};

export type ProviderDraft = { id: string; profile: ProviderProfile };

export type DmxapiProtocolPreset = 'chat' | 'responses' | 'anthropic';

/** Preset copies use canonical positive integer suffixes, starting at two. */
export function dmxapiProtocolForProvider(id: string): DmxapiProtocolPreset | undefined {
  const match = /^dmxapi-(chat|responses|anthropic)(?:-([2-9]|[1-9][0-9]+))?$/.exec(id);
  return match?.[0] === id ? match[1] as DmxapiProtocolPreset : undefined;
}

const DMXAPI_PROTOCOL_PRESETS: Record<DmxapiProtocolPreset, {
  id: string; displayName: string; api: string; baseURL: string;
}> = {
  chat: { id: 'dmxapi-chat', displayName: 'DMXAPI · Chat', api: 'openai-completions', baseURL: 'https://www.dmxapi.cn/v1' },
  responses: { id: 'dmxapi-responses', displayName: 'DMXAPI · Responses', api: 'openai-responses', baseURL: 'https://www.dmxapi.cn/v1' },
  anthropic: { id: 'dmxapi-anthropic', displayName: 'DMXAPI · Anthropic', api: 'anthropic-messages', baseURL: 'https://www.dmxapi.cn' },
};

const DEFAULT_CAPACITY = 1_000_000;
const DEFAULT_OUTPUT = 128_000;
const THREE_LEVELS = { low: 'low', high: 'high', max: 'max' } as const;
const OFF_THREE_LEVELS = { off: 'disabled', ...THREE_LEVELS } as const;
const CLAUDE_COMPAT = { forceAdaptiveThinking: true } as const;
export const ALWAYS_ON_PRESET_IDS: ReadonlySet<string> = new Set([
  'glm-5.3', 'glm-5.3-flash', 'gpt-6-astra',
  'claude-fable-5-1-cc', 'claude-opus-5-5-cc',
]);

/** Ordered model facts from the model vendors; the exact IDs are DMXAPI-facing. */
const DMXAPI_MODEL_PRESETS: Record<DmxapiProtocolPreset, readonly ModelProfile[]> = {
  chat: [
    {
      id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash', input: ['text', 'image'],
      contextWindow: DEFAULT_CAPACITY, maxTokens: 384_000,
      reasoningEfforts: { ...OFF_THREE_LEVELS },
      compat: { thinkingFormat: 'deepseek', supportsReasoningEffort: true },
    },
    {
      id: 'glm-5.3', name: 'glm-5.3', input: ['text'],
      contextWindow: DEFAULT_CAPACITY, maxTokens: DEFAULT_OUTPUT,
      reasoningEfforts: { ...THREE_LEVELS },
      compat: { thinkingFormat: 'zai', supportsReasoningEffort: true },
    },
    {
      id: 'glm-5.3-flash', name: 'glm-5.3-flash', input: ['text', 'image'],
      contextWindow: DEFAULT_CAPACITY, maxTokens: DEFAULT_OUTPUT,
      reasoningEfforts: { ...THREE_LEVELS },
      compat: { thinkingFormat: 'zai', supportsReasoningEffort: true },
    },
    {
      id: 'qwen3.8-max', name: 'qwen3.8-max', input: ['text', 'image'],
      contextWindow: DEFAULT_CAPACITY, maxTokens: 131_072,
      reasoningEfforts: { off: null, medium: 'medium', xhigh: 'xhigh' },
      compat: { thinkingFormat: 'qwen', supportsReasoningEffort: true, supportsThinkingTokenBudget: false },
    },
    {
      id: 'qwen3.8-max-0902', name: 'qwen3.8-max-0902', input: ['text', 'image'],
      contextWindow: DEFAULT_CAPACITY, maxTokens: 131_072,
      reasoningEfforts: { off: null, medium: 'medium', xhigh: 'xhigh' },
      compat: { thinkingFormat: 'qwen', supportsReasoningEffort: true, supportsThinkingTokenBudget: false },
    },
    {
      id: 'mimo-v2.6-pro', name: 'mimo-v2.6-pro', input: ['text', 'image'],
      contextWindow: DEFAULT_CAPACITY, maxTokens: DEFAULT_OUTPUT,
      // Host requires a standard effort ID; UI metadata names this switch “开启”.
      reasoningEfforts: { off: 'disabled', high: 'high' },
      compat: { thinkingFormat: 'deepseek', supportsReasoningEffort: false, maxTokensField: 'max_completion_tokens' },
    },
  ],
  responses: [
    {
      id: 'gpt-6-astra', name: 'gpt-6-astra', input: ['text', 'image'],
      contextWindow: 1_050_000, maxTokens: DEFAULT_OUTPUT,
      reasoningEfforts: { ...THREE_LEVELS },
    },
    ...(['gpt-6-sol', 'gpt-6-luna'] as const).map(id => ({
      id, name: id, input: ['text', 'image'] as ('text' | 'image')[],
      contextWindow: 1_050_000, maxTokens: DEFAULT_OUTPUT,
      reasoningEfforts: { off: 'none', ...THREE_LEVELS },
    })),
  ],
  anthropic: [
    ...(['claude-fable-5-1-cc', 'claude-opus-5-5-cc'] as const).map(id => ({
      id, name: id, input: ['text', 'image'] as ('text' | 'image')[],
      contextWindow: DEFAULT_CAPACITY, maxTokens: DEFAULT_OUTPUT,
      reasoningEfforts: { ...THREE_LEVELS },
      compat: { ...CLAUDE_COMPAT },
    })),
    {
      id: 'claude-sonnet-5-cc', name: 'claude-sonnet-5-cc', input: ['text', 'image'],
      contextWindow: DEFAULT_CAPACITY, maxTokens: DEFAULT_OUTPUT,
      reasoningEfforts: { off: 'disabled', ...THREE_LEVELS },
      compat: { ...CLAUDE_COMPAT },
    },
  ],
};

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor', '<<']);
const SECRET_KEYS = new Set([
  'apikey', 'token', 'password', 'passwd', 'secret', 'clientsecret',
  'accesstoken', 'refreshtoken', 'authorization', 'credential', 'credentials',
]);
const normalizeKey = (key: string): string => key.toLowerCase().replace(/[-_\s]/g, '');

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fail(message: string): never {
  throw new Error(message);
}

/** Reject non-JSON objects and dangerous property names before copying any untrusted data. */
function validateTree(value: unknown): void {
  const ancestors = new WeakSet<object>();
  let visited = 0;
  const visit = (item: unknown, depth: number, inHeaders: boolean): void => {
    if (++visited > 50_000 || depth > 64) fail('配置过大或嵌套过深，请缩小后重试。');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || (!Array.isArray(item) && !isRecord(item))) {
      fail('配置只接受 JSON 类型的值，不支持日期、函数或特殊对象。');
    }
    if (ancestors.has(item)) fail('配置不能包含循环引用。');
    ancestors.add(item);
    if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1, inHeaders);
    } else {
      for (const [key, child] of Object.entries(item)) {
        if (FORBIDDEN_KEYS.has(key)) fail('配置含有不允许的原型字段或 YAML 合并键。');
        if (!inHeaders && SECRET_KEYS.has(normalizeKey(key))) {
          fail('YAML 配置不能保存明文密钥；请在上方 API Key 输入框中填写。');
        }
        visit(child, depth + 1, inHeaders || key.toLowerCase() === 'headers');
      }
    }
    ancestors.delete(item);
  };
  visit(value, 0, false);
}

function requireText(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    fail(`${label}必须是非空文本，且不能带首尾空格。`);
  }
}

function optionalText(record: Record<string, unknown>, field: string, label: string): void {
  if (record[field] !== undefined) requireText(record[field], label);
}

function validateModalities(value: unknown, label: string, allowEmpty: boolean): void {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    fail(`${label}必须是 text、image 组成的数组。`);
  }
  if (value.some((part) => part !== 'text' && part !== 'image') || new Set(value).size !== value.length) {
    fail(`${label}只能包含不重复的 text、image。`);
  }
}

function validateEfforts(value: unknown): asserts value is false | Record<string, string | null> {
  if (value === false) return;
  if (!isRecord(value) || Object.keys(value).length === 0) {
    fail('思考等级必须是非空 YAML 映射，或 false（不支持思考）。');
  }
  for (const [level, wire] of Object.entries(value)) {
    if (!(EFFORT_LEVELS as readonly string[]).includes(level)) {
      fail(`思考等级仅支持 ${EFFORT_LEVELS.join('、')}。`);
    }
    if (wire === null) {
      if (level !== 'off') fail('只有 off 的映射值可以是 null；其他等级必须填写接口接受的值。');
    } else {
      requireText(wire, '思考等级映射值');
    }
  }
  if (Object.keys(value).every((level) => level === 'off')) {
    fail('思考等级不能只有 off；不支持思考的模型请填写 false。');
  }
}

function validateModelFields(model: Record<string, unknown>): void {
  optionalText(model, 'name', '模型名称');
  if (model.input !== undefined) validateModalities(model.input, '模型输入类型', true);
  if (model.reasoningEfforts !== undefined) validateEfforts(model.reasoningEfforts);
  for (const field of ['contextWindow', 'maxTokens']) {
    const value = model[field];
    if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)) {
      fail(`${field} 必须是正整数。`);
    }
  }
  if (model.compat !== undefined && !isRecord(model.compat)) fail('模型 compat 必须是映射。');
}

/** A new mutable draft with exactly the user-requested DMXAPI preset. */
export function createDmxapiDraft(): ProviderDraft {
  return {
    id: 'dmxapi',
    profile: {
      displayName: 'DMXAPI',
      apiKeyEnv: 'DMXAPI_API_KEY',
      api: 'openai-completions',
      baseURL: 'https://www.dmxapi.cn/v1',
      reasoning: 'high',
      compat: {
        thinkingFormat: 'deepseek',
        supportsReasoningEffort: true,
        supportsDeveloperRole: false,
        maxTokensField: 'max_tokens',
      },
      models: [{
        id: 'deepseek-v4.1-flash',
        name: 'deepseek-v4.1-flash',
        input: ['text', 'image'],
        reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' },
      }],
    },
  };
}

/** Three independent routes with vendor-informed ordered model catalogs. */
export function createDmxapiProtocolDraft(protocol: DmxapiProtocolPreset): ProviderDraft {
  const preset = DMXAPI_PROTOCOL_PRESETS[protocol];
  return {
    id: preset.id,
    profile: {
      displayName: preset.displayName,
      api: preset.api,
      baseURL: preset.baseURL,
      ...(protocol === 'chat' ? {} : { reasoning: 'high' }),
      ...(protocol === 'chat' ? { compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' } } : {}),
      models: structuredClone(DMXAPI_MODEL_PRESETS[protocol]) as ModelProfile[],
    },
  };
}

/** Only a matching preset route, effective protocol and known model receive a default. */
export function presetReasoningDefault(provider: string, modelId: string, api: string | undefined): string | undefined {
  const protocol = dmxapiProtocolForProvider(provider);
  if (!protocol || DMXAPI_PROTOCOL_PRESETS[protocol].api !== api ||
    !DMXAPI_MODEL_PRESETS[protocol].some(model => model.id === modelId)) return undefined;
  return modelId.startsWith('qwen3.8-') ? 'medium' : 'high';
}

const MANAGED_COMPAT = [
  'thinkingFormat', 'supportsReasoningEffort', 'supportsThinkingTokenBudget',
  'thinkingTokenBudgetField', 'forceAdaptiveThinking', 'maxTokensField',
] as const;

/** Apply current official defaults to matching IDs while retaining unrelated user fields. */
export function mergeDmxapiProtocolDraft(existing: ProviderDraft, protocol: DmxapiProtocolPreset): ProviderDraft {
  const preset = createDmxapiProtocolDraft(protocol);
  if (existing.id !== preset.id || existing.profile.api !== preset.profile.api) {
    fail('只能将推荐模型应用到同标识、同接口协议的 DMXAPI 服务商。');
  }
  if (existing.profile.modelOverrides && Object.keys(existing.profile.modelOverrides).length > 0) {
    fail('此服务商使用 modelOverrides；请先在完整 YAML 中处理覆盖项，再应用推荐模型。');
  }
  const result = structuredClone(existing);
  const originals = new Map((result.profile.models ?? []).map(model => [model.id, model]));
  const recommended = new Set(preset.profile.models!.map(model => model.id));
  result.profile.models = preset.profile.models!.map(model => {
    const current = originals.get(model.id);
    if (!current) return model;
    const compat = { ...(current.compat ?? {}) };
    for (const field of MANAGED_COMPAT) delete compat[field];
    Object.assign(compat, model.compat ?? {});
    const merged: ModelProfile = { ...current, ...model, name: current.name ?? model.name };
    if (Object.keys(compat).length) merged.compat = compat;
    else delete merged.compat;
    return merged;
  });
  result.profile.models.push(...(existing.profile.models ?? [])
    .filter(model => !recommended.has(model.id)).map(model => structuredClone(model)));
  const level = result.profile.reasoning;
  if (level && result.profile.models.some(model => model.reasoningEfforts === false ||
    (model.reasoningEfforts !== undefined && !Object.hasOwn(model.reasoningEfforts, level)))) {
    if (result.profile.models.every(model => model.reasoningEfforts !== false &&
      (model.reasoningEfforts === undefined || Object.hasOwn(model.reasoningEfforts, 'high')))) {
      result.profile.reasoning = 'high';
    } else {
      delete result.profile.reasoning;
    }
  }
  validateDraft(result);
  return result;
}

/** Validate authored fields; the Host remains authoritative for catalog inheritance and wire compatibility. */
export function validateDraft(draft: ProviderDraft): void {
  if (!isRecord(draft) || !isRecord(draft.profile)) fail('配置必须包含 provider ID 和 provider 配置映射。');
  requireText(draft.id, 'Provider ID');
  if (!/^[a-z][a-z0-9_-]*$/.test(draft.id) || FORBIDDEN_KEYS.has(draft.id)) {
    fail('Provider ID 必须以小写字母开头，仅包含小写字母、数字、下划线和连字符。');
  }
  if (draft.id === 'deepseek-official') fail('deepseek-official 是官方适配器保留的 Provider ID，请使用其他 ID。');
  if (draft.id === 'providers' || draft.id === 'llm-pi-ai') fail('providers 和 llm-pi-ai 是 YAML 外层名称，请使用其他 Provider ID。');
  validateTree(draft.profile);
  const profile = draft.profile;
  optionalText(profile, 'displayName', '显示名称');
  optionalText(profile, 'api', 'API 协议');
  if (profile.apiKeyEnv !== undefined) {
    if (typeof profile.apiKeyEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(profile.apiKeyEnv)) {
      fail('apiKeyEnv 仅用于内部凭据引用；实际密钥请填写在 API Key 输入框中。');
    }
  }
  if (profile.baseURL !== undefined) {
    requireText(profile.baseURL, '接口地址');
    let url: URL;
    try { url = new URL(profile.baseURL); } catch { fail('接口地址必须是有效的 HTTP 或 HTTPS URL。'); }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) fail('接口地址必须使用 HTTP 或 HTTPS。');
    if (url.username || url.password || [...url.searchParams.keys()].some((key) => SECRET_KEYS.has(normalizeKey(key)))) {
      fail('接口地址不能包含用户名、密码或密钥参数；请使用 apiKeyEnv 管理凭证。');
    }
  }
  if (profile.reasoning !== undefined && !(EFFORT_LEVELS as readonly unknown[]).includes(profile.reasoning)) {
    fail(`默认思考等级仅支持 ${EFFORT_LEVELS.join('、')}。`);
  }
  if (profile.compat !== undefined && !isRecord(profile.compat)) fail('Provider compat 必须是映射。');
  if (profile.defaultInput !== undefined) validateModalities(profile.defaultInput, '默认输入类型', false);
  if (profile.headers !== undefined) {
    if (!isRecord(profile.headers) || Object.values(profile.headers).some((value) => typeof value !== 'string')) {
      fail('headers 必须是文本值组成的映射。');
    }
  }
  if (profile.models !== undefined) {
    if (!Array.isArray(profile.models) || profile.models.length === 0) fail('models 必须是至少包含一个模型的数组；使用内置目录时请移除 models 字段。');
    const ids = new Set<string>();
    for (const model of profile.models) {
      if (!isRecord(model)) fail('每个模型必须是配置映射。');
      requireText(model.id, '模型 ID');
      if (ids.has(model.id)) fail('模型 ID 不能重复。');
      ids.add(model.id);
      validateModelFields(model);
      if (dmxapiProtocolForProvider(draft.id) === 'anthropic' && profile.api === 'anthropic-messages' &&
        /^deepseek[-.]/i.test(model.id) &&
        (model.compat?.forceAdaptiveThinking ?? profile.compat?.forceAdaptiveThinking) === true) {
        if (model.reasoningEfforts === undefined || model.reasoningEfforts === false) {
          fail(`模型“${model.id}”将按 DeepSeek Anthropic 方式发送 enabled + effort；请显式填写可用思考等级。`);
        }
        for (const [level, wire] of Object.entries(model.reasoningEfforts)) {
          if (!['off', 'low', 'high', 'max'].includes(level) ||
            (level !== 'off' && !['low', 'high', 'max'].includes(wire as string))) {
            fail(`模型“${model.id}”的 DeepSeek Anthropic 思考等级仅支持 off、low、high、max，接口值只能是 low、high、max。`);
          }
        }
      }
      if (profile.reasoning !== undefined && model.reasoningEfforts !== undefined) {
        if (model.reasoningEfforts === false) {
          if (profile.reasoning !== 'off') fail(`模型“${model.id}”不支持思考；请把默认思考等级改为“跟随模型默认”。`);
        } else if (!Object.hasOwn(model.reasoningEfforts, profile.reasoning)) {
          fail(`模型“${model.id}”未提供默认思考等级 ${profile.reasoning}；请选择该模型支持的等级，或改为“跟随模型默认”。`);
        }
      }
    }
  }
  if (profile.modelOverrides !== undefined) {
    if (!isRecord(profile.modelOverrides)) fail('modelOverrides 必须是模型 ID 到配置的映射。');
    // Host settings views materialize an omitted override map as {}.
    if (profile.models !== undefined && Object.keys(profile.modelOverrides).length > 0) fail('models 与 modelOverrides 不能同时设置。');
    for (const [id, override] of Object.entries(profile.modelOverrides)) {
      requireText(id, '模型 ID');
      if (!isRecord(override)) fail('每个 modelOverrides 条目必须是配置映射。');
      validateModelFields(override);
    }
  }
}

function parseYaml(text: string): unknown {
  if (typeof text !== 'string' || text.trim().length === 0) fail('请填写 YAML 配置。');
  if (text.length > 1_048_576) fail('YAML 配置不能超过 1 MiB。');
  let value: unknown;
  try { value = load(text, { schema: JSON_SCHEMA }); } catch {
    // Parser diagnostics can include the entire credential-bearing source line.
    fail('YAML 解析失败，请检查缩进、重复键、特殊标签或多文档分隔符。');
  }
  validateTree(value);
  return value;
}

/** Accept a single route mapping, its providers wrapper, or its llm-pi-ai settings wrapper. */
export function parseProviderYaml(text: string): ProviderDraft {
  const parsed = parseYaml(text);
  if (!isRecord(parsed)) fail('YAML 顶层必须是 provider 映射。');
  let routes: Record<string, unknown> = parsed;
  if (Object.hasOwn(routes, 'llm-pi-ai')) {
    const section = routes['llm-pi-ai'];
    if (Object.keys(routes).length !== 1 || !isRecord(section)) {
      fail('每次只能导入一个 llm-pi-ai provider，不能夹带其他设置命名空间。');
    }
    routes = section;
    if (!Object.hasOwn(routes, 'providers')) fail('llm-pi-ai 配置中缺少 providers。');
  }
  if (Object.hasOwn(routes, 'providers')) {
    const providers = routes.providers;
    if (Object.keys(routes).length !== 1 || !isRecord(providers)) fail('providers 外层不能包含其他字段。');
    routes = providers;
  }
  if (Object.keys(routes).length !== 1) fail('每次只能导入一个 provider；请分别导入，避免丢失其他配置。');
  const [id, profile] = Object.entries(routes)[0]!;
  if (!isRecord(profile)) fail('provider 的配置必须是映射。');
  const draft: ProviderDraft = { id, profile };
  validateDraft(draft);
  return draft;
}

/** Produce a shareable YAML copy. Headers are intentionally omitted at every level. */
export function exportProviderYaml(draft: ProviderDraft): string {
  validateDraft(draft);
  const withoutHeaders = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(withoutHeaders);
    if (!isRecord(value)) return value;
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => key.toLowerCase() !== 'headers')
      .map(([key, child]) => [key, withoutHeaders(child)]));
  };
  return dump({ [draft.id]: withoutHeaders(draft.profile) }, {
    schema: JSON_SCHEMA, noRefs: true, lineWidth: -1, noCompatMode: false,
  });
}

export function parseEfforts(text: string): false | Record<string, string | null> {
  const value = parseYaml(text);
  validateEfforts(value);
  return value;
}

export function formatEfforts(value: ModelProfile['reasoningEfforts']): string {
  if (value === undefined) return '';
  validateTree(value);
  validateEfforts(value);
  return dump(value, { schema: JSON_SCHEMA, noRefs: true, lineWidth: -1 }).trimEnd();
}
