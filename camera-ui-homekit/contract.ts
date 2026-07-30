import { PluginRole, SensorType } from '@camera.ui/sdk';

import type { PluginContract } from '@camera.ui/sdk';

export const contract: PluginContract = {
  name: 'HomeKit',
  role: PluginRole.Hub,
  provides: [],
  consumes: [
    SensorType.Motion,
    SensorType.Doorbell,
    SensorType.Battery,
    SensorType.Light,
    SensorType.Contact,
    SensorType.Siren,
    SensorType.SecuritySystem,
    SensorType.Switch,
    SensorType.Occupancy,
    SensorType.Smoke,
    SensorType.Leak,
    SensorType.Temperature,
    SensorType.Humidity,
    SensorType.Lock,
    SensorType.Garage,
  ],
  interfaces: [],
};

export default contract;
