import { PluginInterface, PluginRole, SensorType } from '@camera.ui/sdk';

import type { PluginContract } from '@camera.ui/sdk';

export const contract: PluginContract = {
  name: 'YAMNet Audio Detection',
  role: PluginRole.SensorProvider,
  provides: [SensorType.Audio],
  consumes: [],
  pythonVersion: '3.11',
  interfaces: [PluginInterface.AudioDetection],
};

export default contract;
