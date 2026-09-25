from __future__ import annotations

from .base import BaseDetector
from .box import BoxDetector, NormalizedDetection, ParseKind
from .embedder import Embedder
from .landmarks import LandmarkDetector
from .ocr import DEFAULT_ALPHABET, OcrResult, PlateOcr
from .person import PersonEmbedder
from .segmenter import Segmenter

__all__ = [
    "BaseDetector",
    "BoxDetector",
    "NormalizedDetection",
    "ParseKind",
    "Embedder",
    "LandmarkDetector",
    "PersonEmbedder",
    "Segmenter",
    "PlateOcr",
    "OcrResult",
    "DEFAULT_ALPHABET",
]
