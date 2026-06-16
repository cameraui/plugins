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
        maximum: 21,
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
        maximum: 21,
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
    // Ensure WASM is initialized
    await this.ensureWASMInitialized(frame.width, frame.height);

    if (!this.wasmExports) {
      return { detected: false, detections: [] };
    }

    // Get configuration from storage (with defaults)
    const config = this.getConfig();

    // Use any types for WASM functions to bypass TypeScript's incorrect type inference
    const { detectMotion, getNumBoxes, __newArray, __getInt32Array, __pin, __unpin, __collect, Uint8Array_ID } = this.wasmExports as any;

    // Convert frame data to Uint8Array
    const frameData = frame.data instanceof Uint8Array ? frame.data : new Uint8Array(frame.data);

    const inputPtr = __pin(__newArray(Uint8Array_ID.value, frameData));
    const resultPtr = detectMotion(inputPtr, config.threshold, config.blurRadius, config.dilationSize, config.area);

    const numBoxes = getNumBoxes();
    const boxesArray = __getInt32Array(resultPtr) as Int32Array;

    const detections: MotionResult['detections'] = [];

    for (let i = 0; i < numBoxes; i++) {
      const x = boxesArray[i * 4];
      const y = boxesArray[i * 4 + 1];
      const w = boxesArray[i * 4 + 2];
      const h = boxesArray[i * 4 + 3];

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

    __unpin(inputPtr);
    __collect();

    return {
      detected: detections.length > 0,
      detections,
    };
  }

  resetState(): void {
    // WASM module handles internal state
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
      return; // Already configured correctly
    }

    if (!this.wasmExports) {
      const wasmModule = await instantiate(readFileSync(resolve(__dirname, 'detector.wasm')), {
        console: {
          log: () => {
            // WASM log messages (unused)
          },
        },
        env: {
          abort: () => {
            // WASM abort handler (unused)
          },
        },
      });

      this.wasmExports = wasmModule.exports as WASMModule;
    }

    // Initialize/reconfigure for new dimensions
    this.wasmExports.initialize(width, height);
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
