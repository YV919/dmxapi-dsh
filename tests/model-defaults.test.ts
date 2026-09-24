import assert from 'node:assert/strict';
import { after, before, test, type TestContext } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { BlockAssembler, ReasoningEffortId, type LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm';
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai';
import type { PiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai';
import { createDmxapiProtocolDraft, type ProviderDraft } from '../src/config.ts';
import { installPresetModelDefaults, withPresetModelDefaults } from '../src/model-defaults.ts';
import { assemble, mockOpenAI, textPrompt, TEST_KEY, TEST_KEY_ENV } from './helpers.ts';

const originalKey = process.env[TEST_KEY_ENV];
before(() => { process.env[TEST_KEY_ENV] = TEST_KEY; });
after(() => {
  if (originalKey === undefined) delete process.env[TEST_KEY_ENV];
  else process.env[TEST_KEY_ENV] = originalKey;
});

function info(provider = 'dmxapi-chat', id = 'mimo-v2.6-pro', levels = ['off', 'high']): LlmResolvedModelInfo {
  return { provider, id, name: id, reasoning: { efforts: levels.map(level => ({
    id: ReasoningEffortId(level), name: level,
  })) } };
}

test('默认和开关显示只装饰目标模型，保留冻结原对象与显式默认', () => {
  const original = info();
  Object.freeze(original.reasoning!.efforts[0]);
  Object.freeze(original.reasoning!.efforts[1]);
  Object.freeze(original.reasoning!.efforts);
  Object.freeze(original.reasoning);
  Object.freeze(original);
  const decorated = withPresetModelDefaults(original, 'openai-completions');
  assert.equal(original.reasoning!.defaultEffort, undefined);
  assert.deepEqual(original.reasoning!.efforts.map(effort => effort.name), ['off', 'high']);
  assert.equal(decorated.reasoning!.defaultEffort, 'high');
  assert.deepEqual(decorated.reasoning!.efforts.map(effort => [effort.id, effort.name]), [['off', '关闭'], ['high', '开启']]);

  const authored = info();
  authored.reasoning!.defaultEffort = ReasoningEffortId('off');
  assert.equal(withPresetModelDefaults(authored, 'openai-completions').reasoning!.defaultEffort, 'off');
  const customLevels = info('dmxapi-chat', 'mimo-v2.6-pro', ['low', 'high']);
  assert.equal(withPresetModelDefaults(customLevels, 'openai-completions').reasoning!.efforts[1].name, 'high');
  for (const untouched of [info('other'), info('dmxapi-chat', 'unknown'),
    info('dmxapi-chat', 'qwen3.8-max', ['off', 'xhigh']),
    { provider: 'dmxapi-chat', id: 'glm-5.3', name: 'GLM' }]) {
    assert.equal(withPresetModelDefaults(untouched, 'openai-completions'), untouched);
  }
  for (const api of [undefined, 'anthropic-messages', 'openai-responses']) {
    assert.equal(withPresetModelDefaults(original, api), original);
  }
});

test('共享 adapter 去重、热挂载和卸载只恢复自身 wrapper，并保留原 prepared stream', async () => {
  class PiAiAdapter {
    snapshot = { models: { getModel: () => ({ api: 'openai-completions' }) } };
    current() { return this.snapshot; }
    async resolveModel(provider: string, model: string) { return info(provider, model); }
    async prepareCall(provider: string, model: string) {
      return Object.freeze({ model: Object.freeze(info(provider, model)), stream: this.stream });
    }
    stream = () => undefined;
  }
  const adapter = new PiAiAdapter();
  const originalResolve = adapter.resolveModel;
  const originalPrepare = adapter.prepareCall;
  const adapters = new Map(['dmxapi-chat', 'dmxapi-responses', 'other'].map(route => [route, { adapter }]));
  const listeners = new Set<() => void>();
  const ctx = { llm: { adapters }, on: (_event: string, callback: () => void) => {
    listeners.add(callback); return () => listeners.delete(callback);
  } } as unknown as Context;
  const uninstall = installPresetModelDefaults(ctx);
  assert.throws(() => installPresetModelDefaults(ctx), /不能重复加载/);
  const wrapper = adapter.resolveModel;
  for (const listener of listeners) listener();
  assert.equal(adapter.resolveModel, wrapper);
  assert.equal((await adapter.resolveModel('dmxapi-chat', 'mimo-v2.6-pro')).reasoning!.defaultEffort, 'high');
  assert.equal((await adapter.resolveModel('other', 'mimo-v2.6-pro')).reasoning!.defaultEffort, undefined);
  const prepared = await adapter.prepareCall('dmxapi-chat', 'mimo-v2.6-pro');
  assert.equal(prepared.stream, adapter.stream);
  assert.equal(prepared.model.reasoning!.defaultEffort, 'high');
  const replacement = new PiAiAdapter();
  const replacementOriginal = replacement.resolveModel;
  adapters.set('dmxapi-chat', { adapter: replacement });
  for (const listener of listeners) listener();
  assert.notEqual(replacement.resolveModel, replacementOriginal);
  const thirdPartyResolve = async () => info('other');
  replacement.resolveModel = thirdPartyResolve;
  uninstall();
  assert.equal(listeners.size, 0);
  assert.equal(adapter.resolveModel, originalResolve);
  assert.equal(adapter.prepareCall, originalPrepare);
  assert.equal(replacement.resolveModel, thirdPartyResolve);
  assert.equal(replacement.prepareCall, originalPrepare);
  const uninstallAgain = installPresetModelDefaults(ctx);
  uninstallAgain();
});

test('真实 Host 后缀 Chat 路由保留 Qwen 默认和 MiMo 开关名，错误路由及有效协议不装饰', async t => {
  const server = await mockOpenAI();
  t.after(server.close);
  for (const route of ['dmxapi-chat-2', 'dmxapi-chat-10', 'dmxapi-chat-02', 'dmxapi-chat-foo', 'dmxapi-chat-2-2']) {
    const draft = createDmxapiProtocolDraft('chat');
    draft.id = route;
    draft.profile.apiKeyEnv = TEST_KEY_ENV;
    draft.profile.baseURL = server.baseURL;
    const ctx = await runtime(t, draft);
    const supported = ['dmxapi-chat-2', 'dmxapi-chat-10'].includes(route);
    const qwen = await ctx.llm.resolveModelInfo(route, 'qwen3.8-max');
    const mimo = await ctx.llm.resolveModelInfo(route, 'mimo-v2.6-pro');
    assert.equal(qwen.reasoning?.defaultEffort, supported ? 'medium' : undefined);
    assert.deepEqual(mimo.reasoning?.efforts.map(effort => effort.name), supported ? ['关闭', '开启'] : ['Off', 'High']);
    const prepared = await ctx.llm.prepareCall({ provider: route, model: 'qwen3.8-max' });
    assert.equal(prepared.config.reasoningEffort, supported ? 'medium' : undefined);
    assert.equal((await assemble(ctx, { provider: route, model: 'qwen3.8-max' })).finish.kind, 'stop');
    assert.equal(server.requests.at(-1)!.enable_thinking, supported);
    assert.equal(server.requests.at(-1)!.reasoning_effort, supported ? 'medium' : undefined);
  }

  // Route names alone must not turn a user-authored Messages/Responses model
  // into the Chat preset's switch/default.
  for (const api of ['anthropic-messages', 'openai-responses']) {
    const draft: ProviderDraft = { id: 'dmxapi-chat-3', profile: {
      api,
      baseURL: server.baseURL, apiKeyEnv: TEST_KEY_ENV,
      models: [{ id: 'mimo-v2.6-pro',
        reasoningEfforts: { off: null, high: 'high' } }],
    } };
    const ctx = await runtime(t, draft);
    const resolved = await ctx.llm.resolveModelInfo(draft.id, 'mimo-v2.6-pro');
    assert.equal(resolved.reasoning?.defaultEffort, undefined);
    assert.deepEqual(resolved.reasoning?.efforts.map(effort => effort.name), ['Off', 'High']);
    assert.equal((await ctx.llm.prepareCall({ provider: draft.id, model: 'mimo-v2.6-pro' })).config.reasoningEffort, undefined);
  }
});

async function runtime(t: TestContext, draft: ProviderDraft) {
  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(LlmPiAi, { providers: { [draft.id]: draft.profile as PiAiProviderProfile } });
  const uninstall = installPresetModelDefaults(ctx);
  t.after(async () => { uninstall(); await ctx.fiber.dispose(); });
  return ctx;
}

test('真实 Host 普通与 prepared 请求按模型补默认，显式等级保留，Qwen 旧等级被拒绝', async t => {
  const server = await mockOpenAI();
  t.after(server.close);
  const draft = createDmxapiProtocolDraft('chat');
  draft.profile.apiKeyEnv = TEST_KEY_ENV;
  draft.profile.baseURL = server.baseURL;
  const ctx = await runtime(t, draft);
  for (const model of draft.profile.models!) {
    const qwen = model.id.startsWith('qwen');
    const level = qwen ? 'medium' : 'high';
    const metadata = await ctx.llm.resolveModelInfo(draft.id, model.id);
    assert.equal(metadata.reasoning?.defaultEffort, level);
    if (model.id.startsWith('mimo')) {
      assert.deepEqual(metadata.reasoning?.efforts.map(effort => effort.name), ['关闭', '开启']);
    }
    assert.equal((await assemble(ctx, { provider: draft.id, model: model.id })).finish.kind, 'stop');
    const normal = server.requests.at(-1)!;
    assert.equal(qwen ? normal.enable_thinking : normal.thinking?.type === 'enabled', true);
    assert.equal(normal.reasoning_effort, model.id.startsWith('mimo') ? undefined : level);

    const prepared = await ctx.llm.prepareCall({ provider: draft.id, model: model.id });
    assert.equal(prepared.config.reasoningEffort, level);
    assert.equal(prepared.adapterDefaults.reasoningEffort, true);
    const assembler = new BlockAssembler();
    for await (const chunk of prepared.stream({ ...prepared.config, messages: textPrompt() })) assembler.push(chunk);
    assert.equal(assembler.finish.kind, 'stop');
    assert.equal(server.requests.at(-1)!.reasoning_effort, normal.reasoning_effort);
  }
  for (const [model, level] of [['qwen3.8-max', 'off'], ['qwen3.8-max-0902', 'xhigh'],
    ['mimo-v2.6-pro', 'off'], ['deepseek-v4.1-flash', 'off'], ['glm-5.3', 'low']]) {
    const prepared = await ctx.llm.prepareCall({ provider: draft.id, model, reasoningEffort: ReasoningEffortId(level) });
    assert.equal(prepared.config.reasoningEffort, level);
    assert.equal(prepared.adapterDefaults.reasoningEffort, undefined);
    const assembler = new BlockAssembler();
    for await (const chunk of prepared.stream({ ...prepared.config, messages: textPrompt() })) assembler.push(chunk);
    assert.equal(assembler.finish.kind, 'stop');
    const body = server.requests.at(-1)!;
    if (level === 'off') {
      assert.equal(model.startsWith('qwen') ? body.enable_thinking : body.thinking?.type === 'enabled', false);
      assert.equal(body.reasoning_effort, undefined);
    } else assert.equal(body.reasoning_effort, level);
  }
  const count = server.requests.length;
  for (const model of ['qwen3.8-max', 'qwen3.8-max-0902']) {
    for (const level of ['low', 'high', 'max']) {
      await assert.rejects(ctx.llm.prepareCall({ provider: draft.id, model, reasoningEffort: ReasoningEffortId(level) }),
        /does not support reasoning effort/);
      const result = await assemble(ctx, { provider: draft.id, model, reasoningEffort: ReasoningEffortId(level) });
      assert.equal(result.finish.kind, 'error');
      if (result.finish.kind === 'error') assert.equal(result.finish.failure.code, 'UNSUPPORTED_REASONING_EFFORT');
    }
  }
  assert.equal(server.requests.length, count);
});

test('服务商显式默认 xhigh 优先于预设 medium', async t => {
  const server = await mockOpenAI();
  t.after(server.close);
  const draft = createDmxapiProtocolDraft('chat');
  draft.profile.apiKeyEnv = TEST_KEY_ENV;
  draft.profile.baseURL = server.baseURL;
  draft.profile.models = draft.profile.models!.filter(model => model.id.startsWith('qwen'));
  draft.profile.reasoning = 'xhigh';
  const ctx = await runtime(t, draft);
  assert.equal((await ctx.llm.resolveModelInfo(draft.id, 'qwen3.8-max')).reasoning?.defaultEffort, 'xhigh');
  assert.equal((await assemble(ctx, { provider: draft.id, model: 'qwen3.8-max' })).finish.kind, 'stop');
  assert.equal(server.requests.at(-1)!.reasoning_effort, 'xhigh');
});

test('移除推荐等级后，无 off 的模型在普通和 prepared 请求中采用剩余原生等级', async t => {
  const server = await mockOpenAI();
  t.after(server.close);
  const draft = createDmxapiProtocolDraft('chat');
  draft.profile.apiKeyEnv = TEST_KEY_ENV;
  draft.profile.baseURL = server.baseURL;
  draft.profile.models = draft.profile.models!.filter(model => model.id === 'glm-5.3' || model.id === 'qwen3.8-max');
  draft.profile.models[0].reasoningEfforts = { low: 'low', max: 'max' };
  draft.profile.models[1].reasoningEfforts = { xhigh: 'xhigh' };
  const ctx = await runtime(t, draft);
  for (const [model, level] of [['glm-5.3', 'low'], ['qwen3.8-max', 'xhigh']]) {
    const metadata = await ctx.llm.resolveModelInfo(draft.id, model);
    assert.equal(metadata.reasoning?.defaultEffort, level);
    assert.equal((await assemble(ctx, { provider: draft.id, model })).finish.kind, 'stop');
    const normal = server.requests.at(-1)!;
    assert.equal(normal.reasoning_effort, level);
    assert.equal(model.startsWith('qwen') ? normal.enable_thinking : normal.thinking?.type === 'enabled', true);
    const prepared = await ctx.llm.prepareCall({ provider: draft.id, model });
    assert.equal(prepared.config.reasoningEffort, level);
    const assembled = new BlockAssembler();
    for await (const chunk of prepared.stream({ ...prepared.config, messages: textPrompt() })) assembled.push(chunk);
    assert.equal(assembled.finish.kind, 'stop');
    const body = server.requests.at(-1)!;
    assert.equal(body.reasoning_effort, level);
    assert.equal(model.startsWith('qwen') ? body.enable_thinking : body.thinking?.type === 'enabled', true);
  }
});
