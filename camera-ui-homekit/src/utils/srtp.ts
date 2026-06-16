import { randomBytes } from 'node:crypto';
import { CameraController } from '../hap.js';

export interface SrtpOptions {
  srtp_key: Buffer;
  srtp_salt: Buffer;
}

export function encodeSrtpOptions({ srtp_key, srtp_salt }: SrtpOptions): string {
  return Buffer.concat([srtp_key, srtp_salt]).toString('base64');
}

export function decodeSrtpOptions(encodedOptions: string): SrtpOptions {
  const crypto = Buffer.from(encodedOptions, 'base64');

  return {
    srtp_key: crypto.subarray(0, 16),
    srtp_salt: crypto.subarray(16, 30),
  };
}

export function createCryptoLine(srtpOptions: SrtpOptions): string {
  const encodedOptions = encodeSrtpOptions(srtpOptions);

  return `a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${encodedOptions}`;
}

export function generateSrtpOptions(): SrtpOptions {
  return {
    srtp_key: randomBytes(16),
    srtp_salt: randomBytes(14),
  };
}

export function generateSsrc(): number {
  return CameraController.generateSynchronisationSource();
}

export function getSessionConfig(srtpOptions: SrtpOptions) {
  return {
    keys: {
      localMasterKey: srtpOptions.srtp_key,
      localMasterSalt: srtpOptions.srtp_salt,
      remoteMasterKey: srtpOptions.srtp_key,
      remoteMasterSalt: srtpOptions.srtp_salt,
    },
    profile: 1,
  };
}
