import { API_EVENT, ServicePlugin } from '@camera.ui/sdk';

import { available, respond } from './cli.js';
import { ANSWER_SCHEMA, CONTEXT_TOKENS, MODEL_ID, MODEL_NAME, RECHECK_MS, unavailableReason } from './model.js';

import type {
  AssistantModelChunk,
  AssistantModelContext,
  AssistantModelProvider,
  AssistantModelRequest,
  AssistantModelSpec,
  AssistantModelStatus,
  DeviceStorage,
  JsonSchema,
  LoggerService,
  PluginAPI,
} from '@camera.ui/sdk';
import type { FmImage } from './cli.js';
import type { PluginStorageValues } from './types.js';

export default class AppleLLM extends ServicePlugin<PluginStorageValues> implements AssistantModelProvider {
  private ready = false;
  private checkedAt = 0;

  constructor(logger: LoggerService, api: PluginAPI, storage: DeviceStorage<PluginStorageValues>) {
    super(logger, api, storage);

    this.api.on(API_EVENT.FINISH_LAUNCHING, this.start.bind(this));
  }

  public get storageSchema(): JsonSchema[] {
    return [
      {
        type: 'boolean',
        key: 'wrapAnswers',
        title: 'Ask for structured answers',
        description:
          'Apple refuses plain answers about people at doors, gates and windows. With this on, every answer is requested as structured output, ' +
          'which the model answers. Off only to see the raw refusals.',
        store: true,
        defaultValue: true,
      },
      {
        type: 'boolean',
        key: 'permissiveGuardrails',
        title: 'Relaxed safety filter',
        description: 'Uses the permissive guardrail level of the model, which refuses fewer everyday camera scenes.',
        store: true,
        defaultValue: true,
      },
      {
        type: 'number',
        key: 'contextTokens',
        title: 'Context window (tokens)',
        description: 'How much the model can hold. Raise it after a system update that brings a larger window, camera.ui plans the conversation with this number.',
        store: true,
        defaultValue: CONTEXT_TOKENS,
        minimum: 1024,
        maximum: 131072,
        step: 1024,
      },
      {
        type: 'boolean',
        key: 'sendImages',
        title: 'Send pictures to the model',
        description: 'The model looks at event pictures instead of reading only the text around them.',
        store: true,
        defaultValue: true,
      },
    ];
  }

  public async assistantModels(): Promise<AssistantModelSpec[]> {
    if (!(await this.usable())) return [];

    return [
      {
        id: MODEL_ID,
        name: MODEL_NAME,
        contextTokens: await this.contextTokens(),
        vision: await this.storage.getValue('sendImages', true),
        toolCalling: false,
        structuredOutput: true,
        note: 'Runs on this Mac, nothing leaves it.',
      },
    ];
  }

  public async assistantModelStatus(): Promise<AssistantModelStatus> {
    if (await this.usable()) return { ready: true };

    const result = await available().catch(() => ({ available: false, reason: 'unknown' }));
    return { ready: false, message: capitalize(unavailableReason(result.reason)) };
  }

  public async *assistantGenerate(request: AssistantModelRequest, ctx: AssistantModelContext): AsyncGenerator<AssistantModelChunk> {
    if (!(await this.usable())) {
      yield { type: 'done', finish: 'error', message: 'The Apple on-device model is not available on this Mac' };
      return;
    }

    const wrap = request.outputSchema === undefined && (await this.storage.getValue('wrapAnswers', true));
    const schema = request.outputSchema ?? (wrap ? ANSWER_SCHEMA : undefined);

    try {
      const answer = await respond({
        instructions: request.system.join('\n\n'),
        prompt: conversation(request),
        ...(schema ? { schema: schema } : {}),
        images: await this.images(request),
        timeoutMs: ctx.timeoutMs,
        permissive: await this.storage.getValue('permissiveGuardrails', true),
      });
      const text = wrap ? unwrap(answer) : answer;
      if (text) yield { type: 'text', delta: text };
      yield { type: 'done', finish: 'stop' };
    } catch (error: any) {
      yield { type: 'done', finish: 'error', message: error?.message ?? String(error) };
    }
  }

  private async images(request: AssistantModelRequest): Promise<FmImage[]> {
    if (!(await this.storage.getValue('sendImages', true))) return [];

    const images: FmImage[] = [];
    for (const message of request.messages) {
      for (const part of message.content) {
        if (part.type === 'image') images.push({ data: part.data });
      }
    }
    return images;
  }

  private async usable(): Promise<boolean> {
    if (this.ready) return true;
    if (Date.now() - this.checkedAt < RECHECK_MS) return false;

    this.checkedAt = Date.now();
    const result = await available().catch(() => ({ available: false, reason: 'unknown' }));
    this.ready = result.available;
    if (this.ready) this.logger.log('Apple on-device model is ready');
    else this.logger.debug(`The on-device model is not usable: ${unavailableReason(result.reason)}`);
    return this.ready;
  }

  private async contextTokens(): Promise<number> {
    const stored = await this.storage.getValue('contextTokens', CONTEXT_TOKENS);
    return typeof stored === 'number' && stored >= 1024 ? stored : CONTEXT_TOKENS;
  }

  private async start(): Promise<void> {
    if (process.platform !== 'darwin') {
      this.logger.warn('The Apple on-device model needs macOS on Apple Silicon, the plugin stays idle');
      return;
    }

    if (await this.usable()) {
      this.logger.log(`Apple on-device model ready (${await this.contextTokens()} tokens of context)`);
      return;
    }
    this.logger.warn('The on-device model is not usable yet, camera.ui offers it as soon as macOS reports it ready');
  }
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function conversation(request: AssistantModelRequest): string {
  const lines: string[] = [];
  for (const message of request.messages) {
    const text = message.content.flatMap((part) => (part.type === 'text' ? [part.text] : []));
    const calls = (message.toolCalls ?? []).map((call) => `called ${call.name}(${JSON.stringify(call.arguments)})`);
    const body = [...text, ...calls].join('\n');
    if (!body) continue;
    lines.push(message.role === 'assistant' ? `Assistant: ${body}` : message.role === 'tool' ? `Tool result: ${body}` : `User: ${body}`);
  }
  return lines.join('\n\n');
}

function unwrap(answer: string): string {
  try {
    const parsed = JSON.parse(answer);
    return typeof parsed?.answer === 'string' ? parsed.answer : answer;
  } catch {
    return answer;
  }
}
