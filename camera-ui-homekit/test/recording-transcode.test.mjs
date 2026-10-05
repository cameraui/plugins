import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RecordingSession } from '../dist/camera/recordingSession.js';

for (const [name, codec, force, expected] of [
  ['existing cameras keep H.264 copy support', 'h264', undefined, ['h264']],
  ['disabled setting keeps H.264 copy support', 'h264', false, ['h264']],
  ['enabled setting forces classic HKSV video encoding', 'h264', true, []],
  ['HEVC path keeps both copy-compatible codecs', 'hevc', false, ['h264', 'hevc']],
  ['stored opt-in does not convert an HKSV3 session to H.264', 'hevc', true, ['h264', 'hevc']],
]) {
  test(name, async () => {
    let options;
    const session = {
      onError: { subscribe: () => ({ unsubscribe() {} }) },
      onEnded: { subscribe: () => ({ unsubscribe() {} }) },
      startStream: async (value) => { options = value; },
      stop: async () => {},
    };
    const accessory = {
      secureVideoCodec: codec,
      cameraStorage: { values: {
        forceVideoTranscodingForRecording: force,
        useHardwareAccelerationForRecording: true,
      } },
    };
    const camera = { streamSource: { createFmp4Session: () => session } };
    const logger = { debug() {}, warn() {}, error() {} };
    const recording = new RecordingSession(accessory, camera, logger);
    recording.updateRecordingConfiguration({
      mediaContainerConfiguration: { fragmentLength: 4000 },
      prebufferLength: 8000,
      videoCodec: { resolution: [1920, 1080, 24], parameters: { bitRate: 1600 } },
    });
    try {
      // Exercise the actual options passed by the recording session, without
      // creating network streams or requiring a HomeKit controller.
      await recording.startSession();
      assert.deepEqual(options.supportedVideoCodecs, expected);
      assert.deepEqual(options.supportedAudioCodecs, ['aac']);
      assert.deepEqual(options.video, { width: 1920, height: 1080, fps: 24, bitrate: 1_600_000 });
      assert.equal(options.fragDuration, 4_000_000);
      assert.equal(options.hardware, 'auto');
    } finally {
      await recording.stop();
    }
  });
}
