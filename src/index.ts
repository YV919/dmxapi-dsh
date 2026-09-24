/** Host anchor for the Web extension and the narrow DeepSeek Anthropic wire bridge. */
import type { Context } from '@deepseek-ai/cordis';
import { installAnthropicEffortBridge } from './anthropic-effort.ts';
import { installPresetModelDefaults } from './model-defaults.ts';

export const name = 'dmxapi-settings'
export const inject = ['llm', 'settings']
export function apply(ctx: Context): void {
  ctx.effect(() => installAnthropicEffortBridge(ctx), 'dmxapi-settings: DeepSeek Anthropic effort');
  ctx.effect(() => installPresetModelDefaults(ctx), 'dmxapi-settings: preset model defaults');
}
