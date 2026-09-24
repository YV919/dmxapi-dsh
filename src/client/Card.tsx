import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { dump, JSON_SCHEMA } from 'js-yaml';
import dmxapiIcon from './assets/dmxapi.png';
import type { SaveConfigurationResult } from './save-configuration.ts';
import { createNewProviderDraft, makeProviderDraftUnique, type NewProviderKind } from '../new-provider.ts';
import {
  REASONING_MODES, applyReasoningMode, deepseekAnthropicBridgeModels,
  inferReasoningMode, normalizeProtocolDraft, visibleReasoningModes,
  protocolPathHint, recommendReasoningMode, type ProtocolNormalization, type ReasoningMode,
} from '../protocol.ts';
import {
  EFFORT_LEVELS,
  ALWAYS_ON_PRESET_IDS,
  createDmxapiProtocolDraft,
  dmxapiProtocolForProvider,
  exportProviderYaml,
  formatEfforts,
  parseEfforts,
  parseProviderYaml,
  validateDraft,
  type ModelProfile,
  type ProviderDraft,
  type ProviderProfile,
} from '../config.ts';

export interface Snapshot {
  status: 'loading' | 'ready' | 'unavailable';
  value?: { providers?: Record<string, ProviderProfile> };
  revision?: number;
  writable: boolean;
  mode: 'host' | 'memory';
}

export interface DmxapiCardProps {
  store: {
    getSnapshot: () => Snapshot;
    subscribe: (listener: () => void) => () => void;
  };
  save: (draft: ProviderDraft, revision: number, apiKey: string) => Promise<SaveConfigurationResult>;
  retryCredential: (receipt: SaveConfigurationResult, apiKey: string) => Promise<SaveConfigurationResult>;
}

const copy = <T,>(value: T): T => structuredClone(value);
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function containsHeaders(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsHeaders);
  return isRecord(value) && Object.entries(value).some(([key, entry]) => key.toLowerCase() === 'headers' || containsHeaders(entry));
}

// Editing must work even while required fields are incomplete. Downloads use
// the stricter exporter, while this serializer only formats a local draft.
function editorYaml(draft: ProviderDraft): string {
  const redact = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(redact);
    if (!isRecord(value)) return value;
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !['headers', 'apikey', 'token', 'password', 'passwd', 'secret',
        'clientsecret', 'accesstoken', 'refreshtoken', 'authorization', 'credential', 'credentials']
        .includes(key.toLowerCase().replace(/[-_\s]/g, '')))
      .map(([key, entry]) => [key, redact(entry)]));
  };
  return dump({ [draft.id]: redact(draft.profile) }, { schema: JSON_SCHEMA, noRefs: true, lineWidth: -1 });
}

// The YAML editor intentionally omits request headers. Restore them only to the
// same provider/model, so editing visible fields does not erase hidden settings.
function restoreHeaders(edited: unknown, original: unknown): unknown {
  if (Array.isArray(edited) && Array.isArray(original)) {
    return edited.map((entry, index) => {
      const previous = isRecord(entry) && typeof entry.id === 'string'
        ? original.find(item => isRecord(item) && item.id === entry.id)
        : original[index];
      return restoreHeaders(entry, previous);
    });
  }
  if (!isRecord(edited) || !isRecord(original)) return edited;
  const result = { ...edited };
  for (const [key, value] of Object.entries(original)) {
    if (key.toLowerCase() === 'headers' && !(key in result)) result[key] = copy(value);
    else if (key in result) result[key] = restoreHeaders(result[key], value);
  }
  return result;
}

function destinations(value: unknown, path = '', result: Record<string, unknown> = {}): Record<string, unknown> {
  if (Array.isArray(value)) value.forEach((entry, index) => destinations(entry, `${path}/${isRecord(entry) ? entry.id ?? index : index}`, result));
  else if (isRecord(value)) for (const [key, entry] of Object.entries(value)) {
    if (key === 'baseURL') result[`${path}/${key}`] = entry;
    else destinations(entry, `${path}/${key}`, result);
  }
  return result;
}

function checkHeaderDestination(next: ProviderDraft, previous: ProviderDraft) {
  if (next.id !== previous.id || !containsHeaders(previous.profile)) return;
  const nextUrls = destinations(next.profile);
  const beforeUrls = destinations(previous.profile);
  if (Object.keys(nextUrls).length !== Object.keys(beforeUrls).length ||
    Object.keys(nextUrls).some(key => nextUrls[key] !== beforeUrls[key])) {
    throw new Error('此配置包含已有请求头。更换 API 地址前，请先在原配置中移除请求头，或新建独立服务商。');
  }
}

const MODE_LABELS: Record<ReasoningMode, string> = {
  'chat-deepseek': 'DeepSeek 思考',
  'chat-zai': '智谱 GLM 思考',
  'chat-effort': '标准 Chat 思考',
  'chat-qwen-effort': '千问原生等级',
  'chat-qwen-budget': '千问思考预算',
  'chat-switch': '思考开关',
  'responses-effort': 'Responses 思考',
  'anthropic-adaptive': 'Claude 自适应思考',
  'anthropic-deepseek': 'DeepSeek 思考',
  'anthropic-budget': '思考预算（兼容旧模型）',
  none: '不支持思考',
  custom: '自定义配置',
};

const MODE_HINTS: Partial<Record<ReasoningMode, string>> = {
  'chat-deepseek': '请求发送 thinking.type=enabled 和 reasoning_effort；仅适用于接受该组合的 Chat 模型。',
  'chat-zai': '请求发送智谱格式 thinking.type=enabled 和 reasoning_effort；模型必须支持所选档位。',
  'chat-effort': '请求只发送 reasoning_effort；适用于标准 Chat 兼容模型。',
  'chat-qwen-effort': '开启时发送 enable_thinking=true 和所选的原生 reasoning_effort；关闭时发送 enable_thinking=false。',
  'chat-qwen-budget': '请求发送 enable_thinking 和 thinking_budget；预算模式只提供 off/low/high，其他等级无法独立透传。',
  'chat-switch': '只传输思考开关；该模式不提供真正的 low/high/max 独立档位。',
  'responses-effort': '请求通过 reasoning.effort 发送所选等级。',
  'anthropic-adaptive': '请求发送 thinking.type=adaptive 和 output_config.effort；需模型支持 adaptive。',
  'anthropic-deepseek': '仅限本插件 DMXAPI Anthropic 预设中的 DeepSeek 模型；请求发送 thinking.type=enabled 和 output_config.effort。',
  'anthropic-budget': '旧模型按预算发送 thinking.budget_tokens；只提供 off/low/high，其他等级无法独立透传。',
  none: '此模型不展示思考等级。若服务商默认等级不是 off，请改为“跟随模型默认”。',
};

const LEVEL_LABELS: Record<string, string> = {
  off: '关闭', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '超高', max: '极致',
};
const INPUT_CAPACITIES = [262144, 524288, 1000000] as const;
const OUTPUT_CAPACITIES = [65536, 131072, 262144] as const;
const capacityLabel = (value: number) => value === 1000000 ? '1M' : `${value / 1024}K`;

function defaultWireValue(level: string, mode: ReasoningMode): string | null {
  if (level !== 'off') return level;
  if (mode === 'chat-qwen-effort') return null;
  if (['chat-deepseek', 'chat-zai', 'chat-switch',
    'anthropic-adaptive', 'anthropic-deepseek'].includes(mode)) return 'disabled';
  if (mode === 'responses-effort') return 'none';
  return null;
}

function readEffortMap(text: string): { value: ModelProfile['reasoningEfforts']; valid: boolean } {
  if (!text.trim()) return { value: undefined, valid: true };
  try { return { value: parseEfforts(text), valid: true }; }
  catch { return { value: undefined, valid: false }; }
}

function isSimpleSwitch(value: ModelProfile['reasoningEfforts']): boolean {
  return !!value && typeof value === 'object' && Object.keys(value).length === 2 &&
    value.off === 'disabled' && value.high === 'high';
}

export function DmxapiCard({ store, save, retryCredential }: DmxapiCardProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const uid = useId();
  const [draft, setDraft] = useState<ProviderDraft>(() => createDmxapiProtocolDraft('chat'));
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [pendingCredential, setPendingCredential] = useState<SaveConfigurationResult | null>(null);
  const [selection, setSelection] = useState<NewProviderKind>('chat');
  const [revision, setRevision] = useState<number | undefined>();
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mode, setMode] = useState<'form' | 'yaml'>('form');
  const [yaml, setYaml] = useState('');
  const [efforts, setEfforts] = useState<string[]>([]);
  const [modeSelections, setModeSelections] = useState<(ReasoningMode | undefined)[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const initialized = useRef(false);
  const initialDraft = useRef<ProviderDraft>(draft);
  const fileInput = useRef<HTMLInputElement>(null);
  const providers = snapshot.value?.providers ?? {};
  const locked = saving || snapshot.status !== 'ready' || !snapshot.writable || snapshot.mode !== 'host';
  const conflict = !pendingCredential && dirty && revision !== undefined && snapshot.revision !== revision;
  let importedCredentialRef: string | undefined;
  let protocolPreview: ProtocolNormalization | undefined;
  try {
    const currentDraft = mode === 'yaml' ? parseProviderYaml(yaml) : draft;
    importedCredentialRef = currentDraft.profile.apiKeyEnv;
    protocolPreview = normalizeProtocolDraft(currentDraft);
  } catch { /* Incomplete YAML is validated on save. */ }
  const deepseekWireModels = protocolPreview ? deepseekAnthropicBridgeModels(protocolPreview.draft) : [];

  function load(next: ProviderDraft, nextSelection: NewProviderKind, changed = false, loadedRevision = store.getSnapshot().revision) {
    const value = copy(next);
    setDraft(value);
    setApiKey('');
    setShowKey(false);
    initialDraft.current = copy(value);
    setPendingCredential(null);
    setSelection(nextSelection);
    setRevision(loadedRevision);
    setEfforts((value.profile.models ?? []).map(model =>
      model.reasoningEfforts === undefined ? '' : formatEfforts(model.reasoningEfforts)));
    setModeSelections((value.profile.models ?? []).map(model =>
      nextSelection !== 'custom'
        ? undefined : inferReasoningMode(model, value.profile.api, value.id)));
    setMode('form');
    setYaml('');
    setDirty(changed);
    setError('');
    setNotice('');
  }

  useEffect(() => {
    if (snapshot.status !== 'ready') return;
    if (!initialized.current) {
      initialized.current = true;
      load(createNewProviderDraft('chat', providers), 'chat');
      return;
    }
    if (!dirty && !saving && !pendingCredential && snapshot.revision !== revision) {
      load(makeProviderDraftUnique(draft, providers), selection);
    }
  }, [snapshot, dirty, saving, revision, pendingCredential]);

  function markDirty() {
    setDirty(true);
    setError('');
    setNotice('');
  }

  function updateProfile(key: string, value: unknown) {
    setDraft(previous => {
      const profile = { ...previous.profile };
      if (value === undefined) delete profile[key];
      else profile[key] = value;
      return { ...previous, profile };
    });
    markDirty();
  }

  function updateModel(index: number, key: string, value: unknown) {
    setDraft(previous => {
      const models = [...(previous.profile.models ?? [])];
      const model = { ...models[index] } as ModelProfile;
      if (value === undefined) delete model[key];
      else model[key] = value;
      models[index] = model;
      return { ...previous, profile: { ...previous.profile, models } };
    });
    markDirty();
  }

  function updateModelId(index: number, id: string) {
    const previousModel = draft.profile.models?.[index];
    if (!previousModel) return;
    let nextModel: ModelProfile = { ...previousModel, id };
    if (id.trim() && modeSelections[index] === undefined) {
      const suggested = recommendReasoningMode(draft.profile.api, draft.id, id);
      nextModel = applyReasoningMode(nextModel, draft.profile.api, draft.id, suggested);
      setEfforts(previous => previous.map((text, position) =>
        position === index ? formatEfforts(nextModel.reasoningEfforts) : text));
    }
    setDraft(previous => {
      const models = [...(previous.profile.models ?? [])];
      models[index] = nextModel;
      return { ...previous, profile: { ...previous.profile, models } };
    });
    markDirty();
  }

  function selectReasoningMode(index: number, mode: ReasoningMode) {
    const model = draft.profile.models?.[index];
    if (!model) return;
    try {
      const nextModel = applyReasoningMode(model, draft.profile.api, draft.id, mode);
      setDraft(previous => {
        const models = [...(previous.profile.models ?? [])];
        models[index] = nextModel;
        return { ...previous, profile: { ...previous.profile, models } };
      });
      setEfforts(previous => previous.map((text, position) =>
        position === index ? formatEfforts(nextModel.reasoningEfforts) : text));
      setModeSelections(previous => previous.map((value, position) => position === index ? mode : value));
      markDirty();
    } catch (cause) { setError(errorMessage(cause)); }
  }

  function changeEffortLevel(index: number, level: string, enabled: boolean) {
    const parsed = readEffortMap(efforts[index] ?? '');
    if (!parsed.valid) {
      setError('当前等级映射 YAML 无法解析。请先修复 YAML，再通过勾选框调整等级。');
      return;
    }
    const current = parsed.value && typeof parsed.value === 'object' ? { ...parsed.value } : {};
    if (enabled) {
      const model = draft.profile.models?.[index];
      const selected = modeSelections[index] ?? inferReasoningMode(model ?? { id: '' }, draft.profile.api, draft.id);
      current[level] = defaultWireValue(level, selected);
    } else delete current[level];
    if (Object.keys(current).every(name => name === 'off')) {
      setError('请至少保留一个思考等级；完全不支持思考时可选择“不支持思考”传输方式。');
      return;
    }
    setEfforts(previous => previous.map((text, position) => position === index ? formatEfforts(current) : text));
    markDirty();
  }

  function formValue(): ProviderDraft {
    const result = copy(draft);
    for (const [index, model] of (result.profile.models ?? []).entries()) {
      const selected = modeSelections[index];
      if (!selected || selected === 'custom') continue;
      if (!REASONING_MODES[result.profile.api ?? '']?.includes(selected)) {
        throw new Error(`模型“${model.id || index + 1}”的思考传输方式与当前接口协议不匹配，请重新选择。`);
      }
      if (selected === 'anthropic-deepseek' || selected === 'anthropic-adaptive') {
        applyReasoningMode(model, result.profile.api, result.id, selected);
      }
    }
    if (result.profile.models) result.profile.models = result.profile.models.map((model, index) => {
      const text = efforts[index] ?? '';
      if (text.trim()) model.reasoningEfforts = parseEfforts(text);
      else delete model.reasoningEfforts;
      return model;
    });
    return result;
  }

  function yamlValue(): ProviderDraft {
    const result = parseProviderYaml(yaml);
    checkHeaderDestination(result, draft);
    if (result.id === draft.id) {
      result.profile = restoreHeaders(result.profile, draft.profile) as ProviderProfile;
    }
    return result;
  }

  function valueToSave() {
    const authored = mode === 'yaml' ? yamlValue() : formValue();
    validateDraft(authored);
    const value = normalizeProtocolDraft(authored).draft;
    checkHeaderDestination(value, initialDraft.current);
    validateDraft(value);
    return value;
  }

  function switchMode(nextMode: 'form' | 'yaml') {
    if (nextMode === mode) return;
    try {
      if (nextMode === 'yaml') {
        const next = formValue();
        setDraft(next);
        setYaml(editorYaml(next));
      } else {
        const next = yamlValue();
        setDraft(next);
        setEfforts((next.profile.models ?? []).map(model =>
          model.reasoningEfforts === undefined ? '' : formatEfforts(model.reasoningEfforts)));
        setModeSelections((next.profile.models ?? []).map(model => inferReasoningMode(model, next.profile.api, next.id)));
      }
      setMode(nextMode);
      setError('');
    } catch (cause) { setError(errorMessage(cause)); }
  }

  function mayDiscard() {
    return !dirty || window.confirm('当前有未保存的修改，是否放弃这些修改？');
  }

  function selectProvider(value: NewProviderKind) {
    if (!mayDiscard()) return;
    load(createNewProviderDraft(value, store.getSnapshot().value?.providers ?? {}), value);
  }

  function resetDraft() {
    if (!mayDiscard()) return;
    load(makeProviderDraftUnique(initialDraft.current, store.getSnapshot().value?.providers ?? {}), selection);
  }

  function finishCreation(result: SaveConfigurationResult) {
    const current = store.getSnapshot();
    const occupied = { ...(current.value?.providers ?? {}), [result.draft.id]: result.draft.profile };
    load(createNewProviderDraft(selection, occupied), selection, false, current.revision ?? result.revision);
    setNotice(`已新增“${result.draft.profile.displayName || result.draft.id}”（${result.draft.id}）。原有配置未修改，可在聊天中选择新模型。`);
  }

  function continueCreating() {
    load(createNewProviderDraft(selection, store.getSnapshot().value?.providers ?? {}), selection);
    setNotice('已新增的配置保留。需要补充密钥时，请前往 Harness 的“设置 → 模型”；这里可继续新增服务商。');
  }

  async function retryKey() {
    if (!pendingCredential || locked) return;
    setSaving(true);
    setError('');
    try {
      const result = await retryCredential(pendingCredential, apiKey);
      if (result.credential === 'failed') {
        setPendingCredential(result);
        setError('API Key 仍未保存。可重试密钥，或继续新建并稍后在“设置 → 模型”中补充。');
      } else finishCreation(result);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setSaving(false); }
  }

  async function saveDraft() {
    setError('');
    setNotice('');
    try {
      if (locked || pendingCredential) throw new Error('当前不能新增配置，请先处理待保存的密钥或等待连接恢复。');
      const current = store.getSnapshot();
      if (revision === undefined || current.revision !== revision) {
        throw new Error('配置已在其他位置更新。请先导出草稿，重新载入后再编辑。');
      }
      const next = valueToSave();
      if (Object.hasOwn(current.value?.providers ?? {}, next.id)) {
        throw new Error(`服务商标识“${next.id}”已存在。插件只新增配置，请使用其他标识，原配置不会被覆盖。`);
      }
      setSaving(true);
      const result = await save(next, revision, apiKey);
      if (result.credential === 'failed') {
        // Preserve the exact receipt: retry writes only this creation's isolated credential.
        load(result.draft, selection, false, result.revision);
        setPendingCredential(result);
        setApiKey(apiKey);
        setError('配置已新增，但 API Key 未保存。输入内容已保留并隐藏；下方“重试密钥”只保存本次密钥，不重复新增或覆盖配置。');
      } else finishCreation(result);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setSaving(false); }
  }

  async function importFile(file: File) {
    try {
      if (file.size > 1_048_576) throw new Error('YAML 配置不能超过 1 MiB。');
      const value = parseProviderYaml(await file.text());
      validateDraft(value);
      if (!mayDiscard()) return;
      const next = makeProviderDraftUnique(value, store.getSnapshot().value?.providers ?? {});
      load(next, 'custom', true);
      setNotice(next.id === value.id ? 'YAML 已作为新服务商草稿载入，尚未保存。'
        : `原标识“${value.id}”已存在，已为新草稿使用“${next.id}”。原配置未修改。`);
    } catch (cause) { setError(errorMessage(cause)); }
  }

  function downloadYaml() {
    try {
      const value = valueToSave();
      const url = URL.createObjectURL(new Blob([exportProviderYaml(value)], { type: 'application/yaml;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `${value.id.replace(/[^a-zA-Z0-9._-]/g, '-') || 'provider'}.yaml`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setError('');
      setNotice('YAML 已导出；请求头和密钥不包含在导出文件中。');
    } catch (cause) { setError(errorMessage(cause)); }
  }

  const models = draft.profile.models ?? [];
  const commonDefaultLevels = models.length === 0 ? [] : EFFORT_LEVELS.filter(level =>
    models.every((_, index) => {
      const parsed = readEffortMap(efforts[index] ?? '');
      return parsed.valid && (parsed.value === false ? level === 'off'
        : parsed.value !== undefined && level in parsed.value);
    }));
  const invalidDefault = draft.profile.reasoning &&
    !commonDefaultLevels.includes(draft.profile.reasoning as typeof EFFORT_LEVELS[number]);
  const switchOnly = models.length > 0 && models.every((model, index) =>
    (modeSelections[index] ?? inferReasoningMode(model, draft.profile.api, draft.id)) === 'chat-switch' &&
    isSimpleSwitch(readEffortMap(efforts[index] ?? '').value));
  return (
    <section className="dmx-card" aria-labelledby={`${uid}-title`}>
      <header className="dmx-header">
        <img className="dmx-brand" src={dmxapiIcon} alt="DMXAPI" />
        <div className="dmx-heading">
          <h2 id={`${uid}-title`}>DMXAPI-DSH配置工具</h2>
          <p>新增第三方 API、图片输入和模型思考等级。</p>
        </div>
      </header>

      {snapshot.status === 'unavailable' && <div className="dmx-alert" role="alert">无法读取模型配置。请确认 llm-pi-ai 已启用，然后重新打开设置。</div>}
      {snapshot.status === 'ready' && !snapshot.writable && <div className="dmx-note">当前配置为只读。请在有写入权限的 Harness 实例中编辑。</div>}
      {snapshot.mode === 'memory' && <div className="dmx-note">当前设置仅保存在内存中，重启后不会保留。</div>}

      <form noValidate onSubmit={event => { event.preventDefault(); void saveDraft(); }}>
        <fieldset className="dmx-fields" disabled={locked || !!pendingCredential}>
          <div className="dmx-toolbar">
            <label className="dmx-field dmx-provider-picker">
                <span>新增服务商</span>
                <select value={selection} onChange={event => selectProvider(event.target.value as NewProviderKind)}>
                  <option value="chat">DMXAPI · Chat</option>
                  <option value="responses">DMXAPI · Responses</option>
                  <option value="anthropic">DMXAPI · Anthropic</option>
                  <option value="custom">新建自定义服务商</option>
              </select>
            </label>
            <div className="dmx-actions">
              <button type="button" onClick={() => fileInput.current?.click()}>导入 YAML</button>
              <button type="button" onClick={downloadYaml}>导出 YAML</button>
              <input ref={fileInput} className="dmx-file" type="file" accept=".yaml,.yml,text/yaml,application/yaml" aria-label="导入 YAML 文件"
                onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importFile(file); }} />
            </div>
          </div>

          <p className="dmx-note">这里只新增配置，不修改已有服务商。原配置继续保留，可在 Harness 的“设置 → 模型”中管理。</p>

          <div className="dmx-mode" role="group" aria-label="编辑方式">
            <button type="button" aria-pressed={mode === 'form'} onClick={() => switchMode('form')}>表单配置</button>
            <button type="button" aria-pressed={mode === 'yaml'} onClick={() => switchMode('yaml')}>完整 YAML</button>
          </div>

          <div className="dmx-field dmx-secret-field">
            <label htmlFor={`${uid}-api-key`}>API Key <small>为新服务商独立保存</small></label>
            <div className="dmx-secret-input">
              <input id={`${uid}-api-key`} className="dmx-code" type={showKey ? 'text' : 'password'}
                value={apiKey} autoComplete="new-password" spellCheck={false} autoCapitalize="none"
                placeholder="输入 API Key"
                aria-describedby={`${uid}-key-hint`}
                onChange={event => { setApiKey(event.target.value); markDirty(); }} />
              <button type="button" aria-label={showKey ? '隐藏 API Key' : '显示 API Key'} aria-pressed={showKey}
                onClick={() => setShowKey(value => !value)}>{showKey ? '隐藏' : '显示'}</button>
            </div>
            <p id={`${uid}-key-hint`} className="dmx-hint">默认隐藏，保存后清空。填写密钥不会替换其他服务商的密钥。{importedCredentialRef && '此草稿包含凭据引用：留空使用导入引用，填写则为新服务商独立保存。'}</p>
          </div>

          {dirty && protocolPreview && (protocolPreview.removedCompat.length > 0 || protocolPreview.baseURLChanged) &&
            <div className="dmx-note" role="status">
              {protocolPreview.removedCompat.length > 0 && `保存时将移除 ${protocolPreview.removedCompat.length} 项当前协议不支持的兼容参数。`}
              {protocolPreview.baseURLChanged && `DMXAPI 请求地址将调整为 ${protocolPreview.draft.profile.baseURL}。`}
            </div>}
          {deepseekWireModels.length > 0 && <div className="dmx-note" role="status">
            {deepseekWireModels.join('、')} 将按 DeepSeek Anthropic 方式发送 thinking.type=enabled 和 output_config.effort；这也适用于从 YAML 导入的同类配置。
          </div>}

          {mode === 'yaml' ? <div className="dmx-yaml-panel">
            <label className="dmx-field">
              <span>服务商 YAML</span>
              <textarea className="dmx-code dmx-yaml" value={yaml} spellCheck={false} rows={22}
                onChange={event => { setYaml(event.target.value); markDirty(); }} />
            </label>
            <p className="dmx-hint">在此编辑 compat、模型兼容项及其他高级字段。请求头不会显示或导出；同标识、同地址的已有请求头会保留。不要填写 API 密钥。</p>
          </div> : <>
            <div className="dmx-grid">
              <label className="dmx-field"><span>显示名称</span><input value={draft.profile.displayName ?? ''} placeholder="DMXAPI" onChange={event => updateProfile('displayName', event.target.value || undefined)} /></label>
              <label className="dmx-field"><span>服务商标识 <small>必须与已有配置不同</small></span><input className="dmx-code" value={draft.id} placeholder="my-provider" onChange={event => { setDraft({ ...draft, id: event.target.value }); markDirty(); }} /></label>
              <label className="dmx-field dmx-span"><span>API 地址</span><input className="dmx-code" type="url" value={draft.profile.baseURL ?? ''} placeholder="https://www.dmxapi.cn/v1" onChange={event => updateProfile('baseURL', event.target.value)} /></label>
              <label className="dmx-field"><span>接口协议</span><select value={draft.profile.api ?? 'openai-completions'} onChange={event => {
                setModeSelections(models.map(model => inferReasoningMode(model, draft.profile.api, draft.id)));
                updateProfile('api', event.target.value);
              }}>
                <option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option>
                {draft.profile.api && !['openai-completions', 'openai-responses', 'anthropic-messages'].includes(draft.profile.api) && <option value={draft.profile.api}>{draft.profile.api}（现有协议）</option>}
              </select></label>
              <label className="dmx-field"><span>默认思考等级</span><select value={draft.profile.reasoning ?? ''} onChange={event => updateProfile('reasoning', event.target.value || undefined)}>
                <option value="">跟随模型默认</option>
                {commonDefaultLevels.map(level => <option key={level} value={level}>
                  {switchOnly ? level === 'off' ? '关闭' : '开启' : level === 'off' ? 'off · 关闭思考' : level}
                </option>)}
                {invalidDefault && <option value={draft.profile.reasoning}>{draft.profile.reasoning}（当前配置，需调整）</option>}
              </select></label>
            </div>
            <p className="dmx-hint dmx-advanced-hint">{protocolPathHint(draft.profile.api)}</p>
            <p className="dmx-hint dmx-advanced-hint">这里只列出所有模型共同支持的等级。选择「跟随模型默认」时，DMXAPI 预设的千问默认 medium，其他思考模型默认高强度；开关模型默认开启。</p>

            <div className="dmx-section-title"><div><h3>模型</h3><span>{models.length} 个模型 · 点击一行编辑</span></div><div className="dmx-actions">
              <button type="button" onClick={() => {
              const nextModel: ModelProfile = {
                id: '', input: ['text'],
                reasoningEfforts: draft.profile.api === 'anthropic-messages'
                  ? { off: null, low: 'low', high: 'high' }
                  : { off: null, low: 'low', high: 'high', max: 'max' },
                ...(draft.profile.api === 'anthropic-messages' ? { compat: { forceAdaptiveThinking: false } } : {}),
              };
              updateProfile('models', [...models, nextModel]);
              setEfforts([...efforts, formatEfforts(nextModel.reasoningEfforts)]);
              setModeSelections([...modeSelections, undefined]);
            }}>＋ 添加模型</button></div></div>
            {models.length === 0 && <div className="dmx-empty">添加模型后，可分别设置图片输入能力和思考等级。</div>}
            <div className="dmx-models">{models.map((model, index) => {
              const effortState = readEffortMap(efforts[index] ?? '');
              const effortMap = effortState.value && typeof effortState.value === 'object' ? effortState.value : {};
              const reasoningMode = modeSelections[index] ?? inferReasoningMode(model, draft.profile.api, draft.id);
              const levelDisabled = reasoningMode === 'none';
              const isSwitch = reasoningMode === 'chat-switch' && isSimpleSwitch(effortState.value);
              const configuredLevels = Object.keys(effortMap);
              const customLevels = EFFORT_LEVELS.filter(level => !(level in effortMap) &&
                !(level === 'off' && ALWAYS_ON_PRESET_IDS.has(model.id)) &&
                !(['chat-qwen-budget', 'anthropic-budget'].includes(reasoningMode) && ['max', 'xhigh'].includes(level)));
              const modeChoices = visibleReasoningModes(draft.profile.api, draft.id, model);
              return <details className="dmx-model" key={index} open={model.id === '' ? true : undefined}>
              <summary className="dmx-model-title"><span className="dmx-model-summary"><strong className="dmx-code">{model.id || `新模型 ${index + 1}`}</strong><small>{isSwitch ? '思考开关 · 开启 / 关闭' : levelDisabled ? '不支持思考' : configuredLevels.length ? configuredLevels.join(' / ') : '使用模型默认配置'}</small></span><span className="dmx-model-badges"><span>文本</span>{model.input?.includes('image') && <span className="dmx-image-badge">图片</span>}{effortState.value === false ? <span>不思考</span> : configuredLevels.some(level => level !== 'off') && <span>思考</span>}</span></summary>
              <div className="dmx-grid dmx-model-body">
                <label className="dmx-field"><span>模型 ID</span><input className="dmx-code" value={model.id} placeholder="例如 deepseek-v4.1-flash" onChange={event => updateModelId(index, event.target.value)} /></label>
                <label className="dmx-field"><span>显示名称 <small>可选</small></span><input value={model.name ?? ''} placeholder="与模型 ID 相同" onChange={event => updateModel(index, 'name', event.target.value || undefined)} /></label>
                <div className="dmx-editor-panel dmx-span">
                  <h4>模型能力</h4>
                  <label className="dmx-checkbox"><input type="checkbox" checked={model.input?.includes('image') ?? false} onChange={event => updateModel(index, 'input', event.target.checked ? ['text', 'image'] : ['text'])} /><span>图片输入</span></label>
                  <p className="dmx-hint">文本输入始终可用；勾选图片仅声明模型能力，服务商接口也须支持。工具调用由 Harness 按实际模型能力传递。</p>
                </div>
                {modeSelections[index] && !REASONING_MODES[draft.profile.api ?? '']?.includes(modeSelections[index]) &&
                  <p className="dmx-model-warning dmx-span">协议已更改；请为该模型重新选择当前协议的思考传输方式。</p>}
                {modeSelections[index] === 'anthropic-deepseek' && (!/^deepseek[-.]/i.test(model.id) || dmxapiProtocolForProvider(draft.id) !== 'anthropic') &&
                  <p className="dmx-model-warning dmx-span">DeepSeek 精确档位需要 DMXAPI Anthropic 预设，模型 ID 以 deepseek- 或 deepseek. 开头。</p>}
                {modeSelections[index] === 'anthropic-adaptive' && dmxapiProtocolForProvider(draft.id) === 'anthropic' && /^deepseek[-.]/i.test(model.id) &&
                  <p className="dmx-model-warning dmx-span">该 DeepSeek 模型会使用 enabled + effort；请改选 DeepSeek 专用模式。</p>}
                <div className="dmx-level-panel dmx-span">
                  <div className="dmx-level-heading"><h4>{isSwitch ? '思考开关' : '支持的思考等级'}</h4><span>{isSwitch ? '在聊天中选择开启或关闭' : '仅显示此模型已配置的选项'}</span></div>
                  {!effortState.valid && <p className="dmx-model-warning">等级映射 YAML 尚未解析成功；修复下方内容后可使用勾选框。</p>}
                  {isSwitch ? <><div className="dmx-switch-options"><span>关闭</span><span>开启</span></div><p className="dmx-hint">此模型只区分思考开关，不设置强度等级。</p></> : <>
                    <div className="dmx-level-options">
                      {configuredLevels.map(level => <label className="dmx-checkbox" key={level}><input type="checkbox" checked disabled={!effortState.valid || levelDisabled} onChange={event => changeEffortLevel(index, level, event.target.checked)} /><span>{level} <small>{LEVEL_LABELS[level]}</small></span></label>)}
                    </div>
                    {!levelDisabled && <label className="dmx-add-level"><span>添加等级</span><select aria-label={`模型 ${index + 1} 添加思考等级`} value="" disabled={!effortState.valid || customLevels.length === 0} onChange={event => changeEffortLevel(index, event.target.value, true)}><option value="">选择等级…</option>{customLevels.map(level => <option key={level} value={level}>{level} · {LEVEL_LABELS[level]}</option>)}</select></label>}
                    <p className="dmx-hint">{levelDisabled ? '此模型不提供思考选项。' : '取消勾选可移除选项；添加前请确认模型支持该等级。'}</p>
                    {ALWAYS_ON_PRESET_IDS.has(model.id) && <p className="dmx-hint">此模型的思考始终开启。</p>}
                    {/^qwen3\.8-max(?:-0902)?$/.test(model.id) && <p className="dmx-hint">等级按原值发送。旧会话若仍选着 high / max，请展开聊天中的思考等级菜单，重新选择 medium / xhigh。</p>}
                  </>}
                </div>
                <details className="dmx-model-advanced dmx-span">
                  <summary>高级配置</summary>
                  <label className="dmx-field"><span>思考传输方式</span><select aria-label={`模型 ${index + 1} 思考传输方式`} value={modeChoices.includes(reasoningMode) ? reasoningMode : 'custom'} onChange={event => selectReasoningMode(index, event.target.value as ReasoningMode)}>
                    {modeChoices.map(choice => <option key={choice} value={choice}>{MODE_LABELS[choice]}</option>)}
                  </select></label>
                  <p className="dmx-hint">{MODE_HINTS[reasoningMode] ?? '保留现有配置；请按服务商说明填写参数。'}</p>
                  {!isSwitch && <label className="dmx-field"><span>自定义接口值 · YAML</span><textarea className="dmx-code dmx-efforts" value={efforts[index] ?? ''} rows={4} spellCheck={false} placeholder={'low: low\nhigh: high'} onChange={event => {
                    setEfforts(efforts.map((text, position) => position === index ? event.target.value : text));
                    markDirty();
                  }} /><span className="dmx-hint">通常两侧保持同名。仅在服务商有特殊要求时修改；留空继承模型配置，false 表示不提供思考选项。</span></label>}
                </details>
                <div className="dmx-capacity-grid dmx-span">
                  <div className="dmx-capacity"><label className="dmx-field"><span>输入上下文 <small>tokens</small></span><input type="number" min="1" step="1" value={model.contextWindow ?? ''} placeholder="使用默认值" onChange={event => updateModel(index, 'contextWindow', event.target.value === '' ? undefined : Number(event.target.value))} /></label><div className="dmx-capacity-shortcuts" aria-label="输入上下文快捷值">{INPUT_CAPACITIES.map(value => <button type="button" key={value} aria-pressed={model.contextWindow === value} onClick={() => updateModel(index, 'contextWindow', value)}>{capacityLabel(value)}</button>)}</div></div>
                  <div className="dmx-capacity"><label className="dmx-field"><span>最大输出 <small>tokens · 每次请求默认上限</small></span><input type="number" min="1" step="1" value={model.maxTokens ?? ''} placeholder="使用默认值" onChange={event => updateModel(index, 'maxTokens', event.target.value === '' ? undefined : Number(event.target.value))} /></label><div className="dmx-capacity-shortcuts" aria-label="最大输出快捷值">{OUTPUT_CAPACITIES.map(value => <button type="button" key={value} aria-pressed={model.maxTokens === value} onClick={() => updateModel(index, 'maxTokens', value)}>{capacityLabel(value)}</button>)}</div></div>
                </div>
                {model.contextWindow !== undefined && model.maxTokens !== undefined && model.maxTokens > model.contextWindow &&
                  <p className="dmx-model-warning dmx-span">最大输出超过输入上下文；请调整容量值，避免请求或保存被服务商拒绝。</p>}
                {draft.profile.reasoning && effortState.valid && !(draft.profile.reasoning in effortMap) &&
                  <p className="dmx-model-warning dmx-span">此模型未提供服务商默认等级 {draft.profile.reasoning}。请添加该等级，或将默认等级改为“跟随模型默认”。</p>}
                <div className="dmx-model-controls dmx-span"><button type="button" className="dmx-remove" aria-label={`删除模型 ${model.id || index + 1}`} onClick={() => {
                  updateProfile('models', models.filter((_, position) => position !== index));
                  setEfforts(efforts.filter((_, position) => position !== index));
                  setModeSelections(modeSelections.filter((_, position) => position !== index));
                }}>删除此模型</button></div>
              </div>
            </details>;})}</div>
            <p className="dmx-hint dmx-advanced-hint">新模型会根据 ID 推荐传输方式；请确认 DMXAPI 对该模型支持所选档位。thinkingFormat、maxTokensField 等参数可在「完整 YAML」中编辑。</p>
          </>}
        </fieldset>

        <div className="dmx-key-note"><span className="dmx-note-icon" aria-hidden="true">i</span><p>API Key 由 Harness 凭据服务保存，不会写入模型配置或 YAML 导出。直接在上方填写并保存即可。</p></div>

        {conflict && <div className="dmx-conflict" role="alert"><div><strong>检测到其他位置的配置更新</strong><p>你的草稿仍然保留。可先导出 YAML，再重新载入最新配置。</p></div><button type="button" onClick={resetDraft} disabled={saving}>重新载入</button></div>}
        {error && <div className="dmx-alert" role="alert">{error}</div>}
        {notice && <div className="dmx-success" role="status">{notice}</div>}
        <footer className="dmx-footer"><span>{pendingCredential ? '配置已新增，等待密钥保存' : '仅新增，不覆盖已有配置'}</span><div className="dmx-actions">
          {pendingCredential ? <><button type="button" onClick={continueCreating} disabled={saving}>继续新建</button><button type="button" className="dmx-primary" onClick={() => void retryKey()} disabled={locked}>{saving ? '正在重试…' : '重试密钥'}</button></>
            : <><button type="button" onClick={resetDraft} disabled={locked || !dirty}>取消修改</button><button type="submit" className="dmx-primary" disabled={locked || conflict}>{saving ? '正在新增…' : '新增配置'}</button></>}
        </div></footer>
      </form>
    </section>
  );
}
