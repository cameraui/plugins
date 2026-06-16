import { PluginInterface, PluginRole, SensorType } from '@camera.ui/sdk';

import type { PluginContract } from '@camera.ui/sdk';

export const contract: PluginContract = {
  name: 'Ring',
  role: PluginRole.CameraController,
  provides: [SensorType.Motion, SensorType.Battery, SensorType.Light, SensorType.Siren, SensorType.Doorbell],
  consumes: [],
  interfaces: [PluginInterface.DiscoveryProvider],
};

export default contract;
