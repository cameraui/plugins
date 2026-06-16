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
    SensorType.Audio,
    SensorType.Motion,
  ],
  interfaces: [],
};

export default contract;
