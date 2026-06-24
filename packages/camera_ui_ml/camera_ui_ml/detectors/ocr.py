from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from camera_ui_sdk import LoggerService

from ..backend import InputSpec, NDArray, Outputs
from ..geometry import Box
from ..model_manager import BaseModelManager
from ..parsing import decode_ocr
from ..preprocess import frame_to_rgb
from .base import BaseDetector

#: Default plate alphabet: digits + uppercase letters + pad. Plugins pass the
#: exact constant their model was trained with.
DEFAULT_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_"


@dataclass(frozen=True)
class OcrResult:
    text: str
    confidence: float


class PlateOcr(BaseDetector):
    def __init__(
        self,
        manager: BaseModelManager,
        logger: LoggerService,
        *,
        width: int = 128,
        height: int = 64,
        slots: int = 10,
        alphabet: str = DEFAULT_ALPHABET,
        pad_char: str = "_",
        name: str = "OCR",
    ) -> None:
        super().__init__(manager, logger)
        self.name = name
        self.input_size = (width, height)
        self._slots = slots
        self._alphabet = alphabet
        self._pad = pad_char

    @property
    def _spec(self) -> InputSpec:
        return InputSpec(
            self.input_size[0],
            self.input_size[1],
            layout="nhwc",
            normalize="none",
            dtype="uint8",
        )

    async def recognize(self, image: NDArray) -> OcrResult | None:
        """Recognize an HWC uint8 RGB plate crop."""
        if not self._ready():
            return None
        assert self.backend is not None
        return self._decode(await self.backend.run(image, self._spec))

    async def recognize_from_crop(
        self, frame_data: bytes, width: int, height: int, box: Box
    ) -> OcrResult | None:
        if not self._ready():
            return None

        x1 = max(0, int(box[0]))
        y1 = max(0, int(box[1]))
        x2 = min(width, int(box[2]))
        y2 = min(height, int(box[3]))
        if x2 <= x1 or y2 <= y1:
            return None

        rgb = frame_to_rgb(frame_data, width, height)
        return await self.recognize(rgb[y1:y2, x1:x2])

    def _decode(self, outputs: Outputs) -> OcrResult | None:
        logits: NDArray | None = None
        for value in outputs:
            # Batched [1, slots, classes] (onnx/openvino/coreml) or bare [slots,
            # classes] (ncnn) — squeeze to a 2D logits matrix either way.
            arr = np.squeeze(np.asarray(value))
            if arr.ndim == 2 and arr.shape[0] == self._slots:
                logits = arr

        if logits is None:
            return None

        text, confidence = decode_ocr(logits, self._alphabet, self._pad)
        return OcrResult(text, confidence) if text else None
