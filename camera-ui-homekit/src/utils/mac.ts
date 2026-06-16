import crypto from 'node:crypto';

const validMac = /^([0-9A-F]{2}:){5}([0-9A-F]{2})$/;

function rd(): number {
  return Math.round(Math.random() * 100000) % 10;
}

export type MacAddress = string;

export function validMacAddress(address: string): boolean {
  return validMac.test(address);
}

export function generate(data: string | Buffer | NodeJS.TypedArray | DataView): MacAddress {
  const sha1sum = crypto.createHash('sha1');
  sha1sum.update(data);
  const s = sha1sum.digest('hex');

  let i = 0;
  return 'xx:xx:xx:xx:xx:xx'.replace(/[x]/g, () => s[i++]).toUpperCase();
}

export function randomPinCode(): string {
  return `${rd()}${rd()}${rd()}-${rd()}${rd()}-${rd()}${rd()}${rd()}`;
}
