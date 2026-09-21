import { spawn } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

import type { AssistantModelChunk, AssistantModelRequest } from '@camera.ui/sdk';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

const HELPER = resolve(__dirname, 'apple-llm-helper');
const STATUS_TIMEOUT_MS = 15_000;

export interface HelperStatus {
  available: boolean;
  reason: string;
  contextSize?: number;
  variant?: string;
}

export interface HelperRequest extends Pick<AssistantModelRequest, 'system' | 'messages' | 'tools' | 'outputSchema' | 'maxOutputTokens'> {
  permissive: boolean;
}

type Line = AssistantModelChunk & { id?: string };

interface Sink {
  lines: Line[];
  wake?: () => void;
}

let child: ChildProcessWithoutNullStreams | undefined;
let stderr = '';
let counter = 0;
const sinks = new Map<string, Sink>();

export async function status(): Promise<HelperStatus> {
  for await (const line of run({ mode: 'status' }, STATUS_TIMEOUT_MS, true)) return line as unknown as HelperStatus;
  return { available: false, reason: 'unknown' };
}

// eslint-disable-next-line @stylistic/generator-star-spacing
export async function* generate(request: HelperRequest, timeoutMs: number): AsyncGenerator<AssistantModelChunk> {
  yield* run({ mode: 'generate', ...request }, timeoutMs, false);
}

export function stop(): void {
  child?.kill('SIGTERM');
}

function helper(): ChildProcessWithoutNullStreams {
  if (child) return child;

  chmodSync(HELPER, 0o755);
  const started = spawn(HELPER, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  child = started;
  stderr = '';
  started.stderr.on('data', (data: Buffer) => (stderr = `${stderr}${data.toString()}`.slice(-2000)));
  started.stdin.on('error', () => {});
  createInterface({ input: started.stdout }).on('line', (text) => {
    if (!text.trim()) return;
    const line = JSON.parse(text) as Line;
    const sink = line.id ? sinks.get(line.id) : undefined;
    sink?.lines.push(line);
    sink?.wake?.();
  });
  started.on('close', () => {
    if (child === started) child = undefined;
    const message =
      stderr
        .split('\n')
        .filter((line) => line.trim())
        .pop() ?? 'The helper stopped';
    for (const sink of sinks.values()) {
      sink.lines.push({ type: 'done', finish: 'error', message });
      sink.wake?.();
    }
  });
  return started;
}

// eslint-disable-next-line @stylistic/generator-star-spacing
async function* run(body: Record<string, unknown>, timeoutMs: number, single: boolean): AsyncGenerator<AssistantModelChunk> {
  const id = `r${++counter}`;
  const sink: Sink = { lines: [] };
  sinks.set(id, sink);
  let finished = false;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    sink.wake?.();
  }, timeoutMs);

  try {
    helper().stdin.write(`${JSON.stringify({ id, ...body })}\n`);
    while (!finished) {
      if (!sink.lines.length && !timedOut) await new Promise<void>((wake) => (sink.wake = wake));
      if (timedOut && !sink.lines.length) {
        yield { type: 'done', finish: 'error', message: `The model did not answer within ${Math.round(timeoutMs / 1000)}s` };
        return;
      }
      for (const { id: _id, ...chunk } of sink.lines.splice(0)) {
        finished = single || chunk.type === 'done';
        yield chunk;
        if (finished) break;
      }
    }
  } finally {
    // a cancelled or timed out run must not keep the model busy for nobody
    clearTimeout(timer);
    sinks.delete(id);
    if (!finished) child?.stdin.write(`${JSON.stringify({ id, mode: 'cancel' })}\n`);
  }
}
