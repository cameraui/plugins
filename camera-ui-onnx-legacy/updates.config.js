export default {
  exclude: ['typescript', 'eslint', 'onnxruntime', 'onnxruntime-gpu', 'numpy', '@stylistic/eslint-plugin'],
  cooldown: '7d',
  overrides: [{ include: [/^(@camera\.ui\/|camera\.ui$|node-av(-light|-lgpl)?$|@seydx\/|camera[-_]ui[-_]|github\.com\/(cameraui|seydx)\/)/], cooldown: 0 }],
};
