import type { ProviderDraft } from './config.ts';

const HIDDEN_YAML_KEYS = new Set([
  'headers', 'apikey', 'token', 'password', 'passwd', 'secret',
  'clientsecret', 'accesstoken', 'refreshtoken', 'authorization', 'credential', 'credentials',
]);

const hiddenYamlKey = (key: string) => HIDDEN_YAML_KEYS.has(key.toLowerCase().replace(/[-_\s]/g, ''));
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Redact fields that could contain credentials from the on-screen YAML editor. */
export function redactHiddenYamlFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactHiddenYamlFields);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !hiddenYamlKey(key))
    .map(([key, entry]) => [key, redactHiddenYamlFields(entry)]));
}

/** Round-trip the hidden fields by model ID; rejected fields stay visible to validation instead of vanishing. */
export function restoreHiddenYamlFields(edited: unknown, original: unknown): unknown {
  if (Array.isArray(edited) && Array.isArray(original)) {
    if (original.some(entry => containsHiddenYamlFields(entry) && (!isRecord(entry) || typeof entry.id !== 'string')) &&
      JSON.stringify(canonical(edited)) !== JSON.stringify(canonical(redactHiddenYamlFields(original)))) {
      throw new Error('YAML 修改无模型 ID 的数组会丢失其中的隐藏字段。请改用表单或 Harness 原生设置。');
    }
    const matched = new Set<number>();
    const result = edited.map((entry, index) => {
      const previousIndex = isRecord(entry) && typeof entry.id === 'string'
        ? original.findIndex(item => isRecord(item) && item.id === entry.id)
        : index;
      if (previousIndex >= 0 && previousIndex < original.length) matched.add(previousIndex);
      return restoreHiddenYamlFields(entry, original[previousIndex]);
    });
    original.forEach((entry, index) => {
      if (!matched.has(index) && containsHiddenYamlFields(entry)) {
        throw new Error('YAML 删除含隐藏字段的数组项会丢失原配置。请改用表单编辑。');
      }
    });
    return result;
  }
  if (!isRecord(edited) || !isRecord(original)) {
    if (containsHiddenYamlFields(original)) {
      throw new Error('YAML 修改会丢失原配置中的隐藏字段。请改用表单编辑，或在 Harness 原生设置中处理该字段。');
    }
    return edited;
  }
  const result = { ...edited };
  for (const [key, value] of Object.entries(original)) {
    if (hiddenYamlKey(key) && !(key in result)) result[key] = structuredClone(value);
    else if (key in result) result[key] = restoreHiddenYamlFields(result[key], value);
    else if (containsHiddenYamlFields(value)) {
      throw new Error(`YAML 删除“${key}”会丢失其中的隐藏字段。请改用表单编辑，或在 Harness 原生设置中处理。`);
    }
  }
  return result;
}

function containsHiddenYamlFields(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsHiddenYamlFields);
  return value !== null && typeof value === 'object' &&
    Object.entries(value).some(([key, entry]) => hiddenYamlKey(key) || containsHiddenYamlFields(entry));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonical(entry)]));
}

/** A model edit may change only the model list and provider default effort. */
export function assertExistingModelEdit(before: ProviderDraft, after: ProviderDraft, fromYaml: boolean): void {
  if (before.id !== after.id) throw new Error('编辑已有服务商时不能修改服务商标识。请选择“新建独立配置”创建另一个服务商。');
  const { models: _beforeModels, reasoning: _beforeReasoning, ...beforeProvider } = before.profile;
  const { models: _afterModels, reasoning: _afterReasoning, ...afterProvider } = after.profile;
  if (JSON.stringify(canonical(beforeProvider)) !== JSON.stringify(canonical(afterProvider))) {
    throw new Error('编辑已有服务商时只能修改模型和默认思考等级；名称、协议、API 地址与凭据请在 Harness 原生设置中修改。');
  }
  if (fromYaml) {
    const nextIds = new Set((after.profile.models ?? []).map(model => model.id));
    for (const model of before.profile.models ?? []) {
      if (containsHiddenYamlFields(model) && !nextIds.has(model.id)) {
        throw new Error(`模型“${model.id}”含有隐藏字段（如请求头）。请切换到表单修改或删除它，避免在 YAML 中改名时丢失这些字段。`);
      }
    }
  }
}
