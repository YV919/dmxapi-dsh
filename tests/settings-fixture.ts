import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot';
import ConfigEditor from '@deepseek-ai/dsh-config-editor';
import Settings from '@deepseek-ai/dsh-settings';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai';
import type { ProviderProfile } from '../src/config.ts';

/** Real 0.2 profile patches, Loader reconciliation and schema-derived settings.
 * Based on the official settings/tests/configuration-fixture.ts at dsh-v0.2.0-rc.2.
 * This fixture owns an isolated installation tree; it never opens the user's DSH_HOME.
 */
export async function settingsFixture(t: TestContext, providers: Record<string, ProviderProfile> = {}) {
  const tempRoot = await realpath(tmpdir());
  const directory = await realpath(await mkdtemp(join(tempRoot, 'dsh-dmxapi-settings-')));
  const dir = join(directory, 'profiles', 'test');
  const contexts: Context[] = [];
  t.after(async () => {
    for (const ctx of contexts.reverse()) await ctx.fiber.dispose();
    const target = resolve(directory);
    assert.ok(target.startsWith(resolve(tempRoot) + sep), 'remove only this allocated temporary fixture');
    await rm(target, { recursive: true, force: true });
  });
  initProfile(dir, ['dmxapi-test-bundle']);
  const bundle = join(dir, 'node_modules', 'dmxapi-test-bundle');
  await mkdir(bundle, { recursive: true });
  await writeFile(join(directory, 'package.json'), '{"name":"dmxapi-test-installation"}\n');
  await writeFile(join(bundle, 'package.json'), JSON.stringify({
    name: 'dmxapi-test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } },
  }));
  await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: 'llm', name: 'cordis:llm' },
    { id: 'llm-pi-ai', name: 'cordis:pi-ai', config: { providers } },
  ] }]));
  await writeFile(join(dir, 'cordis.yml'), '[]\n');
  const profile: ProfileContext = {
    name: 'test', startedBundles: ['dmxapi-test-bundle'], dir,
    patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(directory, 'package.json'),
    cwd: directory, home: directory, overlays: [], telemetryDisabledEnv: undefined,
  };
  const start = async () => {
    const ctx = await boot('dsh', join(dir, 'cordis.yml'), readProfilePatches('dsh', profile), ctx => {
      ctx.provide('profileContext', profile);
      ctx.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {}; } });
      Object.assign(ctx.loader.builtins, { editor: ConfigEditor, settings: Settings, llm: LlmRuntime, 'pi-ai': LlmPiAi });
    });
    contexts.push(ctx);
    return ctx;
  };
  return { ctx: await start(), settingsPath: profile.patchPath, directory, start };
}
