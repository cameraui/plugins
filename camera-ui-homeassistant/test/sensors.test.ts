import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SensorType } from '@camera.ui/sdk';
import HomeAssistant from '../src/index.js';
import { applyEntityState, createImportedSensor, entityUnavailable, importableSensorType } from '../src/sensors.js';
import type { HaState } from '../src/types.js';

const state = (value: string, entity_id = 'binary_sensor.doorbell'): HaState => ({
  entity_id,
  state: value,
  attributes: { device_class: 'sound' },
  last_changed: '',
});

function doorbell() {
  const imported = createImportedSensor({ type: SensorType.Doorbell, name: 'Bell', nativeId: 'id' }, () => async () => {});
  assert.ok(imported?.kind === 'doorbell');
  let rings = 0;
  imported.sensor.trigger = () => {
    rings++;
  };
  return { imported, rings: () => rings };
}

test('sound is an audio sensor unless explicitly assigned as a binary doorbell', () => {
  assert.equal(importableSensorType(state('off')), SensorType.Audio);
  assert.equal(importableSensorType(state('off'), true), SensorType.Doorbell);
  assert.equal(importableSensorType(state('off', 'sensor.unsupported'), true), undefined);
  const imported = createImportedSensor({ type: SensorType.Audio, name: 'Sound', nativeId: 'id' }, () => async () => {});
  assert.ok(imported?.kind === 'audio');
  applyEntityState(imported, state('on'), true);
  assert.equal(imported.sensor.detected, true);
  applyEntityState(imported, state('off'), true);
  assert.equal(imported.sensor.detected, false);
});

test('binary doorbell rings once per live off-to-on transition', () => {
  const bell = doorbell();
  applyEntityState(bell.imported, state('off'), false);
  for (const value of ['on', 'on', 'off']) applyEntityState(bell.imported, state(value), true);
  assert.equal(bell.rings(), 1);
  applyEntityState(bell.imported, state('on'), true);
  assert.equal(bell.rings(), 2);
});

test('initial state, sync and unknown/unavailable recovery never ring', () => {
  const bell = doorbell();
  applyEntityState(bell.imported, state('on'), true);
  applyEntityState(bell.imported, state('off'), false);
  applyEntityState(bell.imported, state('on'), false);
  applyEntityState(bell.imported, state('on'), true);
  for (const invalid of ['unknown', 'unavailable']) {
    applyEntityState(bell.imported, state('off'), true);
    assert.equal(entityUnavailable(bell.imported, state(invalid)), true);
    // Exercise the runtime availability gate, which must invalidate the prior state.
    const plugin = Object.create(HomeAssistant.prototype);
    plugin.applyState({ imported: bell.imported }, state(invalid), true);
    plugin.applyState({ imported: bell.imported }, state('on'), true);
  }
  assert.equal(bell.rings(), 0);
});

test('disconnect resets the binary doorbell baseline', () => {
  const bell = doorbell();
  applyEntityState(bell.imported, state('off'), false);
  const plugin = Object.create(HomeAssistant.prototype);
  plugin.bound = new Map([['id', { entityId: 'binary_sensor.doorbell', imported: bell.imported }]]);
  plugin.markAllUnavailable();
  applyEntityState(bell.imported, state('on'), true);
  assert.equal(bell.rings(), 0);
});

test('event doorbells still ring on changed live timestamps', () => {
  const bell = doorbell();
  applyEntityState(bell.imported, state('first', 'event.doorbell'), false);
  applyEntityState(bell.imported, state('second', 'event.doorbell'), true);
  applyEntityState(bell.imported, state('second', 'event.doorbell'), true);
  assert.equal(bell.rings(), 1);
});
