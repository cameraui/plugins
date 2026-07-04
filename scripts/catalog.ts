import chalk from 'chalk';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

const RAW_BASE = 'https://raw.githubusercontent.com/cameraui/plugins/main';

type Category = 'detection' | 'camera-source' | 'notification' | 'recording' | 'automation' | 'ai-model' | 'utility' | 'other';

interface CatalogEntry {
  displayName?: string;
  category: Category;
  featured: boolean;
  tagline: string;
  logo?: string;
  screenshots: string[];
}

const CATEGORY_OVERRIDES: Record<string, Category> = {
  'camera-ui-audio-yamnet': 'detection',
  'camera-ui-coral': 'ai-model',
  'camera-ui-coreml': 'ai-model',
  'camera-ui-eufy': 'camera-source',
  'camera-ui-homekit': 'automation',
  'camera-ui-ncnn': 'ai-model',
  'camera-ui-onnx': 'ai-model',
  'camera-ui-onvif': 'camera-source',
  'camera-ui-opencl': 'ai-model',
  'camera-ui-opencv': 'ai-model',
  'camera-ui-openvino': 'ai-model',
  'camera-ui-pamdiff': 'detection',
  'camera-ui-ring': 'camera-source',
  'camera-ui-rust-motion': 'detection',
  'camera-ui-smtp': 'detection',
  'camera-ui-tuya': 'camera-source',
  'camera-ui-wasm-motion': 'detection',
  'camera-ui-wyze': 'camera-source',
};

const FEATURED = new Set<string>(['camera-ui-homekit', 'camera-ui-rust-motion', 'camera-ui-coreml', 'camera-ui-openvino', 'camera-ui-onnx']);

// Official plugins published to npm but sourced from a separate repo, so unavailable
// when this script runs. Their metadata is maintained here by hand.
const EXTERNAL_PLUGINS: Record<string, CatalogEntry> = {
  '@camera.ui/camera-ui-nvr': {
    displayName: 'NVR',
    category: 'recording',
    featured: true,
    tagline: 'Manage and store video recordings from your cameras.',
    logo: `${RAW_BASE}/external-logos/camera-ui-nvr.png`,
    screenshots: [],
  },
};

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif']);

function discoverPlugins(): string[] {
  return readdirSync(ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('camera-ui-'))
    .map((entry) => entry.name)
    .filter((name) => existsSync(resolve(ROOT, name, 'package.json')))
    .sort();
}

function firstSentence(description: string): string {
  const text = (description || '').trim();
  const match = text.match(/^(.*?[.!?])(?=\s|$)/);
  return (match ? match[1] : text).trim();
}

function deriveCategory(dir: string): Category {
  const contractPath = resolve(dir, 'contract.ts');
  if (!existsSync(contractPath)) return 'other';

  const src = readFileSync(contractPath, 'utf-8');
  const role = src.match(/role:\s*PluginRole\.(\w+)/)?.[1] ?? '';
  const interfaces = [...src.matchAll(/PluginInterface\.(\w+)/g)].map((m) => m[1]);

  if (role === 'CameraController' || role === 'CameraAndSensorProvider') return 'camera-source';
  if (interfaces.some((name) => name.endsWith('Detection'))) return 'detection';
  if (role === 'SensorProvider') return 'utility';
  return 'other';
}

function collectScreenshots(folder: string, dir: string): string[] {
  const screenshotsDir = resolve(dir, 'screenshots');
  if (!existsSync(screenshotsDir)) return [];

  return readdirSync(screenshotsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase()))
    .map((entry) => entry.name)
    .sort()
    .map((file) => `${RAW_BASE}/${folder}/screenshots/${file}`);
}

function buildEntry(folder: string): { name: string; entry: CatalogEntry } {
  const dir = resolve(ROOT, folder);
  const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf-8'));
  const name: string = pkg.name;

  const entry: CatalogEntry = {
    ...(pkg.displayName ? { displayName: pkg.displayName as string } : {}),
    category: CATEGORY_OVERRIDES[folder] ?? deriveCategory(dir),
    featured: FEATURED.has(folder),
    tagline: firstSentence(pkg.description),
    ...(existsSync(resolve(dir, 'logo.png')) ? { logo: `${RAW_BASE}/${folder}/logo.png` } : {}),
    screenshots: collectScreenshots(folder, dir),
  };

  return { name, entry };
}

function main(): void {
  const folders = discoverPlugins();
  if (!folders.length) {
    console.error('\r\n', chalk.bgRed.bold(' ERROR '), chalk.red('No camera-ui-* plugins found.'));
    process.exit(1);
  }

  const catalog: Record<string, CatalogEntry> = {};
  for (const folder of folders) {
    const { name, entry } = buildEntry(folder);
    catalog[name] = entry;
  }

  for (const [name, entry] of Object.entries(EXTERNAL_PLUGINS)) {
    catalog[name] = entry;
  }

  const sorted: Record<string, CatalogEntry> = {};
  for (const name of Object.keys(catalog).sort()) {
    sorted[name] = catalog[name];
  }

  const outPath = resolve(ROOT, 'catalog.json');
  writeFileSync(outPath, JSON.stringify(sorted, null, 2) + '\n');

  console.log(chalk.cyan(`\r\nWrote ${chalk.bold(String(Object.keys(sorted).length))} plugins to catalog.json\r\n`));
  for (const name of Object.keys(sorted)) {
    const { category, featured } = sorted[name];
    console.log(`  ${featured ? chalk.yellow('★') : ' '} ${chalk.bold(name)} ${chalk.gray('->')} ${category}`);
  }
  console.log('\r\n', chalk.bgGreen(' SUCCESS '), chalk.green(`catalog.json written to ${outPath}`));
}

main();
