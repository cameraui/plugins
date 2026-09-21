import { API_EVENT, ServicePlugin } from '@camera.ui/sdk';

import { generate, status, stop } from './helper.js';
import { ANSWER_SCHEMA, CONTEXT_TOKENS, MODEL_ID, MODEL_NAME, RECHECK_MS, unavailableReason } from './model.js';

import type {
  AssistantModelChunk,
  AssistantModelContext,
  AssistantModelMessage,
  AssistantModelProvider,
  AssistantModelRequest,
  AssistantModelSpec,
  AssistantModelStatus,
  DeviceStorage,
  JsonSchema,
  LoggerService,
  PluginAPI,
} from '@camera.ui/sdk';
import type { HelperStatus } from './helper.js';
import type { PluginStorageValues } from './types.js';

export default class AppleLLM extends ServicePlugin<PluginStorageValues> implements AssistantModelProvider {
  private ready = false;
  private checkedAt = 0;
  private reason = '';
  private contextSize = 0;
  private variant = '';

  constructor(logger: LoggerService, api: PluginAPI, storage: DeviceStorage<PluginStorageValues>) {
    super(logger, api, storage);

    this.api.on(API_EVENT.FINISH_LAUNCHING, this.start.bind(this));
    this.api.on(API_EVENT.SHUTDOWN, stop);
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
        key: 'useTools',
        title: 'Let the model use tools',
        description:
          'The assistant can look at events, cameras and sensors through this model. camera.ui fits the tool list to the small context window. ' +
          'Off makes it a plain chat model.',
        store: true,
        defaultValue: true,
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
        name: this.variant || MODEL_NAME,
        contextTokens: await this.contextTokens(),
        vision: await this.storage.getValue('sendImages', true),
        toolCalling: await this.storage.getValue('useTools', true),
        structuredOutput: true,
        toolRouting: true,
        note: 'Runs on this Mac, nothing leaves it.',
      },
    ];
  }

  public async assistantModelStatus(): Promise<AssistantModelStatus> {
    if (await this.usable()) return { ready: true };
    return { ready: false, message: capitalize(unavailableReason(this.reason)) };
  }

  public async *assistantGenerate(request: AssistantModelRequest, ctx: AssistantModelContext): AsyncGenerator<AssistantModelChunk> {
    if (!(await this.usable())) {
      yield { type: 'done', finish: 'error', message: 'The Apple on-device model is not available on this Mac' };
      return;
    }

    const tools = (await this.storage.getValue('useTools', true)) ? request.tools : [];
    const wrap = request.outputSchema === undefined && tools.length === 0 && (await this.storage.getValue('wrapAnswers', true));
    const chunks = generate(
      {
        system: request.system,
        messages: (await this.storage.getValue('sendImages', true)) ? request.messages : request.messages.map(withoutImages),
        tools,
        outputSchema: request.outputSchema ?? (wrap ? ANSWER_SCHEMA : undefined),
        maxOutputTokens: request.maxOutputTokens,
        permissive: await this.storage.getValue('permissiveGuardrails', true),
      },
      ctx.timeoutMs,
    );

    let wrapped = '';
    for await (const chunk of chunks) {
      if (wrap && chunk.type === 'text') {
        wrapped += chunk.delta;
        continue;
      }
      if (wrap && chunk.type === 'done' && wrapped) yield { type: 'text', delta: unwrap(wrapped) };
      yield chunk;
    }
  }

  private async usable(): Promise<boolean> {
    if (this.ready) return true;
    if (Date.now() - this.checkedAt < RECHECK_MS) return false;

    this.checkedAt = Date.now();
    const result = await status().catch((error: Error): HelperStatus => ({ available: false, reason: error.message }));
    this.ready = result.available;
    this.reason = result.reason;
    this.contextSize = result.contextSize ?? this.contextSize;
    this.variant = result.variant ?? this.variant;
    if (this.ready) this.logger.log('Apple on-device model is ready');
    else this.logger.debug(`The on-device model is not usable: ${unavailableReason(result.reason)}`);
    return this.ready;
  }

  private async contextTokens(): Promise<number> {
    const stored = await this.storage.getValue('contextTokens', CONTEXT_TOKENS);
    return Math.max(typeof stored === 'number' && stored >= 1024 ? stored : CONTEXT_TOKENS, this.contextSize);
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

function withoutImages(message: AssistantModelMessage): AssistantModelMessage {
  return { ...message, content: message.content.filter((part) => part.type !== 'image') };
}

function unwrap(answer: string): string {
  try {
    const parsed = JSON.parse(answer);
    return typeof parsed?.answer === 'string' ? parsed.answer : answer;
  } catch {
    return answer;
  }
}
