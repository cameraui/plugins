# OpenVino Legacy

OpenVino detection backend for camera.ui, optimized for Intel hardware. Runs object detection, face detection and recognition, license plate recognition with OCR, and CLIP semantic embeddings.

The same detection plugin as [OpenVino](https://github.com/cameraui/plugins/blob/main/camera-ui-openvino/README.md), pinned to the older OpenVINO 2024.6 runtime.

Newer OpenVINO releases generate GPU code that the drivers of older Intel chips can no longer build. On those machines the regular plugin logs `CL_BUILD_PROGRAM_FAILURE` and every model silently falls back to the CPU. The 2024.6 runtime still compiles for these GPUs.

## When to use it

Install this plugin instead of the regular OpenVino plugin if your Intel GPU is 10th gen Core or older (Gen9/Gen11 graphics, for example HD/UHD Graphics 610 to 630). On 11th gen and newer (Iris Xe, Arc) use the regular plugin, the newer runtime is faster there and keeps getting fixes.

On Linux with the camera.ui Docker image this is usually not needed: the image ships a legacy compute stack for old Intel GPUs. It mainly matters on Windows, where the OpenCL compiler is part of the graphics driver and cannot be updated separately.
