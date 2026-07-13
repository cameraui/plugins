import { PluginInterface, PluginRole, SensorType } from '@camera.ui/sdk';

import type { PluginContract } from '@camera.ui/sdk';

export const contract: PluginContract = {
  name: 'Reolink',
  role: PluginRole.CameraController,
  provides: [SensorType.Motion, SensorType.Object, SensorType.Battery, SensorType.Doorbell, SensorType.Siren, SensorType.Light, SensorType.PTZ],
  consumes: [],
  interfaces: [PluginInterface.DiscoveryProvider],
};

export default contract;
