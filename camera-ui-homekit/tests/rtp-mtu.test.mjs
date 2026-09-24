import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RtpHeader, RtpPacket, SrtpSession } from 'werift';
import { getVideoRtpMtu } from '../src/utils/rtp.ts';

for (const negotiated of [1378, 1200, 1100]) {
  test(`encrypted RTP remains within negotiated ${negotiated}-byte limit`, () => {
    const key = Buffer.alloc(16, 7), salt = Buffer.alloc(14, 9);
    const config = { keys: { localMasterKey: key, localMasterSalt: salt, remoteMasterKey: key, remoteMasterSalt: salt }, profile: 1 };
    const packet = new RtpPacket(new RtpHeader({ payloadType: 99, sequenceNumber: 10, timestamp: 1000, ssrc: 42 }), Buffer.alloc(getVideoRtpMtu(negotiated) - 12, 0x65));
    const encrypted = new SrtpSession(config).encrypt(packet.payload, packet.header);
    assert.ok(encrypted.length <= negotiated, `${encrypted.length} exceeds ${negotiated}`);
    assert.ok(encrypted.length <= 1210);
    const decrypted = RtpPacket.deSerialize(new SrtpSession(config).decrypt(encrypted));
    assert.deepEqual(decrypted.payload, packet.payload);
  });
}
