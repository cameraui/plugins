import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appleSchema } from './schema.js';

export const FM_BIN = '/usr/bin/fm';

export interface FmImage {
  data: string;
}

export interface FmRequest {
  instructions: string;
  prompt: string;
  schema?: Record<string, unknown>;
  images: FmImage[];
  timeoutMs: number;
  permissive: boolean;
}

export interface FmAvailability {
  available: boolean;
  reason: string;
}

export async function available(): Promise<FmAvailability> {
  const result = await run([FM_BIN, 'available'], undefined, 15_000);
  if (result.code === 0) return { available: true, reason: '' };
  // the cli answers "System model unavailable: <reason>" and exits 69 while the license is open
  const text = `${result.stdout}${result.stderr}`.trim();
  const reason = /unavailable:\s*(\S+)/.exec(text)?.[1];
  if (result.code === 69 && /license/i.test(text)) return { available: false, reason: 'license' };
  return { available: false, reason: reason ?? text.split('\n')[0] ?? 'unknown' };
}

export async function respond(request: FmRequest): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cui-apple-llm-'));
  try {
    const args = [FM_BIN, 'respond', '--no-stream'];
    if (request.instructions) args.push('--instructions', request.instructions);
    if (request.permissive) args.push('--guardrails', 'permissive-content-transformations');

    if (request.schema) {
      const path = join(dir, 'schema.json');
      await writeFile(path, JSON.stringify(appleSchema(request.schema)));
      args.push('--schema', path);
    }

    // --label only counts with a built-in tool, without one the cli refuses the flag
    for (const [index, image] of request.images.entries()) {
      const path = join(dir, `image-${index}.jpg`);
      await writeFile(path, Buffer.from(image.data, 'base64'));
      args.push('--image', path);
    }

    const result = await run(args, request.prompt, request.timeoutMs);
    if (result.code !== 0) throw new Error(cliError(result));
    return result.stdout.trim();
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function cliError(result: { code: number | null; stdout: string; stderr: string }): string {
  const text = `${result.stderr}${result.stdout}`.trim().split('\n')[0] ?? '';
  if (result.code === 69) return 'The Apple Foundation Models license is not agreed yet, run "sudo fm license" on this Mac';
  return text || `fm exited with code ${result.code}`;
}

// the prompt travels over stdin, a conversation can be longer than the argument limit
function run(args: string[], stdin: string | undefined, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const [command, ...rest] = args;
  return new Promise((resolve, reject) => {
    const child = execFile(command, rest, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number' && error.killed) {
        reject(new Error(`The model did not answer within ${Math.round(timeoutMs / 1000)}s`));
        return;
      }
      resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
    });
    child.stdin?.end(stdin ?? '');
  });
}
