import { MotionDetectorSensor } from '@camera.ui/sdk';

import { DEFAULT_BLUR_RADIUS, DEFAULT_DILATION_SIZE, DEFAULT_MOTION_AREA, DEFAULT_REFERENCE_HOLD, DEFAULT_THRESHOLD } from './defaults.js';

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
  referenceHold: number;
  defaults2: boolean;
}

export class RustMotionSensor extends MotionDetectorSensor<RustMotionStorageValues> {
  private imageProcessor?: ImageProcessor;
  private lastWidth = 0;
  private lastHeight = 0;
  private referenceAt = 0;

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
        description: 'Smallest combined size of nearby changed regions that counts as motion.',
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
        description: 'Brightness change needed to mark a pixel as changed.',
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
        description: 'Smoothing applied before detection to reduce noise.',
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
        description: 'Merges nearby changed pixels into one region.',
        store: true,
        defaultValue: DEFAULT_DILATION_SIZE,
        minimum: 1,
        maximum: 31,
        step: 1,
        required: true,
      },
      {
        type: 'number',
        key: 'referenceHold',
        title: 'Reference Hold',
        description: 'Seconds the comparison image is kept. Higher values catch very slow movement, lower values keep motion boxes closer to the current position.',
        store: true,
        defaultValue: DEFAULT_REFERENCE_HOLD,
        minimum: 1,
        maximum: 10,
        step: 1,
        required: true,
      },
      {
        type: 'button',
        key: 'default',
        title: 'Default Settings',
        description: 'Restore the default detection values.',
        color: 'danger',
        onSet: async () => {
          await this.resetToDefaults();
        },
      },
      {
        type: 'boolean',
        key: 'defaults2',
        title: 'Defaults migrated',
        description: '',
        hidden: true,
        store: true,
        defaultValue: false,
      },
    ];
  }

  async detectMotion(frame: VideoFrameData): Promise<MotionResult> {
    if (!rustDetector) {
      return { detected: false, detections: [] };
    }

    this.ensureImageProcessor(frame.width, frame.height);

    if (!this.imageProcessor) {
      return { detected: false, detections: [] };
    }

    const config = this.getConfig();
    const blurRadius = config.blurRadius % 2 === 0 ? config.blurRadius + 1 : config.blurRadius;
    const frameData = frame.data instanceof Uint8Array ? frame.data : new Uint8Array(frame.data);

    const now = Date.now();
    const updateReference = now - this.referenceAt >= config.referenceHold * 1000;
    if (updateReference) this.referenceAt = now;

    const boundingBoxes = this.imageProcessor.processImage(frameData, config.threshold, blurRadius, config.dilationSize, config.area, updateReference);

    return {
      detected: boundingBoxes.length > 0,
      // rust-detector returns [x1, y1, x2, y2] pixel corners; SDK box wants { x, y, width, height }
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

  protected override async onStart(): Promise<void> {
    if (this.storage.values.defaults2) {
      return;
    }
    await this.storage.setValue('threshold', DEFAULT_THRESHOLD);
    await this.storage.setValue('area', DEFAULT_MOTION_AREA);
    await this.storage.setValue('defaults2', true);
  }

  resetState(): void {
    this.imageProcessor?.resetState();
    this.referenceAt = 0;
  }

  private getConfig(): Omit<RustMotionStorageValues, 'defaults2'> {
    return {
      area: this.storage.values.area,
      threshold: this.storage.values.threshold,
      blurRadius: this.storage.values.blurRadius,
      dilationSize: this.storage.values.dilationSize,
      referenceHold: this.storage.values.referenceHold,
    };
  }

  private ensureImageProcessor(width: number, height: number): void {
    if (!rustDetector) {
      return;
    }

    if (this.imageProcessor && this.lastWidth === width && this.lastHeight === height) {
      return;
    }

    if (this.imageProcessor) {
      this.imageProcessor.reconfigure(width, height);
    } else {
      this.imageProcessor = new rustDetector.ImageProcessor(width, height);
    }

    this.lastWidth = width;
    this.lastHeight = height;
    this.referenceAt = 0;
  }

  private async resetToDefaults(): Promise<void> {
    if (this.storage) {
      await this.storage.setValue('area', DEFAULT_MOTION_AREA);
      await this.storage.setValue('threshold', DEFAULT_THRESHOLD);
      await this.storage.setValue('blurRadius', DEFAULT_BLUR_RADIUS);
      await this.storage.setValue('dilationSize', DEFAULT_DILATION_SIZE);
      await this.storage.setValue('referenceHold', DEFAULT_REFERENCE_HOLD);
    }
  }
}
