import { AudioSensor } from '@camera.ui/sdk';

import type { CameraDevice, JsonSchema } from '@camera.ui/sdk';
import type { AudioEventData } from '@seydx/onvif';

export class OnvifAudioSensor extends AudioSensor {
  private cameraDevice: CameraDevice;

  constructor(
    cameraDevice: CameraDevice,
    private topics: string[] = [],
    name = 'ONVIF Audio',
  ) {
    super(name);

    this.cameraDevice = cameraDevice;
  }

  override get storageSchema(): JsonSchema[] {
    if (!this.topics.length) return [];
    return [
      {
        type: 'string',
        key: 'infoTopics',
        title: 'Event Topics',
        description: 'Camera event topics that feed this sensor.',
        readonly: true,
        defaultValue: this.topics.join(', '),
      },
    ];
  }

  handleAudio(data: AudioEventData): void {
    this.reportDetections(data.isAudioDetected);

    if (data.level !== undefined) {
      this.setDecibels(data.level);
    }
  }
}
