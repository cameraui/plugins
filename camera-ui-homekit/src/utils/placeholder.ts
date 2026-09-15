import { readFileSync } from 'node:fs';
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

export async function captureSnapshot(cameraDevice: CameraDevice): Promise<Buffer> {
  const placeholder = placeholderImageFor(cameraDevice);
  if (placeholder) {
    return readFileSync(placeholder);
  }

  const source = cameraDevice.snapshotSource ?? cameraDevice.streamSource;
  try {
    const snapshot = await source.snapshot(true);
    const buffer = snapshot ? Buffer.from(snapshot) : undefined;
    if (buffer && buffer.length > 0) {
      return buffer;
    }
  } catch {
    // fall through to the no-snapshot placeholder
  }
  return readFileSync(noSnapshotImage);
}
