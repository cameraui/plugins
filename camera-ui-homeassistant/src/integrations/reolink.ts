import { DOORBELL, MOTION, domainOf, object, sound } from './helpers.js';

import type { CameraRole } from '@camera.ui/sdk';
import type { CameraIntegration, Detection } from './types.js';

// translation_key of a stream: telephoto_ for the TrackMix zoom lens, _lens_N on dual-lens models HA does not stitch
const STREAM_KEY = /^(telephoto_)?(snapshots_)?(main|ext|sub)(?:_lens_(\d+))?$/;
const STREAMS: Readonly<Record<string, { name: string; role: CameraRole }>> = {
  main: { name: 'Clear', role: 'high-resolution' },
  ext: { name: 'Balanced', role: 'mid-resolution' },
  sub: { name: 'Fluent', role: 'low-resolution' },
};
const DETECTIONS: Readonly<Record<string, Detection>> = {
  person: object('person'),
  vehicle: object('vehicle'),
  'non-motor_vehicle': object('vehicle'),
  pet: object('animal'),
  animal: object('animal'),
  visitor: DOORBELL,
  cry: sound('baby_cry'),
};
const CHANNEL = /^[^_]+_(\d+)_/;

export const reolink: CameraIntegration = {
  stream(entry) {
    const match = STREAM_KEY.exec(entry.translation_key ?? '');
    if (!match) return undefined;
    if (match[2]) return 'ignore';
    const lens = match[1] ? 'telephoto' : match[4] !== undefined ? `lens_${match[4]}` : '';
    return { lens, ...STREAMS[match[3]] };
  },

  entity(entry, state) {
    if (domainOf(entry) !== 'binary_sensor') return undefined;
    const key = entry.translation_key;
    if (key) return DETECTIONS[key] ?? 'ignore';
    // face, package and the zone sensors carry device class motion too, only the plain one has no key
    return state.attributes.device_class === 'motion' ? MOTION : 'ignore';
  },

  entityLens(entry, lenses) {
    const lensChannels = [...lenses].filter((lens) => lens.startsWith('lens_'));
    if (lensChannels.length <= 1) return lensChannels[0] ?? '';
    const channel = CHANNEL.exec(entry.unique_id ?? '')?.[1];
    return channel === undefined ? '' : `lens_${channel}`;
  },
};
