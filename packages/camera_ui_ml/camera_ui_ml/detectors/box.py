from __future__ import annotations

import ast
import re
from collections.abc import Mapping
from typing import Any, Literal

import numpy as np
from camera_ui_sdk import ImageMetadata, LoggerService, VideoFrameData

from ..backend import InputSpec, NDArray, Normalize
from ..geometry import NormalizedBox, normalize_box, scale_box
from ..model_manager import BaseModelManager
from ..parsing import RawDetection, channels_first, nms, parse_end2end, parse_yolov9
from ..preprocess import decode_image, frame_to_rgb
from .base import BaseDetector

ParseKind = Literal["yolov9", "end2end"]
NormalizedDetection = tuple[int, float, NormalizedBox]


class BoxDetector(BaseDetector):
    def __init__(
        self,
        manager: BaseModelManager,
        logger: LoggerService,
        *,
        name: str = "detector",
        parse: ParseKind = "yolov9",
        size: tuple[int, int] = (320, 320),
        normalize: Normalize = "unit",
        multiclass: bool = False,
        apply_nms: bool = False,
        threshold: float = 0.5,
    ) -> None:
        super().__init__(manager, logger)
        self.name = name
        self.threshold = threshold
        self.input_size = size
        self.labels: dict[int, str] = {}

        self._parse = parse
        self._normalize = normalize
        self._multiclass = multiclass
        self._apply_nms = apply_nms

    async def _configure(self, model_name: str) -> None:
        assert self.backend is not None
        self.input_size = self.backend.input_size
        if self._multiclass:
            self.labels = _parse_labels(self.backend.metadata())

    @property
    def _spec(self) -> InputSpec:
        return InputSpec(
            self.input_size[0],
            self.input_size[1],
            layout="nchw",
            normalize=self._normalize,
        )

    async def detect(self, image: NDArray, threshold: float | None = None) -> list[RawDetection]:
        """Detect on an HWC uint8 RGB array; boxes are in model-input pixel coords."""
        if not self._ready():
            return []
        assert self.backend is not None

        outputs = await self.backend.run(image, self._spec)
        primary = np.asarray(outputs[0])
        limit = self.threshold if threshold is None else threshold

        if self._parse == "yolov9":
            detections = parse_yolov9(channels_first(primary), limit)
        else:
            detections = parse_end2end(np.squeeze(primary), limit)

        return nms(detections) if self._apply_nms else detections

    async def detect_frame(self, frame: VideoFrameData, threshold: float | None = None) -> list[RawDetection]:
        """Detect on a raw video frame; boxes are rescaled to frame pixel coords."""
        if not self._ready():
            return []

        rgb = frame_to_rgb(frame["data"], frame["width"], frame["height"], frame["format"])
        raw = await self.detect(rgb, threshold)

        scale_x = frame["width"] / self.input_size[0]
        scale_y = frame["height"] / self.input_size[1]
        return [(cid, conf, scale_box(box, scale_x, scale_y)) for cid, conf, box in raw]

    async def detect_single(
        self, image_data: bytes, metadata: ImageMetadata, threshold: float | None = None
    ) -> list[NormalizedDetection]:
        """Detect on an encoded image; boxes are normalized to 0..1."""
        if not self._ready():
            return []

        raw = await self.detect(decode_image(image_data), threshold)
        return [
            (cid, conf, normalize_box(box, self.input_size[0], self.input_size[1])) for cid, conf, box in raw
        ]


def _parse_labels(metadata: Mapping[str, str]) -> dict[int, str]:
    names = metadata.get("names") or metadata.get("yolo.names")
    if names:
        parsed: dict[Any, Any] = ast.literal_eval(names)
        return {int(key): str(value) for key, value in parsed.items()}

    classes = metadata.get("classes")
    if not classes:
        return {}

    labels: dict[int, str] = {}
    for row, line in enumerate(classes.split(",")):
        pair = re.split(r"[:\s]+", line.strip(), maxsplit=1)
        if len(pair) == 2 and pair[0].strip().isdigit():
            labels[int(pair[0])] = pair[1].strip()
        else:
            labels[row] = line.strip()
    return labels
