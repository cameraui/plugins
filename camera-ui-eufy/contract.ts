import { PluginInterface, PluginRole, SensorType } from '@camera.ui/sdk';

import type { PluginContract } from '@camera.ui/sdk';

export const contract: PluginContract = {
  name: 'Eufy',
  role: PluginRole.CameraController,
  provides: [SensorType.Motion, SensorType.Object, SensorType.Battery, SensorType.Doorbell],
  consumes: [],
  interfaces: [PluginInterface.DiscoveryProvider],
};

export default contract;
