import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai';
import type { PiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai';
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file';
import { assemble, bootRuntime, FixtureAttachments, IMAGE_REF, MODEL, mockOpenAI, PNG_BASE64, TEST_KEY, TEST_KEY_ENV, testProfile } from './helpers.ts';
import { createDmxapiProtocolDraft } from '../src/config.ts';
import { applyReasoningMode } from '../src/protocol.ts';

const originalTestKey = process.env[TEST_KEY_ENV];

test('混用普通模型时清除服务商默认思考等级即可正常请求', async t => {
  const server = await mockOpenAI();
  t.after(server.close);
  const profile = testProfile(server.baseURL);
  profile.models!.push({ id: 'plain-model', input: ['text'], reasoningEfforts: false });
  const withDefault = await bootRuntime(profile);
  t.after(() => withDefault.fiber.dispose());
  const rejected = await assemble(withDefault, { model: 'plain-model' });
  assert.equal(rejected.finish.kind, 'error');
  assert.equal(server.requests.length, 0);
  delete profile.reasoning;
  const withoutDefault = await bootRuntime(profile);
  t.after(() => withoutDefault.fiber.dispose());
  assert.equal((await assemble(withoutDefault, { model: 'plain-model' })).finish.kind, 'stop');
  assert.equal(server.requests[0].reasoning_effort, undefined);
});
before(() => { process.env[TEST_KEY_ENV] = TEST_KEY; });
after(() => {
  if (originalTestKey === undefined) delete process.env[TEST_KEY_ENV];
  else process.env[TEST_KEY_ENV] = originalTestKey;
});

test('真实模型目录提供图片输入、off/low/high/max 和默认 high', async t => {
  const ctx = await bootRuntime(testProfile('http://127.0.0.1:1/v1'));
  t.after(() => ctx.fiber.dispose());
  assert.deepEqual(ctx.llm.listProviders(), [{ id: 'dmxapi', name: 'DMXAPI' }]);
  const info = await ctx.llm.resolveModelInfo('dmxapi', MODEL);
  assert.deepEqual(info.inputModalities, ['text', 'image']);
  assert.deepEqual(info.reasoning?.efforts.map(effort => effort.id), ['off', 'low', 'high', 'max']);
  assert.equal(info.reasoning?.defaultEffort, 'high');
});

test('真实 OpenAI 请求逐档发送 thinking 和 reasoning_effort', async t => {
  const server = await mockOpenAI();
  t.after(server.close);
  const ctx = await bootRuntime(testProfile(server.baseURL));
  t.after(() => ctx.fiber.dispose());
  for (const effort of ['off', 'low', 'high', 'max']) {
    const result = await assemble(ctx, { reasoningEffort: ReasoningEffortId(effort) });
    assert.deepEqual(result.finish, { kind: 'stop' });
    assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 2, totalTokens: 13 });
    assert.deepEqual(result.message.content, [{ type: 'text', text: 'mock answer' }]);
    const request = server.requests.at(-1)!;
    assert.deepEqual(request.thinking, { type: effort === 'off' ? 'disabled' : 'enabled' });
    if (effort === 'off') assert.equal(Object.hasOwn(request, 'reasoning_effort'), false);
    else assert.equal(request.reasoning_effort, effort);
    assert.equal(request.model, MODEL);
    assert.equal(request.stream, true);
  }
  assert.deepEqual(server.paths, Array(4).fill('/v1/chat/completions'));
  assert.ok(server.headers.every(header => header.authorization === `Bearer ${TEST_KEY}`));
});

test('Qwen Chat 预算模式透传 enable_thinking 和 thinking_budget，且不展示 max', async t => {
  const server = await mockOpenAI();
  t.after(server.close);
  const draft = createDmxapiProtocolDraft('chat');
  draft.profile.apiKeyEnv = TEST_KEY_ENV;
  draft.profile.baseURL = server.baseURL;
  draft.profile.models![0] = applyReasoningMode({ ...draft.profile.models![0], id: 'qwen3.8-27b' },
    draft.profile.api, draft.id, 'chat-qwen-budget');
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(LlmPiAi, { providers: { [draft.id]: draft.profile as PiAiProviderProfile } });
  const info = await ctx.llm.resolveModelInfo(draft.id, 'qwen3.8-27b');
  assert.deepEqual(info.reasoning?.efforts.map(item => item.id), ['off', 'low', 'high']);
  for (const effort of ['low', 'high']) {
    const result = await assemble(ctx, { provider: draft.id, model: 'qwen3.8-27b',
      reasoningEffort: ReasoningEffortId(effort) });
    assert.deepEqual(result.finish, { kind: 'stop' });
    const body = server.requests.at(-1)!;
    assert.equal(body.enable_thinking, true);
    assert.ok((body.thinking_budget ?? 0) > 0);
    assert.equal(body.thinking_token_budget, undefined);
    assert.equal(body.reasoning_effort, undefined);
  }
  assert.ok(server.requests[1].thinking_budget! > server.requests[0].thinking_budget!);
  assert.deepEqual(server.paths, ['/v1/chat/completions', '/v1/chat/completions']);
});

test('DMXAPI Chat 官方预设按模型精确透传思考等级', async t => {
  const server = await mockOpenAI();
  t.after(server.close);
  const draft = createDmxapiProtocolDraft('chat');
  draft.profile.apiKeyEnv = TEST_KEY_ENV;
  draft.profile.baseURL = server.baseURL;
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(LlmPiAi, { providers: { [draft.id]: draft.profile as PiAiProviderProfile } });

  const cases = [
    { id: 'deepseek-v4.1-flash', efforts: ['off', 'low', 'high', 'max'] },
    { id: 'glm-5.3', efforts: ['low', 'high', 'max'] },
    { id: 'glm-5.3-flash', efforts: ['low', 'high', 'max'] },
    { id: 'qwen3.8-max', efforts: ['off', 'medium', 'xhigh'] },
    { id: 'qwen3.8-max-0902', efforts: ['off', 'medium', 'xhigh'] },
    { id: 'mimo-v2.6-pro', efforts: ['off', 'high'] },
  ] as const;
  for (const { id, efforts } of cases) {
    const info = await ctx.llm.resolveModelInfo(draft.id, id);
    assert.deepEqual(info.reasoning?.efforts.map(item => item.id), [...efforts], id);
    for (const effort of efforts) {
      const result = await assemble(ctx, { provider: draft.id, model: id,
        reasoningEffort: ReasoningEffortId(effort) });
      assert.deepEqual(result.finish, { kind: 'stop' }, `${id}/${effort}`);
      const body = server.requests.at(-1)!;
      assert.equal(body.model, id);
      assert.equal(body.stream, true);
      if (id.startsWith('qwen')) {
        assert.equal(body.enable_thinking, effort !== 'off', `${id}/${effort}`);
        assert.equal(body.reasoning_effort, effort === 'off' ? undefined : effort);
        assert.equal(body.thinking_budget, undefined);
        assert.equal(body.thinking_token_budget, undefined);
      } else if (id.startsWith('glm')) {
        assert.equal(body.thinking?.type, 'enabled', `${id}/${effort}`);
        assert.equal(body.reasoning_effort, effort);
      } else {
        assert.equal(body.thinking?.type, effort === 'off' ? 'disabled' : 'enabled', `${id}/${effort}`);
        assert.equal(body.reasoning_effort, id.startsWith('mimo') || effort === 'off' ? undefined : effort);
      }
      if (id.startsWith('mimo')) {
        assert.equal(body.max_completion_tokens, 128_000);
        assert.equal(body.max_tokens, undefined);
      }
    }
  }
  const count = cases.reduce((sum, item) => sum + item.efforts.length, 0);
  assert.equal(server.requests.length, count);
  assert.deepEqual(server.paths, Array(count).fill('/v1/chat/completions'));
  assert.ok(server.headers.every(header => header.authorization === `Bearer ${TEST_KEY}`));
  for (const [id, effort] of [['glm-5.3', 'off'], ['mimo-v2.6-pro', 'low']] as const) {
    const before = server.requests.length;
    const result = await assemble(ctx, { provider: draft.id, model: id,
      reasoningEffort: ReasoningEffortId(effort) });
    assert.equal(result.finish.kind, 'error');
    assert.equal(server.requests.length, before);
  }
});

test('未指定思考等级的真实请求使用默认 high', async t => {
  const server = await mockOpenAI();
  t.after(server.close);
  const ctx = await bootRuntime(testProfile(server.baseURL));
  t.after(() => ctx.fiber.dispose());
  assert.equal((await assemble(ctx)).finish.kind, 'stop');
  assert.equal(server.requests[0].reasoning_effort, 'high');
  assert.deepEqual(server.requests[0].thinking, { type: 'enabled' });
});

test('图片通过原生 adapter 发送 image_url/base64，并保留 system 和显式 max_tokens', async t => {
  const server = await mockOpenAI();
  t.after(server.close);
  const ctx = await bootRuntime(testProfile(server.baseURL));
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(FixtureAttachments);
  const result = await assemble(ctx, {
    system: '请描述图片', maxTokens: 77,
    messages: [createUserMessage({ source: { kind: 'plugin', plugin: 'dsh-dmxapi-test' }, content: [
      { type: 'text', text: '这是什么？' }, { type: 'image', attachment: IMAGE_REF },
    ] })],
  });
  assert.deepEqual(result.finish, { kind: 'stop' });
  const request = server.requests[0];
  assert.equal(request.max_tokens, 77);
  assert.equal(Object.hasOwn(request, 'max_completion_tokens'), false);
  assert.equal(request.messages[0].role, 'system');
  assert.equal(request.messages.some(message => message.role === 'developer'), false);
  const userContent = request.messages.find(message => message.role === 'user')!.content;
  assert.ok(Array.isArray(userContent));
  assert.equal(userContent.find(part => part.type === 'image_url')?.image_url?.url, `data:image/png;base64,${PNG_BASE64}`);
  assert.equal((ctx.attachments as FixtureAttachments).requests, 1);
});

test('自定义第二模型独立声明思考协议值和模型输出上限', async t => {
  const server = await mockOpenAI();
  t.after(server.close);
  const profile = testProfile(server.baseURL);
  profile.models!.push({ id: 'custom-vision-v2', name: '自定义视觉模型', input: ['text', 'image'], maxTokens: 123,
    reasoningEfforts: { off: null, high: 'gateway-high' } });
  const ctx = await bootRuntime(profile);
  t.after(() => ctx.fiber.dispose());
  assert.deepEqual((await ctx.llm.listModels('dmxapi')).map(model => model.id), [MODEL, 'custom-vision-v2']);
  const info = await ctx.llm.resolveModelInfo('dmxapi', 'custom-vision-v2');
  assert.equal(info.name, '自定义视觉模型');
  assert.deepEqual(info.reasoning?.efforts.map(effort => effort.id), ['off', 'high']);
  assert.equal((await assemble(ctx, { model: 'custom-vision-v2' })).finish.kind, 'stop');
  assert.equal(server.requests[0].model, 'custom-vision-v2');
  assert.equal(server.requests[0].reasoning_effort, 'gateway-high');
  assert.equal(server.requests[0].max_tokens, 123);
});

test('未声明的思考档位在发送请求前被拒绝', async t => {
  const server = await mockOpenAI();
  t.after(server.close);
  const ctx = await bootRuntime(testProfile(server.baseURL));
  t.after(() => ctx.fiber.dispose());
  const result = await assemble(ctx, { reasoningEffort: ReasoningEffortId('medium') });
  assert.equal(result.finish.kind, 'error');
  if (result.finish.kind === 'error') assert.equal(result.finish.failure.code, 'UNSUPPORTED_REASONING_EFFORT');
  assert.equal(server.requests.length, 0);
});

test('真实文件设置热添加 provider，保留其他配置，并拒绝过期 revision 和无效模型', async t => {
  const tempRoot = resolve(tmpdir());
  const directory = await mkdtemp(join(tempRoot, 'dsh-dmxapi-runtime-'));
  t.after(async () => {
    const target = resolve(directory);
    assert.ok(target.startsWith(tempRoot + sep), 'Only the allocated temporary test directory may be removed');
    await rm(target, { recursive: true, force: true });
  });
  const server = await mockOpenAI();
  t.after(server.close);
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(LlmRuntime);
  const settingsPath = join(directory, 'settings.yaml');
  await ctx.plugin(FileSettingsProvider, { path: settingsPath, watch: false });
  await ctx.plugin(LlmPiAi, {});
  assert.deepEqual(ctx.llm.listProviders(), []);
  const revision = () => ctx.settings.describe().find(section => section.ns === 'llm-pi-ai')!.revision;
  await ctx.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'other-provider'], value: {
    ...testProfile(server.baseURL), displayName: 'Other', models: [{ id: 'other-model', input: ['text'], reasoningEfforts: false }], reasoning: 'off',
  } }], revision());
  const before = ctx.settings.describe().find(section => section.ns === 'llm-pi-ai')!.user as { providers: Record<string, unknown> };
  const oldRevision = revision();
  await ctx.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'dmxapi'], value: testProfile(server.baseURL) }], oldRevision);
  assert.deepEqual(ctx.llm.listProviders().map(provider => provider.id), ['other-provider', 'dmxapi']);
  const user = ctx.settings.describe().find(section => section.ns === 'llm-pi-ai')!.user as { providers: Record<string, unknown> };
  assert.deepEqual(user.providers['other-provider'], before.providers['other-provider']);
  assert.equal((await assemble(ctx)).finish.kind, 'stop');
  const acceptedFile = await readFile(settingsPath, 'utf8');
  await assert.rejects(ctx.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'dmxapi', 'reasoning'], value: 'low' }], oldRevision), /conflict|revision|changed/i);
  assert.equal(await readFile(settingsPath, 'utf8'), acceptedFile);
  await assert.rejects(ctx.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'dmxapi', 'models'], value: [
    { id: MODEL, reasoningEfforts: { high: null } },
  ] }], revision()), /high|wire value|empty/i);
  assert.equal(await readFile(settingsPath, 'utf8'), acceptedFile);
  await ctx.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'dmxapi', 'reasoning'], value: 'low' }], revision());
  assert.equal((await assemble(ctx)).finish.kind, 'stop');
  assert.equal(server.requests.at(-1)!.reasoning_effort, 'low');
  assert.deepEqual((await ctx.llm.listModels('other-provider')).map(model => model.id), ['other-model']);
});
