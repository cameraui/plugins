import { PluginInterface, PluginRole, SensorType } from '@camera.ui/sdk';

import type { PluginContract } from '@camera.ui/sdk';

export const contract: PluginContract = {
  name: 'ONNX',
  role: PluginRole.SensorProvider,
  provides: [
    SensorType.Object,
    SensorType.Face,
    SensorType.FaceEmbedder,
    SensorType.LicensePlate,
    SensorType.Clip,
  ],
  consumes: [],
  pythonVersion: '3.11',
  interfaces: [
    PluginInterface.ObjectDetection,
    PluginInterface.FaceDetection,
    PluginInterface.FaceEmbedding,
    PluginInterface.LicensePlateDetection,
    PluginInterface.ClipDetection,
  ],
};

export default contract;
