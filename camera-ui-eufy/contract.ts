import { PluginInterface, PluginRole, SensorType } from '@camera.ui/sdk';

import type { PluginContract } from '@camera.ui/sdk';

export const contract: PluginContract = {
  name: 'Eufy',
  role: PluginRole.CameraController,
  provides: [
    SensorType.Motion,
    SensorType.Object,
    SensorType.Audio,
    SensorType.Battery,
    SensorType.Doorbell,
    SensorType.Light,
    SensorType.Siren,
    SensorType.Switch,
    SensorType.PTZ,
    SensorType.SecuritySystem,
    SensorType.Contact,
    SensorType.Lock,
    SensorType.Leak,
    SensorType.Smoke,
    SensorType.CarbonMonoxide,
  ],
  consumes: [],
  interfaces: [PluginInterface.DiscoveryProvider, PluginInterface.SensorDiscovery],
};

export default contract;
