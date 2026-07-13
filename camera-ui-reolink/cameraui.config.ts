import type { CameraUiBuildOptions } from '@camera.ui/cli';

const mode = process.env.MODE || 'production';

const config: CameraUiBuildOptions = {
  input: ['src/index.ts'],
  mode: mode === 'development' ? 'development' : 'production',
  external: [],
  additionalFiles: [],
  language: 'go',
  go: {
    cgoEnabled: '0',
    ldflags: '-s -w',
    targets: [
      { goos: 'darwin', goarch: 'arm64' },
      { goos: 'darwin', goarch: 'amd64' },
      { goos: 'linux', goarch: 'amd64' },
      { goos: 'linux', goarch: 'arm64' },
      { goos: 'windows', goarch: 'amd64' },
      { goos: 'windows', goarch: 'arm64' },
      { goos: 'linux', goarch: 'amd64', libc: 'musl' },
      { goos: 'linux', goarch: 'arm64', libc: 'musl' },
    ],
  },
};

export default config;
