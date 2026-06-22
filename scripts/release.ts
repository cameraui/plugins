import chalk from 'chalk';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Bump a single plugin's version, commit it, tag it `<plugin>-v<version>` and
// push. The matching `release.yml` workflow then builds, bundles and publishes
// that plugin to npm with provenance.
//
//   tsx scripts/release.ts camera-ui-homekit patch
//   tsx scripts/release.ts camera-ui-eufy 1.2.0
//   tsx scripts/release.ts camera-ui-coreml 0.1.0-beta.1 --yes

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

const SEMVER = /^\d+\.\d+\.\d+(?:-(?:alpha|beta)\.\d+)?$/;

function fail(message: string): never {
  console.error('\r\n', chalk.bgRed.bold(' ERROR '), chalk.red(message));
  process.exit(1);
}

function usage(): never {
  console.log(
    [
      '',
      chalk.bold('Usage:') +
        ' tsx scripts/release.ts <plugin> <version|major|minor|patch> [--yes] [--skip-checks]',
      '',
      'Examples:',
      '  tsx scripts/release.ts camera-ui-homekit patch',
      '  tsx scripts/release.ts camera-ui-eufy 1.2.0',
      '  tsx scripts/release.ts camera-ui-coreml 0.1.0-beta.1 --yes',
      '',
      'Options:',
      '  --yes, -y       Push without the confirmation prompt.',
      '  --skip-checks   Skip the local lint + build pre-flight (the workflow still runs it).',
      '',
    ].join('\r\n'),
  );
  process.exit(1);
}

function git(cmd: string, opts: { capture?: boolean } = {}): string {
  return execSync(`git ${cmd}`, {
    cwd: ROOT,
    encoding: 'utf-8',
    stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })
    ?.toString()
    .trim();
}

function bump(current: string, spec: 'major' | 'minor' | 'patch'): string {
  const [major, minor, patch] = current.split('-')[0].split('.').map(Number);
  if ([major, minor, patch].some(Number.isNaN))
    fail(`Cannot bump non-numeric version '${current}'.`);
  if (spec === 'major') return `${major + 1}.0.0`;
  if (spec === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const plugin = args[0];
  const spec = args[1];
  const yes = args.includes('--yes') || args.includes('-y');
  const skipChecks = args.includes('--skip-checks');

  if (!plugin || !spec) usage();

  const pluginDir = resolve(ROOT, plugin);
  const pkgPath = resolve(pluginDir, 'package.json');
  if (!plugin.startsWith('camera-ui-') || !existsSync(pkgPath)) {
    fail(`Unknown plugin '${plugin}' (no ${plugin}/package.json found).`);
  }

  // Safety: clean tree, on main, not behind origin.
  if (git('status --porcelain', { capture: true })) {
    fail('Working tree not clean - commit or stash first.');
  }
  const branch = git('rev-parse --abbrev-ref HEAD', { capture: true });
  if (branch !== 'main') fail(`Not on main (on '${branch}').`);
  try {
    git('fetch -q origin main', { capture: true });
    if (git('rev-list HEAD..origin/main', { capture: true })) {
      fail('Local main is behind origin/main - pull first.');
    }
  } catch {
    // offline / no remote tracking - skip the behind check
  }

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  const current: string = pkg.version;

  const next =
    spec === 'major' || spec === 'minor' || spec === 'patch'
      ? bump(current, spec)
      : spec;
  if (!SEMVER.test(next))
    fail(
      `Invalid version '${next}' (expected X.Y.Z or X.Y.Z-alpha.N / -beta.N).`,
    );

  const tag = `${plugin}-v${next}`;
  try {
    git(`rev-parse ${tag}`, { capture: true });
    fail(`Tag ${tag} already exists.`);
  } catch {
    // tag does not exist - good
  }

  console.log(
    chalk.cyan(
      `\r\nReleasing ${chalk.bold(plugin)}: ${current} -> ${chalk.bold(next)} (tag ${tag})\r\n`,
    ),
  );

  if (!skipChecks) {
    console.log(chalk.yellow(`Running lint + build for ${plugin}...`));
    execSync(`npm --prefix "${pluginDir}" run lint`, {
      cwd: ROOT,
      stdio: 'inherit',
    });
    execSync(`npm --prefix "${pluginDir}" run build`, {
      cwd: ROOT,
      stdio: 'inherit',
    });
  }

  // Bump the version (no tag yet - we create an annotated tag ourselves below).
  execSync(`npm --prefix "${pluginDir}" version ${next} --no-git-tag-version`, {
    cwd: ROOT,
    stdio: 'inherit',
  });

  git(`add "${plugin}/package.json" "${plugin}/package-lock.json"`);
  git(`commit -q -m "release(${plugin}): v${next}"`);
  console.log(chalk.green('Committed version bump.'));

  git(`tag ${tag}`);
  console.log(chalk.green(`Created tag ${tag}.`));

  if (!yes) {
    const ok = await confirm(
      `Push main + ${tag} and trigger the release? [y/N] `,
    );
    if (!ok) {
      git(`tag -d ${tag}`, { capture: true });
      git('reset -q --hard HEAD~1', { capture: true });
      console.log(
        chalk.yellow('Aborted - tag and bump commit were undone locally.'),
      );
      process.exit(0);
    }
  }

  git('push -q origin main');
  git(`push -q origin ${tag}`);
  console.log(
    '\r\n',
    chalk.bgGreen(' SUCCESS '),
    chalk.green(
      'Pushed. Watch the release workflow under the repo Actions tab.',
    ),
  );
}

main().catch((error) =>
  fail(error instanceof Error ? error.message : String(error)),
);
