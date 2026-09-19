import { PluginInterface, PluginRole } from '@camera.ui/sdk';

import type { PluginContract } from '@camera.ui/sdk';

export const contract: PluginContract = {
  name: 'Apple LLM',
  role: PluginRole.Service,
  provides: [],
  consumes: [],
  interfaces: [PluginInterface.AssistantModels],
};

export default contract;
