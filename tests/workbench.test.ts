import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
import { runInThisContext } from 'node:vm';
import { build } from 'esbuild';
import type { Context } from '@deepseek-ai/cordis';
import type { ReactElement } from 'react';
import type { DmxapiCardProps, Snapshot } from '../src/client/Card.tsx';
import type { ProviderProfile } from '../src/config.ts';
import { createDmxapiProtocolDraft } from '../src/config.ts';

// Exercise the real browser entry, including its CSS lifecycle and save ports,
// without loading a second Host runtime or touching any installed profile.
const bundle = await build({
  entryPoints: ['src/client/index.ts'], bundle: true, platform: 'browser',
  format: 'cjs', write: false, jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-dom'],
  loader: { '.css': 'text', '.png': 'dataurl' },
});

type ConfigurationEntry = {
  name: string;
  key: string;
  inject(): DmxapiCardProps;
};
type ConfigurationView = (props: DmxapiCardProps & { view: 'summary' | 'page' }) => ReactElement;
type Mutation = { op: 'set' | 'unset'; path: string[]; value?: unknown };

function mountWorkbench(providers: Record<string, ProviderProfile> = {}) {
  let snapshot: Snapshot = { status: 'ready', writable: true, mode: 'host', revision: 7, value: { providers } };
  const listeners = new Set<() => void>();
  const styles = new Set<object>();
  const disposers: Array<() => void> = [];
  const mutations: Array<{ namespace: string; ops: Mutation[]; revision: number }> = [];
  const credentials: Array<{ ref: string; value: string }> = [];
  const accepted: number[] = [];
  let slot: { name: string; declare: () => () => void } | undefined;
  let active: { spec: ConfigurationEntry; View: ConfigurationView } | undefined;
  let registeredOff: (() => void) | undefined;
  const module = { exports: {} as { apply(ctx: Context): void; inject: string[] } };
  const evaluate = runInThisContext(`(function(require, module, exports, document, crypto) {\n${bundle.outputFiles[0].text}\n})`);
  evaluate(createRequire(import.meta.url), module, module.exports, {
    createElement: () => {
      const style = { dataset: {}, textContent: '', remove: () => { styles.delete(style); } };
      return style;
    },
    head: { appendChild: (style: object) => styles.add(style) },
  }, webcrypto);
  const context = {
    effect: (effect: () => () => void) => { disposers.push(effect()); },
    configForms: {
      get: (namespace: string) => {
        assert.equal(namespace, 'llm-pi-ai');
        return {
          getSnapshot: () => snapshot,
          subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
          },
        };
      },
      describe: () => ({ acceptView: (view: { revision: number; value: Snapshot['value'] }) => {
        accepted.push(view.revision);
        snapshot = { ...snapshot, revision: view.revision, value: view.value };
        for (const listener of listeners) listener();
      } }),
    },
    remote: {
      settings: { mutate: async (namespace: string, ops: Mutation[], revision: number) => {
        assert.equal(namespace, 'llm-pi-ai');
        assert.equal(revision, snapshot.revision);
        mutations.push(structuredClone({ namespace, ops, revision }));
        const value = structuredClone(snapshot.value) as Record<string, unknown>;
        for (const op of ops) {
          let target = value;
          for (const key of op.path.slice(0, -1)) target = target[key] as Record<string, unknown>;
          const key = op.path.at(-1)!;
          if (op.op === 'set') target[key] = structuredClone(op.value);
          else delete target[key];
        }
        return { ok: true, value: { revision: revision + 1, value } };
      } },
      credentials: { set: async (ref: string, value: string) => {
        credentials.push({ ref, value });
        return { ok: true };
      } },
    },
    slots: {
      inject: (name: string, declare: () => () => void) => {
        slot = { name, declare };
        disposers.push(() => { registeredOff?.(); slot = undefined; });
      },
      register: (spec: ConfigurationEntry, View: ConfigurationView) => {
        assert.equal(active, undefined);
        active = { spec, View };
        return () => { active = undefined; };
      },
    },
  };
  module.exports.apply(context as unknown as Context);
  return {
    module, styles, mutations, credentials, accepted,
    snapshot: () => snapshot,
    active: () => active,
    declareSlot: () => {
      assert.equal(slot?.name, 'plugins.bundle.config');
      registeredOff = slot!.declare();
      return active!;
    },
    dispose: () => { for (const dispose of disposers.reverse()) dispose(); },
  };
}

test('workbench waits for the bundle slot, exposes summary/page, and removes styles and registration on disposal', () => {
  const mounted = mountWorkbench();
  assert.equal(mounted.styles.size, 1);
  assert.equal(mounted.active(), undefined, 'late slot declaration must be supported');
  assert.deepEqual(Array.from(mounted.module.exports.inject), ['slots', 'configForms', 'remote', 'remote.settings', 'remote.credentials']);
  const { spec, View } = mounted.declareSlot();
  assert.equal(spec.name, 'plugins.bundle.config');
  assert.equal(spec.key, 'dsh-dmxapi', 'configuration belongs to this bundle, not the llm-pi-ai bundle');
  const face = spec.inject();
  const summary = View({ ...face, view: 'summary' });
  assert.equal(summary.props.children, '快速配置 Chat、Responses、Anthropic 服务商与模型。');
  const page = View({ ...face, view: 'page' });
  assert.equal(page.props.className, 'dmx-workbench');
  assert.equal(page.props.children.props.store, face.store, 'page receives the live settings form');
  assert.equal(mounted.mutations.length, 0, 'opening the workbench must not write configuration');
  assert.equal(mounted.credentials.length, 0);
  mounted.dispose();
  assert.equal(mounted.active(), undefined);
  assert.equal(mounted.styles.size, 0);
});

test('workbench save writes a new route and its isolated credential through separate Host services', async () => {
  const mounted = mountWorkbench();
  try {
    const face = mounted.declareSlot().spec.inject();
    let changes = 0;
    const unsubscribe = face.store.subscribe(() => { changes++; });
    const receipt = await face.save(createDmxapiProtocolDraft('chat'), 7, 'workbench-test-key');
    assert.equal(receipt.credential, 'saved');
    assert.equal(receipt.revision, 8);
    assert.deepEqual(mounted.mutations[0].ops.map(op => op.path), [['providers', 'dmxapi-chat']]);
    assert.equal(JSON.stringify(mounted.mutations).includes('workbench-test-key'), false);
    assert.deepEqual(mounted.credentials, [{ ref: receipt.draft.profile.apiKeyEnv, value: 'workbench-test-key' }]);
    assert.deepEqual(mounted.accepted, [8]);
    assert.equal(changes, 1);
    assert.equal(face.store.getSnapshot().revision, 8);
    unsubscribe();
  } finally { mounted.dispose(); }
});

test('workbench model edits retain the existing route and never call the credential writer', async () => {
  const original = createDmxapiProtocolDraft('anthropic');
  original.profile.apiKeyEnv = 'EXISTING_REFERENCE';
  const sibling = createDmxapiProtocolDraft('responses');
  const mounted = mountWorkbench({ [original.id]: original.profile, [sibling.id]: sibling.profile });
  try {
    const face = mounted.declareSlot().spec.inject();
    const edited = structuredClone(original);
    edited.profile.models!.push({ id: 'additional-model', input: ['text', 'image'] });
    await face.updateModels(edited, 7);
    assert.deepEqual(mounted.mutations[0].ops.map(op => op.path), [['providers', original.id, 'models']]);
    assert.deepEqual(Object.keys(mounted.snapshot().value!.providers!), [original.id, sibling.id]);
    assert.equal(mounted.snapshot().value!.providers![original.id].apiKeyEnv, 'EXISTING_REFERENCE');
    assert.deepEqual(mounted.snapshot().value!.providers![sibling.id], sibling.profile);
    assert.equal(mounted.credentials.length, 0);
  } finally { mounted.dispose(); }
});
