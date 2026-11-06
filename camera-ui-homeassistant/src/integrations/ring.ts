import type { CameraIntegration } from './types.js';

export const ring: CameraIntegration = {
  cloud: true,
  // camera_proxy gives a frame of the last recording, not the live picture
  snapshotFromStream: true,
};
