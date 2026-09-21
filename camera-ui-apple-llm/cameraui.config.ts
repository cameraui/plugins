import type { CameraUiBuildOptions } from '@camera.ui/cli';

const mode = process.env.MODE || 'production';

const config: CameraUiBuildOptions = {
  input: ['src/index.ts'],
  additionalFiles: ['helper/bin/apple-llm-helper'],
  mode: mode === 'development' ? 'development' : 'production',
};

export default config;
