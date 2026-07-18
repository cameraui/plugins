import { beforeEach, describe, expect, it, vi } from 'vitest';

const streaming = vi.hoisted(() => ({
  instances: [] as any[],
  prepare: vi.fn(),
  activate: vi.fn(),
  stop: vi.fn(),
}));

vi.mock('../src/camera/streamingSession.js', () => ({
  StreamingSession: class {
    start = Date.now();
    audioSplitter = { port: 1000 };
    videoSplitter = { port: 1001 };
    audioSsrc = 1;
    videoSsrc = 2;
    audioSrtp = { srtp_key: Buffer.alloc(16), srtp_salt: Buffer.alloc(14) };
    videoSrtp = { srtp_key: Buffer.alloc(16), srtp_salt: Buffer.alloc(14) };
    prepare = streaming.prepare;
    activate = streaming.activate;
    stop = streaming.stop;

    constructor() {
      streaming.instances.push(this);
    }
  },
}));

import { StreamRequestTypes } from '../src/hap.js';
import { StreamingDelegate } from '../src/camera/streamingDelegate.js';

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function createDelegate(): StreamingDelegate {
  const logger = {
    debug: vi.fn(),
    log: vi.fn(),
    error: vi.fn(),
  };
  const cameraDevice = {
    logger,
    streamSource: { snapshot: vi.fn() },
  };
  return new StreamingDelegate({} as never, cameraDevice as never);
}

async function prepare(delegate: StreamingDelegate, sessionID = 'session'): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    delegate.prepareStream({ sessionID } as never, (error?: Error) => (error ? reject(error) : resolve()));
  });
}

describe('StreamingDelegate lifecycle', () => {
  beforeEach(() => {
    streaming.instances.length = 0;
    streaming.prepare.mockReset().mockResolvedValue(undefined);
    streaming.activate.mockReset().mockResolvedValue(undefined);
    streaming.stop.mockReset().mockResolvedValue(undefined);
  });

  it('stops a session when prepare fails', async () => {
    const error = new Error('prepare failed');
    streaming.prepare.mockRejectedValue(error);
    const delegate = createDelegate();

    await expect(prepare(delegate)).rejects.toBe(error);
    expect(streaming.stop).toHaveBeenCalledTimes(1);
  });

  it('removes and stops a session when activation fails', async () => {
    const error = new Error('activate failed');
    streaming.activate.mockRejectedValue(error);
    const delegate = createDelegate();
    await prepare(delegate);

    await new Promise<void>((resolve) => {
      delegate.handleStreamRequest({ sessionID: 'session', type: StreamRequestTypes.START } as never, (callbackError?: Error) => {
        expect(callbackError).toBe(error);
        resolve();
      });
    });

    expect(streaming.stop).toHaveBeenCalledTimes(1);
    await new Promise<void>((resolve) => {
      delegate.handleStreamRequest({ sessionID: 'session', type: StreamRequestTypes.STOP } as never, (callbackError?: Error) => {
        expect(callbackError).toBeInstanceOf(Error);
        resolve();
      });
    });
  });

  it('awaits prepared sessions during cleanup', async () => {
    const stopped = deferred();
    streaming.stop.mockReturnValue(stopped.promise);
    const delegate = createDelegate();
    await prepare(delegate);

    let finished = false;
    const cleanup = delegate.cleanup().then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);

    stopped.resolve();
    await cleanup;
    expect(finished).toBe(true);
  });

  it('stops a prepare that completes after cleanup', async () => {
    const prepared = deferred();
    streaming.prepare.mockReturnValue(prepared.promise);
    const delegate = createDelegate();
    const callback = vi.fn();
    delegate.prepareStream({ sessionID: 'session' } as never, callback);

    await delegate.cleanup();
    prepared.resolve();
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(expect.any(Error)));
    expect(streaming.stop).toHaveBeenCalledTimes(1);
  });
});
