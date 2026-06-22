from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from typing import TYPE_CHECKING, Any

import ncnn
import numpy as np
from PIL import Image

from defaults import FACE_EMBEDDER_INPUT_SIZE

if TYPE_CHECKING:
    from model_manager import ModelManager


class FaceEmbedder:
    def __init__(self, manager: ModelManager) -> None:
        self.manager = manager
        self.initialized = False
        self.executor: ThreadPoolExecutor | None = ThreadPoolExecutor(max_workers=2)

        self.model: Any = None
        self.input_size = FACE_EMBEDDER_INPUT_SIZE

        self.closed = False
        self._init_task: asyncio.Task[None] | None = None

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

            self.initialized = True
            self.manager.logger.success(f"Loaded face embedder: {model_name}")
        except Exception as e:
            self.manager.logger.error(f"Failed to initialize face embedder: {e}")
        finally:
            self._init_task = None

    async def embed(self, image: Image.Image) -> list[float]:
        if not self.initialized or self.model is None:
            return []

        resized = image.resize((self.input_size, self.input_size))
        arr = np.asarray(resized, dtype=np.float32)
        resized.close()
        arr = (arr - 127.5) / 128.0
        arr = np.ascontiguousarray(arr.transpose(2, 0, 1))  # HWC -> CHW, no batch dim

        embedding = await asyncio.get_event_loop().run_in_executor(self.executor, self._predict, arr)
        norm = np.linalg.norm(embedding)
        if norm > 0:
            embedding = embedding / norm
        return list(embedding.tolist())

    async def embed_from_crop(
        self, frame_data: bytes, frame_width: int, frame_height: int, box: tuple[float, float, float, float]
    ) -> list[float]:
        if not self.initialized or self.model is None:
            return []

        x1, y1, x2, y2 = (
            max(0, int(box[0])),
            max(0, int(box[1])),
            min(frame_width, int(box[2])),
            min(frame_height, int(box[3])),
        )
        if x2 <= x1 or y2 <= y1:
            return []

        np_array: np.ndarray[Any, Any] = np.frombuffer(frame_data, dtype=np.uint8).reshape(
            (frame_height, frame_width, 3)
        )
        image = Image.fromarray(np_array[y1:y2, x1:x2], mode="RGB")
        result = await self.embed(image)
        image.close()
        return result

    async def embed_batch(self, images: list[Image.Image]) -> list[list[float]]:
        if not self.initialized or self.model is None:
            return [[] for _ in images]
        return [await self.embed(img) for img in images]

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

    def _predict(self, tensor: np.ndarray[Any, Any]) -> np.ndarray[Any, Any]:
        ex = self.model.create_extractor()
        ex.input("in0", ncnn.Mat(tensor))
        _, out = ex.extract("out0")
        return np.array(out).flatten()
