from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from typing import TYPE_CHECKING, Any, cast

import numpy as np
from camera_ui_sdk import VideoFrameData
from PIL import Image
from transformers import CLIPProcessor

from defaults import DEFAULT_CLIP_EMBEDDER, DEFAULT_CLIP_TEXT, DEFAULT_CLIP_VISION

if TYPE_CHECKING:
    from model_manager import ModelManager


class ClipEncoder:
    def __init__(self, manager: ModelManager) -> None:
        self.manager = manager
        self.initialized = False
        self.executor: ThreadPoolExecutor | None = ThreadPoolExecutor(max_workers=2)

        self.vision_model: Any = None
        self.text_model: Any = None
        self.processor: CLIPProcessor | None = None

        self.closed = False
        self._init_task: asyncio.Task[None] | None = None

    @property
    def embedding_model(self) -> str:
        return DEFAULT_CLIP_EMBEDDER

    async def initialize(
        self, vision_model_name: str = DEFAULT_CLIP_VISION, text_model_name: str = DEFAULT_CLIP_TEXT
    ) -> None:
        if self.initialized:
            return
        if self._init_task is None:
            self._init_task = asyncio.create_task(self._do_initialize(vision_model_name, text_model_name))
        await self._init_task

    async def _do_initialize(self, vision_model_name: str, text_model_name: str) -> None:
        try:
            self.vision_model = await self.manager.ensure_model(vision_model_name)
            if self.closed:
                return
            self.manager.logger.success(f"Loaded CLIP vision: {vision_model_name}")

            self.text_model = await self.manager.ensure_model(text_model_name)
            if self.closed:
                return  # type: ignore[unreachable]
            self.manager.logger.success(f"Loaded CLIP text: {text_model_name}")

            if self.closed:
                return  # type: ignore[unreachable]

            self.processor = await asyncio.to_thread(
                CLIPProcessor.from_pretrained, "openai/clip-vit-base-patch32"
            )
            self.manager.logger.success("Loaded CLIP processor")

            self.initialized = True
        except Exception as e:
            self.manager.logger.error(f"Failed to initialize CLIP encoder: {e}")
        finally:
            self._init_task = None

    async def embed_image(self, image: Image.Image) -> list[float]:
        if not self.initialized or self.processor is None or self.vision_model is None:
            return []

        processor = self.processor
        vision_model = self.vision_model

        def _predict() -> list[float]:
            inputs = processor(images=image, return_tensors="np", padding="max_length", truncation=True)  # type: ignore[operator]
            pixel_values = np.asarray(inputs["pixel_values"], dtype=np.float32)
            result = vision_model([pixel_values])
            emb = np.array(result[vision_model.output(0)]).flatten().astype(np.float32)
            norm = float(np.linalg.norm(emb))
            return cast("list[float]", (emb / norm if norm > 0 else emb).tolist())

        return await asyncio.get_event_loop().run_in_executor(self.executor, _predict)

    async def embed_frame(self, width: int, height: int, data: bytes) -> list[float]:
        np_array: np.ndarray[Any, Any] = np.frombuffer(data, dtype=np.uint8).reshape((height, width, 3))
        image = Image.fromarray(np_array, mode="RGB")
        result = await self.embed_image(image)
        image.close()
        return result

    async def embed_frames(self, frames: list[VideoFrameData]) -> list[list[float]]:
        if not self.initialized or self.processor is None or self.vision_model is None:
            return [[] for _ in frames]
        return [await self.embed_frame(f["width"], f["height"], f["data"]) for f in frames]

    async def embed_text(self, text: str) -> list[float]:
        if not self.initialized or self.processor is None or self.text_model is None:
            return []

        processor = self.processor
        text_model = self.text_model

        def _predict() -> list[float]:
            inputs = processor(text=text, return_tensors="np", padding="max_length", truncation=True)  # type: ignore[operator]
            # CLIP text IR expects int64 token ids + attention mask, accessed by index
            # (input 0 = input_ids, input 1 = attention_mask).
            input_ids = np.asarray(inputs["input_ids"], dtype=np.int64)
            attention_mask = np.asarray(inputs["attention_mask"], dtype=np.int64)
            result = text_model([input_ids, attention_mask])
            emb = np.array(result[text_model.output(0)]).flatten().astype(np.float32)
            norm = float(np.linalg.norm(emb))
            return cast("list[float]", (emb / norm if norm > 0 else emb).tolist())

        return await asyncio.get_event_loop().run_in_executor(self.executor, _predict)

    async def close(self) -> None:
        self.closed = True
        if self._init_task:
            self._init_task.cancel()
            self._init_task = None
        self.vision_model = None
        self.text_model = None
        self.processor = None
        if self.executor:
            self.executor.shutdown(wait=False)
            self.executor = None
