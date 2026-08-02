export const NODE = {
  'camera-ui-homekit': 'externals/hap',
  'camera-ui-onvif': 'externals/onvif',
  'camera-ui-ring': 'externals/ring',
  'camera-ui-eufy': 'externals/eufy-security-client',
  'camera-ui-pamdiff': '',
  'camera-ui-rust-motion': '',
  'camera-ui-smtp': '',
  'camera-ui-tuya': '',
  'camera-ui-wasm-motion': '',
};

export const GO = {
  'camera-ui-reolink': 'externals/reolinkproxy',
};

// CI/publish python; plugins absent here use the default 3.13
// (openvino 2024.6 ships no cp313 wheels)
export const PYTHON_VERSIONS = {
  'camera-ui-openvino-legacy': '3.11',
};

export const PYTHON = [
  'camera-ui-audio-yamnet',
  'camera-ui-coral',
  'camera-ui-coreml',
  'camera-ui-hailo',
  'camera-ui-ncnn',
  'camera-ui-onnx',
  'camera-ui-opencl',
  'camera-ui-opencv',
  'camera-ui-openvino',
  'camera-ui-openvino-legacy',
  'camera-ui-wyze',
];
