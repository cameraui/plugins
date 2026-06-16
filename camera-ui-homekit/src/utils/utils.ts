import { SensorType } from '@camera.ui/sdk';

import { HDSProtocolSpecificErrorReason } from '../hap.js';

import type {
  AudioStreamInfo,
  BatteryInfoLike,
  ContactSensorLike,
  Disposable,
  DoorbellTriggerLike,
  LightControlLike,
  MotionSensorLike,
  SecuritySystemLike,
  SirenControlLike,
  SwitchControlLike,
  VideoStreamInfo,
} from '@camera.ui/sdk';
import type { H264Level, H264Profile } from '../hap.js';

export interface RecordingRequest {
  audio: {
    codec: string;
    sampleRate: string;
    channels?: number;
    bitrate: number;
  };
  video: {
    width: number;
    height: number;
    fps: number;
    max_bit_rate: number;
    iFrameInterval: number;
    profile: H264Profile;
    level: H264Level;
  };
}

export interface PrecheckStreamInfo {
  audioStream: AudioStreamInfo[];
  videoStream: VideoStreamInfo[];
  talkbackStream?: AudioStreamInfo;
  isH264: boolean | null;
}

export class Subscribed {
  private readonly subscriptions: Disposable[] = [];
  private readonly additionalSubscriptions: Disposable[] = [];

  public addSubscriptions(...subscriptions: Disposable[]): void {
    this.subscriptions.push(...subscriptions);
  }

  public addAdditionalSubscriptions(...subscriptions: Disposable[]): void {
    this.additionalSubscriptions.push(...subscriptions);
  }

  protected unsubscribe(): void {
    this.subscriptions.forEach((subscription) => subscription.dispose());
  }

  protected unsubscribeAdditional(): void {
    this.additionalSubscriptions.forEach((subscription) => subscription.dispose());
  }
}

export function generateValidAccessoryName(input = ''): string {
  // Function to remove leading and trailing special characters
  const trimSpecialChars = (str: string): string => {
    return str.replace(/^[^a-zA-Z]+|[^a-zA-Z0-9]+$/g, '');
  };

  // Remove leading and trailing whitespace
  let safeName = trimSpecialChars(input.trim());

  // Replace all special characters with a space
  safeName = safeName.replace(/[^\p{L}\p{N} ']/gu, ' ');

  // Remove multiple spaces
  safeName = safeName.replace(/\s+/g, ' ');

  // Limit to 250 characters
  safeName = safeName.slice(0, 250);

  // Remove leading and trailing special characters again
  safeName = trimSpecialChars(safeName);

  // Check if the name is valid
  const isValid = safeName.length >= 2 && /^[\p{L}\p{N}][\p{L}\p{N} ']*[\p{L}\p{N}]$/u.test(safeName);

  if (!isValid) {
    return 'Default Camera';
  }

  return safeName;
}

export function getDurationSeconds(start: number) {
  return (Date.now() - start) / 1000;
}

export function getHdsReason(reason?: HDSProtocolSpecificErrorReason): string {
  switch (reason) {
    case HDSProtocolSpecificErrorReason.BAD_DATA:
      return 'Bad Data';
    case HDSProtocolSpecificErrorReason.BUSY:
      return 'Busy';
    case HDSProtocolSpecificErrorReason.CANCELLED:
      return 'Cancelled';
    case HDSProtocolSpecificErrorReason.INVALID_CONFIGURATION:
      return 'Invalid Configuration';
    case HDSProtocolSpecificErrorReason.NORMAL:
      return 'Normal';
    case HDSProtocolSpecificErrorReason.NOT_ALLOWED:
      return 'Not Allowed';
    case HDSProtocolSpecificErrorReason.PROTOCOL_ERROR:
      return 'Protocol Error';
    case HDSProtocolSpecificErrorReason.TIMEOUT:
      return 'Timeout';
    case HDSProtocolSpecificErrorReason.UNEXPECTED_FAILURE:
      return 'Unexpected Failure';
    case HDSProtocolSpecificErrorReason.UNSUPPORTED:
      return 'Unsupported';
    default:
      return 'Unknown';
  }
}

export function isBatteryInfo(obj: any): obj is BatteryInfoLike {
  return obj && typeof obj === 'object' && 'type' in obj && obj.type === SensorType.Battery;
}

export function isContactSensor(obj: any): obj is ContactSensorLike {
  return obj && typeof obj === 'object' && 'type' in obj && obj.type === SensorType.Contact;
}

export function isDoorbellTrigger(obj: any): obj is DoorbellTriggerLike {
  return obj && typeof obj === 'object' && 'type' in obj && obj.type === SensorType.Doorbell;
}

export function isLightControl(obj: any): obj is LightControlLike {
  return obj && typeof obj === 'object' && 'type' in obj && obj.type === SensorType.Light;
}

export function isMotionSensor(obj: any): obj is MotionSensorLike {
  return obj && typeof obj === 'object' && 'type' in obj && obj.type === SensorType.Motion;
}

export function isSecuritySystem(obj: any): obj is SecuritySystemLike {
  return obj && typeof obj === 'object' && 'type' in obj && obj.type === SensorType.SecuritySystem;
}

export function isSirenControl(obj: any): obj is SirenControlLike {
  return obj && typeof obj === 'object' && 'type' in obj && obj.type === SensorType.Siren;
}

export function isSwitchControl(obj: any): obj is SwitchControlLike {
  return obj && typeof obj === 'object' && 'type' in obj && obj.type === SensorType.Switch;
}

export async function PromiseTimeout<T>(promise: Promise<T> | (() => Promise<T>), ms: number, cleanup?: () => void, errorMessage?: string): Promise<T> {
  let timeoutId: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      cleanup?.();
      reject(new Error(errorMessage ?? `Operation timed out after ${ms}ms`));
    }, ms);
  });

  try {
    const promiseFn = typeof promise === 'function' ? promise : () => promise;
    return await Promise.race([promiseFn(), timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
}
