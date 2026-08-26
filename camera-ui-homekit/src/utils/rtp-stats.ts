import type { RtpPacket } from 'werift';

export interface RtpSenderState {
  timestamp: number;
  wallclock: number;
  packets: number;
  octets: number;
  lastTransit?: number;
  pacingJitterMs: number;
  pacingJitterMaxMs: number;
}

export function recordRtpPacket(state: RtpSenderState | undefined, rtp: RtpPacket, clockRate: number): RtpSenderState {
  const wallclock = Date.now();
  const transit = wallclock - (rtp.header.timestamp / clockRate) * 1000;

  let pacingJitterMs = state?.pacingJitterMs ?? 0;
  if (state?.lastTransit !== undefined) {
    const deviation = Math.abs(transit - state.lastTransit);
    if (deviation < 10_000) {
      pacingJitterMs += (deviation - pacingJitterMs) / 16;
    }
  }

  return {
    timestamp: rtp.header.timestamp,
    wallclock,
    packets: (state?.packets ?? 0) + 1,
    octets: (state?.octets ?? 0) + rtp.payload.length,
    lastTransit: transit,
    pacingJitterMs,
    pacingJitterMaxMs: Math.max(state?.pacingJitterMaxMs ?? 0, pacingJitterMs),
  };
}

export interface RtcpReceiverStats {
  rrCount: number;
  packetsLost: number;
  fractionLostMax: number;
  jitterSum: number;
  jitterMax: number;
  jitterCount: number;
  rttSumMs: number;
  rttMaxMs: number;
  rttCount: number;
  pliCount: number;
}

export function createReceiverStats(): RtcpReceiverStats {
  return { rrCount: 0, packetsLost: 0, fractionLostMax: 0, jitterSum: 0, jitterMax: 0, jitterCount: 0, rttSumMs: 0, rttMaxMs: 0, rttCount: 0, pliCount: 0 };
}

export function summarizeReceiverStats(label: string, stats: RtcpReceiverStats, sender: RtpSenderState | undefined, clockRate: number): string {
  const sent = sender?.packets ?? 0;
  if (sent === 0) return `${label}: nothing sent`;

  const parts: string[] = [];
  if (stats.rrCount === 0) {
    parts.push(`${label}: sent ${sent}, no receiver reports`);
  } else {
    const lossPct = ((stats.packetsLost / sent) * 100).toFixed(1);
    const jitterAvg = stats.jitterCount > 0 ? Math.round((stats.jitterSum / stats.jitterCount / clockRate) * 1000) : 0;
    const jitterMax = Math.round((stats.jitterMax / clockRate) * 1000);
    parts.push(`${label}: loss ${lossPct}% (${stats.packetsLost} of ${sent})`, `jitter avg ${jitterAvg}ms max ${jitterMax}ms`);
    if (stats.rttCount > 0) parts.push(`rtt avg ${Math.round(stats.rttSumMs / stats.rttCount)}ms max ${Math.round(stats.rttMaxMs)}ms`);
    if (stats.pliCount > 0) parts.push(`${stats.pliCount} keyframe requests`);
  }
  if (sender) parts.push(`pacing avg ${Math.round(sender.pacingJitterMs)}ms max ${Math.round(sender.pacingJitterMaxMs)}ms`);
  return parts.join(', ');
}

const NTP_EPOCH_OFFSET_S = 2208988800;

export function ntpMiddle32(wallclockMs: number): number {
  return Math.round((wallclockMs / 1000 + NTP_EPOCH_OFFSET_S) * 65536) >>> 0;
}

export function ntpTimestamp(wallclockMs: number): bigint {
  const seconds = wallclockMs / 1000 + NTP_EPOCH_OFFSET_S;
  const whole = Math.floor(seconds);
  const fraction = Math.round((seconds - whole) * 0xffffffff);
  return (BigInt(whole) << 32n) | BigInt(fraction);
}
