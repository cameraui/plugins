export interface PluginStorageValues {
  bridgePin: string;
  bridgePortOverride: number;
  bridgeAdvertiseAddress?: string;
  bridgeRepublishId: string;
  bridgeAdvertiser: string;
}

export interface CameraStorageValues {
  accessoryPin: string;
  accessoryPortOverride: number;
  advertiseAddress?: string;
  republishId: string;
  useHardwareAcceleration: boolean;
  useHardwareAccelerationForRecording: boolean;
  forceVideoTranscodingForRecording: boolean;
  adaptiveStreamSource: boolean;
  advertiser: string;
}
