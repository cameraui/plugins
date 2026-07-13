import chalk from 'chalk';
import { execSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function runCommandsInDirectory(directoryPath: string) {
  try {
    const cmds = ['npm run update --if-present'];
    const fullPath = resolve(__dirname, directoryPath);

    cmds.forEach((cmd) => {
      console.log(chalk.cyan('USER:', userInfo().username));
      console.log(chalk.cyan('DIR:', fullPath));
      console.log(chalk.cyan(`COMMAND: ${cmd}\r\n`));

      execSync(cmd, { stdio: 'inherit', cwd: fullPath });

      console.log('\r\n');
    });

    console.log('\r\n', chalk.bgGreen(' SUCCESS '), chalk.green(`Command completed in ${fullPath}`));
  } catch (error) {
    console.error('\r\n', chalk.bgRed.bold(' ERROR '), chalk.red(`Failed to run command in ${directoryPath}: ${error}`));
  } finally {
    console.log('\r\n----------------------------------------\r\n');
  }
}

function runCommandsInDirectories(directories: string[]) {
  directories.forEach((directory) => {
    runCommandsInDirectory(directory);
  });

  console.log('All commands completed\r\n');
}

const directories = [
  '../camera-ui-audio-yamnet',
  '../camera-ui-coral',
  '../camera-ui-coreml',
  '../camera-ui-eufy',
  '../camera-ui-hailo',
  '../camera-ui-homekit',
  '../camera-ui-ncnn',
  '../camera-ui-onnx',
  '../camera-ui-onvif',
  '../camera-ui-opencl',
  '../camera-ui-opencv',
  '../camera-ui-openvino',
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
