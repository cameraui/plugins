/** Charging is deliberately not an exemption: doorbell wiring can be trickle-only. */
export function canRecordOnBattery(sensors: { level: unknown; low: unknown }[]): boolean {
  return sensors.length > 0 && sensors.every(({ level, low }) => typeof level === 'number' && Number.isFinite(level) && level > 20 && low !== true);
}
