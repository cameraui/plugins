import { PluginRole, SensorType } from '@camera.ui/sdk';

import type { PluginContract } from '@camera.ui/sdk';

export const contract: PluginContract = {
  name: 'SMTP Motion',
  role: PluginRole.SensorProvider,
  provides: [SensorType.Motion],
  consumes: [],
  interfaces: [],
};

export default contract;
