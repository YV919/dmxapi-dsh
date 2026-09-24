import test from 'node:test';
import assert from 'node:assert/strict';
import { createDmxapiProtocolDraft, validateDraft, type ModelProfile } from '../src/config.ts';
import { applyReasoningMode, deepseekAnthropicBridgeModels, inferReasoningMode, recommendReasoningMode, visibleReasoningModes } from '../src/protocol.ts';

const baseModel = (): ModelProfile => ({
  id: 'example-model', input: ['text', 'image'],
  compat: { supportsStrictMode: true },
  future: { retained: true },
});

test('后缀 Anthropic 预设继续推荐、校验和识别窄桥接，非规范后缀保持自定义', () => {
  for (const route of ['dmxapi-anthropic-2', 'dmxapi-anthropic-10']) {
    const model = applyReasoningMode({ id: 'deepseek-v4.1-flash' }, 'anthropic-messages', route, 'anthropic-deepseek');
    assert.equal(recommendReasoningMode('anthropic-messages', route, model.id), 'anthropic-deepseek');
    assert.equal(inferReasoningMode(model, 'anthropic-messages', route), 'anthropic-deepseek');
    assert.deepEqual(deepseekAnthropicBridgeModels({ id: route, profile: { api: 'anthropic-messages', models: [model] } }), [model.id]);
    model.reasoningEfforts = { medium: 'medium' };
    assert.throws(() => validateDraft({ id: route, profile: { api: 'anthropic-messages', models: [model] } }), /仅支持 off、low、high、max/);
  }
  for (const route of ['dmxapi-anthropic-02', 'dmxapi-anthropic-1', 'dmxapi-anthropic-2-2', 'other']) {
    assert.equal(recommendReasoningMode('anthropic-messages', route, 'deepseek-v4.1-flash'), 'anthropic-budget');
    assert.throws(() => applyReasoningMode({ id: 'deepseek-v4.1-flash' }, 'anthropic-messages', route, 'anthropic-deepseek'), /仅用于/);
  }
});

test('Chat 各厂商模式保留互不冲突的思考参数及自定义字段', () => {
  const source = baseModel();
  for (const [mode, expected, efforts] of [
    ['chat-deepseek', { thinkingFormat: 'deepseek', supportsReasoningEffort: true },
      { off: 'disabled', low: 'low', high: 'high', max: 'max' }],
    ['chat-zai', { thinkingFormat: 'zai', supportsReasoningEffort: true },
      { low: 'low', high: 'high', max: 'max' }],
    ['chat-effort', { thinkingFormat: 'openai', supportsReasoningEffort: true },
      { off: null, low: 'low', high: 'high', max: 'max' }],
    ['chat-qwen-effort', { thinkingFormat: 'qwen', supportsReasoningEffort: true, supportsThinkingTokenBudget: false },
      { off: null, medium: 'medium', xhigh: 'xhigh' }],
    ['chat-qwen-budget', { thinkingFormat: 'qwen', supportsReasoningEffort: false, supportsThinkingTokenBudget: true, thinkingTokenBudgetField: 'thinking_budget' },
      { off: null, low: 'low', high: 'high' }],
    ['chat-switch', { thinkingFormat: 'deepseek', supportsReasoningEffort: false },
      { off: 'disabled', high: 'high' }],
  ] as const) {
    const next = applyReasoningMode(source, 'openai-completions', 'dmxapi-chat', mode);
    assert.deepEqual(next.reasoningEfforts, efforts);
    assert.deepEqual(next.compat, { supportsStrictMode: true, ...expected });
    assert.equal(inferReasoningMode(next, 'openai-completions', 'dmxapi-chat'), mode);
    assert.deepEqual(next.input, ['text', 'image']);
    assert.deepEqual(next.future, { retained: true });
  }
  const disabled = applyReasoningMode(source, 'openai-completions', 'dmxapi-chat', 'none');
  assert.equal(disabled.reasoningEfforts, false);
  assert.equal(disabled.compat?.supportsReasoningEffort, false);
  assert.deepEqual(source, baseModel());
});

test('重新选择模式不会为已知仅思考模型添加 off', () => {
  for (const protocol of ['chat', 'responses', 'anthropic'] as const) {
    const draft = createDmxapiProtocolDraft(protocol);
    for (const model of draft.profile.models!) {
      if (!['glm-5.3', 'glm-5.3-flash', 'gpt-6-astra', 'claude-fable-5-1-cc', 'claude-opus-5-5-cc'].includes(model.id)) continue;
      const mode = recommendReasoningMode(draft.profile.api, draft.id, model.id);
      const updated = applyReasoningMode(model, draft.profile.api, draft.id, mode);
      assert.equal(Object.hasOwn(updated.reasoningEfforts as object, 'off'), false, model.id);
    }
  }
});

test('Anthropic 只展示相关模式并保留已有旧预算配置', () => {
  const claude = createDmxapiProtocolDraft('anthropic').profile.models![0]!;
  assert.deepEqual(visibleReasoningModes('anthropic-messages', 'dmxapi-anthropic', claude),
    ['anthropic-adaptive', 'none', 'custom']);
  const legacy = { ...claude, compat: { forceAdaptiveThinking: false }, reasoningEfforts: { off: null, high: 'high' } };
  assert.deepEqual(visibleReasoningModes('anthropic-messages', 'dmxapi-anthropic', legacy),
    ['anthropic-adaptive', 'none', 'custom', 'anthropic-budget']);
  const deepseek = applyReasoningMode({ id: 'deepseek-v4.1-flash' }, 'anthropic-messages', 'dmxapi-anthropic', 'anthropic-deepseek');
  assert.deepEqual(visibleReasoningModes('anthropic-messages', 'dmxapi-anthropic', deepseek),
    ['anthropic-deepseek', 'none', 'custom']);
  assert.ok(visibleReasoningModes('openai-completions', 'dmxapi-chat', { id: 'any' }).includes('chat-qwen-budget'));
});

test('Responses 使用独立等级映射且移除 Chat 思考兼容字段', () => {
  const chat = applyReasoningMode(baseModel(), 'openai-completions', 'dmxapi-chat', 'chat-deepseek');
  const response = applyReasoningMode(chat, 'openai-responses', 'dmxapi-responses', 'responses-effort');
  assert.deepEqual(response.reasoningEfforts, { off: null, low: 'low', high: 'high', max: 'max' });
  assert.deepEqual(response.compat, { supportsStrictMode: true });
  assert.equal(inferReasoningMode(response, 'openai-responses', 'dmxapi-responses'), 'responses-effort');
  assert.throws(() => applyReasoningMode(response, 'openai-responses', 'dmxapi-responses', 'chat-deepseek'), /协议不匹配/);
});

test('Anthropic adaptive 与 DeepSeek enabled 显式标记，budget 不提供 max', () => {
  const deepseek = { ...baseModel(), id: 'deepseek-v4.1-flash' };
  const special = applyReasoningMode(deepseek, 'anthropic-messages', 'dmxapi-anthropic', 'anthropic-deepseek');
  assert.deepEqual(special.reasoningEfforts, { off: null, low: 'low', high: 'high', max: 'max' });
  assert.equal(special.compat?.forceAdaptiveThinking, true);
  assert.equal(inferReasoningMode(special, 'anthropic-messages', 'dmxapi-anthropic'), 'anthropic-deepseek');
  assert.throws(() => applyReasoningMode(deepseek, 'anthropic-messages', 'dmxapi-anthropic', 'anthropic-adaptive'), /不能选 Claude adaptive/);
  assert.throws(() => applyReasoningMode({ ...deepseek, id: 'claude-model' }, 'anthropic-messages', 'dmxapi-anthropic', 'anthropic-deepseek'), /仅用于.*DeepSeek|DeepSeek.*仅用于/);
  assert.throws(() => applyReasoningMode(deepseek, 'anthropic-messages', 'other', 'anthropic-deepseek'), /仅用于.*DeepSeek|DeepSeek.*仅用于/);

  const adaptive = applyReasoningMode(baseModel(), 'anthropic-messages', 'dmxapi-anthropic', 'anthropic-adaptive');
  assert.equal(adaptive.compat?.forceAdaptiveThinking, true);
  assert.equal(inferReasoningMode(adaptive, 'anthropic-messages', 'dmxapi-anthropic'), 'anthropic-adaptive');
  const budget = applyReasoningMode(adaptive, 'anthropic-messages', 'dmxapi-anthropic', 'anthropic-budget');
  assert.deepEqual(budget.reasoningEfforts, { off: null, low: 'low', high: 'high' });
  assert.equal(budget.compat?.forceAdaptiveThinking, false);
  assert.equal(inferReasoningMode(budget, 'anthropic-messages', 'dmxapi-anthropic'), 'anthropic-budget');
  const disabled = applyReasoningMode(adaptive, 'anthropic-messages', 'dmxapi-anthropic', 'none');
  assert.equal(disabled.reasoningEfforts, false);

  const route = createDmxapiProtocolDraft('anthropic');
  route.profile.models = [special, adaptive];
  assert.deepEqual(deepseekAnthropicBridgeModels(route), ['deepseek-v4.1-flash']);
  route.profile.models![0]!.reasoningEfforts = false;
  assert.throws(() => validateDraft(route), /将按 DeepSeek Anthropic 方式发送/);
});

test('新增模型按 ID 推荐，旧配置和高级自定义映射不被推断过程改写', () => {
  assert.equal(recommendReasoningMode('openai-completions', 'dmxapi-chat', 'deepseek-v4.1-flash'), 'chat-deepseek');
  assert.equal(recommendReasoningMode('openai-completions', 'dmxapi-chat', 'glm-5.3'), 'chat-zai');
  assert.equal(recommendReasoningMode('openai-completions', 'dmxapi-chat', 'qwen3.8-max'), 'chat-qwen-effort');
  assert.equal(recommendReasoningMode('openai-completions', 'dmxapi-chat', 'mimo-v2.6-pro'), 'chat-switch');
  assert.equal(recommendReasoningMode('openai-completions', 'dmxapi-chat', 'qwen3-27b'), 'chat-qwen-budget');
  assert.equal(recommendReasoningMode('openai-completions', 'dmxapi-chat', 'other'), 'chat-effort');
  assert.equal(recommendReasoningMode('openai-responses', 'dmxapi-responses', 'other'), 'responses-effort');
  assert.equal(recommendReasoningMode('anthropic-messages', 'dmxapi-anthropic', 'deepseek-v4.1-flash'), 'anthropic-deepseek');
  assert.equal(recommendReasoningMode('anthropic-messages', 'dmxapi-anthropic', 'claude-fable-5-1-cc'), 'anthropic-adaptive');
  assert.equal(recommendReasoningMode('anthropic-messages', 'custom', 'old-anthropic-compatible'), 'anthropic-budget');
  assert.equal(recommendReasoningMode('anthropic-messages', 'custom', 'deepseek-v4.1-flash'), 'anthropic-budget');
  const authored = { id: 'custom-model', reasoningEfforts: { low: 'lite', high: 'strong' }, compat: { thinkingFormat: 'deepseek' } } satisfies ModelProfile;
  const before = structuredClone(authored);
  assert.equal(inferReasoningMode(authored, 'openai-completions', 'custom',), 'custom');
  assert.deepEqual(applyReasoningMode(authored, 'openai-completions', 'custom', 'custom'), before);
  assert.deepEqual(authored, before);
  const legacy = createDmxapiProtocolDraft('chat');
  legacy.profile.models![0]!.id = 'custom-model';
  legacy.profile.models![0]!.reasoningEfforts = { low: 'lite', high: 'strong' };
  assert.doesNotThrow(() => validateDraft(legacy));
});
