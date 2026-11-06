import { MOTION, domainOf } from './helpers.js';

import type { CameraIntegration } from './types.js';

const STREAM = /-camera:(\d+)-stream_([01])$/;
const CAMERA_MOTION = /-camera:(\d+)-camera_motion$/;

function lensOf(index: string): string {
  return index === '0' ? '' : `camera_${index}`;
}

export const shelly: CameraIntegration = {
  stream(entry) {
    const match = STREAM.exec(entry.unique_id ?? '');
    if (!match) return undefined;
    return match[2] === '0'
      ? { lens: lensOf(match[1]), name: 'Stream 0', role: 'high-resolution' }
      : { lens: lensOf(match[1]), name: 'Stream 1', role: 'low-resolution' };
  },

  entity(entry) {
    if (domainOf(entry) !== 'binary_sensor') return undefined;
    // zone sensors repeat the camera's motion for a part of the picture
    return CAMERA_MOTION.test(entry.unique_id ?? '') ? MOTION : 'ignore';
  },

  entityLens(entry) {
    const index = CAMERA_MOTION.exec(entry.unique_id ?? '')?.[1];
    return index === undefined ? '' : lensOf(index);
  },
};
