# ONNX Legacy

ONNX Runtime detection backend for camera.ui. Runs object detection, face detection and recognition, license plate recognition with OCR, and CLIP semantic embeddings.

The same detection plugin as [ONNX](https://github.com/cameraui/plugins/blob/main/camera-ui-onnx/README.md), pinned to onnxruntime-gpu 1.26, the last release built on CUDA 12.

CUDA 13 dropped support for NVIDIA architectures before Turing. The regular ONNX plugin runs on the CUDA 13 line, so on those cards detection silently falls back to the CPU. This plugin stays on the CUDA 12 build, which still carries kernels for them.

## When to use it

Install this plugin instead of the regular ONNX plugin if:

- your NVIDIA GPU is older than a GTX 1650: Maxwell (GTX 700/900 series), Pascal (GTX 10 series, Quadro P400 to P4000, Tesla P4/P40/P100) or Volta (Titan V, Tesla V100)
- or your system has a CUDA 12 toolkit installed that you don't want to upgrade

It needs CUDA 12.x and cuDNN 9.x for CUDA 12 installed, with NVIDIA driver 525 or newer. On a GTX 1650 or newer, use the regular ONNX plugin: it runs on CUDA 13, supports the RTX 50 series natively and keeps getting runtime fixes.
