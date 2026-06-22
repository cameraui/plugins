from __future__ import annotations

from camera_ui_sdk import DetectionLabel

MODEL_BASE_URL = "https://raw.githubusercontent.com/cameraui/models/main/models/openvino"
MODEL_LFS_URL = "https://media.githubusercontent.com/media/cameraui/models/main/models/openvino"

model_version = "v1"

OBJECT_MODELS: dict[str, int] = {
    "yolo-v9-t-320": 320,
    "yolo-v9-s-320": 320,
    "yolo-v9-m-320": 320,
    "yolo-v9-c-320": 320,
}

FACE_DETECTOR_MODELS: dict[str, int] = {
    "yolo-v9-t-320-faces": 320,
}

LPD_DETECTOR_MODELS: dict[str, int] = {
    "yolo-v9-t-256-license-plates": 256,
    "yolo-v9-t-384-license-plates": 384,
    "yolo-v9-t-416-license-plates": 416,
    "yolo-v9-t-512-license-plates": 512,
    "yolo-v9-t-640-license-plates": 640,
    "yolo-v9-s-608-license-plates": 608,
}

CLIP_VISION_MODELS: dict[str, int] = {
    "clip-vit-base-patch32-vision": 224,
}

CLIP_TEXT_MODELS: dict[str, int] = {
    "clip-vit-base-patch32-text": 77,
}

FACE_EMBEDDER_MODELS: dict[str, int] = {
    "facenet-inceptionresnetv1-512": 512,
}

OCR_MODELS: list[str] = [
    "cct-xs-v2-global",
    "cct-s-v2-global",
]

DEFAULT_OBJECT_MODEL = "yolo-v9-s-320"

DEFAULT_FACE_DETECTOR = "yolo-v9-t-320-faces"
DEFAULT_FACE_EMBEDDER = "facenet-inceptionresnetv1-512"

DEFAULT_LPD_DETECTOR = "yolo-v9-t-384-license-plates"
DEFAULT_OCR = "cct-xs-v2-global"

DEFAULT_CLIP_VISION = "clip-vit-base-patch32-vision"
DEFAULT_CLIP_TEXT = "clip-vit-base-patch32-text"
DEFAULT_CLIP_EMBEDDER = "clip-vit-base-patch32"

FACE_EMBEDDER_INPUT_SIZE = 160

OCR_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_"
OCR_PAD_CHAR = "_"
OCR_MAX_SLOTS = 10
OCR_INPUT_WIDTH = 128
OCR_INPUT_HEIGHT = 64

CLIP_EMBEDDING_DIM = 512

# The OpenVINO IR has no embedded class names (unlike the ONNX variant), so
# object/face labels are hardcoded to match the trained classes.
OBJECT_LABELS: dict[int, DetectionLabel] = {0: "person", 1: "vehicle", 2: "animal"}

# OpenVINO device selection (plugin-level setting).
# "Default" auto-detects hardware and builds a smart AUTO string (e.g. AUTO:NPU,GPU,CPU);
# "AUTO" lets OpenVINO choose; CPU/GPU/NPU force a specific device.
OPENVINO_DEVICES = ["Default", "AUTO", "CPU", "GPU", "NPU"]
DEFAULT_OPENVINO_DEVICE = "Default"
