# ONNX

ONNX Runtime detection backend for camera.ui. Runs object detection, face detection and recognition, license plate recognition with OCR, and CLIP semantic embeddings.

GPU inference runs on the CUDA 13 line and needs CUDA 13, cuDNN 9 for CUDA 13 and NVIDIA driver 580 or newer. For NVIDIA GPUs before the GTX 1650 (Maxwell, Pascal, Volta) or systems staying on CUDA 12, use [ONNX Legacy](https://github.com/cameraui/plugins/blob/main/camera-ui-onnx-legacy/README.md) instead.
