export function getPayloadType(message: Buffer): number {
  return message.readUInt8(1) & 0x7f;
}

export function isRtpMessagePayloadType(payloadType: number): boolean {
  return payloadType > 90 || payloadType === 0;
}

export function getSsrc(message: Buffer): number | null {
  try {
    const payloadType = getPayloadType(message),
      isRtp = isRtpMessagePayloadType(payloadType);
    return message.readUInt32BE(isRtp ? 8 : 4);
  } catch {
    return null;
  }
}
