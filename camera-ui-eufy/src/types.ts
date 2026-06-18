import type { Device, Station } from 'eufy-security-client';

export interface DeviceIdentifier {
  uniqueId: string;
  displayName: string;
  type: number;
}

export interface StationContainer {
  deviceIdentifier: DeviceIdentifier;
  eufyDevice: Station;
}

export interface DeviceContainer {
  deviceIdentifier: DeviceIdentifier;
  eufyDevice: Device;
}

export interface EufyHome {
  name: string;
  username: string;
  password: string;
  country?: string;
  deviceName?: string;
  debug?: boolean;
  maxLiveStreamDuration?: number;
  ignoreDevices?: string[];
}

export interface EufyCameraStorage {
  useP2P?: boolean;
}

export interface StorageValues extends EufyHome {}

export interface EufyConnectionResponse {
  connected: boolean;
  is2FA?: boolean;
  isCaptcha?: { id: string; captcha: string };
}
