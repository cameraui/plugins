import { MotionDetectorSensor } from '@camera.ui/sdk';
import PamDiff from 'pam-diff';
import P2P from 'pipe2pam';
import { PassThrough } from 'stream';

import { DEFAULT_DIFFERENCE, DEFAULT_MODE, DEFAULT_PERCENTAGE } from './constants.js';

import type { JsonSchema, MotionResult, VideoFrameData } from '@camera.ui/sdk';

export interface PamDiffStorageValues {
  difference: number;
  percentage: number;
  mode: 'gray' | 'rgb';
}

interface StreamSession {
  pt: PassThrough;
  p2p: P2P;
  pamDiff: PamDiff;
  blobs: PamDiff.Blob[];
  processing: boolean;
  lastWidth: number;
  lastHeight: number;
}

export class PamDiffMotionSensor extends MotionDetectorSensor<PamDiffStorageValues> {
  private streamSession?: StreamSession;
  private consecutiveEmpty = 0;

  constructor(name = 'Pam Diff') {
    super(name);
  }

  get storageSchema(): JsonSchema[] {
    return [
      {
        type: 'number',
        key: 'difference',
        title: 'Motion Difference',
        description: 'Per-pixel color change needed to count as motion.',
        defaultValue: DEFAULT_DIFFERENCE,
        minimum: 1,
        maximum: 255,
        step: 1,
        store: true,
        required: true,
        onSet: async () => {
          this.reconfigure();
        },
      },
      {
        type: 'number',
        key: 'percentage',
        title: 'Motion Percent',
        description: 'Share of changed pixels needed to trigger motion.',
        defaultValue: DEFAULT_PERCENTAGE,
        minimum: 0,
        maximum: 100,
        step: 1,
        store: true,
        required: true,
        onSet: async () => {
          this.reconfigure();
        },
      },
      {
        type: 'string',
        key: 'mode',
        title: 'Motion Mode',
        description: 'Color space used for detection (gray is faster).',
        defaultValue: DEFAULT_MODE,
        store: true,
        enum: ['gray', 'rgb'],
        required: true,
        onSet: async () => {
          this.reconfigure();
        },
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
    if (this.streamSession && (this.streamSession.lastWidth !== frame.width || this.streamSession.lastHeight !== frame.height)) {
      this.cleanup();
    }

    this.streamSession ??= this.initializeStreams(frame.width, frame.height);

    const session = this.streamSession;

    if (session.processing) {
      return { detected: false, detections: [] };
    }

    session.processing = true;

    try {
      const mode = this.storage.values.mode;
      const tuplType = mode === 'gray' ? 'GRAYSCALE' : 'RGB';
      const depth = mode === 'gray' ? 1 : 3;

      const header = ['P7', `WIDTH ${frame.width}`, `HEIGHT ${frame.height}`, `DEPTH ${depth}`, 'MAXVAL 255', `TUPLTYPE ${tuplType}`, 'ENDHDR'].join('\n') + '\n';

      const frameData = frame.data instanceof Uint8Array ? Buffer.from(frame.data) : Buffer.from(frame.data);

      const pamFrame = Buffer.concat([Buffer.from(header), frameData]);

      const canContinue = session.pt.write(pamFrame);
      if (!canContinue) {
        await new Promise<void>((resolve) => session.pt.once('drain', resolve));
      }

      // pipe2pam needs an event-loop tick to emit parsed frames
      await new Promise((resolve) => setImmediate(resolve));

      const detections: MotionResult['detections'] = [];

      while (session.blobs.length > 0) {
        const blob = session.blobs.shift();
        if (blob) {
          detections.push({
            label: 'motion',
            confidence: 1,
            box: {
              x: blob.minX / frame.width,
              y: blob.minY / frame.height,
              width: (blob.maxX - blob.minX) / frame.width,
              height: (blob.maxY - blob.minY) / frame.height,
            },
          });
        }
      }

      if (detections.length === 0) {
        this.consecutiveEmpty++;
      } else {
        this.consecutiveEmpty = 0;
      }

      if (this.consecutiveEmpty > 10) {
        this.consecutiveEmpty = 0;
      }

      return {
        detected: detections.length > 0,
        detections,
      };
    } finally {
      session.processing = false;
    }
  }

  resetState(): void {
    this.cleanup();
    this.consecutiveEmpty = 0;
  }

  private initializeStreams(width: number, height: number): StreamSession {
    const difference = this.storage.values.difference;
    const percentage = this.storage.values.percentage;
    const pt = new PassThrough({ highWaterMark: 1024 * 1024 });
    const p2p = new P2P();
    const pamDiff = new PamDiff({
      difference,
      percent: percentage,
      response: 'blobs',
    });

    pt.pipe(p2p).pipe(pamDiff);

    const blobs: PamDiff.Blob[] = [];
    pamDiff.on('diff', (data) => {
      for (const trigger of data.trigger) {
        if (trigger.blobs) {
          blobs.push(...trigger.blobs);
        }
      }
    });

    return {
      pt,
      p2p,
      pamDiff,
      blobs,
      processing: false,
      lastWidth: width,
      lastHeight: height,
    };
  }

  private cleanup(): void {
    if (this.streamSession) {
      try {
        this.streamSession.pt.unpipe();
        this.streamSession.p2p.unpipe();
        this.streamSession.pt.destroy();
        this.streamSession.p2p.destroy();
        this.streamSession.pamDiff.destroy();
      } catch {
        // ignore
      }
      this.streamSession = undefined;
    }
  }

  private reconfigure(): void {
    this.cleanup();
  }

  private async resetToDefaults(): Promise<void> {
    if (this.storage) {
      await this.storage.setValue('difference', DEFAULT_DIFFERENCE);
      await this.storage.setValue('percentage', DEFAULT_PERCENTAGE);
      await this.storage.setValue('mode', DEFAULT_MODE);
    }
  }
}
