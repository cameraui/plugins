import { MDNSAdvertiser } from './hap.js';

export const baseAdvertiser: string[] = [
  `${MDNSAdvertiser.CIAO} (recommended)`,
  `${MDNSAdvertiser.AVAHI} (recommended, Linux only)`,
  `${MDNSAdvertiser.BONJOUR} (deprecated)`,
  `${MDNSAdvertiser.RESOLVED} (experimental)`,
];

export const videoPayloadType = 99;
export const audioPayloadType = 110;
export const secureVideoMaxRemoteSessions = 16;
