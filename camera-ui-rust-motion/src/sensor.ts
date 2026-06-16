import { MotionDetectorSensor } from '@camera.ui/sdk';

import { DEFAULT_BLUR_RADIUS, DEFAULT_DILATION_SIZE, DEFAULT_MOTION_AREA, DEFAULT_THRESHOLD } from './defaults.js';

import type * as RustDetector from '@camera.ui/rust-detector';
import type { ImageProcessor } from '@camera.ui/rust-detector';
import type { JsonSchema, MotionResult, VideoFrameData } from '@camera.ui/sdk';

let rustDetector: typeof RustDetector | undefined;
try {
  rustDetector = require('@camera.ui/rust-detector');
} catch {
  //
}

export interface RustMotionStorageValues {
  area: number;
  threshold: number;
  blurRadius: number;
  dilationSize: number;
}

export class RustMotionSensor extends MotionDetectorSensor<RustMotionStorageValues> {
  private imageProcessor?: ImageProcessor;
  private lastWidth = 0;
  private lastHeight = 0;

  constructor(name = 'Rust Motion') {
    super(name);
  }

  get isAvailable(): boolean {
    return rustDetector !== undefined;
  }

  get storageSchema(): JsonSchema[] {
    return [
      {
        type: 'number',
        key: 'area',
        title: 'Area',
        description: 'Minimum area for a motion detection',
        store: true,
        defaultValue: DEFAULT_MOTION_AREA,
        minimum: 10,
        maximum: 1000,
        step: 1,
        required: true,
      },
      {
        type: 'number',
        key: 'threshold',
        title: 'Threshold',
        description: 'Threshold for motion detection',
        store: true,
        defaultValue: DEFAULT_THRESHOLD,
        minimum: 1,
        maximum: 255,
        step: 1,
        required: true,
      },
      {
        type: 'number',
        key: 'blurRadius',
        title: 'Blur Radius',
        description: 'Blur radius for motion detection',
        store: true,
        defaultValue: DEFAULT_BLUR_RADIUS,
        minimum: 1,
        maximum: 31,
        step: 1,
        required: true,
      },
      {
        type: 'number',
        key: 'dilationSize',
        title: 'Dilation Size',
        description: 'Dilation size for motion detection',
        store: true,
        defaultValue: DEFAULT_DILATION_SIZE,
        minimum: 1,
        maximum: 31,
        step: 1,
        required: true,
      },
      {
        type: 'button',
        key: 'default',
        title: 'Default Settings',
        description: 'Reset motion detection settings to default',
        color: 'danger',
        onSet: async () => {
          await this.resetToDefaults();
        },
      },
    ];
  }

  async detectMotion(frame: VideoFrameData): Promise<MotionResult> {
    if (!rustDetector) {
      return { detected: false, detections: [] };
    }

    // Ensure ImageProcessor is initialized with correct dimensions
    this.ensureImageProcessor(frame.width, frame.height);

    if (!this.imageProcessor) {
      return { detected: false, detections: [] };
    }

    // Get configuration from storage (with defaults)
    const config = this.getConfig();
    const blurRadius = config.blurRadius % 2 === 0 ? config.blurRadius + 1 : config.blurRadius;

    // Convert frame data to Uint8Array (rust-detector expects this)
    const frameData = frame.data instanceof Uint8Array ? frame.data : new Uint8Array(frame.data);

    // Process frame through Rust detector
    // Returns array of [x, y, width, height] tuples
    const boundingBoxes = this.imageProcessor.processImage(frameData, config.threshold, blurRadius, config.dilationSize, config.area);

    return {
      detected: boundingBoxes.length > 0,
      // rust-detector returns BoundingBox = [x1, y1, x2, y2] (top-left + bottom-right
      // in pixel space). The SDK Detection.box format is { x, y, width, height } where
      // width/height are dimensions, not corner coordinates — convert here.
      detections: boundingBoxes.map((box) => {
        const [x1, y1, x2, y2] = box;
        return {
          label: 'motion',
          confidence: 1,
          box: {
            x: x1 / frame.width,
            y: y1 / frame.height,
            width: (x2 - x1) / frame.width,
            height: (y2 - y1) / frame.height,
          },
        };
      }),
    };
  }

  resetState(): void {
    this.imageProcessor?.resetState();
  }

  private getConfig(): RustMotionStorageValues {
    return {
      area: this.storage.values.area,
      threshold: this.storage.values.threshold,
      blurRadius: this.storage.values.blurRadius,
      dilationSize: this.storage.values.dilationSize,
    };
  }

  private ensureImageProcessor(width: number, height: number): void {
    if (!rustDetector) {
      return;
    }

    if (this.imageProcessor && this.lastWidth === width && this.lastHeight === height) {
      return; // Already configured correctly
    }

    if (this.imageProcessor) {
      // Reconfigure existing processor
      this.imageProcessor.reconfigure(width, height);
    } else {
      // Create new processor
      this.imageProcessor = new rustDetector.ImageProcessor(width, height);
    }

    this.lastWidth = width;
    this.lastHeight = height;
  }

  private async resetToDefaults(): Promise<void> {
    if (this.storage) {
      this.storage.setValue('area', DEFAULT_MOTION_AREA);
      this.storage.setValue('threshold', DEFAULT_THRESHOLD);
      this.storage.setValue('blurRadius', DEFAULT_BLUR_RADIUS);
      this.storage.setValue('dilationSize', DEFAULT_DILATION_SIZE);
    }
  }
}
