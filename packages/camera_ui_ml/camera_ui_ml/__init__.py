from __future__ import annotations

from .backend import (
    DType,
    InferenceBackend,
    InputSpec,
    Layout,
    NDArray,
    Normalize,
    Outputs,
)
from .detectors import (
    BaseDetector,
    BoxDetector,
    Embedder,
    NormalizedDetection,
    OcrResult,
    ParseKind,
    PlateOcr,
)
from .geometry import (
    Box,
    NormalizedBox,
    clamp_box,
    cxcywh_to_xyxy,
    normalize_box,
    pad_box,
    scale_box,
)
from .model_manager import BaseModelManager
from .parsing import (
    RawDetection,
    channels_first,
    decode_ocr,
    l2_normalize,
    nms,
    parse_end2end,
    parse_yolov9,
)
from .pipeline import prepare_executor, run_prepare
from .pipelines import detect_clip, detect_faces, detect_objects, detect_plates
from .preprocess import (
    crop_rgb,
    decode_image,
    frame_to_rgb,
    resize_rgb,
    to_pil,
    to_tensor,
)

__all__ = [
    # backend seam
    "InferenceBackend",
    "InputSpec",
    "Outputs",
    "NDArray",
    "Layout",
    "Normalize",
    "DType",
    # model manager
    "BaseModelManager",
    # detectors (ClipEncoder is opt-in via camera_ui_ml.detectors.clip)
    "BaseDetector",
    "BoxDetector",
    "NormalizedDetection",
    "ParseKind",
    "Embedder",
    "PlateOcr",
    "OcrResult",
    # geometry
    "Box",
    "NormalizedBox",
    "cxcywh_to_xyxy",
    "scale_box",
    "clamp_box",
    "normalize_box",
    "pad_box",
    # parsing
    "RawDetection",
    "channels_first",
    "parse_yolov9",
    "parse_end2end",
    "decode_ocr",
    "l2_normalize",
    "nms",
    # preprocess
    "frame_to_rgb",
    "resize_rgb",
    "to_pil",
    "to_tensor",
    "crop_rgb",
    "decode_image",
    # pipeline
    "run_prepare",
    "prepare_executor",
    # orchestration
    "detect_objects",
    "detect_faces",
    "detect_plates",
    "detect_clip",
]
