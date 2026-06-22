from __future__ import annotations

import asyncio
import io
from concurrent.futures import ThreadPoolExecutor
from typing import TYPE_CHECKING, Any, TypedDict, cast

import numpy as np
from camera_ui_sdk import ImageMetadata, VideoFrameData
from PIL import Image

if TYPE_CHECKING:
    from model_manager import ModelManager


class FaceBox(TypedDict):
    confidence: float
    box: tuple[float, float, float, float]  # x1, y1, x2, y2 in pixel coords


class FaceDetector:
    def __init__(self, manager: ModelManager) -> None:
        self.manager = manager
        self.initialized = False
        self.executor: ThreadPoolExecutor | None = ThreadPoolExecutor(max_workers=2)

        self.model: Any = None
        self.input_size: tuple[int, int] = (320, 320)

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

            ps = self.model.input(0).get_partial_shape()
            self.input_size = (ps[3].get_length(), ps[2].get_length())
            self.initialized = True
            self.manager.logger.success("Loaded face detector")
        except Exception as e:
            self.manager.logger.error(f"Failed to initialize face detector: {e}")
        finally:
            self._init_task = None

    async def detect(self, image: Image.Image, confidence_threshold: float = 0.5) -> list[FaceBox]:
        if not self.initialized or self.model is None:
            return []

        results = await asyncio.get_event_loop().run_in_executor(self.executor, self._predict, image)
        return self._parse_yolov9(results, confidence_threshold)

    async def detect_batch(
        self, images: list[Image.Image], confidence_threshold: float = 0.5
    ) -> list[list[FaceBox]]:
        if not self.initialized or self.model is None:
            return [[] for _ in images]
        return [await self.detect(img, confidence_threshold) for img in images]

    async def detect_frame(self, frame: VideoFrameData, confidence_threshold: float = 0.5) -> list[FaceBox]:
        if not self.initialized or self.model is None:
            return []

        width, height = frame["width"], frame["height"]
        np_array: np.ndarray[Any, Any] = np.frombuffer(frame["data"], dtype=np.uint8).reshape(
            (height, width, 3)
        )
        needs_resize = width != self.input_width or height != self.input_height
        image = Image.fromarray(np_array, mode="RGB")
        if needs_resize:
            image = image.resize((self.input_width, self.input_height))

        raw = await self.detect(image, confidence_threshold)
        image.close()

        if not needs_resize:
            return raw

        sx, sy = width / self.input_width, height / self.input_height
        return [
            {
                "confidence": p["confidence"],
                "box": (p["box"][0] * sx, p["box"][1] * sy, p["box"][2] * sx, p["box"][3] * sy),
            }
            for p in raw
        ]

    async def detect_single(self, image_data: bytes, metadata: ImageMetadata) -> list[FaceBox]:
        if not self.initialized or self.model is None:
            return []

        image = Image.open(io.BytesIO(image_data)).convert("RGB")
        width, height = image.size
        resized = image.resize((self.input_width, self.input_height))
        image.close()

        raw = await self.detect(resized)
        resized.close()

        sx, sy = width / self.input_width, height / self.input_height
        return [
            {
                "confidence": p["confidence"],
                "box": (p["box"][0] * sx, p["box"][1] * sy, p["box"][2] * sx, p["box"][3] * sy),
            }
            for p in raw
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

    def _predict(self, image: Image.Image) -> np.ndarray[Any, Any]:
        arr = np.asarray(image, dtype=np.float32).transpose(2, 0, 1)
        arr = np.ascontiguousarray(np.expand_dims(arr, axis=0)) / 255.0
        result = self.model([arr])
        return cast("np.ndarray[Any, Any]", result[self.model.output(0)][0])

    @staticmethod
    def _parse_yolov9(results: np.ndarray[Any, Any], threshold: float) -> list[FaceBox]:
        keep = np.where(results[4] > threshold)[0]
        faces: list[FaceBox] = []
        for idx in keep:
            conf = float(results[4, idx])
            cx, cy = float(results[0, idx]), float(results[1, idx])
            w, h = float(results[2, idx]), float(results[3, idx])
            faces.append({"confidence": conf, "box": (cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2)})
        return faces
