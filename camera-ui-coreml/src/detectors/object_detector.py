from __future__ import annotations

import ast
import asyncio
import io
import re
from concurrent.futures import ThreadPoolExecutor
from typing import TYPE_CHECKING, Any, TypedDict, cast

import numpy as np
from camera_ui_sdk import Detection, DetectionLabel, ImageMetadata, VideoFrameData
from PIL import Image

if TYPE_CHECKING:
    from model_manager import ModelManager


class DetectionResult(TypedDict):
    label: DetectionLabel
    confidence: float
    box: tuple[float, float, float, float]


class ObjectDetector:
    def __init__(self, manager: ModelManager) -> None:
        self.manager = manager
        self.initialized = False
        self.executor: ThreadPoolExecutor | None = ThreadPoolExecutor(max_workers=4)

        self.model: Any = None
        self.input_name: str = ""
        self.input_size: tuple[int, int] = (320, 320)
        self.labels: dict[int, DetectionLabel] = {}

        self.closed = False
        self._init_task: asyncio.Task[None] | None = None

    @property
    def input_width(self) -> int:
        return self.input_size[0]

    @property
    def input_height(self) -> int:
        return self.input_size[1]

    async def initialize(self, model_name: str) -> None:
        if self.initialized:
            return
        if self._init_task is None:
            self._init_task = asyncio.create_task(self._do_initialize(model_name))
        await self._init_task

    async def _do_initialize(self, model_name: str) -> None:
        try:
            self.model = await self.manager.ensure_model(model_name)
            if self.closed:
                return

            spec = self.model.get_spec()
            self.input_name = spec.description.input[0].name

            inputdesc = spec.description.input[0]
            inputheight: Any = inputdesc.type.imageType.height
            inputwidth: Any = inputdesc.type.imageType.width
            self.input_size = (inputwidth, inputheight)

            self.labels = _parse_labels(spec.description.metadata.userDefined)
            self.initialized = True
        except Exception as e:
            self.manager.logger.error(f"Failed to initialize object detector: {e}")
        finally:
            self._init_task = None

    async def detect(
        self, image: Image.Image, confidence_threshold: float = 0.5
    ) -> list[tuple[int, float, tuple[float, float, float, float]]]:
        if not self.initialized or self.model is None:
            return []

        out_dict = await asyncio.get_event_loop().run_in_executor(self.executor, self._predict, image)
        results = list(out_dict.values())[0][0]
        return _parse_yolov9(results, confidence_threshold)

    async def detect_frame(
        self, frame: VideoFrameData, confidence_threshold: float = 0.5
    ) -> list[DetectionResult]:
        if not self.initialized or self.model is None:
            return []

        width = frame["width"]
        height = frame["height"]
        data = frame["data"]

        np_array: np.ndarray[Any, Any] = np.frombuffer(data, dtype=np.uint8).reshape((height, width, 3))
        needs_resize = width != self.input_width or height != self.input_height
        image = Image.fromarray(np_array, mode="RGB")
        if needs_resize:
            image = image.resize((self.input_width, self.input_height))

        raw = await self.detect(image, confidence_threshold)
        image.close()

        if not needs_resize:
            return [
                {"label": self.labels.get(cid, "unknown"), "confidence": s, "box": b}  # type: ignore[arg-type]
                for cid, s, b in raw
            ]

        sx = width / self.input_width
        sy = height / self.input_height
        return [
            {
                "label": self.labels.get(cid, "unknown"),  # type: ignore[arg-type]
                "confidence": s,
                "box": (b[0] * sx, b[1] * sy, b[2] * sx, b[3] * sy),
            }
            for cid, s, b in raw
        ]

    async def detect_single(self, image_data: bytes, metadata: ImageMetadata) -> list[Detection]:
        if not self.initialized or self.model is None:
            return []

        image = (
            Image.open(io.BytesIO(image_data)).convert("RGB").resize((self.input_width, self.input_height))
        )
        raw = await self.detect(image)
        image.close()

        return [
            {
                "label": self.labels.get(cid, "unknown"),  # type: ignore[arg-type]
                "confidence": s,
                "box": {
                    "x": b[0] / self.input_width,
                    "y": b[1] / self.input_height,
                    "width": (b[2] - b[0]) / self.input_width,
                    "height": (b[3] - b[1]) / self.input_height,
                },
            }
            for cid, s, b in raw
        ]

    async def close(self) -> None:
        self.closed = True
        if self._init_task:
            self._init_task.cancel()
            self._init_task = None
        self.initialized = False
        self.model = None
        if self.executor:
            self.executor.shutdown(wait=False)
            self.executor = None

    def _predict(self, image: Image.Image) -> Any:
        return self.model.predict({self.input_name: image})


def _parse_labels(user_defined: dict[str, Any]) -> dict[int, DetectionLabel]:
    yolo = user_defined.get("names") or user_defined.get("yolo.names")
    if yolo:
        j = ast.literal_eval(yolo)
        return {int(k): v for k, v in j.items()}
    classes = user_defined.get("classes")
    if not classes:
        raise Exception("no classes found in model metadata")
    lines = classes.split(",")
    ret: dict[int, DetectionLabel] = {}
    for row, content in enumerate(lines):
        pair = re.split(r"[:\s]+", content.strip(), maxsplit=1)
        if len(pair) == 2 and pair[0].strip().isdigit():
            ret[int(pair[0])] = cast(DetectionLabel, pair[1].strip())
        else:
            ret[row] = content.strip()
    return ret


def _parse_yolov9(
    results: np.ndarray[Any, Any], threshold: float = 0.2
) -> list[tuple[int, float, tuple[float, float, float, float]]]:
    keep = np.argwhere(results[4:] > threshold)
    detections: list[tuple[int, float, tuple[float, float, float, float]]] = []
    for indices in keep:
        class_id = indices[0]
        index = indices[1]
        confidence = float(results[class_id + 4, index])
        cx, cy = float(results[0][index]), float(results[1][index])
        w, h = float(results[2][index]), float(results[3][index])
        detections.append((int(class_id), confidence, (cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2)))
    return detections
