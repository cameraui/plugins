import { ObjectSensor } from '@camera.ui/sdk';

import type { CameraDevice, JsonSchema, TrackedDetection } from '@camera.ui/sdk';

type ObjectCategory = 'person' | 'vehicle' | 'animal';

interface ObjectDetectionData {
  category: ObjectCategory;
  isDetected: boolean;
  rule?: string;
}

export class OnvifObjectSensor extends ObjectSensor {
  private cameraDevice: CameraDevice;
  private activeCategories = new Set<ObjectCategory>();

  constructor(
    cameraDevice: CameraDevice,
    private topics: string[] = [],
    name = 'ONVIF Object',
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

  handleDetection(data: ObjectDetectionData): void {
    if (data.isDetected) {
      this.activeCategories.add(data.category);
    } else {
      this.activeCategories.delete(data.category);
    }

    if (this.activeCategories.size === 0) {
      this.reportDetections(false);
      return;
    }

    // ONVIF events lack bounding boxes — synthesize a full-frame detection per category for labels.
    const detections: TrackedDetection[] = Array.from(this.activeCategories).map((category) => ({
      label: category,
      confidence: 1,
      box: { x: 0, y: 0, width: 1, height: 1 },
    }));

    this.reportDetections(true, detections);
  }
}
