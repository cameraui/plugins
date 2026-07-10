import type { CameraUiBuildOptions } from '@camera.ui/cli';

const mode = process.env.MODE || 'production';

const config: CameraUiBuildOptions = {
  input: ['src/index.ts'],
  mode: mode === 'development' ? 'development' : 'production',
  external: [],
  additionalFiles: [
    { source: '../externals/eufy-security-client/src/push/proto/mcs.proto', target: 'proto/mcs.proto' },
    { source: '../externals/eufy-security-client/src/push/proto/checkin.proto', target: 'proto/checkin.proto' },
    { source: '../externals/eufy-security-client/src/mqtt/proto/lock.proto', target: 'proto/lock.proto' },
    { source: '../externals/eufy-security-client/src/mqtt/mqtt-eufy.crt', target: 'mqtt-eufy.crt' },
  ],
};

export default config;
