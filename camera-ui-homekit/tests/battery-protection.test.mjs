import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RecordingSession } from '../dist/camera/recordingSession.js';
import { canRecordOnBattery } from '../dist/utils/battery-policy.js';
import { BatterySnapshotCache } from '../dist/utils/battery-snapshot.js';

const settle = () => new Promise((resolve) => setImmediate(resolve));
function fixture({ battery = true, allowed = true, fail = false, startGate } = {}) {
  const calls = { start: 0, stop: 0 };
  const accessory = { batteryPowered: battery, batteryRecordingAllowed: allowed, secureVideoCodec: 'h264', cameraStorage: { values: {} } };
  const event = { subscribe: () => ({ unsubscribe() {} }) };
  const camera = {
    disabled: false,
    connected: true,
    streamSource: {
      createFmp4Session() {
        return {
          onError: event,
          onEnded: event,
          initSegment: Promise.resolve(Buffer.from('init')),
          async startStream() {
            calls.start++;
            if (startGate) await startGate;
            if (fail) throw new Error('offline');
          },
          async stop() {
            calls.stop++;
          },
          async *streamBoxes(signal) {
            yield* [];
            if (!signal.aborted) await new Promise((r) => signal.addEventListener('abort', r, { once: true }));
          },
        };
      },
    },
  };
  const session = new RecordingSession(accessory, camera, { debug() {}, error() {}, warn() {} });
  session.updateRecordingConfiguration({
    prebufferLength: 4000,
    mediaContainerConfiguration: { fragmentLength: 4000 },
    videoCodec: { resolution: [640, 360, 15], parameters: { bitRate: 300 } },
  });
  session.updateRecordingActive(true);
  return { session, calls, accessory, camera };
}

test('battery camera never starts or retries an idle prebuffer, even while recording is enabled', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture();
  await settle();
  f.session.refreshPrebuffer();
  f.session.resumePrebuffer();
  t.mock.timers.tick(300000);
  await settle();
  assert.equal(f.calls.start, 0);
  await f.session.stop();
});

test('mains camera retains automatic prebuffering', async () => {
  const f = fixture({ battery: false });
  await settle();
  assert.equal(f.calls.start, 1);
  await f.session.stop();
});

test('battery event recording starts on demand and stops when the consumer finishes', async () => {
  const f = fixture();
  const recording = f.session.getRecordingStream();
  assert.equal((await recording.next()).value.toString(), 'init');
  assert.equal(f.calls.start, 1);
  await recording.return();
  assert.equal(f.calls.stop, 1);
  await assert.rejects(f.session.getRecordingStream().next(), /cooling down/);
  assert.equal(f.calls.start, 1);
  await f.session.stop();
});

test('low or unknown battery refuses an automatic recording without opening a stream', async () => {
  const f = fixture({ allowed: false });
  await assert.rejects(f.session.getRecordingStream().next(), /low\/unknown battery/);
  assert.equal(f.calls.start, 0);
  await f.session.stop();
});

test('battery drop closes active recording and does not schedule reconnection', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture();
  const recording = f.session.getRecordingStream();
  await recording.next();
  f.accessory.batteryRecordingAllowed = false;
  f.session.refreshBatteryState();
  await settle();
  assert.equal(f.calls.stop, 1);
  t.mock.timers.tick(300000);
  await settle();
  assert.equal(f.calls.start, 1);
  await recording.return();
  await f.session.stop();
});

test('battery recording has a hard sixty-second limit', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture();
  const recording = f.session.getRecordingStream();
  await recording.next();
  t.mock.timers.tick(60000);
  await settle();
  assert.equal(f.calls.stop, 1);
  t.mock.timers.tick(120000);
  await settle();
  assert.equal(f.calls.start, 1);
  await recording.return();
  await f.session.stop();
});

test('failed battery startup closes resources and does not loop', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture({ fail: true });
  await assert.rejects(f.session.getRecordingStream().next(), /offline/);
  assert.equal(f.calls.stop, 1);
  t.mock.timers.tick(300000);
  await settle();
  assert.equal(f.calls.start, 1);
  await f.session.stop();
});

test('battery preview does not wake an idle source', async () => {
  let snapshots = 0;
  const camera = {
    streamSource: {
      getStreamStatus: async () => 'idle',
      snapshot: async () => {
        snapshots++;
      },
    },
  };
  assert.equal(await new BatterySnapshotCache().get(camera), undefined);
  assert.equal(snapshots, 0);
});

test('battery preview coalesces requests and reuses its image while asleep', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  let state = 'connected',
    snapshots = 0;
  const camera = {
    streamSource: {
      getStreamStatus: async () => state,
      snapshot: async (force) => {
        assert.equal(force, false);
        snapshots++;
        return Uint8Array.from([1, 2, 3]).buffer;
      },
    },
  };
  const cache = new BatterySnapshotCache();
  const images = await Promise.all([cache.get(camera), cache.get(camera)]);
  assert.equal(snapshots, 1);
  assert.deepEqual(images[0], Buffer.from([1, 2, 3]));
  state = 'idle';
  t.mock.timers.tick(61000);
  assert.deepEqual(await cache.get(camera), images[0]);
  assert.equal(snapshots, 1);
});

test('reported battery boundaries and alerts fail closed', () => {
  for (const level of [undefined, null, NaN, -1, 0, 20]) assert.equal(canRecordOnBattery([{ level, low: false }]), false);
  assert.equal(canRecordOnBattery([]), false);
  assert.equal(canRecordOnBattery([{ level: 90, low: true }]), false);
  assert.equal(canRecordOnBattery([{ level: 21, low: false }]), true);
});

test('overlapping consumers share the source until the last one finishes', async () => {
  const f = fixture();
  const first = f.session.getRecordingStream();
  const second = f.session.getClipStream({});
  await first.next();
  await second.next();
  assert.equal(f.calls.start, 1);
  await first.return();
  assert.equal(f.calls.stop, 0);
  await second.return();
  assert.equal(f.calls.stop, 1);
  await f.session.stop();
});

test('aborted demand during startup closes the source without reconnecting', async () => {
  let ready;
  const startGate = new Promise((r) => {
    ready = r;
  });
  const f = fixture({ startGate });
  const abort = new AbortController();
  const request = f.session.getRecordingStream(abort.signal).next();
  const rejected = assert.rejects(request);
  await settle();
  abort.abort();
  ready();
  await rejected;
  assert.equal(f.calls.stop, 1);
  await f.session.stop();
});

test('a late consumer release cannot stop a newer battery session', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture();
  const old = f.session.getRecordingStream();
  await old.next();
  t.mock.timers.tick(60000);
  await settle();
  t.mock.timers.tick(31000);
  const current = f.session.getRecordingStream();
  await current.next();
  assert.equal(f.calls.start, 2);
  await old.return();
  assert.equal(f.calls.stop, 1);
  await current.return();
  assert.equal(f.calls.stop, 2);
  await f.session.stop();
});
