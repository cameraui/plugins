import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sources = readdirSync(join(root, 'helper'))
  .filter((file) => file.endsWith('.swift'))
  .map((file) => join(root, 'helper', file));
const output = join(root, 'helper', 'bin', 'apple-llm-helper');

if (process.platform !== 'darwin') {
  console.log('Skipping the Swift helper, it only builds on macOS');
  process.exit(0);
}

mkdirSync(dirname(output), { recursive: true });
execFileSync('xcrun', ['swiftc', '-O', '-target', 'arm64-apple-macos26.0', '-o', output, ...sources], { stdio: 'inherit' });
console.log(`Built ${output}`);
