import chalk from 'chalk';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function runsHere(fullPath: string): boolean {
  const { os, cpu } = JSON.parse(readFileSync(resolve(fullPath, 'package.json'), 'utf8')) as { os?: string[]; cpu?: string[] };
  return (!os || os.includes(process.platform)) && (!cpu || cpu.includes(process.arch));
}

function runCommandsInDirectory(directoryPath: string) {
  try {
    const fullPath = resolve(__dirname, directoryPath);
    // npm refuses to fix a plugin built for another platform, report only
    const cmd = runsHere(fullPath) ? 'npm audit fix --min-release-age=0' : 'npm audit';

    console.log(chalk.cyan('USER:', userInfo().username));
    console.log(chalk.cyan('DIR:', fullPath));
    console.log(chalk.cyan(`COMMAND: ${cmd}\r\n`));

    execSync(cmd, { stdio: 'inherit', cwd: fullPath });

    console.log('\r\n', chalk.bgGreen(' SUCCESS '), chalk.green(`Command completed in ${fullPath}`));
  } catch (error) {
    process.exitCode = 1;
    console.error('\r\n', chalk.bgRed.bold(' ERROR '), chalk.red(`Failed to run command in ${directoryPath}: ${error}`));
  } finally {
    console.log('\r\n----------------------------------------\r\n');
  }
}

function runCommandsInDirectories(directories: string[]) {
  directories.forEach((directory) => {
    runCommandsInDirectory(directory);
  });

  console.log('All commands completed');
}

const directories = [
  '../camera-ui-apple-llm',
  '../camera-ui-audio-yamnet',
  '../camera-ui-coral',
  '../camera-ui-coreml',
  '../camera-ui-eufy',
  '../camera-ui-hailo',
  '../camera-ui-homeassistant',
  '../camera-ui-homekit',
  '../camera-ui-ncnn',
  '../camera-ui-onnx',
  '../camera-ui-onnx-legacy',
  '../camera-ui-onvif',
  '../camera-ui-opencl',
  '../camera-ui-opencv',
  '../camera-ui-openvino',
  '../camera-ui-openvino-legacy',
  '../camera-ui-pamdiff',
  '../camera-ui-reolink',
  '../camera-ui-ring',
  '../camera-ui-rust-motion',
  '../camera-ui-smtp',
  '../camera-ui-tuya',
  '../camera-ui-wasm-motion',
  '../camera-ui-wyze',
];

runCommandsInDirectories(directories);
