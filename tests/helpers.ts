import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { Context } from '@deepseek-ai/cordis';
import { AttachmentId, AttachmentStore, ImageVariantId } from '@deepseek-ai/dsh-attachment';
import type { ImageAttachmentLimits, ImageAttachmentRef, ImageRequestPolicy, RequestImageAttachment, SaveImageAttachment, StoredImageAttachment } from '@deepseek-ai/dsh-attachment';
import LlmRuntime, { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai';
import type { PiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai';
import { createDmxapiDraft } from '../src/config.ts';

// A test-only credential reference; production environment names are never read.
export const TEST_KEY_ENV = 'DSH_DMXAPI_TEST_ONLY_KEY';
export const TEST_KEY = 'not-a-real-api-key';
export const MODEL = 'deepseek-v4.1-flash';

export interface WireRequest {
  model: string;
  messages: Array<{ role: string; content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> }>;
  thinking?: { type: string };
  reasoning_effort?: string;
  enable_thinking?: boolean;
  thinking_budget?: number;
  thinking_token_budget?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stream?: boolean;
}

/** Loopback-only OpenAI SSE endpoint. No real provider or credential store is used. */
export async function mockOpenAI() {
  const requests: WireRequest[] = [];
  const headers: IncomingMessage['headers'][] = [];
  const paths: string[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => { body += chunk; });
    request.on('end', () => {
      try {
        requests.push(JSON.parse(body) as WireRequest);
        paths.push(request.url ?? '');
        headers.push(request.headers);
      } catch {
        response.writeHead(400);
        response.end('invalid JSON');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const events = [
        { choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { content: 'mock ' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { content: 'answer' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 } },
      ];
      for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Mock server has no TCP address');
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`, requests, headers, paths,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

/** Run the plugin's actual preset through the installed Host schema. */
export function testProfile(baseURL: string): PiAiProviderProfile {
  const draft = createDmxapiDraft();
  const config = LlmPiAi.Config({ providers: {
    [draft.id]: { ...draft.profile, apiKeyEnv: TEST_KEY_ENV, baseURL } as PiAiProviderProfile,
  } });
  return config.providers![draft.id];
}

export async function bootRuntime(profile: PiAiProviderProfile) {
  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(LlmPiAi, { providers: { dmxapi: profile } });
  return ctx;
}

export function textPrompt() {
  return [createUserMessage({ content: [{ type: 'text', text: '请返回测试结果' }], source: { kind: 'plugin', plugin: 'dsh-dmxapi-test' } })];
}

export async function assemble(ctx: Context, options: Omit<GenerateOptions, 'provider' | 'model' | 'messages'> & Partial<Pick<GenerateOptions, 'provider' | 'model' | 'messages'>> = {}) {
  const request: GenerateOptions = { provider: 'dmxapi', model: MODEL, messages: textPrompt(), ...options };
  const assembler = new BlockAssembler();
  for await (const chunk of ctx.llm.stream(request)) assembler.push(chunk);
  return {
    message: assembler.message({ kind: 'model', provider: request.provider, model: request.model }),
    finish: assembler.finish,
    usage: assembler.usage,
  };
}

// A valid 1x1 PNG. The adapter receives durable attachment references, exactly as
// it does after Web uploads. Admission/encoding is outside this protocol test.
export const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDZ0AAAAASUVORK5CYII=';
const png = Buffer.from(PNG_BASE64, 'base64');
export const IMAGE_REF: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${createHash('sha256').update(png).digest('hex')}`),
  mediaType: 'image/png', bytes: png.length, width: 1, height: 1,
};

export class FixtureAttachments extends AttachmentStore {
  readonly imageLimits: ImageAttachmentLimits = {
    maxImageBytes: 1024, maxImagesPerMessage: 4, maxMessageImageBytes: 4096,
    maxImagePixels: 100, maxImageDimension: 100, mediaTypes: ['image/png'],
  };
  requests = 0;
  async validateImage(_input: SaveImageAttachment): Promise<void> { throw new Error('Fixture does not admit uploads'); }
  async saveImage(_input: SaveImageAttachment): Promise<ImageAttachmentRef> { throw new Error('Fixture is read-only'); }
  async readImage(ref: ImageAttachmentRef): Promise<StoredImageAttachment> { return { ref, data: png }; }
  override async readImageRequest(ref: ImageAttachmentRef, _policy: ImageRequestPolicy): Promise<RequestImageAttachment> {
    if (ref.attachmentId !== IMAGE_REF.attachmentId) throw new Error('Unexpected attachment');
    this.requests++;
    return { variantId: ImageVariantId(`sha256:${'b'.repeat(64)}`), attachment: ref, data: png, mediaType: 'image/png', bytes: png.length, width: 1, height: 1, depth: 'uchar', space: 'srgb', hasAlpha: true };
  }
}
