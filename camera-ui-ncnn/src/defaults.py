from __future__ import annotations

from camera_ui_sdk import DetectionLabel

MODEL_BASE_URL = "https://raw.githubusercontent.com/cameraui/models/main/models/ncnn"
MODEL_LFS_URL = "https://media.githubusercontent.com/media/cameraui/models/main/models/ncnn"

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

FACE_EMBEDDER_INPUT_SIZE = 160

OCR_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_"
OCR_PAD_CHAR = "_"
OCR_MAX_SLOTS = 10
OCR_INPUT_WIDTH = 128
OCR_INPUT_HEIGHT = 64

# NCNN models carry no embedded class names, so object labels are hardcoded.
OBJECT_LABELS: dict[int, DetectionLabel] = {0: "person", 1: "vehicle", 2: "animal"}

# NCNN runs on Vulkan when available (GPU) and falls back to CPU otherwise.
DEFAULT_USE_VULKAN = True
