## [1.2.3]

- Initial release. Same features as the ONNX plugin, but on the CUDA 12 runtime line (onnxruntime-gpu 1.26). The regular plugin moved to CUDA 13, which dropped NVIDIA GPUs before the GTX 1650 (Maxwell, Pascal, Volta); this plugin keeps them running on the GPU. Also for systems that stay on an installed CUDA 12 toolkit.
