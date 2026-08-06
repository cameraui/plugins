## [1.2.6]

- **A "Reset to Defaults" button in every settings section.** One click puts all values of that section back to the defaults, models included.
- **A new "default" choice in every model dropdown.** It follows the recommended model for that task, so plugin updates can improve the pick automatically. Choosing a concrete model still pins it. Existing setups keep their current selection.
- **Five new face detection models.** Small and medium tiers plus 640 px variants of each size (t, s, m). The 640 models catch small and distant faces the 320 px default misses, at a higher compute cost. The default model stays unchanged.

## [1.2.5]

- When the GPU refuses a model even here, the log no longer recommends this very plugin as the way out.

## [1.2.4]

- Initial release. Same features as the OpenVino plugin, but with the older OpenVINO 2024.6 runtime for Intel GPUs up to 10th gen Core. On those chips the current runtime fails to build its GPU code and detection silently ran on the CPU; with this plugin the models load on the GPU again.
