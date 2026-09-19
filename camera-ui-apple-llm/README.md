# Apple LLM

Apple's on-device foundation model as an assistant model for camera.ui. The model runs on the Mac this plugin runs on: no API key, no account, nothing leaves the machine.

Install it, then pick **Apple LLM** as the provider under Settings, Assistant, Add model.

## Requirements

- macOS 26 or newer on Apple Silicon with Apple Intelligence turned on, and the `fm` command line tool that ships with macOS 27.
- The license of the tool has to be agreed once per Mac: `sudo fm license`.
- camera.ui 2.2.4 or newer.

camera.ui itself may run anywhere. When your instance runs in Docker on Linux, install this plugin on a Mac paired as a worker and assign it there: the model answers on the Mac, the rest of camera.ui stays where it is.

## What it can and cannot do

Measured on macOS 27 (M-series, September 2026):

- **Descriptions, text alerts, episode stories:** yes, 1 to 2 seconds per answer. These ask for a fixed shape (title, summary, level), which is what the model is good at.
- **Pictures:** yes. A camera picture is described in about 2 seconds with a shape, 5 seconds as free text; the model even reads plates and clock overlays.
- **Chat:** short questions. The model holds 8192 tokens, the assistant's instructions alone take about 2900, so there is room for a conversation but not for the tool list. The assistant therefore sends this model no tools.

Apple's safety filter used to refuse plain answers about people at doors, gates and windows. On macOS 27 it answers them, and the plugin still asks for structured output by default because it is both robust against the filter and slightly faster. Both that and the relaxed filter level are switches in the plugin settings.

## After a system update

macOS downloads the model again after a major update. Until it is through, the model does not appear in the assistant settings and the plugin log says so; it checks again by itself, no restart needed.
