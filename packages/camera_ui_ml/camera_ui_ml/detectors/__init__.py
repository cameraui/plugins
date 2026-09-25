from __future__ import annotations

from .base import BaseDetector
from .box import BoxDetector, NormalizedDetection, ParseKind
from .embedder import Embedder
from .landmarks import LandmarkDetector
from .ocr import DEFAULT_ALPHABET, OcrResult, PlateOcr

__all__ = [
    "BaseDetector",
    "BoxDetector",
    "NormalizedDetection",
    "ParseKind",
    "Embedder",
    "LandmarkDetector",
    "PlateOcr",
    "OcrResult",
    "DEFAULT_ALPHABET",
]
