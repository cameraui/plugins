import { BatteryCapability, BatteryInfo, ChargingState, DoorbellTrigger, LightControl, MotionSensor, SirenControl } from '@camera.ui/sdk';

import type { RingCamera } from './ring-client-api.js';

interface Unsubscribable {
  unsubscribe(): void;
}

export class RingMotionSensor extends MotionSensor {
  private ringCamera: RingCamera;
  private subscriptions: Unsubscribable[] = [];

  constructor(ringCamera: RingCamera) {
    super('Ring Motion');
    this.ringCamera = ringCamera;
  }

  protected override onAssigned(): void {
    this.subscriptions.push(
      this.ringCamera.onMotionDetected.subscribe((motionDetected) => {
        this.reportDetections(motionDetected);
      }),
    );
  }

  protected override onDeassigned(): void {
    this.subscriptions.forEach((sub) => sub.unsubscribe());
    this.subscriptions = [];
  }
}

export class RingBatteryInfo extends BatteryInfo {
  private ringCamera: RingCamera;
  private subscriptions: Unsubscribable[] = [];

  constructor(ringCamera: RingCamera) {
    super('Ring Battery');
    this.ringCamera = ringCamera;
    this.capabilities = [BatteryCapability.Charging, BatteryCapability.LowBattery];
  }

  protected override onAssigned(): void {
    this.updateFromRingCamera();

    this.subscriptions.push(
      this.ringCamera.onBatteryLevel.subscribe(() => {
        this.updateFromRingCamera();
      }),
    );
  }

  protected override onDeassigned(): void {
    this.subscriptions.forEach((sub) => sub.unsubscribe());
    this.subscriptions = [];
  }

  private updateFromRingCamera(): void {
    this.setLevel(this.ringCamera.batteryLevel ?? 100);

    if (this.ringCamera.isCharging) {
      this.setCharging(ChargingState.Charging);
    } else if (this.ringCamera.hasLowBattery) {
      this.setCharging(ChargingState.NotCharging);
      this.setLow(true);
    } else {
      this.setCharging(ChargingState.NotCharging);
      this.setLow(false);
    }
  }
}

export class RingLightControl extends LightControl {
  private ringCamera: RingCamera;
  private subscriptions: Unsubscribable[] = [];

  constructor(ringCamera: RingCamera) {
    super('Ring Light');
    this.ringCamera = ringCamera;
  }

  protected override onAssigned(): void {
    if (this.ringCamera.data.led_status) {
      if (this.ringCamera.data.led_status === 'on') {
        super.setOn();
      } else {
        super.setOff();
      }
    }

    this.subscriptions.push(
      this.ringCamera.onData.subscribe((data) => {
        if (data.led_status) {
          if (data.led_status === 'on') {
            super.setOn();
          } else {
            super.setOff();
          }
        }
      }),
    );
  }

  protected override onDeassigned(): void {
    this.subscriptions.forEach((sub) => sub.unsubscribe());
    this.subscriptions = [];
  }

  override async setOn(): Promise<void> {
    try {
      await this.ringCamera.setLight(true);
      await super.setOn();
    } catch {
      // ignore
    }
  }

  override async setOff(): Promise<void> {
    try {
      await this.ringCamera.setLight(false);
      await super.setOff();
    } catch {
      // ignore
    }
  }
}

export class RingSirenControl extends SirenControl {
  private ringCamera: RingCamera;
  private subscriptions: Unsubscribable[] = [];

  constructor(ringCamera: RingCamera) {
    super('Ring Siren');
    this.ringCamera = ringCamera;
  }

  protected override onAssigned(): void {
    if (this.ringCamera.data.siren_status) {
      if (this.ringCamera.data.siren_status.seconds_remaining > 0) {
        super.setActive();
      } else {
        super.setInactive();
      }
    }

    this.subscriptions.push(
      this.ringCamera.onData.subscribe((data) => {
        if (data.siren_status) {
          if (data.siren_status.seconds_remaining > 0) {
            super.setActive();
          } else {
            super.setInactive();
          }
        }
      }),
    );
  }

  protected override onDeassigned(): void {
    this.subscriptions.forEach((sub) => sub.unsubscribe());
    this.subscriptions = [];
  }

  override async setActive(): Promise<void> {
    try {
      await this.ringCamera.setSiren(true);
      await super.setActive();
    } catch (err) {
      console.error('Error activating Ring siren:', err);
    }
  }

  override async setInactive(): Promise<void> {
    try {
      await this.ringCamera.setSiren(false);
      await super.setInactive();
    } catch (err) {
      console.error('Error deactivating Ring siren:', err);
    }
  }
}

export class RingDoorbellTrigger extends DoorbellTrigger {
  private ringCamera: RingCamera;
  private subscriptions: Unsubscribable[] = [];

  constructor(ringCamera: RingCamera) {
    super('Ring Doorbell');
    this.ringCamera = ringCamera;
  }

  protected override onAssigned(): void {
    // SDK auto-resets the doorbell trigger after a short delay
    this.subscriptions.push(
      this.ringCamera.onDoorbellPressed.subscribe(() => {
        this.trigger();
      }),
    );
  }

  protected override onDeassigned(): void {
    this.subscriptions.forEach((sub) => sub.unsubscribe());
    this.subscriptions = [];
  }
}
