import {
  ContactProperty,
  DoorbellProperty,
  GarageProperty,
  GarageState,
  HumidityProperty,
  LeakProperty,
  LightCapability,
  LightProperty,
  LockProperty,
  LockState,
  MotionProperty,
  OccupancyProperty,
  SecuritySystemProperty,
  SecuritySystemState,
  SensorType,
  SirenProperty,
  SmokeProperty,
  SwitchProperty,
  TemperatureProperty,
} from '@camera.ui/sdk';

import { Accessory, AccessoryEventTypes, Categories, Characteristic, Service, uuid } from '../hap.js';
import { generateValidAccessoryName, isLightControl } from '../utils/utils.js';

import type { Disposable, LightControlLike, LoggerService, SensorLike } from '@camera.ui/sdk';
import type { CharacteristicValue } from '../hap.js';

type HAPServiceConstructor = any;

type HAPCharacteristicConstructor = any;

interface PropertyBinding {
  property: string;
  characteristic: HAPCharacteristicConstructor;
  defaultValue: CharacteristicValue;
  toHAP?: (value: unknown) => CharacteristicValue;
  fromHAP?: (value: CharacteristicValue) => unknown;
  props?: { minValue?: number; maxValue?: number };
  writable?: boolean;
}

interface TriggerBinding {
  property: string;
  characteristic: HAPCharacteristicConstructor;
  triggerValue: CharacteristicValue;
}

interface SensorServiceConfig {
  serviceType: HAPServiceConstructor;
  typeName: string;
  category: Categories;
  bindings: PropertyBinding[];
  trigger?: TriggerBinding;
}

const SENSOR_CONFIGS: Partial<Record<SensorType, SensorServiceConfig>> = {
  [SensorType.Motion]: {
    serviceType: Service.MotionSensor,
    typeName: 'motion sensor',
    category: Categories.SENSOR,
    bindings: [
      {
        property: MotionProperty.Detected,
        characteristic: Characteristic.MotionDetected,
        defaultValue: false,
      },
    ],
  },
  [SensorType.Doorbell]: {
    serviceType: Service.Doorbell,
    typeName: 'doorbell',
    category: Categories.OTHER,
    bindings: [],
    trigger: {
      property: DoorbellProperty.Ring,
      characteristic: Characteristic.ProgrammableSwitchEvent,
      triggerValue: Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS,
    },
  },
  [SensorType.Contact]: {
    serviceType: Service.ContactSensor,
    typeName: 'contact sensor',
    category: Categories.SENSOR,
    bindings: [
      {
        property: ContactProperty.Detected,
        characteristic: Characteristic.ContactSensorState,
        defaultValue: false,
        toHAP: (v) => (v ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED : Characteristic.ContactSensorState.CONTACT_DETECTED),
      },
    ],
  },
  [SensorType.Siren]: {
    serviceType: Service.Switch,
    typeName: 'siren',
    category: Categories.SWITCH,
    bindings: [
      {
        property: SirenProperty.Active,
        characteristic: Characteristic.On,
        defaultValue: false,
        writable: true,
      },
    ],
  },
  [SensorType.Switch]: {
    serviceType: Service.Switch,
    typeName: 'switch',
    category: Categories.SWITCH,
    bindings: [
      {
        property: SwitchProperty.On,
        characteristic: Characteristic.On,
        defaultValue: false,
        writable: true,
      },
    ],
  },
  [SensorType.SecuritySystem]: {
    serviceType: Service.SecuritySystem,
    typeName: 'security system',
    category: Categories.SECURITY_SYSTEM,
    bindings: [
      {
        property: SecuritySystemProperty.CurrentState,
        characteristic: Characteristic.SecuritySystemCurrentState,
        defaultValue: SecuritySystemState.Disarmed,
      },
      {
        property: SecuritySystemProperty.TargetState,
        characteristic: Characteristic.SecuritySystemTargetState,
        defaultValue: SecuritySystemState.Disarmed,
        writable: true,
      },
    ],
  },
  [SensorType.Occupancy]: {
    serviceType: Service.OccupancySensor,
    typeName: 'occupancy sensor',
    category: Categories.SENSOR,
    bindings: [
      {
        property: OccupancyProperty.Detected,
        characteristic: Characteristic.OccupancyDetected,
        defaultValue: false,
        toHAP: (v) => (v ? Characteristic.OccupancyDetected.OCCUPANCY_DETECTED : Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED),
      },
    ],
  },
  [SensorType.Smoke]: {
    serviceType: Service.SmokeSensor,
    typeName: 'smoke sensor',
    category: Categories.SENSOR,
    bindings: [
      {
        property: SmokeProperty.Detected,
        characteristic: Characteristic.SmokeDetected,
        defaultValue: false,
        toHAP: (v) => (v ? Characteristic.SmokeDetected.SMOKE_DETECTED : Characteristic.SmokeDetected.SMOKE_NOT_DETECTED),
      },
    ],
  },
  [SensorType.Leak]: {
    serviceType: Service.LeakSensor,
    typeName: 'leak sensor',
    category: Categories.SENSOR,
    bindings: [
      {
        property: LeakProperty.Detected,
        characteristic: Characteristic.LeakDetected,
        defaultValue: false,
        toHAP: (v) => (v ? Characteristic.LeakDetected.LEAK_DETECTED : Characteristic.LeakDetected.LEAK_NOT_DETECTED),
      },
    ],
  },
  [SensorType.Temperature]: {
    serviceType: Service.TemperatureSensor,
    typeName: 'temperature sensor',
    category: Categories.SENSOR,
    bindings: [
      {
        property: TemperatureProperty.Current,
        characteristic: Characteristic.CurrentTemperature,
        defaultValue: 0,
        props: { minValue: -100, maxValue: 150 },
      },
    ],
  },
  [SensorType.Humidity]: {
    serviceType: Service.HumiditySensor,
    typeName: 'humidity sensor',
    category: Categories.SENSOR,
    bindings: [
      {
        property: HumidityProperty.Current,
        characteristic: Characteristic.CurrentRelativeHumidity,
        defaultValue: 0,
      },
    ],
  },
  [SensorType.Lock]: {
    serviceType: Service.LockMechanism,
    typeName: 'lock',
    category: Categories.DOOR_LOCK,
    bindings: [
      {
        property: LockProperty.CurrentState,
        characteristic: Characteristic.LockCurrentState,
        defaultValue: LockState.Unknown,
        toHAP: (v) =>
          v === LockState.Secured
            ? Characteristic.LockCurrentState.SECURED
            : v === LockState.Unsecured
              ? Characteristic.LockCurrentState.UNSECURED
              : Characteristic.LockCurrentState.UNKNOWN,
      },
      {
        property: LockProperty.TargetState,
        characteristic: Characteristic.LockTargetState,
        defaultValue: LockState.Secured,
        toHAP: (v) => (v === LockState.Secured ? Characteristic.LockTargetState.SECURED : Characteristic.LockTargetState.UNSECURED),
        fromHAP: (v) => (v === Characteristic.LockTargetState.SECURED ? LockState.Secured : LockState.Unsecured),
        writable: true,
      },
    ],
  },
  // GarageState matches the HAP door-state values 1:1, no mapping needed
  [SensorType.Garage]: {
    serviceType: Service.GarageDoorOpener,
    typeName: 'garage door',
    category: Categories.GARAGE_DOOR_OPENER,
    bindings: [
      {
        property: GarageProperty.CurrentState,
        characteristic: Characteristic.CurrentDoorState,
        defaultValue: GarageState.Closed,
      },
      {
        property: GarageProperty.TargetState,
        characteristic: Characteristic.TargetDoorState,
        defaultValue: GarageState.Closed,
        writable: true,
      },
      {
        property: GarageProperty.ObstructionDetected,
        characteristic: Characteristic.ObstructionDetected,
        defaultValue: false,
      },
    ],
  },
};

export interface BridgedSensorAccessory {
  accessory: Accessory;
  dispose: () => void;
}

export function buildSensorAccessory(sensor: SensorLike, republishId: string, logger: LoggerService): BridgedSensorAccessory | undefined {
  const accessoryUUID = uuid.generate(`${republishId}-sensor-${sensor.id}`);
  const displayName = generateValidAccessoryName(sensor.displayName || sensor.name);

  if (isLightControl(sensor)) {
    const accessory = createAccessory(sensor, displayName, accessoryUUID, Categories.LIGHTBULB, logger);
    const dispose = bindLightService(accessory, sensor, displayName, logger);
    return { accessory, dispose };
  }

  const config = SENSOR_CONFIGS[sensor.type];
  if (!config) {
    return undefined;
  }

  const accessory = createAccessory(sensor, displayName, accessoryUUID, config.category, logger);
  const dispose = bindConfiguredService(accessory, sensor, displayName, config, logger);
  return { accessory, dispose };
}

function createAccessory(sensor: SensorLike, displayName: string, accessoryUUID: string, category: Categories, logger: LoggerService): Accessory {
  const accessory = new Accessory(displayName, accessoryUUID);
  accessory.category = category;

  const accessoryInformation = accessory.getService(Service.AccessoryInformation);
  accessoryInformation?.setCharacteristic(Characteristic.Name, displayName);
  accessoryInformation?.setCharacteristic(Characteristic.ConfiguredName, displayName);
  accessoryInformation?.setCharacteristic(Characteristic.Manufacturer, 'camera.ui');
  accessoryInformation?.setCharacteristic(Characteristic.Model, sensor.type);
  accessoryInformation?.setCharacteristic(Characteristic.SerialNumber, sensor.id);

  accessory.on(AccessoryEventTypes.IDENTIFY, () => logger.debug(`${displayName} identified!`));

  return accessory;
}

function bindConfiguredService(accessory: Accessory, sensor: SensorLike, displayName: string, config: SensorServiceConfig, logger: LoggerService): () => void {
  const service = accessory.addService(config.serviceType, displayName);
  const subscriptions: Disposable[] = [];

  for (const binding of config.bindings) {
    const char = service.getCharacteristic(binding.characteristic);

    if (binding.props) {
      char.setProps(binding.props);
    }

    if (binding.writable) {
      char.onSet(async (value: CharacteristicValue) => {
        await sensor.updateValue(binding.property, binding.fromHAP ? binding.fromHAP(value) : value);
      });
    }

    char.on('change', (change) => {
      if (change.oldValue !== change.newValue) {
        logger.debug(`${config.typeName} ${displayName} ${binding.property} changed to`, change.newValue);
      }
    });

    const raw = (sensor.getValue(binding.property) as CharacteristicValue | undefined) ?? binding.defaultValue;
    char.updateValue(binding.toHAP ? binding.toHAP(raw) : raw);
  }

  subscriptions.push(
    sensor.onPropertyChanged.subscribe(({ property, value }) => {
      if (property === config.trigger?.property && value === true) {
        logger.debug(`${config.typeName} ${displayName} triggered`);
        service.getCharacteristic(config.trigger.characteristic).updateValue(config.trigger.triggerValue);
        return;
      }

      for (const binding of config.bindings) {
        if (property === binding.property) {
          const hapValue = binding.toHAP ? binding.toHAP(value) : value;
          service.getCharacteristic(binding.characteristic).updateValue(hapValue as CharacteristicValue);
          break;
        }
      }
    }),
  );

  return () => {
    subscriptions.forEach((sub) => sub.dispose());
    accessory.removeAllListeners();
    service.removeAllListeners();
  };
}

function bindLightService(accessory: Accessory, sensor: LightControlLike, displayName: string, logger: LoggerService): () => void {
  const service = accessory.addService(Service.Lightbulb, displayName);
  const subscriptions: Disposable[] = [];

  const addBrightnessCharacteristic = (): void => {
    if (service.testCharacteristic(Characteristic.Brightness)) {
      return;
    }

    logger.debug(`Adding brightness characteristic to light: ${displayName}`);
    service.addCharacteristic(Characteristic.Brightness);

    service
      .getCharacteristic(Characteristic.Brightness)
      .onSet(async (value: CharacteristicValue) => {
        await sensor.updateValue(LightProperty.Brightness, value);
      })
      .on('change', (change) => {
        if (change.oldValue !== change.newValue) {
          logger.debug(`Light ${displayName} brightness changed to`, change.newValue);
        }
      });

    const brightness = sensor.getValue(LightProperty.Brightness) ?? 100;
    service.getCharacteristic(Characteristic.Brightness).updateValue(brightness as CharacteristicValue);
  };

  service
    .getCharacteristic(Characteristic.On)
    .onSet(async (value: CharacteristicValue) => {
      await sensor.updateValue(LightProperty.On, value);
    })
    .on('change', (change) => {
      if (change.oldValue !== change.newValue) {
        logger.debug(`Light ${displayName} changed to`, change.newValue);
      }
    });

  service.getCharacteristic(Characteristic.On).updateValue((sensor.getValue(LightProperty.On) ?? false) as CharacteristicValue);

  if (sensor.hasCapability(LightCapability.Brightness)) {
    addBrightnessCharacteristic();
  }

  subscriptions.push(
    sensor.onPropertyChanged.subscribe(({ property, value }) => {
      if (property === LightProperty.On) {
        service.getCharacteristic(Characteristic.On).updateValue(value as CharacteristicValue);
      } else if (property === LightProperty.Brightness && sensor.hasCapability(LightCapability.Brightness)) {
        service.getCharacteristic(Characteristic.Brightness).updateValue(value as CharacteristicValue);
      }
    }),

    sensor.onCapabilitiesChanged.subscribe((capabilities) => {
      if (capabilities.includes(LightCapability.Brightness)) {
        addBrightnessCharacteristic();
      }
    }),
  );

  return () => {
    subscriptions.forEach((sub) => sub.dispose());
    accessory.removeAllListeners();
    service.removeAllListeners();
  };
}
