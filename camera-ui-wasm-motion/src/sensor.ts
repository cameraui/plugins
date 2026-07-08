import { instantiate } from '@assemblyscript/loader';
import { MotionDetectorSensor } from '@camera.ui/sdk';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { DEFAULT_BLUR_RADIUS, DEFAULT_DILATION_SIZE, DEFAULT_MOTION_AREA, DEFAULT_THRESHOLD } from './defaults.js';

import type { ASUtil } from '@assemblyscript/loader';
import type { JsonSchema, MotionResult, VideoFrameData } from '@camera.ui/sdk';
import type { instantiate as instantiateWasm } from './wasm/build/detector.js';

type WASMModule = ASUtil & Record<string, unknown> & Awaited<ReturnType<typeof instantiateWasm>>;

export interface WASMMotionStorageValues {
  area: number;
  threshold: number;
  blurRadius: number;
  dilationSize: number;
}

export class WASMMotionSensor extends MotionDetectorSensor<WASMMotionStorageValues> {
  private wasmExports?: WASMModule;
  private frameView?: Uint8Array;
  private boxesView?: Int32Array;
  private lastWidth = 0;
  private lastHeight = 0;

  readonly isAvailable = true;

  constructor(name = 'WASM Motion') {
    super(name);
  }

  get storageSchema(): JsonSchema[] {
    return [
      {
        type: 'number',
        key: 'area',
        title: 'Area',
        description: 'Smallest region size that counts as motion.',
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
        maximum: 21,
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
        maximum: 21,
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
    ];
  }

  async detectMotion(frame: VideoFrameData): Promise<MotionResult> {
    await this.ensureWASMInitialized(frame.width, frame.height);

    if (!this.wasmExports) {
      return { detected: false, detections: [] };
    }

    if (!this.frameView || !this.boxesView) {
      return { detected: false, detections: [] };
    }

    const config = this.getConfig();

    const { detectMotion } = this.wasmExports;

    const frameData = frame.data instanceof Uint8Array ? frame.data : new Uint8Array(frame.data);
    this.frameView.set(frameData.subarray(0, this.frameView.length));

    const numBoxes = detectMotion(config.threshold, config.blurRadius, config.dilationSize, config.area);

    const detections: MotionResult['detections'] = [];

    for (let i = 0; i < numBoxes; i++) {
      const x = this.boxesView[i * 4];
      const y = this.boxesView[i * 4 + 1];
      const w = this.boxesView[i * 4 + 2];
      const h = this.boxesView[i * 4 + 3];

      detections.push({
        label: 'motion',
        confidence: 1,
        box: {
          x: x / frame.width,
          y: y / frame.height,
          width: w / frame.width,
          height: h / frame.height,
        },
      });
    }

    return {
      detected: detections.length > 0,
      detections,
    };
  }

  resetState(): void {
    this.wasmExports?.reset();
  }

  private getConfig(): WASMMotionStorageValues {
    return {
      area: this.storage.values.area,
      threshold: this.storage.values.threshold,
      blurRadius: this.storage.values.blurRadius,
      dilationSize: this.storage.values.dilationSize,
    };
  }

  private async ensureWASMInitialized(width: number, height: number): Promise<void> {
    if (this.wasmExports && this.lastWidth === width && this.lastHeight === height) {
      return;
    }

    if (!this.wasmExports) {
      const wasmModule = await instantiate(readFileSync(resolve(__dirname, 'detector.wasm')), {
        console: {
          log: () => {},
        },
        env: {
          abort: () => {},
        },
      });

      this.wasmExports = wasmModule.exports as WASMModule;
    }

    this.wasmExports.initialize(width, height);

    const exports = this.wasmExports;
    const buffer = exports.memory.buffer as ArrayBuffer;
    this.frameView = new Uint8Array(buffer, exports.getFramePtr(), width * height);
    this.boxesView = new Int32Array(buffer, exports.getBoxesPtr(), exports.getMaxBoxes() * 4);

    this.lastWidth = width;
    this.lastHeight = height;
  }

  private async resetToDefaults(): Promise<void> {
    if (this.storage) {
      await this.storage.setValue('area', DEFAULT_MOTION_AREA);
      await this.storage.setValue('threshold', DEFAULT_THRESHOLD);
      await this.storage.setValue('blurRadius', DEFAULT_BLUR_RADIUS);
      await this.storage.setValue('dilationSize', DEFAULT_DILATION_SIZE);
    }
  }
}
