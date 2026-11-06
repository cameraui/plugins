import { DOORBELL, MOTION, domainOf, object, sound } from './helpers.js';

import type { CameraIntegration, Detection } from './types.js';

// the onvif_parsers library names its entities "<device> <detection>"
const DETECTIONS: readonly [string, Detection][] = [
  ['Person Detection', object('person')],
  ['Human Shape Detect', object('person')],
  ['Vehicle Detection', object('vehicle')],
  ['Pet Detection', object('animal')],
  ['Visitor Detection', DOORBELL],
  ['Detected Sound', sound('')],
  ['Motion Detection', MOTION],
  ['Motion Region Detection', MOTION],
];

export const onvif: CameraIntegration = {
  entity(entry) {
    if (domainOf(entry) !== 'binary_sensor') return undefined;
    const name = entry.original_name ?? '';
    return DETECTIONS.find(([suffix]) => name.includes(suffix))?.[1] ?? 'ignore';
  },
};
