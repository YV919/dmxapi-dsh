import test from 'node:test';
import { Config as HostConfig } from '@deepseek-ai/dsh-llm-pi-ai';
import assert from 'node:assert/strict';
import {
  createDmxapiDraft, createDmxapiProtocolDraft, mergeDmxapiProtocolDraft, EFFORT_LEVELS, exportProviderYaml, formatEfforts,
  parseEfforts, parseProviderYaml, validateDraft, dmxapiProtocolForProvider, presetReasoningDefault, type ProviderDraft,
} from '../src/config.js';

test('预设路由只识别原 ID 与规范数字后缀，模型默认还核对有效协议', () => {
  for (const protocol of ['chat', 'responses', 'anthropic'] as const) {
    for (const suffix of ['', '-2', '-9', '-10', '-100']) {
      assert.equal(dmxapiProtocolForProvider(`dmxapi-${protocol}${suffix}`), protocol);
    }
    for (const suffix of ['-0', '-1', '-02', '-01', '-foo', '-2-2', '-2x', '-2\n', ' ']) {
      assert.equal(dmxapiProtocolForProvider(`dmxapi-${protocol}${suffix}`), undefined);
    }
  }
  for (const route of ['dmxapi', 'other', 'my-dmxapi-chat', 'DMXAPI-chat']) assert.equal(dmxapiProtocolForProvider(route), undefined);
  assert.equal(presetReasoningDefault('dmxapi-chat-2', 'qwen3.8-max', 'openai-completions'), 'medium');
  assert.equal(presetReasoningDefault('dmxapi-chat-2', 'qwen3.8-max', 'openai-responses'), undefined);
  assert.equal(presetReasoningDefault('dmxapi-chat-2', 'unknown', 'openai-completions'), undefined);
});

test('Host schema 默认字段可在重新载入后再次编辑保存', () => {
  const draft = createDmxapiDraft();
  const normalized = HostConfig({ providers: { dmxapi: draft.profile as never } });
  const profile = normalized.providers!.dmxapi as unknown as ProviderDraft['profile'];
  assert.deepEqual(profile.modelOverrides, {});
  assert.doesNotThrow(() => validateDraft({ id: 'dmxapi', profile }));
  profile.models!.push({ id: 'new-model', input: ['text'] });
  assert.doesNotThrow(() => validateDraft({ id: 'dmxapi', profile }));
  assert.throws(() => validateDraft({ id: 'dmxapi', profile: { ...profile, modelOverrides: { existing: { input: ['text'] } } } }), /modelOverrides/);
});

test('DMXAPI 预设精确保留多模态、默认 high 与四档思考映射', () => {
  const draft = createDmxapiDraft();
  assert.deepEqual(draft, {
    id: 'dmxapi',
    profile: {
      displayName: 'DMXAPI', apiKeyEnv: 'DMXAPI_API_KEY', api: 'openai-completions',
      baseURL: 'https://www.dmxapi.cn/v1', reasoning: 'high',
      compat: { thinkingFormat: 'deepseek', supportsReasoningEffort: true, supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
      models: [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash', input: ['text', 'image'], reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' } }],
    },
  });
  validateDraft(draft);
  draft.profile.models![0]!.name = 'changed';
  assert.equal(createDmxapiDraft().profile.models![0]!.name, 'deepseek-v4.1-flash');
});

test('三种 DMXAPI 预设按指定顺序提供模型、协议、视觉和真实思考档位', () => {
  const expected = [
    ['chat', 'dmxapi-chat', 'openai-completions', 'https://www.dmxapi.cn/v1',
      ['deepseek-v4.1-flash', 'glm-5.3', 'glm-5.3-flash', 'qwen3.8-max', 'qwen3.8-max-0902', 'mimo-v2.6-pro']],
    ['responses', 'dmxapi-responses', 'openai-responses', 'https://www.dmxapi.cn/v1',
      ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna']],
    ['anthropic', 'dmxapi-anthropic', 'anthropic-messages', 'https://www.dmxapi.cn',
      ['claude-fable-5-1-cc', 'claude-opus-5-5-cc', 'claude-sonnet-5-cc']],
  ] as const;
  for (const [preset, id, api, baseURL, modelIds] of expected) {
    const draft = createDmxapiProtocolDraft(preset);
    assert.equal(draft.id, id);
    assert.equal(draft.profile.api, api);
    assert.equal(draft.profile.baseURL, baseURL);
    assert.equal(draft.profile.reasoning, preset === 'chat' ? undefined : 'high');
    assert.equal(draft.profile.apiKeyEnv, undefined);
    assert.deepEqual(draft.profile.models!.map(model => model.id), modelIds);
    assert.ok(draft.profile.models!.every(model => (model.contextWindow ?? 0) >= 1_000_000 &&
      (model.maxTokens ?? 0) >= 128_000 && model.reasoningEfforts !== false));
    validateDraft(draft);
    HostConfig({ providers: { [draft.id]: draft.profile as never } });
    draft.profile.models![0]!.name = 'changed';
    assert.equal(createDmxapiProtocolDraft(preset).profile.models![0]!.name, modelIds[0]);
  }
  const chat = createDmxapiProtocolDraft('chat').profile.models!;
  assert.deepEqual(chat[0]!.reasoningEfforts, { off: 'disabled', low: 'low', high: 'high', max: 'max' });
  assert.deepEqual(chat[3]!.reasoningEfforts, { off: null, medium: 'medium', xhigh: 'xhigh' });
  assert.deepEqual(chat[4]!.reasoningEfforts, chat[3]!.reasoningEfforts);
  assert.deepEqual(chat[5]!.reasoningEfforts, { off: 'disabled', high: 'high' });
  assert.equal(chat[5]!.compat?.maxTokensField, 'max_completion_tokens');
  assert.deepEqual(createDmxapiProtocolDraft('responses').profile.models![0]!.reasoningEfforts,
    { low: 'low', high: 'high', max: 'max' });
  assert.deepEqual(createDmxapiProtocolDraft('responses').profile.models![1]!.reasoningEfforts,
    { off: 'none', low: 'low', high: 'high', max: 'max' });
  assert.deepEqual(createDmxapiProtocolDraft('anthropic').profile.models![0]!.reasoningEfforts,
    { low: 'low', high: 'high', max: 'max' });
  assert.deepEqual(createDmxapiProtocolDraft('anthropic').profile.models![2]!.reasoningEfforts,
    { off: 'disabled', low: 'low', high: 'high', max: 'max' });
  assert.deepEqual(chat[1]!.input, ['text']);
  assert.deepEqual(chat[2]!.input, ['text', 'image']);
  assert.equal(createDmxapiDraft().id, 'dmxapi');
});

test('更新旧 Chat 推荐配置时采用 Qwen 原生等级并移除无效统一 high', () => {
  const draft = createDmxapiProtocolDraft('chat');
  draft.profile.reasoning = 'high';
  draft.profile.models![3]!.reasoningEfforts = { off: null, low: 'low', high: 'medium', max: 'xhigh' };
  const merged = mergeDmxapiProtocolDraft(draft, 'chat');
  assert.equal(merged.profile.reasoning, undefined);
  assert.deepEqual(merged.profile.models![3]!.reasoningEfforts, { off: null, medium: 'medium', xhigh: 'xhigh' });
  assert.equal(draft.profile.reasoning, 'high');
  validateDraft(merged);
});

test('应用推荐模型更新同名模型，同时保留密钥引用、自定义字段和额外模型', () => {
  const old = createDmxapiProtocolDraft('anthropic');
  old.profile.apiKeyEnv = 'DMXAPI_EXISTING_REF';
  old.profile.customSetting = { retained: true };
  old.profile.models = [{
    id: 'claude-opus-5-5-cc', name: '自定义名称', input: ['text'], contextWindow: 100,
    reasoningEfforts: { off: null, high: 'high' },
    compat: { forceAdaptiveThinking: false, supportsStrictTools: true },
    customField: 'retained',
  }, { id: 'extra-model', reasoningEfforts: { low: 'low' } }];
  const before = structuredClone(old);
  const merged = mergeDmxapiProtocolDraft(old, 'anthropic');
  assert.deepEqual(old, before);
  assert.equal(merged.profile.apiKeyEnv, 'DMXAPI_EXISTING_REF');
  assert.deepEqual(merged.profile.customSetting, { retained: true });
  assert.deepEqual(merged.profile.models!.map(model => model.id), [
    'claude-fable-5-1-cc', 'claude-opus-5-5-cc', 'claude-sonnet-5-cc', 'extra-model',
  ]);
  const opus = merged.profile.models![1]!;
  assert.equal(opus.name, '自定义名称');
  assert.deepEqual(opus.input, ['text', 'image']);
  assert.equal(opus.contextWindow, 1_000_000);
  assert.deepEqual(opus.reasoningEfforts, { low: 'low', high: 'high', max: 'max' });
  assert.equal(opus.compat?.forceAdaptiveThinking, true);
  assert.equal(opus.compat?.supportsStrictTools, true);
  assert.equal(opus.customField, 'retained');
  assert.equal(merged.profile.reasoning, undefined);
  validateDraft(merged);
  HostConfig({ providers: { [merged.id]: merged.profile as never } });
  assert.throws(() => mergeDmxapiProtocolDraft(old, 'chat'), /同标识、同接口协议/);
  old.profile.modelOverrides = { conflicting: {} };
  assert.throws(() => mergeDmxapiProtocolDraft(old, 'anthropic'), /modelOverrides/);
});

test('显式模型的服务商默认思考等级必须逐个受支持', () => {
  const draft = createDmxapiProtocolDraft('responses');
  draft.profile.models = [
    { id: 'model-one', reasoningEfforts: { low: 'low', high: 'high' } },
    { id: 'model-two', reasoningEfforts: { off: null, low: 'low' } },
  ];
  assert.throws(() => validateDraft(draft), /model-two.*high/);
  draft.profile.reasoning = 'low';
  assert.doesNotThrow(() => validateDraft(draft));
  draft.profile.models![1]!.reasoningEfforts = false;
  assert.throws(() => validateDraft(draft), /model-two.*不支持思考/);
  delete draft.profile.reasoning;
  assert.doesNotThrow(() => validateDraft(draft));
});

test('YAML 往返保留所有非敏感高级字段', () => {
  const draft = createDmxapiDraft();
  draft.profile.timeoutMs = 12_345;
  draft.profile.requestImagePixelBudget = 4_194_304;
  draft.profile.retryPolicy = { mode: 'normal', maxRetries: 2 };
  draft.profile.compat!.futureFlag = { enabled: true, levels: ['fast', 'slow'] };
  draft.profile.models![0]!.contextWindow = 262_144;
  draft.profile.models![0]!.futureMetadata = { nested: { one: 1 }, unavailable: null };
  assert.deepEqual(parseProviderYaml(exportProviderYaml(draft)), draft);
});

test('单 provider 的三种 YAML 外层都可导入', () => {
  const route = 'dmxapi:\n  baseURL: https://www.dmxapi.cn/v1\n  api: openai-completions\n  models:\n    - id: deepseek-v4.1-flash\n';
  const expected = parseProviderYaml(route);
  const indent = (text: string) => text.split('\n').map((line) => line ? `  ${line}` : line).join('\n');
  assert.deepEqual(parseProviderYaml(`providers:\n${indent(route)}`), expected);
  assert.deepEqual(parseProviderYaml(`llm-pi-ai:\n  providers:\n${indent(indent(route))}`), expected);
});

test('多 provider、多命名空间和 wrapper 的额外字段不会被静默丢弃', () => {
  for (const source of [
    'dmxapi: {}\nother: {}',
    'providers:\n  dmxapi: {}\n  other: {}',
    'llm-pi-ai:\n  providers:\n    dmxapi: {}\nother: {}',
    'providers:\n  dmxapi: {}\nextra: true',
    'llm-pi-ai:\n  providers:\n    dmxapi: {}\n  extra: true',
    'llm-pi-ai: {}', '{}', '[]', 'false', 'dmxapi: null',
  ]) assert.throws(() => parseProviderYaml(source));
});

test('重复键、特殊标签、多 YAML 文档和原型字段被拒绝', () => {
  for (const source of [
    'dmxapi:\n  reasoning: low\n  reasoning: high',
    'dmxapi: {}\ndmxapi: {}',
    'dmxapi: !!js/function function(){}',
    'dmxapi: {}\n---\nother: {}',
    '__proto__: {}',
    'dmxapi:\n  compat:\n    __proto__: { polluted: true }',
    'dmxapi:\n  compat:\n    constructor: { prototype: { polluted: true } }',
    'dmxapi:\n  <<: { reasoning: high }',
    'dmxapi: &loop\n  repeated: *loop',
  ]) assert.throws(() => parseProviderYaml(source));
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('YAML 错误消息不回显包含密钥的源文本', () => {
  assert.throws(() => parseProviderYaml('dmxapi:\n  apiKey: [sk-do-not-echo'), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /sk-do-not-echo/);
    return true;
  });
});

test('全部思考等级允许映射到接口自定义值，off 可映射 null', () => {
  const levels = Object.fromEntries(EFFORT_LEVELS.map((level) => [level, level === 'off' ? null : `wire-${level}`]));
  assert.deepEqual(parseEfforts(formatEfforts(levels)), levels);
  assert.equal(parseEfforts('false'), false);
  assert.equal(formatEfforts(false), 'false');
  assert.equal(formatEfforts(undefined), '');
  assert.deepEqual(parseEfforts('off: disabled\nmax: ultra'), { off: 'disabled', max: 'ultra' });
});

test('无效等级、空字典、只有 off 或错误映射类型被拒绝', () => {
  for (const source of ['', '{}', 'true', 'null', '[]', 'off: null', 'ultra: max', 'high: null', 'high: false', 'high: 1', 'high: ""', 'high: " high "']) {
    assert.throws(() => parseEfforts(source));
  }
  assert.throws(() => parseEfforts('high: high\nhigh: max'));
});

test('校验只检查已配置字段，允许内置 provider 继承目录与地址', () => {
  validateDraft({ id: 'openai', profile: {} });
  validateDraft({ id: 'anthropic', profile: { apiKeyEnv: 'ANTHROPIC_API_KEY' } });
  validateDraft({ id: 'openai', profile: { modelOverrides: { 'gpt-example': { input: ['text', 'image'], maxTokens: 32_768 } } } });
  validateDraft({ id: 'dmxapi', profile: { models: [{ id: 'inherit-modalities', input: [] }] } });
  assert.throws(() => validateDraft({ id: 'openai', profile: { models: [] } }));
  assert.doesNotThrow(() => validateDraft({ id: 'openai', profile: { models: [{ id: 'gpt-example' }], modelOverrides: {} } }));
});

test('Provider ID、apiKeyEnv、HTTP 地址与 URL 凭证检查', () => {
  for (const id of ['', 'DMXAPI', ' dmxapi', 'has space', '../dmxapi', '__proto__', 'constructor', 'deepseek-official', 'providers', 'llm-pi-ai']) {
    assert.throws(() => validateDraft({ id, profile: {} }));
  }
  for (const apiKeyEnv of ['', 'sk-secret-key', 'DMXAPI\\_API\\_KEY', 'DMX API KEY']) {
    assert.throws(() => validateDraft({ id: 'dmxapi', profile: { apiKeyEnv } }));
  }
  for (const baseURL of ['ftp://host/v1', 'not a URL', 'https://user:pass@host/v1', 'https://host/v1?api_key=secret']) {
    assert.throws(() => validateDraft({ id: 'dmxapi', profile: { baseURL } }));
  }
  for (const baseURL of ['https://www.dmxapi.cn/v1', 'http://localhost:1234/v1', 'http://[::1]:1234/v1']) {
    validateDraft({ id: 'dmxapi', profile: { baseURL } });
  }
});

test('模型 ID、输入类型、容量与默认思考等级检查', () => {
  const invalid: ProviderDraft[] = [
    { id: 'dmxapi', profile: { reasoning: 'ultra' } },
    { id: 'dmxapi', profile: { models: [{ id: '' }] } },
    { id: 'dmxapi', profile: { models: [{ id: 'same' }, { id: 'same' }] } },
    { id: 'dmxapi', profile: { models: [{ id: 'm', name: '' }] } },
    { id: 'dmxapi', profile: { models: [{ id: 'm', input: ['text', 'text'] }] } },
    { id: 'dmxapi', profile: { models: [{ id: 'm', input: ['audio'] as never }] } },
    { id: 'dmxapi', profile: { models: [{ id: 'm', maxTokens: 0 }] } },
    { id: 'dmxapi', profile: { models: [{ id: 'm', contextWindow: 1.5 }] } },
    { id: 'dmxapi', profile: { defaultInput: [] } },
  ];
  for (const draft of invalid) assert.throws(() => validateDraft(draft));
});

test('拒绝明文 secret 字段，但不误判容量与凭证引用字段', () => {
  for (const field of ['apiKey', 'api_key', 'token', 'password', 'access_token', 'clientSecret', 'authorization']) {
    const draft = createDmxapiDraft();
    draft.profile[field] = 'never-export-this';
    assert.throws(() => validateDraft(draft), /明文密钥/);
  }
  assert.throws(() => parseProviderYaml('dmxapi:\n  extra:\n    apiKey: secret'), /明文密钥/);
  const draft = createDmxapiDraft();
  draft.profile.defaultMaxTokens = 32_768;
  draft.profile.models![0]!.maxTokens = 32_768;
  validateDraft(draft);
});

test('导出移除所有 headers 但保留源对象和其他高级字段', () => {
  const draft = createDmxapiDraft();
  draft.profile.headers = { Authorization: 'Bearer secret-one', 'X-Tenant': 'tenant-a' };
  draft.profile.models![0]!.future = { headers: { 'x-api-key': 'secret-two' }, safeValue: 42 };
  const before = structuredClone(draft);
  const text = exportProviderYaml(draft);
  assert.doesNotMatch(text, /headers|secret-one|secret-two|tenant-a/);
  const roundTrip = parseProviderYaml(text);
  assert.equal(roundTrip.profile.headers, undefined);
  assert.deepEqual(roundTrip.profile.models![0]!.future, { safeValue: 42 });
  assert.deepEqual(draft, before);
});

test('不接受非 JSON 值、循环对象或过深结构', () => {
  const loop: Record<string, unknown> = {};
  loop.again = loop;
  for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, new Date(), () => 1, loop]) {
    assert.throws(() => validateDraft({ id: 'dmxapi', profile: { advanced: value } }));
  }
  let value: unknown = 1;
  for (let index = 0; index < 70; index++) value = { nested: value };
  assert.throws(() => validateDraft({ id: 'dmxapi', profile: { advanced: value } }));
});
