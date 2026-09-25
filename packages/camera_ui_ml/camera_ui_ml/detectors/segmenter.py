from __future__ import annotations

import math
from typing import TYPE_CHECKING

import numpy as np
from camera_ui_sdk import BoundingBox, LoggerService
from PIL import Image

from ..backend import InputSpec, NDArray, Outputs
from ..model_manager import BaseModelManager
from ..parsing import channels_first
from .base import BaseDetector

if TYPE_CHECKING:
    from camera_ui_sdk import ObjectMask

MIN_SCORE = 0.25
MIN_IOU = 0.3


class Segmenter(BaseDetector):
    def __init__(
        self,
        manager: BaseModelManager,
        logger: LoggerService,
        *,
        size: tuple[int, int] = (320, 320),
        name: str = "segmenter",
    ) -> None:
        super().__init__(manager, logger)
        self.name = name
        self.input_size = size

    async def _configure(self, model_name: str) -> None:
        assert self.backend is not None
        width, height = self.backend.input_size
        if width > 0 and height > 0:
            self.input_size = (width, height)

    @property
    def _spec(self) -> InputSpec:
        return InputSpec(self.input_size[0], self.input_size[1], layout="nchw", normalize="unit")

    async def segment(self, rgb: NDArray, box: BoundingBox) -> ObjectMask | None:
        """Outline the object at ``box`` (normalized to ``rgb``); the mask box is normalized the same way."""
        if not self._ready() or rgb.size == 0:
            return None
        assert self.backend is not None

        width, height = self.input_size
        if rgb.shape[1] != width or rgb.shape[0] != height:
            # bilinear, as measured; PIL's bicubic default cost up to 3 points of mask IoU
            rgb = np.asarray(
                Image.fromarray(rgb, mode="RGB").resize((width, height), Image.Resampling.BILINEAR)
            )
        outputs = await self.backend.run(rgb, self._spec)
        return decode_mask(outputs, box, self.input_size)


def decode_mask(outputs: Outputs, box: BoundingBox, size: tuple[int, int]) -> ObjectMask | None:
    split = _split(outputs)
    if split is None:
        return None
    candidates, protos = split
    coefficients = protos.shape[0]
    classes = candidates.shape[0] - 4 - coefficients
    if classes < 1:
        return None

    width, height = size
    scores = candidates[4 : 4 + classes].max(axis=0)
    cx, cy, w, h = (candidates[i] / scale for i, scale in enumerate((width, height, width, height)))
    left, top, right, bottom = cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2

    overlap_x = np.minimum(right, box["x"] + box["width"]) - np.maximum(left, box["x"])
    overlap_y = np.minimum(bottom, box["y"] + box["height"]) - np.maximum(top, box["y"])
    inter = np.clip(overlap_x, 0, None) * np.clip(overlap_y, 0, None)
    union = w * h + box["width"] * box["height"] - inter
    iou = np.where((scores > MIN_SCORE) & (union > 0), inter / np.maximum(union, 1e-9), 0.0)
    best = int(np.argmax(iou))
    if iou[best] < MIN_IOU:
        return None

    x1 = min(max(math.floor(left[best] * width), 0), width)
    y1 = min(max(math.floor(top[best] * height), 0), height)
    x2 = min(max(math.ceil(right[best] * width), 0), width)
    y2 = min(max(math.ceil(bottom[best] * height), 0), height)
    if x2 <= x1 or y2 <= y1:
        return None

    logits = candidates[4 + classes :, best] @ protos.reshape(coefficients, -1)
    # tanh form of the sigmoid, exp overflows on large logits
    probability = 0.5 * (1.0 + np.tanh(logits / 2.0))
    small = (
        np.clip(probability * 255.0 + 0.5, 0, 255).astype(np.uint8).reshape(protos.shape[1], protos.shape[2])
    )
    full = np.asarray(Image.fromarray(small).resize((width, height), Image.Resampling.BILINEAR))
    crop = np.ascontiguousarray(full[y1:y2, x1:x2])

    return {
        "box": {"x": x1 / width, "y": y1 / height, "width": (x2 - x1) / width, "height": (y2 - y1) / height},
        "width": x2 - x1,
        "height": y2 - y1,
        "data": crop.tobytes(),
    }


def _split(outputs: Outputs) -> tuple[NDArray, NDArray] | None:
    # the runtimes name and order the two outputs differently, the shapes tell them apart
    candidates: NDArray | None = None
    protos: NDArray | None = None
    for output in outputs:
        array = np.squeeze(np.asarray(output, dtype=np.float32))
        if array.ndim == 3:
            protos = array
        elif array.ndim == 2:
            candidates = channels_first(array)
    if candidates is None or protos is None:
        return None
    return candidates, protos
