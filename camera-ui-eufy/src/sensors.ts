import { BatteryCapability, BatteryInfo, ChargingState, DoorbellTrigger, MotionSensor, ObjectSensor } from '@camera.ui/sdk';
import { PropertyName } from 'eufy-security-client';

import type { Camera as EufyCamera } from 'eufy-security-client';

export class EufyMotionSensor extends MotionSensor {
  constructor() {
    super('Eufy Motion');
  }
}

export class EufyObjectSensor extends ObjectSensor {
  constructor() {
    super('Eufy Object');
  }
}

export class EufyBatteryInfo extends BatteryInfo {
  constructor() {
    super('Eufy Battery');

    // Eufy cameras support low battery and charging detection
    this.capabilities = [BatteryCapability.LowBattery, BatteryCapability.Charging];
  }

  updateFromEufyCamera(eufyCamera: EufyCamera): void {
    const batteryLevel = eufyCamera.getPropertyValue(PropertyName.DeviceBattery) as number | undefined;
    this.setLevel(batteryLevel ?? 100);

    const isCharging = eufyCamera.getPropertyValue(PropertyName.DeviceChargingStatus) as number | undefined;
    const isLowBattery = eufyCamera.getPropertyValue(PropertyName.DeviceBatteryLow) as boolean | undefined;

    if (isCharging && isCharging > 0) {
      this.setCharging(ChargingState.Charging);
    } else if (isLowBattery) {
      this.setCharging(ChargingState.NotCharging);
      this.setLow(true);
    } else {
      this.setCharging(ChargingState.NotCharging);
      this.setLow(false);
    }
  }
}

export class EufyDoorbellTrigger extends DoorbellTrigger {
  constructor() {
    super('Eufy Doorbell');
  }
}
