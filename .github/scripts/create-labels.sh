#!/usr/bin/env bash
set -euo pipefail

REPO="${1:-cameraui/plugins}"

# name|color|description
labels=(
  # per-plugin (labeler.yml) — applied when a PR touches that plugin's folder
  "audio-yamnet|c5def5|Changes to the YAMNet Audio plugin"
  "coreml|c5def5|Changes to the CoreML plugin"
  "eufy|c5def5|Changes to the Eufy plugin"
  "homekit|c5def5|Changes to the HomeKit plugin"
  "onnx|c5def5|Changes to the ONNX plugin"
  "onvif|c5def5|Changes to the ONVIF plugin"
  "opencl|c5def5|Changes to the OpenCL plugin"
  "opencv|c5def5|Changes to the OpenCV plugin"
  "openvino|c5def5|Changes to the OpenVINO plugin"
  "pamdiff|c5def5|Changes to the Pam Diff plugin"
  "ring|c5def5|Changes to the Ring plugin"
  "rust-motion|c5def5|Changes to the Rust Motion plugin"
  "smtp|c5def5|Changes to the SMTP plugin"
  "tuya|c5def5|Changes to the Tuya plugin"
  "wasm-motion|c5def5|Changes to the WASM Motion plugin"
  "wyze|c5def5|Changes to the Wyze plugin"

  # cross-cutting (labeler.yml)
  "externals|d4c5f9|Changes to the externals/ submodules"
  "dependencies|0366d6|Dependency updates"
  "workflow|ededed|CI / GitHub config changes"
  "docs|0075ca|Documentation changes"

  # branch-based (pr-labeler.yml)
  "feature|a2eeef|New feature"
  "fix|d73a4a|Bug fix"
  "chore|ededed|Maintenance / chores"
  "housekeeping|fef2c0|Repo housekeeping"
)

for entry in "${labels[@]}"; do
  IFS='|' read -r name color desc <<<"$entry"
  echo "→ $name"
  gh label create "$name" --color "$color" --description "$desc" --repo "$REPO" --force
done

echo "Done — ${#labels[@]} labels ensured on $REPO."
