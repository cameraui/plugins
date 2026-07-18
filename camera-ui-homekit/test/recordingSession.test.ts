import { describe, expect, it, vi } from 'vitest';

import { RecordingSession } from '../src/camera/recordingSession.js';

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function observable() {
  return {
    subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
  };
}

function fakeFmp4Session(startStream = vi.fn().mockResolvedValue(undefined)) {
  return {
    initSegment: Promise.resolve(Buffer.from('init')),
    onError: observable(),
    onEnded: observable(),
    startStream,
    stop: vi.fn().mockResolvedValue(undefined),
    streamBoxes: async function* (signal?: AbortSignal) {
      await new Promise<void>((resolve) => {
        if (signal?.aborted) {
          resolve();
        } else {
          signal?.addEventListener('abort', () => resolve(), { once: true });
        }
      });
    },
  };
}

function configuration() {
  return {
    prebufferLength: 4000,
    mediaContainerConfiguration: { fragmentLength: 4000 },
    videoCodec: {
      resolution: [1920, 1080, 30],
      parameters: { bitRate: 2000 },
    },
  };
}

function createRecordingSession(createFmp4Session = vi.fn(() => fakeFmp4Session())) {
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  };
  const cameraAccessory = {
    cameraStorage: { values: { useHardwareAcceleration: true } },
  };
  const cameraDevice = {
    streamSource: { createFmp4Session },
  };

  return {
    recording: new RecordingSession(cameraAccessory as never, cameraDevice as never, logger as never),
    logger,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Condition was not reached');
}

describe('RecordingSession lifecycle', () => {
  it('stops the old session before starting a replacement', async () => {
    const events: string[] = [];
    const first = fakeFmp4Session(vi.fn(async () => events.push('first:start')));
    first.stop.mockImplementation(async () => {
      events.push('first:stop');
    });
    const second = fakeFmp4Session(vi.fn(async () => events.push('second:start')));
    const createFmp4Session = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const { recording } = createRecordingSession(createFmp4Session);

    recording.updateRecordingConfiguration(configuration() as never);
    recording.updateRecordingActive(true);
    await waitFor(() => events.includes('first:start'));
    recording.updateRecordingConfiguration(configuration() as never);
    await waitFor(() => events.includes('second:start'));

    expect(events.indexOf('first:stop')).toBeLessThan(events.indexOf('second:start'));
    expect(createFmp4Session).toHaveBeenCalledTimes(2);
    await recording.stop();
  });

  it('cleans up a session whose start fails', async () => {
    const startError = new Error('start failed');
    const session = fakeFmp4Session(vi.fn().mockRejectedValue(startError));
    const { recording } = createRecordingSession(vi.fn(() => session));

    recording.updateRecordingConfiguration(configuration() as never);
    recording.updateRecordingActive(true);
    await waitFor(() => session.stop.mock.calls.length === 1);

    expect(session.stop).toHaveBeenCalledTimes(1);
    await recording.stop();
  });

  it('does not restart when stopped while a session is starting', async () => {
    const started = deferred<void>();
    const session = fakeFmp4Session(vi.fn(() => started.promise));
    const createFmp4Session = vi.fn(() => session);
    const { recording } = createRecordingSession(createFmp4Session);

    recording.updateRecordingConfiguration(configuration() as never);
    recording.updateRecordingActive(true);
    await waitFor(() => session.startStream.mock.calls.length === 1);
    const stopped = recording.stop();
    started.resolve();
    await stopped;

    expect(session.stop).toHaveBeenCalledTimes(1);
    expect(createFmp4Session).toHaveBeenCalledTimes(1);
  });

  it('aborts immediately while waiting for the init segment', async () => {
    const init = deferred<Buffer>();
    const session = fakeFmp4Session();
    session.initSegment = init.promise;
    const { recording } = createRecordingSession(vi.fn(() => session));
    recording.updateRecordingConfiguration(configuration() as never);
    recording.updateRecordingActive(true);
    await waitFor(() => session.startStream.mock.calls.length === 1);

    const abort = new AbortController();
    const removeEventListener = vi.spyOn(abort.signal, 'removeEventListener');
    const next = recording.getRecordingStream(abort.signal).next();
    abort.abort();

    await expect(next).resolves.toEqual({ done: true, value: undefined });
    expect(removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function));
    await recording.stop();
  });

  it('ends only the current recording when its live queue exceeds eight fragments', async () => {
    const session = fakeFmp4Session();
    const { recording } = createRecordingSession(vi.fn(() => session));
    recording.updateRecordingConfiguration(configuration() as never);
    recording.updateRecordingActive(true);
    await waitFor(() => session.startStream.mock.calls.length === 1);

    const iterator = recording.getRecordingStream();
    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    for (let index = 0; index < 9; index += 1) {
      (recording as unknown as { pushBox(box: Buffer): void }).pushBox(Buffer.from(`box-${index}`));
    }

    await expect(iterator.next()).rejects.toThrow('recording ended after 8 queued fragments');
    expect(session.stop).not.toHaveBeenCalled();
    await recording.stop();
    expect(session.stop).toHaveBeenCalledTimes(1);
  });
});
