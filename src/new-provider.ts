import { createDmxapiProtocolDraft, dmxapiProtocolForProvider, type DmxapiProtocolPreset, type ProviderDraft } from './config.ts';

export type NewProviderKind = DmxapiProtocolPreset | 'custom';

export interface ProviderSelection {
  draft: ProviderDraft;
  existingId: string | null;
}

/** Only presets with the expected route ID and wire protocol can be edited here. */
export function existingPresetProviderIds(kind: DmxapiProtocolPreset, providers: Readonly<Record<string, unknown>>): string[] {
  const expectedApi = createDmxapiProtocolDraft(kind).profile.api;
  const base = `dmxapi-${kind}`;
  return Object.keys(providers).filter(id => {
    const profile = providers[id];
    return dmxapiProtocolForProvider(id) === kind && profile !== null &&
      typeof profile === 'object' && !Array.isArray(profile) &&
      (profile as Record<string, unknown>).api === expectedApi;
  }).sort((left, right) => {
    const leftIndex = left === base ? 1 : Number(left.slice(base.length + 1));
    const rightIndex = right === base ? 1 : Number(right.slice(base.length + 1));
    return leftIndex - rightIndex;
  });
}

/** An omitted ID opens the first existing preset; an empty ID explicitly creates a new route. */
export function selectProviderDraft(
  kind: NewProviderKind,
  providers: Readonly<Record<string, unknown>>,
  existingId?: string,
): ProviderSelection {
  if (kind !== 'custom' && existingId !== '') {
    const ids = existingPresetProviderIds(kind, providers);
    const selected = existingId ?? ids[0];
    if (selected) {
      if (!ids.includes(selected)) throw new Error('所选服务商已不存在或接口协议已变化，请重新选择。');
      return { draft: { id: selected, profile: structuredClone(providers[selected]) as ProviderDraft['profile'] }, existingId: selected };
    }
  }
  return { draft: createNewProviderDraft(kind, providers), existingId: null };
}

/** Allocate a fresh route without ever loading or modifying an existing profile. */
export function makeProviderDraftUnique(draft: ProviderDraft, providers: Readonly<Record<string, unknown>>): ProviderDraft {
  const next = structuredClone(draft);
  if (!Object.hasOwn(providers, next.id)) return next;
  const protocol = dmxapiProtocolForProvider(next.id);
  const base = protocol ? `dmxapi-${protocol}` : next.id;
  let suffix = 2;
  while (Object.hasOwn(providers, `${base}-${suffix}`)) suffix++;
  next.id = `${base}-${suffix}`;
  if (next.profile.displayName) next.profile.displayName = `${next.profile.displayName} (${suffix})`;
  return next;
}

export function createNewProviderDraft(kind: NewProviderKind, providers: Readonly<Record<string, unknown>>): ProviderDraft {
  return makeProviderDraftUnique(kind === 'custom' ? {
    id: '', profile: { api: 'openai-completions', baseURL: '', models: [{ id: '', input: ['text'] }] },
  } : createDmxapiProtocolDraft(kind), providers);
}
