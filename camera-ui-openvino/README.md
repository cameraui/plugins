# OpenVino

OpenVino detection backend for camera.ui, optimized for Intel hardware. Runs object detection, face detection and recognition, license plate recognition with OCR, and CLIP semantic embeddings.

On Windows with an Intel GPU up to 10th gen Core (HD/UHD Graphics 610 to 630), use [OpenVino Legacy](https://github.com/cameraui/plugins/blob/main/camera-ui-openvino-legacy/README.md) instead: those drivers cannot build the GPU code of the current runtime.
