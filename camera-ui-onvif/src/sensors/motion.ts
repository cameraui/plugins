import { MotionSensor } from '@camera.ui/sdk';

import type { CameraDevice, JsonSchema } from '@camera.ui/sdk';
import type { MotionEventData } from '@seydx/onvif';

export class OnvifMotionSensor extends MotionSensor {
  private cameraDevice: CameraDevice;

  constructor(
    cameraDevice: CameraDevice,
    private topics: string[] = [],
    name = 'ONVIF Motion',
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

  handleMotion(data: MotionEventData): void {
    this.reportDetections(data.isMotion);
  }
}
