import { describe, expect, it, vi } from 'vitest';

import { RecordingSession } from '../src/camera/recordingSession.js';

function fakeSession() {
  return {
    initSegment: Promise.resolve(Buffer.from('init')),
    onError: { subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })) },
    onEnded: { subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })) },
    startStream: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    streamBoxes: async function* (signal?: AbortSignal) {
      await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Condition was not reached');
}

describe('RecordingSession failure isolation', () => {
  it('restarts only the affected camera after repeated HKSV failures', async () => {
    const first = fakeSession();
    const second = fakeSession();
    const createFmp4Session = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const cameraAccessory = { cameraStorage: { values: { useHardwareAcceleration: false } } };
    const cameraDevice = {
      streamSource: { createFmp4Session },
      connected: true,
      disabled: false,
    };
    const recording = new RecordingSession(cameraAccessory as never, cameraDevice as never, logger as never);

    recording.updateRecordingConfiguration({
      prebufferLength: 4000,
      mediaContainerConfiguration: { fragmentLength: 4000 },
      videoCodec: { resolution: [1920, 1080, 30], parameters: { bitRate: 2000 } },
    } as never);
    recording.updateRecordingActive(true);
    await waitFor(() => createFmp4Session.mock.calls.length === 1);

    recording.reportRecordingFailure();
    recording.reportRecordingFailure();
    recording.reportRecordingFailure();
    await waitFor(() => createFmp4Session.mock.calls.length === 2);

    expect(first.stop).toHaveBeenCalledTimes(1);
    expect(second.stop).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('[HKSV]', "Repeated HKSV recording failures; restarting this camera's FMP4 session");

    await recording.stop();
  });
});
