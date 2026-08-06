from __future__ import annotations

from camera_ui_sdk import DetectionLabel

model_version = "v1"

_MODELS_HOST = "https://models.cameraui.com"
MODEL_BASE_URL = f"{_MODELS_HOST}/{model_version}/hailo"
MODEL_LFS_URL = MODEL_BASE_URL

OBJECT_MODELS: dict[str, int] = {
    "yolo-v9-c-640": 640,
}

DEFAULT_OBJECT_MODEL = "yolo-v9-c-640"

OBJECT_LABELS: dict[int, DetectionLabel] = {0: "person", 1: "vehicle", 2: "animal"}

# These HEFs are COCO-80. Map COCO ids to our classes by COCO supercategory
# (person / vehicle / animal); unmapped COCO ids are dropped.
COCO_TO_CLASS: dict[int, int] = {
    0: 0,  # person
    1: 1,
    2: 1,
    3: 1,
    4: 1,
    5: 1,
    6: 1,
    7: 1,
    8: 1,  # bicycle car motorcycle airplane bus train truck boat
    14: 2,
    15: 2,
    16: 2,
    17: 2,
    18: 2,
    19: 2,
    20: 2,
    21: 2,
    22: 2,
    23: 2,  # bird..giraffe
}

DEFAULT_OPTION = "default"


def resolve_model(name: str | None, fallback: str) -> str:
    return fallback if not name or name == DEFAULT_OPTION else name
