// Track Fragment Decode Time offsets per recording: track_ID → first tfdt seen.
export type TfdtOffsets = Map<number, bigint>;

export function normalizeFragmentTfdt(fragment: Buffer, offsets: TfdtOffsets): Buffer {
  const out = Buffer.from(fragment);

  eachBox(out, 0, out.length, (type, _boxStart, contentStart, boxEnd) => {
    if (type !== 'moof') return;

    eachBox(out, contentStart, boxEnd, (trafType, _trafStart, trafContent, trafEnd) => {
      if (trafType !== 'traf') return;

      let trackId: number | undefined;
      let tfdtStart: number | undefined;

      eachBox(out, trafContent, trafEnd, (childType, childStart, childContent) => {
        if (childType === 'tfhd') {
          trackId = out.readUInt32BE(childContent + 4); // after version(1) + flags(3)
        } else if (childType === 'tfdt') {
          tfdtStart = childStart;
        }
      });

      if (trackId === undefined || tfdtStart === undefined) return;

      const version = out.readUInt8(tfdtStart + 8);
      const valuePos = tfdtStart + 12;
      const current = version === 1 ? out.readBigUInt64BE(valuePos) : BigInt(out.readUInt32BE(valuePos));

      if (!offsets.has(trackId)) {
        offsets.set(trackId, current);
      }

      let rebased = current - offsets.get(trackId)!;
      if (rebased < 0n) {
        rebased = 0n;
      }

      if (version === 1) {
        out.writeBigUInt64BE(rebased, valuePos);
      } else {
        out.writeUInt32BE(Number(rebased), valuePos);
      }
    });
  });

  return out;
}

const NTP_EPOCH_OFFSET_SECONDS = 2_208_988_800n;

export function ntpToMilliseconds(ntp: bigint): number {
  const seconds = Number((ntp >> 32n) - NTP_EPOCH_OFFSET_SECONDS);
  const fraction = Number(ntp & 0xffffffffn) / 0x100000000;
  return (seconds + fraction) * 1000;
}

// tvOS 27 hubs read the fragment wall clock from prft and crash homed when it is missing
export function prependProducerReferenceTime(fragment: Buffer, startedAt: number): Buffer {
  let trackId: number | undefined;
  let mediaTime: bigint | undefined;

  eachBox(fragment, 0, fragment.length, (type, _boxStart, contentStart, boxEnd) => {
    if (type !== 'moof' || trackId !== undefined) return;

    eachBox(fragment, contentStart, boxEnd, (trafType, _trafStart, trafContent, trafEnd) => {
      if (trafType !== 'traf' || trackId !== undefined) return;

      eachBox(fragment, trafContent, trafEnd, (childType, childStart, childContent) => {
        if (childType === 'tfhd') {
          trackId = fragment.readUInt32BE(childContent + 4);
        } else if (childType === 'tfdt') {
          const version = fragment.readUInt8(childStart + 8);
          mediaTime = version === 1 ? fragment.readBigUInt64BE(childStart + 12) : BigInt(fragment.readUInt32BE(childStart + 12));
        }
      });
    });
  });

  if (trackId === undefined || mediaTime === undefined) {
    return fragment;
  }

  const milliseconds = BigInt(Math.max(0, Math.round(startedAt)));
  const ntpSeconds = milliseconds / 1000n + NTP_EPOCH_OFFSET_SECONDS;
  const ntpFraction = ((milliseconds % 1000n) << 32n) / 1000n;

  const prft = Buffer.alloc(32);
  prft.writeUInt32BE(32, 0);
  prft.write('prft', 4, 'latin1');
  prft.writeUInt8(1, 8);
  prft.writeUInt32BE(trackId, 12);
  prft.writeBigUInt64BE((ntpSeconds << 32n) | ntpFraction, 16);
  prft.writeBigUInt64BE(mediaTime, 24);

  return Buffer.concat([prft, fragment]);
}

function eachBox(buf: Buffer, start: number, end: number, cb: (type: string, boxStart: number, contentStart: number, boxEnd: number) => void): void {
  let pos = start;
  while (pos + 8 <= end) {
    const size = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);

    let contentStart = pos + 8;
    let boxEnd: number;
    if (size === 1) {
      if (pos + 16 > end) break;
      boxEnd = pos + Number(buf.readBigUInt64BE(pos + 8));
      contentStart = pos + 16;
    } else if (size === 0) {
      boxEnd = end;
    } else {
      boxEnd = pos + size;
    }

    if (boxEnd <= pos || boxEnd > end) break;
    cb(type, pos, contentStart, boxEnd);
    pos = boxEnd;
  }
}
