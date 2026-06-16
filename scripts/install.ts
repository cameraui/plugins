import chalk from 'chalk';
import { execSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function runCommandsInDirectory(directoryPath: string) {
  try {
    const cmds = ['npm i --save --ignore-scripts'];
    const fullPath = resolve(__dirname, directoryPath);

    const withBuild = process.argv.includes('--with-build');
    if (withBuild) {
      cmds.push('npm run build --if-present');
    }

    cmds.push('npm i --save');

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

  console.log('All commands completed');
}

const directories = [
  '../camera-ui-audio-yamnet',
  '../camera-ui-coreml',
  '../camera-ui-eufy',
  '../camera-ui-homekit',
  '../camera-ui-onvif',
  '../camera-ui-opencl',
  '../camera-ui-opencv',
  '../camera-ui-pamdiff',
  '../camera-ui-ring',
  '../camera-ui-rust-motion',
  '../camera-ui-smtp',
  '../camera-ui-tuya',
  '../camera-ui-wasm-motion',
  '../camera-ui-wyze',
  '../mockups/camera-ui-mock-motion',
  '../mockups/camera-ui-mock-object',
  '../mockups/camera-ui-mock-tuya',
  '../mockups/camera-ui-test-node',
  '../mockups/camera-ui-test-go',
  '../mockups/camera-ui-test-python',
];

runCommandsInDirectories(directories);
