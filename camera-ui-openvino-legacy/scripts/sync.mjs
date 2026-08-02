import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const legacyDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baseDir = resolve(legacyDir, '..', 'camera-ui-openvino');

const COPY = ['src', 'cameraui.config.ts', 'ruff.toml', 'mypy.ini', 'LICENSE.md'];

if (!existsSync(baseDir)) {
  console.error(`Base plugin not found at ${baseDir}`);
  process.exit(1);
}

for (const entry of COPY) {
  const source = resolve(baseDir, entry);
  const target = resolve(legacyDir, entry);
  if (!existsSync(source)) {
    console.error(`Missing ${entry} in base plugin`);
    process.exit(1);
  }
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, {
    recursive: true,
    filter: (src) => !/(^|\/)(__pycache__|\.mypy_cache|\.ruff_cache|\.DS_Store)(\/|$)/.test(src),
  });
}

const defaultsPath = resolve(legacyDir, 'src', 'defaults.py');
const defaults = readFileSync(defaultsPath, 'utf8');
if (!defaults.includes('LEGACY_RUNTIME = False')) {
  console.error('Base defaults.py has no LEGACY_RUNTIME flag, update sync.mjs');
  process.exit(1);
}
writeFileSync(defaultsPath, defaults.replace('LEGACY_RUNTIME = False', 'LEGACY_RUNTIME = True'));

const ruff = readFileSync(resolve(legacyDir, 'ruff.toml'), 'utf8');
writeFileSync(resolve(legacyDir, 'ruff.toml'), `respect-gitignore = false\nextend-exclude = ["bundle"]\n${ruff}`);

const contract = readFileSync(resolve(baseDir, 'contract.ts'), 'utf8');
if (!contract.includes("name: 'OpenVino',")) {
  console.error('Base contract.ts no longer matches the expected plugin name, update sync.mjs');
  process.exit(1);
}
writeFileSync(resolve(legacyDir, 'contract.ts'), contract.replace("name: 'OpenVino',", "name: 'OpenVino Legacy',"));

const baseVersion = JSON.parse(readFileSync(resolve(baseDir, 'package.json'), 'utf8')).version;
const legacyVersion = JSON.parse(readFileSync(resolve(legacyDir, 'package.json'), 'utf8')).version;
if (baseVersion !== legacyVersion) {
  console.warn(`Version drift: base is ${baseVersion}, legacy is ${legacyVersion}`);
}

console.log(`Synced ${COPY.length + 1} entries from camera-ui-openvino (${baseVersion})`);
