import chalk from "chalk";
import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ROOT = resolve(__dirname, "..");
const IS_WINDOWS = platform() === "win32";

const SKIP_PYTHON = process.argv.includes("--skip-python");

let stepNo = 0;
const step = (title: string) =>
  console.log(chalk.bold.cyan(`\n[${++stepNo}] ${title}`));
const info = (msg: string) => console.log(chalk.gray(`    ${msg}`));
const ok = (msg: string) => console.log(chalk.green(`    ✓ ${msg}`));
const warn = (msg: string) => console.log(chalk.yellow(`    ! ${msg}`));

function run(cmd: string, cwd: string = ROOT): void {
  info(`$ ${cmd}  (${cwd === ROOT ? "." : cwd.replace(`${ROOT}/`, "")})`);
  execSync(cmd, { stdio: "inherit", cwd });
}

function venvPython(): string {
  return IS_WINDOWS
    ? join(ROOT, ".venv", "Scripts", "python.exe")
    : join(ROOT, ".venv", "bin", "python");
}

function pluginRequirements(): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
    if (!entry.name.startsWith("camera-ui-")) continue;
    const req = join(ROOT, entry.name, "requirements.txt");
    if (existsSync(req)) found.push(req);
  }
  return found;
}

function setupPython(): void {
  step("Setting up Python environment");
  if (SKIP_PYTHON) {
    warn("skipped (--skip-python; managed by camera.ui monorepo)");
    return;
  }

  const python = venvPython();
  if (!existsSync(python)) {
    info("creating virtualenv at .venv");
    run("python3 -m venv .venv");
    run(`"${python}" -m pip install --upgrade pip setuptools wheel`);
  } else {
    ok("virtualenv already present");
  }

  const rootReq = join(ROOT, "requirements.txt");
  if (existsSync(rootReq)) run(`"${python}" -m pip install -r "${rootReq}"`);

  const reqFiles = pluginRequirements();
  if (reqFiles.length === 0) {
    ok("no plugin requirements found");
    return;
  }

  let failures = 0;
  for (const req of reqFiles) {
    try {
      run(`"${python}" -m pip install -r "${req}"`);
    } catch {
      failures++;
      warn(
        `could not install deps for ${basename(dirname(req))} (native/platform dep unavailable?) — continuing`,
      );
    }
  }
  if (failures === 0) ok("plugin Python dependencies installed");
  else warn(`${failures} plugin(s) had dependency install failures`);
}

function main(): void {
  console.log(chalk.bold.magenta("\ncamera.ui · plugins · setup\n"));
  console.log(chalk.gray(`root: ${ROOT}`));

  step("Initializing git submodules");
  run("git submodule update --init --recursive");
  ok("submodules initialized");

  step("Installing dependencies");
  run("npm install");
  ok("root dependencies installed");

  step("Building externals (cli, sdk)");
  if (
    existsSync(resolve(ROOT, "externals", "cli")) &&
    existsSync(resolve(ROOT, "externals", "sdk"))
  ) {
    run("npm run build:externals");
    ok("externals built");
  } else {
    info("externals missing — did submodule init succeed? skipping");
  }

  setupPython();

  step("Installing plugin dependencies");
  run("npm run install-updates");
  ok("plugin dependencies installed");

  step("Bundling plugins (development)");
  run("npm run bundle");
  ok("plugins bundled");

  console.log(
    chalk.bgGreen.bold("\n DONE "),
    chalk.green("plugins are set up and ready."),
  );
}

try {
  main();
} catch (error) {
  console.error(
    chalk.bgRed.bold("\n FAILED "),
    chalk.red(error instanceof Error ? error.message : String(error)),
  );
  console.error(
    chalk.gray(
      '\nFix the issue above and re-run "npm run setup" — it is safe to run repeatedly.',
    ),
  );
  process.exit(1);
}
