import assert from 'node:assert/strict';
import { after, before, test, type TestContext } from 'node:test';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { BlockAssembler, createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai';
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file';
import { createDmxapiDraft, createDmxapiProtocolDraft, type ProviderDraft } from '../src/config.ts';
import { normalizeProtocolDraft } from '../src/protocol.ts';
import * as DmxapiPlugin from '../src/index.ts';
import { installAnthropicEffortBridge } from '../src/anthropic-effort.ts';
import { assemble, FixtureAttachments, IMAGE_REF, PNG_BASE64, TEST_KEY, TEST_KEY_ENV } from './helpers.ts';

type Protocol = 'openai-responses' | 'anthropic-messages';
interface ContentPart {
  type: string;
  image_url?: string;
  source?: { type: string; media_type: string; data: string };
}
interface WireBody {
  model: string;
  stream: boolean;
  input?: Array<{ role: string; content: ContentPart[] }>;
  messages?: Array<{ role: string; content: ContentPart[] }>;
  reasoning?: { effort: string };
  thinking?: { type: string; budget_tokens?: number };
  output_config?: { effort: string };
  max_output_tokens?: number;
  max_tokens?: number;
}
interface RecordedRequest { path: string; headers: IncomingHttpHeaders; body: WireBody }

const originalTestKey = process.env[TEST_KEY_ENV];
before(() => { process.env[TEST_KEY_ENV] = TEST_KEY; });
after(() => {
  if (originalTestKey === undefined) delete process.env[TEST_KEY_ENV];
  else process.env[TEST_KEY_ENV] = originalTestKey;
});

// Both protocols use a loopback endpoint and the public test credential above.
// No real endpoint, credential store, or user settings are used by these tests.
async function mockProtocol(api: Protocol) {
  const requests: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => { body += chunk; });
    request.on('end', () => {
      let payload: WireBody;
      try { payload = JSON.parse(body) as WireBody; }
      catch { response.writeHead(400).end('invalid JSON'); return; }
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      requests.push({ path, headers: request.headers, body: payload });
      const expectedPath = api === 'openai-responses' ? '/v1/responses' : '/v1/messages';
      if (path !== expectedPath) { response.writeHead(404).end('wrong protocol path'); return; }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = (event: Record<string, unknown>) => {
        response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      };
      if (api === 'openai-responses') {
        const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: 'mock answer', annotations: [] }] };
        emit({ type: 'response.created', response: { id: 'resp_fixture', status: 'in_progress' } });
        emit({ type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } });
        emit({ type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: item.id, delta: 'mock answer' });
        emit({ type: 'response.output_item.done', output_index: 0, item });
        emit({ type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [item],
          usage: { input_tokens: 11, output_tokens: 2, total_tokens: 13 } } });
      } else {
        emit({ type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: payload.model,
          content: [], stop_reason: null, usage: { input_tokens: 11, output_tokens: 0 } } });
        emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'mock answer' } });
        emit({ type: 'content_block_stop', index: 0 });
        emit({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } });
        emit({ type: 'message_stop' });
      }
      response.end();
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Mock server has no TCP address');
  return {
    root: `http://127.0.0.1:${address.port}`, requests,
    close: () => new Promise<void>((resolveClose, reject) => {
      server.close(error => error ? reject(error) : resolveClose());
      server.closeAllConnections();
    }),
  };
}

async function settingsRuntime(t: TestContext) {
  const tempRoot = resolve(tmpdir());
  const directory = await mkdtemp(join(tempRoot, 'dsh-dmxapi-protocol-'));
  const ctx = new Context();
  t.after(async () => {
    await ctx.fiber.dispose();
    const target = resolve(directory);
    assert.ok(target.startsWith(tempRoot + sep), 'Only the allocated test directory may be removed');
    await rm(target, { recursive: true, force: true });
  });
  await ctx.plugin(LlmRuntime);
  const settingsPath = join(directory, 'settings.yaml');
  await ctx.plugin(FileSettingsProvider, { path: settingsPath, watch: false });
  await ctx.plugin(LlmPiAi, {});
  await ctx.plugin(FixtureAttachments);
  const save = (draft: ProviderDraft) => ctx.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', draft.id], value: draft.profile }],
    ctx.settings.describe().find(section => section.ns === 'llm-pi-ai')!.revision);
  return { ctx, save, settingsPath };
}

function imageMessages() {
  return [createUserMessage({ source: { kind: 'plugin', plugin: 'dsh-dmxapi-test' }, content: [
    { type: 'text', text: '请描述图片' }, { type: 'image', attachment: IMAGE_REF },
  ] })];
}

for (const api of ['openai-responses', 'anthropic-messages'] as const) {
  test(`${api}: 原预设真实保存被拒绝，归一化后热保存并发送图片与对应思考等级`, async t => {
    const server = await mockProtocol(api);
    t.after(server.close);
    const { ctx, save, settingsPath } = await settingsRuntime(t);
    const draft = createDmxapiDraft();
    draft.profile.api = api;
    draft.profile.apiKeyEnv = TEST_KEY_ENV;
    draft.profile.baseURL = api === 'openai-responses' ? `${server.root}/v1` : server.root;
    const model = `fixture-${api}`;
    draft.profile.models![0].id = model;

    // Exercise Host onChange validation, not just its permissive schema parser.
    await assert.rejects(save(draft), /sets compat.*no model on the route/);
    assert.deepEqual(ctx.llm.listProviders(), []);
    assert.equal(server.requests.length, 0);

    const normalized = normalizeProtocolDraft(draft);
    assert.ok(normalized.removedCompat.length > 0);
    await save(normalized.draft);
    assert.deepEqual(ctx.llm.listProviders().map(provider => provider.id), ['dmxapi']);
    const info = await ctx.llm.resolveModelInfo('dmxapi', model);
    assert.deepEqual(info.inputModalities, ['text', 'image']);
    assert.equal(info.reasoning?.defaultEffort, 'high');
    const persisted = await readFile(settingsPath, 'utf8');
    assert.ok(persisted.includes(api));
    assert.equal(persisted.includes('thinkingFormat'), false);
    assert.equal(persisted.includes(TEST_KEY), false);

    const efforts = api === 'openai-responses' ? ['low', 'high', 'max', 'off'] : ['high', 'off'];
    for (const effort of efforts) {
      const result = await assemble(ctx, { model, messages: imageMessages(), reasoningEffort: ReasoningEffortId(effort) });
      assert.deepEqual(result.finish, { kind: 'stop' });
      assert.equal(result.message.content.filter(part => part.type === 'text').map(part => part.text).join(''), 'mock answer');
      assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 2, totalTokens: 13 });
      const request = server.requests.at(-1)!;
      assert.equal(request.body.model, model);
      assert.equal(request.body.stream, true);
      if (api === 'openai-responses') {
        assert.equal(request.path, '/v1/responses');
        assert.equal(request.headers.authorization, `Bearer ${TEST_KEY}`);
        assert.equal(request.body.reasoning?.effort, effort === 'off' ? 'none' : effort);
        assert.equal(request.body.thinking, undefined);
        assert.ok((request.body.max_output_tokens ?? 0) > 0);
        const image = request.body.input!.find(message => message.role === 'user')!.content.find(part => part.type === 'input_image');
        assert.equal(image?.image_url, `data:image/png;base64,${PNG_BASE64}`);
      } else {
        assert.equal(request.path, '/v1/messages');
        assert.equal(request.headers['x-api-key'], TEST_KEY);
        assert.equal(request.body.thinking?.type, effort === 'off' ? 'disabled' : 'enabled');
        if (effort === 'high') assert.equal(request.body.thinking?.budget_tokens, 16384);
        assert.equal(request.body.output_config, undefined);
        const image = request.body.messages!.find(message => message.role === 'user')!.content.find(part => part.type === 'image');
        assert.deepEqual(image?.source, { type: 'base64', media_type: 'image/png', data: PNG_BASE64 });
      }
    }
    assert.equal(server.requests.length, efforts.length);
    assert.equal((ctx.attachments as FixtureAttachments).requests, efforts.length);
  });
}

test('DMXAPI Responses 三模型按原生 Responses 协议透传 low/high/max 与可用 off', async t => {
  const server = await mockProtocol('openai-responses');
  t.after(server.close);
  const { ctx, save } = await settingsRuntime(t);
  const draft = createDmxapiProtocolDraft('responses');
  draft.profile.apiKeyEnv = TEST_KEY_ENV;
  draft.profile.baseURL = `${server.root}/v1`;
  await save(draft);
  const cases = [
    { id: 'gpt-6-astra', efforts: ['low', 'high', 'max'] },
    { id: 'gpt-6-sol', efforts: ['off', 'low', 'high', 'max'] },
    { id: 'gpt-6-luna', efforts: ['off', 'low', 'high', 'max'] },
  ] as const;
  for (const { id, efforts } of cases) {
    const info = await ctx.llm.resolveModelInfo(draft.id, id);
    assert.deepEqual(info.reasoning?.efforts.map(item => item.id), [...efforts], id);
    assert.deepEqual(info.inputModalities, ['text', 'image']);
    for (const effort of efforts) {
      const result = await assemble(ctx, { provider: draft.id, model: id,
        reasoningEffort: ReasoningEffortId(effort), messages: imageMessages() });
      assert.deepEqual(result.finish, { kind: 'stop' }, `${id}/${effort}`);
      const request = server.requests.at(-1)!;
      assert.equal(request.path, '/v1/responses');
      assert.equal(request.headers.authorization, `Bearer ${TEST_KEY}`);
      assert.equal(request.body.model, id);
      assert.equal(request.body.reasoning?.effort, effort === 'off' ? 'none' : effort);
      assert.equal(request.body.thinking, undefined);
      assert.equal(request.body.max_output_tokens, 128_000);
      const image = request.body.input!.find(message => message.role === 'user')!.content.find(part => part.type === 'input_image');
      assert.equal(image?.image_url, `data:image/png;base64,${PNG_BASE64}`);
    }
  }
  const before = server.requests.length;
  const invalid = await assemble(ctx, { provider: draft.id, model: 'gpt-6-astra',
    reasoningEffort: ReasoningEffortId('off') });
  assert.equal(invalid.finish.kind, 'error');
  assert.equal(server.requests.length, before);
});

test('DMXAPI Anthropic 三模型按原生 Messages 协议透传，Sonnet 可显式关闭思考', async t => {
  const server = await mockProtocol('anthropic-messages');
  t.after(server.close);
  const { ctx, save } = await settingsRuntime(t);
  const draft = createDmxapiProtocolDraft('anthropic');
  draft.profile.apiKeyEnv = TEST_KEY_ENV;
  draft.profile.baseURL = server.root;
  await save(draft);
  const cases = [
    { id: 'claude-fable-5-1-cc', efforts: ['low', 'high', 'max'] },
    { id: 'claude-opus-5-5-cc', efforts: ['low', 'high', 'max'] },
    { id: 'claude-sonnet-5-cc', efforts: ['off', 'low', 'high', 'max'] },
  ] as const;
  for (const { id, efforts } of cases) {
    const info = await ctx.llm.resolveModelInfo(draft.id, id);
    assert.deepEqual(info.reasoning?.efforts.map(item => item.id), [...efforts], id);
    assert.deepEqual(info.inputModalities, ['text', 'image']);
    for (const effort of efforts) {
      const result = await assemble(ctx, { provider: draft.id, model: id,
        reasoningEffort: ReasoningEffortId(effort), messages: imageMessages() });
      assert.deepEqual(result.finish, { kind: 'stop' }, `${id}/${effort}`);
      const request = server.requests.at(-1)!;
      assert.equal(request.path, '/v1/messages');
      assert.equal(request.headers['x-api-key'], TEST_KEY);
      assert.equal(request.body.model, id);
      assert.equal(request.body.thinking?.type, effort === 'off' ? 'disabled' : 'adaptive');
      assert.deepEqual(request.body.output_config, effort === 'off' ? undefined : { effort });
      assert.equal(request.body.max_tokens, 128_000);
      const image = request.body.messages!.find(message => message.role === 'user')!.content.find(part => part.type === 'image');
      assert.deepEqual(image?.source, { type: 'base64', media_type: 'image/png', data: PNG_BASE64 });
    }
  }
  for (const id of ['claude-fable-5-1-cc', 'claude-opus-5-5-cc']) {
    const before = server.requests.length;
    const invalid = await assemble(ctx, { provider: draft.id, model: id,
      reasoningEffort: ReasoningEffortId('off') });
    assert.equal(invalid.finish.kind, 'error');
    assert.equal(server.requests.length, before);
  }
});

test('Anthropic 保留显式 adaptive 兼容项和自定义等级 wire 映射', async t => {
  const server = await mockProtocol('anthropic-messages');
  t.after(server.close);
  const { ctx, save } = await settingsRuntime(t);
  const draft = createDmxapiDraft();
  draft.profile.api = 'anthropic-messages';
  draft.profile.apiKeyEnv = TEST_KEY_ENV;
  draft.profile.baseURL = server.root;
  draft.profile.compat!.forceAdaptiveThinking = true;
  draft.profile.models![0].reasoningEfforts = { off: null, high: 'gateway-high' };
  await save(normalizeProtocolDraft(draft).draft);
  const result = await assemble(ctx);
  assert.deepEqual(result.finish, { kind: 'stop' });
  assert.equal(server.requests[0].body.thinking?.type, 'adaptive');
  assert.deepEqual(server.requests[0].body.output_config, { effort: 'gateway-high' });
});

test('模型默认元数据和 Anthropic wire bridge 共存，prepared Claude 默认 high 不被改为 enabled', async t => {
  const server = await mockProtocol('anthropic-messages');
  t.after(server.close);
  const { ctx, save } = await settingsRuntime(t);
  // Install before routes exist, exercising adapters-updated attachment as well.
  await ctx.plugin(DmxapiPlugin);
  const draft = createDmxapiProtocolDraft('anthropic');
  delete draft.profile.reasoning;
  draft.profile.apiKeyEnv = TEST_KEY_ENV;
  draft.profile.baseURL = server.root;
  await save(draft);
  const prepared = await ctx.llm.prepareCall({ provider: draft.id, model: 'claude-opus-5-5-cc' });
  assert.equal(prepared.config.reasoningEffort, 'high');
  const assembled = new BlockAssembler();
  for await (const chunk of prepared.stream({ ...prepared.config, messages: imageMessages() })) assembled.push(chunk);
  assert.equal(assembled.finish.kind, 'stop');
  assert.equal(server.requests.at(-1)!.body.thinking?.type, 'adaptive');
  assert.deepEqual(server.requests.at(-1)!.body.output_config, { effort: 'high' });
  const normal = await assemble(ctx, { provider: draft.id, model: 'claude-fable-5-1-cc' });
  assert.equal(normal.finish.kind, 'stop');
  assert.equal(server.requests.at(-1)!.body.thinking?.type, 'adaptive');
  assert.deepEqual(server.requests.at(-1)!.body.output_config, { effort: 'high' });
  const disabled = await assemble(ctx, { provider: draft.id, model: 'claude-sonnet-5-cc', reasoningEffort: ReasoningEffortId('off') });
  assert.equal(disabled.finish.kind, 'stop');
  assert.deepEqual(server.requests.at(-1)!.body.thinking, { type: 'disabled' });
  assert.equal(server.requests.at(-1)!.body.output_config, undefined);
});

test('DMXAPI DeepSeek Anthropic: low/high/max/off 精确透传且保留图片与认证', async t => {
  const server = await mockProtocol('anthropic-messages');
  t.after(server.close);
  const { ctx, save } = await settingsRuntime(t);
  await ctx.plugin(DmxapiPlugin);
  assert.throws(() => installAnthropicEffortBridge(ctx), /不能重复加载/);
  const draft = createDmxapiDraft();
  draft.id = 'dmxapi-anthropic';
  draft.profile.api = 'anthropic-messages';
  draft.profile.apiKeyEnv = TEST_KEY_ENV;
  draft.profile.baseURL = server.root;
  // Provider-level compat inheritance must trigger the same bridge and guard.
  draft.profile.compat = { forceAdaptiveThinking: true };
  draft.profile.models!.push({ id: 'claude-fable-5-1-cc', input: ['text'],
    reasoningEfforts: { low: 'low', high: 'high', max: 'max' }, compat: { forceAdaptiveThinking: true } });
  await save(normalizeProtocolDraft(draft).draft);
  for (const effort of ['low', 'high', 'max', 'off'] as const) {
    const result = await assemble(ctx, { provider: 'dmxapi-anthropic', model: 'deepseek-v4.1-flash', messages: imageMessages(),
      reasoningEffort: ReasoningEffortId(effort) });
    assert.deepEqual(result.finish, { kind: 'stop' });
    const request = server.requests.at(-1)!;
    assert.equal(request.path, '/v1/messages');
    assert.equal(request.headers['x-api-key'], TEST_KEY);
    assert.deepEqual(request.body.thinking, { type: effort === 'off' ? 'disabled' : 'enabled' });
    assert.deepEqual(request.body.output_config, effort === 'off' ? undefined : { effort });
    const image = request.body.messages!.find(message => message.role === 'user')!.content.find(part => part.type === 'image');
    assert.deepEqual(image?.source, { type: 'base64', media_type: 'image/png', data: PNG_BASE64 });
  }
  const claude = await assemble(ctx, { provider: 'dmxapi-anthropic', model: 'claude-fable-5-1-cc',
    reasoningEffort: ReasoningEffortId('max') });
  assert.deepEqual(claude.finish, { kind: 'stop' });
  assert.equal(server.requests.at(-1)!.body.thinking?.type, 'adaptive');
  assert.deepEqual(server.requests.at(-1)!.body.output_config, { effort: 'max' });

  // Editing settings recreates pi-ai's provider without changing route registration.
  draft.profile.models![0].id = 'deepseek-v4.2-flash';
  await save(normalizeProtocolDraft(draft).draft);
  const updated = await assemble(ctx, { provider: 'dmxapi-anthropic', model: 'deepseek-v4.2-flash',
    reasoningEffort: ReasoningEffortId('max') });
  assert.deepEqual(updated.finish, { kind: 'stop' });
  assert.deepEqual(server.requests.at(-1)!.body.thinking, { type: 'enabled' });
  assert.deepEqual(server.requests.at(-1)!.body.output_config, { effort: 'max' });
  assert.equal(server.requests.length, 6);

  // A future Host shape mismatch must fail before any uncorrected HTTP request.
  const host = ctx.llm as unknown as { adapters: Map<string, { adapter: { current?: (...args: unknown[]) => unknown } }> };
  const adapter = host.adapters.get('dmxapi-anthropic')!.adapter;
  const workingCurrent = adapter.current;
  adapter.current = undefined;
  try {
    await assert.rejects(assemble(ctx, { provider: 'dmxapi-anthropic', model: 'deepseek-v4.2-flash',
      reasoningEffort: ReasoningEffortId('max') }), /已拒绝启用请求体改写|适配未就绪/);
    assert.equal(server.requests.length, 6);
  } finally {
    adapter.current = workingCurrent;
  }
});

test('新增后缀 Responses/Anthropic 路由的默认与窄桥接继续生效，非规范路由不改写', async t => {
  const anthropic = await mockProtocol('anthropic-messages');
  const responses = await mockProtocol('openai-responses');
  t.after(anthropic.close);
  t.after(responses.close);
  const { ctx, save } = await settingsRuntime(t);
  await ctx.plugin(DmxapiPlugin);
  // A shared pi-ai adapter must pick up each route added after the first wrapper.
  for (const route of ['dmxapi-anthropic-2', 'dmxapi-anthropic-10', 'dmxapi-anthropic-02',
    'dmxapi-anthropic-1', 'dmxapi-anthropic-foo', 'dmxapi-anthropic-2-2']) {
    const draft = createDmxapiProtocolDraft('anthropic');
    draft.id = route;
    draft.profile.apiKeyEnv = TEST_KEY_ENV;
    draft.profile.baseURL = anthropic.root;
    delete draft.profile.reasoning;
    draft.profile.models!.push({ id: 'deepseek-v4.1-flash', input: ['text', 'image'],
      reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' }, compat: { forceAdaptiveThinking: true } });
    await save(draft);
    const supported = ['dmxapi-anthropic-2', 'dmxapi-anthropic-10'].includes(route);
    assert.equal((await ctx.llm.resolveModelInfo(route, 'claude-opus-5-5-cc')).reasoning?.defaultEffort,
      supported ? 'high' : undefined);
    const normal = await assemble(ctx, { provider: route, model: 'deepseek-v4.1-flash', reasoningEffort: ReasoningEffortId('max') });
    assert.equal(normal.finish.kind, 'stop');
    assert.equal(anthropic.requests.at(-1)!.body.thinking?.type, supported ? 'enabled' : 'adaptive');
    assert.deepEqual(anthropic.requests.at(-1)!.body.output_config, { effort: 'max' });
    const prepared = await ctx.llm.prepareCall({ provider: route, model: 'deepseek-v4.1-flash', reasoningEffort: ReasoningEffortId('low') });
    const assembled = new BlockAssembler();
    for await (const chunk of prepared.stream({ ...prepared.config, messages: imageMessages() })) assembled.push(chunk);
    assert.equal(assembled.finish.kind, 'stop');
    assert.equal(anthropic.requests.at(-1)!.body.thinking?.type, supported ? 'enabled' : 'adaptive');
    assert.deepEqual(anthropic.requests.at(-1)!.body.output_config, { effort: 'low' });
  }
  const responseDraft = createDmxapiProtocolDraft('responses');
  responseDraft.id = 'dmxapi-responses-2';
  responseDraft.profile.apiKeyEnv = TEST_KEY_ENV;
  responseDraft.profile.baseURL = `${responses.root}/v1`;
  delete responseDraft.profile.reasoning;
  await save(responseDraft);
  assert.equal((await ctx.llm.resolveModelInfo(responseDraft.id, 'gpt-6-astra')).reasoning?.defaultEffort, 'high');
  assert.equal((await assemble(ctx, { provider: responseDraft.id, model: 'gpt-6-astra' })).finish.kind, 'stop');
  assert.equal(responses.requests.at(-1)!.body.reasoning?.effort, 'high');

  // An Anthropic-named route with an effective Responses protocol stays Responses.
  const wrongProtocol = structuredClone(responseDraft);
  wrongProtocol.id = 'dmxapi-anthropic-3';
  wrongProtocol.profile.models = [{ id: 'claude-opus-5-5-cc', reasoningEfforts: { low: 'low', high: 'high' } }];
  await save(wrongProtocol);
  assert.equal((await ctx.llm.resolveModelInfo(wrongProtocol.id, 'claude-opus-5-5-cc')).reasoning?.defaultEffort, undefined);
  assert.equal((await assemble(ctx, { provider: wrongProtocol.id, model: 'claude-opus-5-5-cc' })).finish.kind, 'stop');
  assert.equal(responses.requests.at(-1)!.body.reasoning, undefined);
  assert.equal(responses.requests.at(-1)!.body.thinking, undefined);

  const noOptIn = createDmxapiProtocolDraft('anthropic');
  noOptIn.id = 'dmxapi-anthropic-4';
  noOptIn.profile.apiKeyEnv = TEST_KEY_ENV;
  noOptIn.profile.baseURL = anthropic.root;
  noOptIn.profile.models = [{ id: 'deepseek-v4.1-flash', reasoningEfforts: { high: 'high' },
    compat: { forceAdaptiveThinking: false } }];
  await save(noOptIn);
  assert.equal((await assemble(ctx, { provider: noOptIn.id, model: 'deepseek-v4.1-flash' })).finish.kind, 'stop');
  assert.equal(anthropic.requests.at(-1)!.body.thinking?.type, 'enabled');
  assert.equal(anthropic.requests.at(-1)!.body.thinking?.budget_tokens, 16384);
  assert.equal(anthropic.requests.at(-1)!.body.output_config, undefined);
});
