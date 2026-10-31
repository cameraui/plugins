import assert from 'node:assert/strict';
import { test } from 'node:test';

import HomeAssistant from '../src/index.js';

import type { StorageValues } from '../src/types.js';

function discovery(values: StorageValues = {}) {
  // Exercise the real discovery path without starting a Home Assistant connection.
  const plugin = Object.create(HomeAssistant.prototype) as HomeAssistant;
  const states = [
    { entity_id: 'binary_sensor.hallway', state: 'off', attributes: { device_class: 'motion' } },
    { entity_id: 'binary_sensor.kitchen', state: 'off', attributes: { device_class: 'motion' } },
    { entity_id: 'binary_sensor.own', state: 'off', attributes: { device_class: 'motion' } },
    { entity_id: 'sensor.unsupported', state: '50', attributes: { device_class: 'battery' } },
  ];
  Object.defineProperties(plugin, {
    storage: { value: { values } },
    byEntityId: { value: new Map() },
    client: {
      value: {
        connected: true,
        fetchStates: async () => states,
        fetchEntityRegistry: async () => [
          { id: 'hallway-id', entity_id: 'binary_sensor.hallway', area_id: 'hall' },
          { id: 'own-id', entity_id: 'binary_sensor.own', platform: 'cameraui' },
        ],
        fetchAreaRegistry: async () => [{ area_id: 'hall', name: 'Hallway' }],
        fetchDeviceRegistry: async () => [],
      },
    },
  });
  return plugin;
}

const addresses = async (plugin: HomeAssistant) => (await plugin.onDiscoverSensors()).map((sensor) => sensor.address);

test('missing or empty inclusion list preserves discovery', async () => {
  for (const includeEntities of [undefined, '', ' ,  , ']) {
    assert.deepEqual(await addresses(discovery({ includeEntities })), ['binary_sensor.hallway', 'binary_sensor.kitchen']);
  }
});

test('inclusion offers only the selected entity and preserves registry metadata', async () => {
  const result = await discovery({ includeEntities: 'binary_sensor.hallway' }).onDiscoverSensors();
  assert.equal(result.length, 1);
  assert.equal(result[0].address, 'binary_sensor.hallway');
  assert.equal(result[0].id, 'hallway-id');
  assert.equal(result[0].room, 'Hallway');
});

test('multiple IDs tolerate whitespace, empty entries and duplicates', async () => {
  assert.deepEqual(await addresses(discovery({ includeEntities: ' binary_sensor.kitchen, ,binary_sensor.hallway, binary_sensor.kitchen, ' })), [
    'binary_sensor.hallway',
    'binary_sensor.kitchen',
  ]);
});

test('exclusion still works alone and takes priority over inclusion', async () => {
  for (const includeEntities of [undefined, 'binary_sensor.hallway,binary_sensor.kitchen']) {
    assert.deepEqual(await addresses(discovery({ includeEntities, excludeEntities: ' binary_sensor.hallway, ' })), ['binary_sensor.kitchen']);
  }
});

test('inclusion cannot import own or unsupported entities', async () => {
  assert.deepEqual(await addresses(discovery({ includeEntities: 'binary_sensor.own,sensor.unsupported' })), []);
});

test('IDs match exactly without wildcard or prefix matching', async () => {
  for (const includeEntities of ['binary_sensor.*', 'binary_sensor.hall', 'binary_sensor.missing']) {
    assert.deepEqual(await addresses(discovery({ includeEntities })), []);
  }
});

test('updated filters are used on the next discovery', async () => {
  const values: StorageValues = { includeEntities: 'binary_sensor.hallway' };
  const plugin = discovery(values);
  assert.deepEqual(await addresses(plugin), ['binary_sensor.hallway']);
  values.includeEntities = 'binary_sensor.kitchen';
  assert.deepEqual(await addresses(plugin), ['binary_sensor.kitchen']);
  values.includeEntities = '';
  assert.deepEqual(await addresses(plugin), ['binary_sensor.hallway', 'binary_sensor.kitchen']);
});

test('explicit binary doorbell mapping respects inclusion and exclusion', async () => {
  const values: StorageValues = { includeEntities: 'binary_sensor.hallway', doorbellEntities: ' binary_sensor.hallway, ' };
  const plugin = discovery(values);
  const result = await plugin.onDiscoverSensors();
  assert.equal(result.length, 1);
  assert.equal(result[0].type, 'doorbell');
  values.excludeEntities = 'binary_sensor.hallway';
  assert.deepEqual(await addresses(plugin), []);
  values.includeEntities = 'binary_sensor.own';
  values.doorbellEntities = 'binary_sensor.own';
  assert.deepEqual(await addresses(plugin), []);
});
