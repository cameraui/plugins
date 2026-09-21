import chalk from 'chalk';
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

// Bump a plugin's version, commit it, tag it `<plugin>-v<version>` and push.
// The matching `release.yml` workflow then builds, bundles and publishes that
// plugin to npm with provenance.
//
//   tsx scripts/release.ts camera-ui-homekit patch
//   tsx scripts/release.ts camera-ui-eufy 1.2.0
//   tsx scripts/release.ts camera-ui-coreml 0.1.0-beta.1 --yes
//
// Several plugins can be released in one go by listing them before the spec;
// ALL releases every camera-ui-* plugin in this monorepo. With more than one
// plugin (or ALL) only the bump specs are allowed, since an
// explicit version rarely fits plugins with divergent version histories:
//
//   tsx scripts/release.ts camera-ui-homekit camera-ui-eufy patch
//   tsx scripts/release.ts ALL patch
//   tsx scripts/release.ts ALL minor --yes --skip-checks
//
// beta moves a plugin one beta further: a stable version gets the next patch as
// beta.0, a running beta counts up, an alpha switches to beta.0 of its version:
//
//   tsx scripts/release.ts camera-ui-reolink beta     1.2.24-beta.0 -> 1.2.24-beta.1
//   tsx scripts/release.ts ALL beta                   1.2.4 -> 1.2.5-beta.0
//
// minor-beta and major-beta start the beta of the next minor or major instead; a
// beta already heading there counts up like beta does:
//
//   tsx scripts/release.ts camera-ui-eufy minor-beta  2.0.2-beta.0 -> 2.1.0-beta.0
//   tsx scripts/release.ts camera-ui-eufy minor-beta  2.1.0-beta.0 -> 2.1.0-beta.1

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

const SEMVER = /^\d+\.\d+\.\d+(?:-(?:alpha|beta)\.\d+)?$/;

const BUMP_SPECS = ['major', 'minor', 'patch', 'beta', 'minor-beta', 'major-beta'] as const;

type BumpSpec = (typeof BUMP_SPECS)[number];

interface PluginPlan {
  name: string;
  dir: string;
  pkgPath: string;
  current: string;
  next: string;
  tag: string;
  addPaths: string[];
}

function fail(message: string): never {
  console.error('\r\n', chalk.bgRed.bold(' ERROR '), chalk.red(message));
  process.exit(1);
}

function usage(): never {
  console.log(
    [
      '',
      chalk.bold('Usage:') + ` tsx scripts/release.ts <plugin...|ALL> <version|${BUMP_SPECS.join('|')}> [--yes] [--skip-checks]`,
      '',
      'Examples:',
      '  tsx scripts/release.ts camera-ui-homekit patch',
      '  tsx scripts/release.ts camera-ui-eufy 1.2.0',
      '  tsx scripts/release.ts camera-ui-coreml 0.1.0-beta.1 --yes',
      '  tsx scripts/release.ts camera-ui-homekit camera-ui-eufy camera-ui-ring patch',
      '  tsx scripts/release.ts ALL patch',
      '  tsx scripts/release.ts ALL minor --yes',
      '  tsx scripts/release.ts camera-ui-reolink beta',
      '  tsx scripts/release.ts ALL beta',
      '  tsx scripts/release.ts camera-ui-eufy minor-beta',
      '',
      'Options:',
      '  --yes, -y       Push without the confirmation prompt.',
      '  --skip-checks   Skip the local lint + build pre-flight (the workflow still runs it).',
      '',
      'Notes:',
      '  ALL releases every camera-ui-* plugin.',
      `  More than one plugin (or ALL) only accepts ${BUMP_SPECS.join('/')}.`,
      '  beta: stable X.Y.Z becomes X.Y.(Z+1)-beta.0, X.Y.Z-beta.N becomes X.Y.Z-beta.(N+1).',
      '  minor-beta / major-beta: beta.0 of the next minor / major, or the next beta if one already heads there.',
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

function isBumpSpec(spec: string): spec is BumpSpec {
  return (BUMP_SPECS as readonly string[]).includes(spec);
}

function bump(current: string, spec: BumpSpec): string {
  const [base, prerelease] = current.split('-');
  const [major, minor, patch] = base.split('.').map(Number);
  if ([major, minor, patch].some(Number.isNaN)) fail(`Cannot bump non-numeric version '${current}'.`);

  if (spec === 'beta' || spec === 'minor-beta' || spec === 'major-beta') {
    const [label, count] = prerelease?.split('.') ?? [];
    const target = spec === 'major-beta' ? `${major + 1}.0.0` : spec === 'minor-beta' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
    // a prerelease already heading to that level keeps its version and counts up
    const heading = prerelease !== undefined && (spec === 'beta' || (spec === 'minor-beta' && patch === 0) || (spec === 'major-beta' && minor === 0 && patch === 0));
    if (!heading) return `${target}-beta.0`;
    return label === 'beta' ? `${base}-beta.${Number(count) + 1}` : `${base}-beta.0`;
  }

  // a prerelease of the bumped version is released as that version, like npm version does
  if (prerelease) {
    if (spec === 'patch') return base;
    if (spec === 'minor' && patch === 0) return base;
    if (spec === 'major' && minor === 0 && patch === 0) return base;
  }

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

function discoverPlugins(): string[] {
  return readdirSync(ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('camera-ui-'))
    .map((entry) => entry.name)
    .filter((name) => existsSync(resolve(ROOT, name, 'package.json')))
    .sort();
}

function planPlugin(name: string, spec: string): PluginPlan {
  const dir = resolve(ROOT, name);
  const pkgPath = resolve(dir, 'package.json');
  if (!name.startsWith('camera-ui-') || !existsSync(pkgPath)) {
    fail(`Unknown plugin '${name}' (no ${name}/package.json found).`);
  }

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  const current: string = pkg.version;
  const next = isBumpSpec(spec) ? bump(current, spec) : spec;
  if (!SEMVER.test(next)) fail(`Invalid version '${next}' (expected X.Y.Z or X.Y.Z-alpha.N / -beta.N).`);

  const tag = `${name}-v${next}`;
  try {
    git(`rev-parse ${tag}`, { capture: true });
    fail(`Tag ${tag} already exists.`);
  } catch {
    // tag does not exist - good
  }

  const addPaths = [`${name}/package.json`];
  if (existsSync(resolve(dir, 'package-lock.json'))) addPaths.push(`${name}/package-lock.json`);

  return { name, dir, pkgPath, current, next, tag, addPaths };
}

function runChecks(plan: PluginPlan): void {
  console.log(chalk.yellow(`Running lint + build for ${plan.name}...`));
  execSync(`npm --prefix "${plan.dir}" run lint`, { cwd: ROOT, stdio: 'inherit' });
  execSync(`npm --prefix "${plan.dir}" run build`, { cwd: ROOT, stdio: 'inherit' });
}

function commitAndTag(plan: PluginPlan): void {
  execSync(`npm --prefix "${plan.dir}" version ${plan.next} --no-git-tag-version`, { cwd: ROOT, stdio: 'inherit' });
  git(`add ${plan.addPaths.map((p) => `"${p}"`).join(' ')}`);
  git(`commit -q -m "release(${plan.name}): v${plan.next}"`);
  git(`tag ${plan.tag}`);
  console.log(chalk.green(`  ${plan.name}: ${plan.current} -> ${plan.next} (tag ${plan.tag})`));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const yes = args.includes('--yes') || args.includes('-y');
  const skipChecks = args.includes('--skip-checks');
  const positionals = args.filter((arg) => !arg.startsWith('-'));

  if (positionals.length < 2) usage();

  const spec = positionals[positionals.length - 1];
  const targets = [...new Set(positionals.slice(0, -1))];

  const all = targets.includes('ALL');
  if (all && targets.length > 1) {
    fail('ALL cannot be combined with plugin names.');
  }
  if ((all || targets.length > 1) && !isBumpSpec(spec)) {
    fail(`Multiple plugins (or ALL) only accept ${BUMP_SPECS.join('/')} (got '${spec}').`);
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

  // Build the release plan (validates everything before any mutation).
  const names = all ? discoverPlugins() : targets;
  if (!names.length) fail('No camera-ui-* plugins found.');
  const plans = names.map((name) => planPlugin(name, spec));

  console.log(chalk.cyan(`\r\nReleasing ${chalk.bold(String(plans.length))} plugin(s):\r\n`));
  for (const plan of plans) {
    console.log(`  ${chalk.bold(plan.name)}: ${plan.current} -> ${chalk.bold(plan.next)} (tag ${plan.tag})`);
  }
  console.log('');

  if (!yes) {
    const ok = await confirm(`Build, commit, tag and push the above? [y/N] `);
    if (!ok) {
      console.log(chalk.yellow('Aborted - nothing changed.'));
      process.exit(0);
    }
  }

  // Pre-flight checks first so a build failure leaves the tree untouched.
  if (!skipChecks) {
    for (const plan of plans) runChecks(plan);
  }

  // From here we mutate the repo. Roll the whole batch back on any failure.
  const startHead = git('rev-parse HEAD', { capture: true });
  const createdTags: string[] = [];
  try {
    for (const plan of plans) {
      commitAndTag(plan);
      createdTags.push(plan.tag);
    }
  } catch (error) {
    console.error(chalk.red('\r\nFailed mid-release - rolling back local commits and tags...'));
    for (const tag of createdTags) git(`tag -d ${tag}`, { capture: true });
    git(`reset -q --hard ${startHead}`, { capture: true });
    fail(error instanceof Error ? error.message : String(error));
  }

  git('push -q origin main');
  for (const plan of plans) git(`push -q origin ${plan.tag}`);
  console.log('\r\n', chalk.bgGreen(' SUCCESS '), chalk.green(`Pushed ${plans.length} release(s). Watch the release workflow under the repo Actions tab.`));
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
