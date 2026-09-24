import { createDmxapiProtocolDraft, dmxapiProtocolForProvider, type DmxapiProtocolPreset, type ProviderDraft } from './config.ts';

export type NewProviderKind = DmxapiProtocolPreset | 'custom';

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
