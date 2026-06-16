import {
  BatteryCapability,
  BatteryProperty,
  ChargingState,
  ContactProperty,
  DoorbellProperty,
  LightCapability,
  LightProperty,
  MotionProperty,
  SecuritySystemProperty,
  SecuritySystemState,
  SensorType,
  SirenProperty,
  SwitchProperty,
} from '@camera.ui/sdk';

import { Characteristic, Service } from '../hap.js';
import {
  isBatteryInfo,
  isContactSensor,
  isDoorbellTrigger,
  isLightControl,
  isMotionSensor,
  isSecuritySystem,
  isSirenControl,
  isSwitchControl,
  Subscribed,
} from '../utils/utils.js';

import type { BatteryInfoLike, CameraDevice, Disposable, LightControlLike, LoggerService, MotionSensorLike, SensorLike } from '@camera.ui/sdk';
import type { Accessory, CharacteristicValue } from '../hap.js';

type HAPServiceConstructor = any;

type HAPCharacteristicConstructor = any;

interface PropertyBinding {
  property: string;
  characteristic: HAPCharacteristicConstructor;
  defaultValue: CharacteristicValue;
  toHAP?: (value: unknown) => CharacteristicValue;
  writable?: boolean;
}

interface TriggerBinding {
  property: string;
  characteristic: HAPCharacteristicConstructor;
  triggerValue: CharacteristicValue;
}

interface MultiProviderConfig {
  serviceType: HAPServiceConstructor;
  typeName: string;
  bindings: PropertyBinding[];
  trigger?: TriggerBinding;
}

const DOORBELL_CONFIG: MultiProviderConfig = {
  serviceType: Service.Doorbell,
  typeName: 'doorbell',
  bindings: [],
  trigger: {
    property: DoorbellProperty.Ring,
    characteristic: Characteristic.ProgrammableSwitchEvent,
    triggerValue: Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS,
  },
};

const CONTACT_CONFIG: MultiProviderConfig = {
  serviceType: Service.ContactSensor,
  typeName: 'contact sensor',
  bindings: [
    {
      property: ContactProperty.Detected,
      characteristic: Characteristic.ContactSensorState,
      defaultValue: false,
      toHAP: (v) => (v ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED : Characteristic.ContactSensorState.CONTACT_DETECTED),
    },
  ],
};

const SIREN_CONFIG: MultiProviderConfig = {
  serviceType: Service.Switch,
  typeName: 'siren',
  bindings: [
    {
      property: SirenProperty.Active,
      characteristic: Characteristic.On,
      defaultValue: false,
      writable: true,
    },
  ],
};

const SWITCH_CONFIG: MultiProviderConfig = {
  serviceType: Service.Switch,
  typeName: 'switch',
  bindings: [
    {
      property: SwitchProperty.On,
      characteristic: Characteristic.On,
      defaultValue: false,
      writable: true,
    },
  ],
};

const SECURITY_CONFIG: MultiProviderConfig = {
  serviceType: Service.SecuritySystem,
  typeName: 'security system',
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
};

export class CameraServices extends Subscribed {
  public services: Service[] = [];

  private accessory: Accessory;
  private cameraDevice: CameraDevice;
  private cameraLogger: LoggerService;

  // Subscriptions
  private sensorAddedSub?: Disposable;
  private sensorRemovedSub?: Disposable;

  // Track subscriptions for each sensor (property changes)
  private sensorSubscriptions = new Map<string, Disposable>();

  // Track capability subscriptions for each sensor
  private capabilitySubscriptions = new Map<string, Disposable>();

  // Track services by sensor ID (for multi-provider types)
  private sensorServices = new Map<string, Service>();

  constructor(accessory: Accessory, cameraDevice: CameraDevice) {
    super();

    this.accessory = accessory;
    this.cameraDevice = cameraDevice;
    this.cameraLogger = cameraDevice.logger;

    this.cameraLogger.debug('Adding services');

    // Set up sensor lifecycle listeners
    this.sensorAddedSub = this.cameraDevice.onSensorAdded.subscribe(({ sensorId, sensorType }) => this.handleSensorAdded(sensorId, sensorType));
    this.sensorRemovedSub = this.cameraDevice.onSensorRemoved.subscribe(({ sensorId, sensorType }) => this.handleSensorRemoved(sensorId, sensorType));

    // Initialize services for existing sensors
    this.initializeServices();
  }

  public cleanup(): void {
    this.sensorAddedSub?.dispose();
    this.sensorRemovedSub?.dispose();

    // Cleanup all sensor subscriptions
    for (const sub of this.sensorSubscriptions.values()) {
      sub.dispose();
    }
    this.sensorSubscriptions.clear();

    // Cleanup all capability subscriptions
    for (const sub of this.capabilitySubscriptions.values()) {
      sub.dispose();
    }
    this.capabilitySubscriptions.clear();

    this.unsubscribe();
    this.services.forEach((service) => service.removeAllListeners());
    this.sensorServices.clear();
  }

  private initializeServices(): void {
    for (const sensor of this.cameraDevice.getSensors()) {
      this.setupSensorService(sensor);
    }
  }

  private handleSensorAdded(sensorId: string, _sensorType: SensorType): void {
    const sensor = this.cameraDevice.getSensor(sensorId);
    if (!sensor) {
      return;
    }
    this.setupSensorService(sensor);
  }

  private setupSensorService(sensor: SensorLike): void {
    if (isMotionSensor(sensor)) this.addMotionService(sensor);
    else if (isBatteryInfo(sensor)) this.addBatteryService(sensor);
    else if (isLightControl(sensor)) this.addLightServiceForSensor(sensor);
    else if (isDoorbellTrigger(sensor)) this.bindMultiProviderService(sensor, DOORBELL_CONFIG);
    else if (isContactSensor(sensor)) this.bindMultiProviderService(sensor, CONTACT_CONFIG);
    else if (isSirenControl(sensor)) this.bindMultiProviderService(sensor, SIREN_CONFIG);
    else if (isSwitchControl(sensor)) this.bindMultiProviderService(sensor, SWITCH_CONFIG);
    else if (isSecuritySystem(sensor)) this.bindMultiProviderService(sensor, SECURITY_CONFIG);
  }

  private handleSensorRemoved(sensorId: string, sensorType: SensorType): void {
    // Cleanup sensor property subscription
    const sub = this.sensorSubscriptions.get(sensorId);
    if (sub) {
      sub.dispose();
      this.sensorSubscriptions.delete(sensorId);
    }

    // Cleanup sensor capability subscription
    const capSub = this.capabilitySubscriptions.get(sensorId);
    if (capSub) {
      capSub.dispose();
      this.capabilitySubscriptions.delete(sensorId);
    }

    // Only remove services for multi-provider types
    const service = this.sensorServices.get(sensorId);
    if (service) {
      this.cameraLogger.debug(`Removing ${sensorType} service for sensor: ${sensorId}`);
      this.accessory.removeService(service);
      this.sensorServices.delete(sensorId);

      const idx = this.services.indexOf(service);
      if (idx > -1) {
        this.services.splice(idx, 1);
      }
    }
  }

  private bindMultiProviderService(sensor: SensorLike, config: MultiProviderConfig): void {
    const sensorId = sensor.id;
    const displayName = sensor.name;
    const subtype = sensorId;

    let service = this.accessory.getServiceById(config.serviceType, subtype);

    if (!service) {
      this.cameraLogger.debug(`Adding ${config.typeName} service: ${displayName}`);

      service = this.accessory.addService(config.serviceType, displayName, subtype);

      // Set up change listeners and onSet handlers for each binding
      for (const binding of config.bindings) {
        const char = service.getCharacteristic(binding.characteristic);

        if (binding.writable) {
          char.onSet(async (value: CharacteristicValue) => {
            await sensor.updateValue(binding.property, value);
          });
        }

        char.on('change', (change) => {
          if (change.oldValue !== change.newValue) {
            this.cameraLogger.debug(`${config.typeName} ${displayName} ${binding.property} changed to`, change.newValue);
          }
        });
      }

      // Set up trigger change listener (e.g. doorbell ring)
      if (config.trigger) {
        service.getCharacteristic(config.trigger.characteristic).on('change', (change) => {
          if (change.oldValue !== change.newValue) {
            this.cameraLogger.debug(`${config.typeName} ${displayName} triggered`);
          }
        });
      }

      this.services.push(service);
      this.sensorServices.set(sensorId, service);
    }

    // Set initial values for property bindings
    for (const binding of config.bindings) {
      const raw = (sensor.getValue(binding.property) as CharacteristicValue | undefined) ?? binding.defaultValue;
      const value = binding.toHAP ? binding.toHAP(raw) : raw;
      service.getCharacteristic(binding.characteristic).updateValue(value);
    }

    // Subscribe to property changes
    const sub = sensor.onPropertyChanged.subscribe(({ property, value }) => {
      // Handle trigger bindings (event-based, e.g. doorbell)
      if (property === config.trigger?.property && value === true) {
        service.getCharacteristic(config.trigger.characteristic).updateValue(config.trigger.triggerValue);
        return;
      }

      // Handle property bindings (state-based)
      for (const binding of config.bindings) {
        if (property === binding.property) {
          const hapValue = binding.toHAP ? binding.toHAP(value) : value;
          service.getCharacteristic(binding.characteristic).updateValue(hapValue as CharacteristicValue);
          break;
        }
      }
    });

    this.sensorSubscriptions.set(sensorId, sub);
  }

  private addMotionService(sensor: MotionSensorLike): void {
    let motionService = this.accessory.getService(Service.MotionSensor);

    if (!motionService) {
      this.cameraLogger.debug('Adding motion service');

      motionService = this.accessory.addService(Service.MotionSensor, 'Motion Sensor');
      motionService.getCharacteristic(Characteristic.MotionDetected).on('change', (change) => {
        if (change.oldValue !== change.newValue) {
          this.cameraLogger.debug('Motion sensor state changed to', change.newValue);
        }
      });

      this.services.push(motionService);
    }

    // Get initial state
    const detected = sensor.getValue(MotionProperty.Detected) ?? false;
    motionService.getCharacteristic(Characteristic.MotionDetected).updateValue(detected);

    // Subscribe via onSensorProperty for cleaner single-provider pattern
    const sub = this.cameraDevice.onSensorProperty<boolean>(SensorType.Motion, MotionProperty.Detected, (value) => {
      motionService.getCharacteristic(Characteristic.MotionDetected).updateValue(value);
    });

    this.sensorSubscriptions.set(sensor.id, sub);
  }

  private addBatteryService(sensor: BatteryInfoLike): void {
    const sensorId = sensor.id;
    let batteryService = this.accessory.getService(Service.Battery);

    // Helper to add ChargingState characteristic dynamically
    const addChargingStateCharacteristic = (service: Service): void => {
      if (!service.testCharacteristic(Characteristic.ChargingState)) {
        this.cameraLogger.debug('Adding ChargingState characteristic to battery');
        service.addCharacteristic(Characteristic.ChargingState);

        service.getCharacteristic(Characteristic.ChargingState).on('change', (change) => {
          if (change.oldValue !== change.newValue) {
            this.cameraLogger.debug('Battery charging state changed to', change.newValue);
          }
        });

        // Set initial charging value
        const charging = sensor.getValue(BatteryProperty.Charging) ?? ChargingState.NotChargeable;
        const isCharging = charging === ChargingState.Charging;
        const chargingState = isCharging ? Characteristic.ChargingState.CHARGING : Characteristic.ChargingState.NOT_CHARGING;
        service.getCharacteristic(Characteristic.ChargingState).updateValue(chargingState);
      }
    };

    if (!batteryService) {
      const hasCharging = sensor.hasCapability(BatteryCapability.Charging);
      this.cameraLogger.debug(`Adding battery service, hasCharging: ${hasCharging}`);

      batteryService = this.accessory.addService(Service.Battery, 'Battery');

      if (!batteryService.testCharacteristic(Characteristic.BatteryLevel)) {
        batteryService.addCharacteristic(Characteristic.BatteryLevel);
      }

      batteryService.getCharacteristic(Characteristic.BatteryLevel).on('change', (change) => {
        if (change.oldValue !== change.newValue) {
          this.cameraLogger.debug('Battery level changed to', change.newValue);
        }
      });

      batteryService.getCharacteristic(Characteristic.StatusLowBattery).on('change', (change) => {
        if (change.oldValue !== change.newValue) {
          this.cameraLogger.debug('Battery state changed to', change.newValue);
        }
      });

      if (hasCharging) {
        addChargingStateCharacteristic(batteryService);
      }

      this.services.push(batteryService);
    }

    // Get initial state
    const level = sensor.getValue(BatteryProperty.Level) ?? 100;
    const low = sensor.getValue(BatteryProperty.Low) ?? false;
    const charging = sensor.hasCapability(BatteryCapability.Charging) ? (sensor.getValue(BatteryProperty.Charging) ?? ChargingState.NotChargeable) : undefined;
    this.updateBatteryValues(batteryService, level, low, charging);

    // Subscribe to property changes directly on the sensor
    const sub = sensor.onPropertyChanged.subscribe(({ property, value }) => {
      const currentLevel = property === BatteryProperty.Level ? value : (sensor.getValue(BatteryProperty.Level) ?? 100);
      const currentLow = property === BatteryProperty.Low ? value : (sensor.getValue(BatteryProperty.Low) ?? false);
      const currentCharging = sensor.hasCapability(BatteryCapability.Charging)
        ? property === BatteryProperty.Charging
          ? value
          : (sensor.getValue(BatteryProperty.Charging) ?? ChargingState.NotChargeable)
        : undefined;

      this.updateBatteryValues(batteryService, currentLevel, currentLow, currentCharging);
    });
    this.sensorSubscriptions.set(sensorId, sub);

    // Subscribe to capability changes - add ChargingState characteristic dynamically if capability is added
    const capSub = sensor.onCapabilitiesChanged.subscribe((capabilities) => {
      if (capabilities.includes(BatteryCapability.Charging)) {
        addChargingStateCharacteristic(batteryService);
      }
    });
    this.capabilitySubscriptions.set(sensorId, capSub);
  }

  private updateBatteryValues(batteryService: Service, level: number, low: boolean, charging?: ChargingState): void {
    const lowBattery = low || level <= 10 ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;

    batteryService.getCharacteristic(Characteristic.BatteryLevel).updateValue(level);
    batteryService.getCharacteristic(Characteristic.StatusLowBattery).updateValue(lowBattery);

    if (charging !== undefined) {
      const isCharging = charging === ChargingState.Charging;
      const chargingState = isCharging ? Characteristic.ChargingState.CHARGING : Characteristic.ChargingState.NOT_CHARGING;
      batteryService.getCharacteristic(Characteristic.ChargingState).updateValue(chargingState);
    }
  }

  // ============ Light Service (Multi Provider, dynamic capabilities) ============

  private addLightServiceForSensor(sensor: LightControlLike): void {
    const sensorId = sensor.id;
    const displayName = sensor.name;
    const subtype = sensorId;

    let lightService = this.accessory.getServiceById(Service.Lightbulb, subtype);

    // Helper to add brightness characteristic dynamically
    const addBrightnessCharacteristic = (service: Service): void => {
      if (!service.testCharacteristic(Characteristic.Brightness)) {
        this.cameraLogger.debug(`Adding brightness characteristic to light: ${displayName}`);
        service.addCharacteristic(Characteristic.Brightness);

        service
          .getCharacteristic(Characteristic.Brightness)
          .onSet(async (value: CharacteristicValue) => {
            await sensor.updateValue(LightProperty.Brightness, value);
          })
          .on('change', (change) => {
            if (change.oldValue !== change.newValue) {
              this.cameraLogger.debug(`Light ${displayName} brightness changed to`, change.newValue);
            }
          });

        // Set initial brightness value
        const brightness = sensor.getValue(LightProperty.Brightness) ?? 100;
        service.getCharacteristic(Characteristic.Brightness).updateValue(brightness);
      }
    };

    if (!lightService) {
      const hasBrightness = sensor.hasCapability(LightCapability.Brightness);
      this.cameraLogger.debug(`Adding light service: ${displayName}, subtype: ${subtype}, hasBrightness: ${hasBrightness}`);

      lightService = this.accessory.addService(Service.Lightbulb, displayName, subtype);

      lightService
        .getCharacteristic(Characteristic.On)
        .onSet(async (value: CharacteristicValue) => {
          await sensor.updateValue(LightProperty.On, value);
        })
        .on('change', (change) => {
          if (change.oldValue !== change.newValue) {
            this.cameraLogger.debug(`Light ${displayName} changed to`, change.newValue);
          }
        });

      if (hasBrightness) {
        addBrightnessCharacteristic(lightService);
      }

      this.services.push(lightService);
      this.sensorServices.set(sensorId, lightService);
    }

    // Set initial state
    const on = sensor.getValue(LightProperty.On) ?? false;
    lightService.getCharacteristic(Characteristic.On).updateValue(on);

    if (sensor.hasCapability(LightCapability.Brightness)) {
      const brightness = sensor.getValue(LightProperty.Brightness) ?? 100;
      lightService.getCharacteristic(Characteristic.Brightness).updateValue(brightness);
    }

    // Subscribe to property changes directly on the sensor
    const sub = sensor.onPropertyChanged.subscribe(({ property, value }) => {
      if (property === LightProperty.On) {
        lightService.getCharacteristic(Characteristic.On).updateValue(value);
      } else if (property === LightProperty.Brightness && sensor.hasCapability(LightCapability.Brightness)) {
        lightService.getCharacteristic(Characteristic.Brightness).updateValue(value);
      }
    });
    this.sensorSubscriptions.set(sensorId, sub);

    // Subscribe to capability changes - add brightness characteristic dynamically if capability is added
    const capSub = sensor.onCapabilitiesChanged.subscribe((capabilities) => {
      if (capabilities.includes(LightCapability.Brightness)) {
        addBrightnessCharacteristic(lightService);
      }
    });
    this.capabilitySubscriptions.set(sensorId, capSub);
  }
}
