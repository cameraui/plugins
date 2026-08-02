## [1.2.4]

- Initial release. Same features as the OpenVino plugin, but with the older OpenVINO 2024.6 runtime for Intel GPUs up to 10th gen Core. On those chips the current runtime fails to build its GPU code and detection silently ran on the CPU; with this plugin the models load on the GPU again.
