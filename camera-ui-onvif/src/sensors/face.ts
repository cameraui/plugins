import { FaceSensor } from '@camera.ui/sdk';

import type { CameraDevice, JsonSchema } from '@camera.ui/sdk';
import type { DetectionEventData } from '@seydx/onvif';

export class OnvifFaceSensor extends FaceSensor {
  private cameraDevice: CameraDevice;

  constructor(
    cameraDevice: CameraDevice,
    private topics: string[] = [],
    name = 'ONVIF Face',
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

  handleDetection(data: DetectionEventData): void {
    this.reportDetections(data.isDetected);
  }
}
