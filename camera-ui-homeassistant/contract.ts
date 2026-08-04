import { PluginInterface, PluginRole, SensorType } from '@camera.ui/sdk';

import type { PluginContract } from '@camera.ui/sdk';

export const contract: PluginContract = {
  name: 'Home Assistant',
  role: PluginRole.SensorProvider,
  provides: [
    SensorType.Motion,
    SensorType.Occupancy,
    SensorType.Contact,
    SensorType.Doorbell,
    SensorType.Smoke,
    SensorType.Leak,
    SensorType.Gas,
    SensorType.CarbonMonoxide,
    SensorType.Heat,
    SensorType.Cold,
    SensorType.Vibration,
    SensorType.Tamper,
    SensorType.Problem,
    SensorType.Power,
    SensorType.Temperature,
    SensorType.Humidity,
    SensorType.Illuminance,
    SensorType.CarbonDioxide,
    SensorType.Lock,
    SensorType.Garage,
    SensorType.SecuritySystem,
    SensorType.Switch,
    SensorType.Light,
    SensorType.Siren,
  ],
  consumes: [],
  interfaces: [PluginInterface.Notifier],
};

export default contract;
