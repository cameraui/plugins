from __future__ import annotations

from dataclasses import dataclass

from camera_ui_ml import Normalize
from camera_ui_sdk import DetectionLabel

# flipped to True by the legacy sibling plugin's sync script
LEGACY_RUNTIME = False

model_version = "v1"

_MODELS_HOST = "https://models.cameraui.com"
MODEL_BASE_URL = f"{_MODELS_HOST}/{model_version}/openvino"
MODEL_LFS_URL = MODEL_BASE_URL

OBJECT_MODELS: dict[str, int] = {
    "yolo-v9-t-320": 320,
    "yolo-v9-s-320": 320,
    "yolo-v9-m-320": 320,
    "yolo-v9-c-320": 320,
}

FACE_DETECTOR_MODELS: dict[str, int] = {
    "yolo-v9-t-320-faces": 320,
    "yolo-v9-s-320-faces": 320,
    "yolo-v9-m-320-faces": 320,
    "yolo-v9-t-640-faces": 640,
    "yolo-v9-s-640-faces": 640,
    "yolo-v9-m-640-faces": 640,
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
    "clip-vit-base-patch32-datacomp-vision": 224,
}

CLIP_TEXT_MODELS: dict[str, int] = {
    "clip-vit-base-patch32-text": 77,
    "clip-vit-base-patch32-datacomp-text": 77,
}


@dataclass(frozen=True)
class FaceEmbedderSpec:
    """How a recognition head wants its crop. The key it is stored under names
    the vector space, which is what the NVR keys enrolled faces by, so it
    changes whenever the preprocessing changes, not only the weights."""

    model: str
    size: int
    normalize: Normalize
    aligned: bool


FACE_EMBEDDERS: dict[str, FaceEmbedderSpec] = {
    # the suffixes name the crop, not the weights: both heads see a padded face
    # box now, where they used to get the detector's tight box, and that alone
    # makes the vectors incomparable to the ones already stored
    "facenet-inceptionresnetv1-512-padded": FaceEmbedderSpec(
        "facenet-inceptionresnetv1-512", 160, "facenet", False
    ),
    "arcface-r100-512-aligned": FaceEmbedderSpec("arcface-r100-512", 112, "arcface", True),
}

FACE_EMBEDDER_MODELS: list[str] = list(FACE_EMBEDDERS)

FACE_LANDMARK_MODEL = "yunet-256-face-landmarks"
FACE_LANDMARK_INPUT_SIZE = 256

# the padded face crop the server sends; the landmark model takes it from there
FACE_EMBEDDER_CROP_SIZE = 256

OCR_MODELS: list[str] = [
    "cct-xs-v2-global",
    "cct-s-v2-global",
]

DEFAULT_OBJECT_MODEL = "yolo-v9-s-320"

DEFAULT_FACE_DETECTOR = "yolo-v9-s-320-faces"
DEFAULT_FACE_EMBEDDER = "arcface-r100-512-aligned"

DEFAULT_LPD_DETECTOR = "yolo-v9-t-384-license-plates"
DEFAULT_OCR = "cct-xs-v2-global"

DEFAULT_CLIP_VISION = "clip-vit-base-patch32-vision"
DEFAULT_CLIP_TEXT = "clip-vit-base-patch32-text"
DEFAULT_CLIP_EMBEDDER = "clip-vit-base-patch32"

OCR_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_"
OCR_PAD_CHAR = "_"
OCR_MAX_SLOTS = 10
OCR_INPUT_WIDTH = 128
OCR_INPUT_HEIGHT = 64

CLIP_EMBEDDING_DIM = 512

# OpenVINO IR carries no class names; labels are hardcoded to the trained classes.
OBJECT_LABELS: dict[int, DetectionLabel] = {0: "person", 1: "vehicle", 2: "animal"}

OPENVINO_DEVICES = ["Default", "AUTO", "CPU", "GPU", "NPU"]
DEFAULT_OPENVINO_DEVICE = "Default"

# some IRs ship with dynamic dims, but the runtime always feeds exactly these
# shapes (batch 1, fixed size); pinning them makes the models NPU-compilable
STATIC_INPUT_SHAPES: dict[str, list[list[int]]] = {
    **{spec.model: [[1, 3, spec.size, spec.size]] for spec in FACE_EMBEDDERS.values()},
    FACE_LANDMARK_MODEL: [[1, 3, FACE_LANDMARK_INPUT_SIZE, FACE_LANDMARK_INPUT_SIZE]],
    **{name: [[1, OCR_INPUT_HEIGHT, OCR_INPUT_WIDTH, 3]] for name in OCR_MODELS},
    **{name: [[1, 3, size, size]] for name, size in CLIP_VISION_MODELS.items()},
    **{name: [[1, tokens], [1, tokens]] for name, tokens in CLIP_TEXT_MODELS.items()},
}

DEFAULT_OPTION = "default"


def resolve_model(name: str | None, fallback: str) -> str:
    return fallback if not name or name == DEFAULT_OPTION else name


def clip_family(vision_model: str) -> str:
    return vision_model.removesuffix("-vision")


CLIP_SCORE_BANDS: dict[str, list[float]] = {
    "clip-vit-base-patch32": [0.15, 0.38],
    "clip-vit-base-patch32-datacomp": [0.10, 0.26],
}


def clip_score_band(family: str) -> list[float]:
    return CLIP_SCORE_BANDS.get(family, CLIP_SCORE_BANDS["clip-vit-base-patch32"])


def clip_text_for(vision_model: str) -> str:
    return f"{clip_family(vision_model)}-text"
