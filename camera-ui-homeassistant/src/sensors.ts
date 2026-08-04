import { DoorbellTrigger, MotionSensor, Sensor } from '@camera.ui/sdk';

import { applyControlState, controlKindForEntity, createControl } from './controls.js';
import { entityDisplayName, mapEntity } from './mapping.js';
import { importOptions } from './types.js';

import type { SensorCategory, SensorMeta, SensorType } from '@camera.ui/sdk';
import type { CommandFn, ControlKind, HaControl } from './controls.js';
import type { HaState } from './types.js';

export class ImportedStateSensor extends Sensor<Record<string, unknown>> {
  readonly type: SensorType;
  readonly category: SensorCategory;

  private readonly stateProperty: string;

  constructor(meta: SensorMeta, name: string, nativeId: string) {
    super(name, importOptions(nativeId));
    this.type = meta.type;
    this.category = meta.category;
    this.stateProperty = meta.semantics!.stateProperty;

    const initial = meta.virtual?.properties?.[this.stateProperty] ?? (meta.properties[this.stateProperty]?.type === 'number' ? 0 : false);
    this._writeState({ [this.stateProperty]: initial });
  }

  writeStateValue(value: boolean | number): void {
    this._writeState({ [this.stateProperty]: value });
  }

  updateValue(): void {}
}

export type ImportedSensor =
  | { kind: 'binary' | 'measurement'; sensor: ImportedStateSensor }
  | { kind: 'motion'; sensor: MotionSensor }
  | { kind: 'doorbell'; sensor: DoorbellTrigger; lastEventState?: string }
  | { kind: 'control'; controlKind: ControlKind; sensor: HaControl };

export function createImportedSensor(state: HaState, commandFor: (kind: ControlKind) => CommandFn): ImportedSensor | undefined {
  const name = entityDisplayName(state);
  const nativeId = state.entity_id;

  const controlKind = controlKindForEntity(state);
  if (controlKind) {
    return { kind: 'control', controlKind, sensor: createControl(controlKind, name, nativeId, commandFor(controlKind)) };
  }

  const mapping = mapEntity(state);
  if (!mapping) return undefined;

  if (mapping.kind === 'motion') {
    return { kind: 'motion', sensor: new MotionSensor(name, importOptions(nativeId)) };
  }
  if (mapping.kind === 'doorbell') {
    return { kind: 'doorbell', sensor: new DoorbellTrigger(name, importOptions(nativeId)) };
  }
  return { kind: mapping.kind, sensor: new ImportedStateSensor(mapping.meta, name, nativeId) };
}

export function applyEntityState(imported: ImportedSensor, state: HaState, live: boolean): void {
  if (state.state === 'unavailable' || state.state === 'unknown') return;

  if (imported.kind === 'control') {
    applyControlState(imported.controlKind, imported.sensor, state);
    return;
  }

  if (imported.kind === 'doorbell') {
    // an event entity's state is the last-trigger timestamp: only a live change
    // is a press, syncs and reconnect replays just seed the baseline
    const changed = imported.lastEventState !== undefined && imported.lastEventState !== state.state;
    imported.lastEventState = state.state;
    if (live && changed) imported.sensor.trigger();
    return;
  }

  if (imported.kind === 'motion') {
    imported.sensor.reportDetections(state.state === 'on');
    return;
  }

  if (imported.kind === 'binary') {
    imported.sensor.writeStateValue(state.state === 'on');
    return;
  }

  const value = Number(state.state);
  if (!Number.isNaN(value)) {
    imported.sensor.writeStateValue(value);
  }
}
