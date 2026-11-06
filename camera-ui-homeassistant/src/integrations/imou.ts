import type { CameraIntegration } from './types.js';

export const imou: CameraIntegration = {
  cloud: true,

  stream(entry) {
    if (entry.translation_key === 'camera_hd') return { lens: '', name: 'HD', role: 'high-resolution' };
    if (entry.translation_key === 'camera_sd') return { lens: '', name: 'SD', role: 'low-resolution' };
    return undefined;
  },
};
