import { resolve } from 'node:path';

import type { CameraDevice } from '@camera.ui/sdk';

export const noSnapshotImage = resolve(__dirname, './media/noSnapshot.png');
export const privacyModeImage = resolve(__dirname, './media/privacyMode.png');
export const cameraOfflineImage = resolve(__dirname, './media/cameraOffline.png');

export function placeholderImageFor(cameraDevice: CameraDevice): string | undefined {
  if (cameraDevice.disabled) return privacyModeImage;
  if (!cameraDevice.connected) return cameraOfflineImage;
  return undefined;
}
