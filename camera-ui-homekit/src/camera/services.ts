import { BatteryCapability, BatteryProperty, ChargingState, DoorbellProperty, LightCapability, LightProperty, SirenProperty } from '@camera.ui/sdk';

import { Characteristic, Service } from '../hap.js';
import { isBatteryInfo, isDoorbellTrigger, isLightControl, isSirenControl, Subscribed } from '../utils/utils.js';

import type { BatteryInfoLike, CameraDevice, DetectionEvent, DetectionEventType, Disposable, LightControlLike, SensorLike, SirenControlLike } from '@camera.ui/sdk';
import type { Accessory, CharacteristicValue } from '../hap.js';

export class CameraServices extends Subscribed {
  public services: Service[] = [];

  private accessory: Accessory;
  private cameraDevice: CameraDevice;
  private cameraLogger: CameraDevice['logger'];

  private motionService: Service;
  private doorbellService?: Service;
  private batteryService?: Service;

  private sensorSubscriptions = new Map<string, Disposable>();
  private capabilitySubscriptions = new Map<string, Disposable>();
  private sensorServices = new Map<string, Service>();
  private doorbellSensorIds = new Set<string>();
  private batterySensorId?: string;

  private activeEventTypes?: Set<string>;

  constructor(accessory: Accessory, cameraDevice: CameraDevice, sensors: Iterable<SensorLike>) {
    super();

    this.accessory = accessory;
    this.cameraDevice = cameraDevice;
    this.cameraLogger = cameraDevice.logger;

    this.cameraLogger.debug('Adding services');

    this.motionService = this.addMotionService();

    if (this.cameraDevice.type === 'doorbell') {
      this.ensureDoorbellService();
    }

    this.addSubscriptions(
      this.cameraDevice.onDetectionEvent.subscribe(({ type, event }) => this.handleDetectionEvent(type, event)),

      this.cameraDevice.onPropertyChange('type').subscribe(({ newData }) => {
        if (newData === 'doorbell') {
          this.ensureDoorbellService();
        } else if (!this.doorbellSensorIds.size) {
          this.removeDoorbellService();
        }
      }),
    );

    for (const sensor of sensors) {
      this.addSensor(sensor);
    }
  }

  public addSensor(sensor: SensorLike): void {
    if (this.sensorSubscriptions.has(sensor.id)) {
      return;
    }

    if (isBatteryInfo(sensor)) {
      this.addBatteryService(sensor);
    } else if (isDoorbellTrigger(sensor)) {
      this.addDoorbellSensor(sensor);
    } else if (isLightControl(sensor)) {
      this.addLightService(sensor);
    } else if (isSirenControl(sensor)) {
      this.addSirenService(sensor);
    }
  }

  public removeSensor(sensorId: string): void {
    this.sensorSubscriptions.get(sensorId)?.dispose();
    this.sensorSubscriptions.delete(sensorId);
    this.capabilitySubscriptions.get(sensorId)?.dispose();
    this.capabilitySubscriptions.delete(sensorId);

    if (this.doorbellSensorIds.delete(sensorId) && !this.doorbellSensorIds.size && this.cameraDevice.type !== 'doorbell') {
      this.removeDoorbellService();
    }

    const sensorService = this.sensorServices.get(sensorId);
    if (sensorService) {
      this.cameraLogger.debug(`Removing service for sensor: ${sensorId}`);
      this.accessory.removeService(sensorService);
      this.sensorServices.delete(sensorId);

      const serviceIdx = this.services.indexOf(sensorService);
      if (serviceIdx > -1) {
        this.services.splice(serviceIdx, 1);
      }
    }

    if (this.batterySensorId === sensorId && this.batteryService) {
      this.cameraLogger.debug('Removing battery service');
      this.accessory.removeService(this.batteryService);

      const idx = this.services.indexOf(this.batteryService);
      if (idx > -1) {
        this.services.splice(idx, 1);
      }
      this.batteryService = undefined;
      this.batterySensorId = undefined;
    }
  }

  public cleanup(): void {
    for (const sub of this.sensorSubscriptions.values()) {
      sub.dispose();
    }
    this.sensorSubscriptions.clear();

    for (const sub of this.capabilitySubscriptions.values()) {
      sub.dispose();
    }
    this.capabilitySubscriptions.clear();

    this.doorbellSensorIds.clear();
    this.sensorServices.clear();
    this.unsubscribe();
    this.services.forEach((service) => service.removeAllListeners());
  }

  private handleDetectionEvent(type: DetectionEventType, event: DetectionEvent): void {
    if (type === 'end') {
      if (this.activeEventTypes?.has('motion')) {
        this.motionService.getCharacteristic(Characteristic.MotionDetected).updateValue(false);
      }
      this.activeEventTypes = undefined;
      return;
    }

    const seen = (this.activeEventTypes ??= new Set());

    if (!seen.has('motion') && event.types.includes('motion')) {
      seen.add('motion');
      this.motionService.getCharacteristic(Characteristic.MotionDetected).updateValue(true);
    }
  }

  private addMotionService(): Service {
    this.cameraLogger.debug('Adding motion service');

    const motionService = this.accessory.getService(Service.MotionSensor) ?? this.accessory.addService(Service.MotionSensor, 'Motion Sensor');

    motionService.getCharacteristic(Characteristic.MotionDetected).updateValue(false);
    motionService.getCharacteristic(Characteristic.MotionDetected).on('change', (change) => {
      if (change.oldValue !== change.newValue) {
        this.cameraLogger.debug('Motion sensor state changed to', change.newValue);
      }
    });

    this.services.push(motionService);
    return motionService;
  }

  private ensureDoorbellService(): Service {
    if (this.doorbellService) {
      return this.doorbellService;
    }

    this.cameraLogger.debug('Adding doorbell service');

    const doorbellService = this.accessory.getService(Service.Doorbell) ?? this.accessory.addService(Service.Doorbell, 'Doorbell');

    doorbellService.getCharacteristic(Characteristic.ProgrammableSwitchEvent).on('change', (change) => {
      if (change.oldValue !== change.newValue) {
        this.cameraLogger.debug('Doorbell triggered');
      }
    });

    this.doorbellService = doorbellService;
    this.services.push(doorbellService);
    return doorbellService;
  }

  private removeDoorbellService(): void {
    if (!this.doorbellService) {
      return;
    }

    this.cameraLogger.debug('Removing doorbell service');
    this.accessory.removeService(this.doorbellService);

    const idx = this.services.indexOf(this.doorbellService);
    if (idx > -1) {
      this.services.splice(idx, 1);
    }
    this.doorbellService = undefined;
  }

  private addDoorbellSensor(sensor: SensorLike): void {
    const doorbellService = this.ensureDoorbellService();
    this.doorbellSensorIds.add(sensor.id);
    const ringProperty: string = DoorbellProperty.Ring;

    const sub = sensor.onPropertyChanged.subscribe(({ property, value }) => {
      if (property === ringProperty && value === true) {
        this.cameraLogger.debug(`Doorbell ring from sensor: ${sensor.displayName}`);
        doorbellService.getCharacteristic(Characteristic.ProgrammableSwitchEvent).updateValue(Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);
      }
    });

    this.sensorSubscriptions.set(sensor.id, sub);
  }

  private addLightService(sensor: LightControlLike): void {
    const sensorId = sensor.id;
    const displayName = sensor.displayName || sensor.name;
    const subtype = sensorId;

    let lightService = this.accessory.getServiceById(Service.Lightbulb, subtype);

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

        const brightness = sensor.getValue(LightProperty.Brightness) ?? 100;
        service.getCharacteristic(Characteristic.Brightness).updateValue(brightness as CharacteristicValue);
      }
    };

    if (!lightService) {
      const hasBrightness = sensor.hasCapability(LightCapability.Brightness);
      this.cameraLogger.debug(`Adding light service: ${displayName}, hasBrightness: ${hasBrightness}`);

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

    const on = sensor.getValue(LightProperty.On) ?? false;
    lightService.getCharacteristic(Characteristic.On).updateValue(on as CharacteristicValue);

    if (sensor.hasCapability(LightCapability.Brightness)) {
      const brightness = sensor.getValue(LightProperty.Brightness) ?? 100;
      lightService.getCharacteristic(Characteristic.Brightness).updateValue(brightness as CharacteristicValue);
    }

    const sub = sensor.onPropertyChanged.subscribe(({ property, value }) => {
      if (property === LightProperty.On) {
        lightService.getCharacteristic(Characteristic.On).updateValue(value as CharacteristicValue);
      } else if (property === LightProperty.Brightness && sensor.hasCapability(LightCapability.Brightness)) {
        lightService.getCharacteristic(Characteristic.Brightness).updateValue(value as CharacteristicValue);
      }
    });
    this.sensorSubscriptions.set(sensorId, sub);

    const capSub = sensor.onCapabilitiesChanged.subscribe((capabilities) => {
      if (capabilities.includes(LightCapability.Brightness)) {
        addBrightnessCharacteristic(lightService);
      }
    });
    this.capabilitySubscriptions.set(sensorId, capSub);
  }

  private addSirenService(sensor: SirenControlLike): void {
    const sensorId = sensor.id;
    const displayName = sensor.displayName || sensor.name;
    const subtype = sensorId;

    let sirenService = this.accessory.getServiceById(Service.Switch, subtype);

    if (!sirenService) {
      this.cameraLogger.debug(`Adding siren service: ${displayName}`);

      sirenService = this.accessory.addService(Service.Switch, displayName, subtype);

      sirenService
        .getCharacteristic(Characteristic.On)
        .onSet(async (value: CharacteristicValue) => {
          await sensor.updateValue(SirenProperty.Active, value);
        })
        .on('change', (change) => {
          if (change.oldValue !== change.newValue) {
            this.cameraLogger.debug(`Siren ${displayName} changed to`, change.newValue);
          }
        });

      this.services.push(sirenService);
      this.sensorServices.set(sensorId, sirenService);
    }

    const active = sensor.getValue(SirenProperty.Active) ?? false;
    sirenService.getCharacteristic(Characteristic.On).updateValue(active as CharacteristicValue);

    const sub = sensor.onPropertyChanged.subscribe(({ property, value }) => {
      if (property === SirenProperty.Active) {
        sirenService.getCharacteristic(Characteristic.On).updateValue(value as CharacteristicValue);
      }
    });
    this.sensorSubscriptions.set(sensorId, sub);
  }

  private addBatteryService(sensor: BatteryInfoLike): void {
    const sensorId = sensor.id;
    this.batterySensorId = sensorId;
    let batteryService = this.batteryService ?? this.accessory.getService(Service.Battery);

    const addChargingStateCharacteristic = (service: Service): void => {
      if (!service.testCharacteristic(Characteristic.ChargingState)) {
        this.cameraLogger.debug('Adding ChargingState characteristic to battery');
        service.addCharacteristic(Characteristic.ChargingState);

        service.getCharacteristic(Characteristic.ChargingState).on('change', (change) => {
          if (change.oldValue !== change.newValue) {
            this.cameraLogger.debug('Battery charging state changed to', change.newValue);
          }
        });

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

    this.batteryService = batteryService;

    const level = sensor.getValue(BatteryProperty.Level) ?? 100;
    const low = sensor.getValue(BatteryProperty.Low) ?? false;
    const charging = sensor.hasCapability(BatteryCapability.Charging) ? (sensor.getValue(BatteryProperty.Charging) ?? ChargingState.NotChargeable) : undefined;
    this.updateBatteryValues(batteryService, level, low, charging);

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
}
