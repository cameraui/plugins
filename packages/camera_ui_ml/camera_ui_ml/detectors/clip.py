from __future__ import annotations

import asyncio
from typing import Any

import numpy as np
from camera_ui_sdk import LoggerService, VideoFrameData
from transformers import CLIPProcessor

from ..backend import InferenceBackend, NDArray
from ..model_manager import BaseModelManager
from ..parsing import l2_normalize
from ..pipeline import run_prepare
from ..preprocess import frame_to_rgb, to_pil


class ClipEncoder:
    def __init__(
        self,
        manager: BaseModelManager,
        logger: LoggerService,
        *,
        pretrained: str = "openai/clip-vit-base-patch32",
        embedding_model: str = "clip-vit-base-patch32",
    ) -> None:
        self.manager = manager
        self.logger = logger
        self.embedding_model = embedding_model

        self.vision: InferenceBackend | None = None
        self.text: InferenceBackend | None = None
        self.processor: Any = None

        self.initialized = False
        self.closed = False
        self._pretrained = pretrained
        self._init_task: asyncio.Task[None] | None = None

    async def initialize(self, vision_model: str, text_model: str) -> None:
        if self.initialized:
            return
        if self._init_task is None:
            self._init_task = asyncio.create_task(self._do_initialize(vision_model, text_model))
        await self._init_task

    async def close(self) -> None:
        self.closed = True
        if self._init_task is not None:
            self._init_task.cancel()
            self._init_task = None
        self.initialized = False
        if self.vision is not None:
            self.vision.close()
            self.vision = None
        if self.text is not None:
            self.text.close()
            self.text = None
        self.processor = None

    async def embed_image(self, image: NDArray) -> list[float]:
        """Embed an HWC uint8 RGB image."""
        if not self._ready():
            return []
        assert self.vision is not None

        pil = to_pil(image)
        pixel_values = await run_prepare(lambda: self._vision_input(pil))
        outputs = await self.vision.infer([pixel_values])
        return [float(value) for value in l2_normalize(outputs[0])]

    async def embed_text(self, text: str) -> list[float]:
        if not self._ready():
            return []
        assert self.text is not None

        input_ids, attention_mask = await run_prepare(lambda: self._text_input(text))
        outputs = await self.text.infer([input_ids, attention_mask])
        return [float(value) for value in l2_normalize(outputs[0])]

    async def embed_frame(self, width: int, height: int, data: bytes) -> list[float]:
        return await self.embed_image(frame_to_rgb(data, width, height))

    async def embed_frames(self, frames: list[VideoFrameData]) -> list[list[float]]:
        if not self._ready():
            return [[] for _ in frames]
        return [await self.embed_frame(frame["width"], frame["height"], frame["data"]) for frame in frames]

    def _ready(self) -> bool:
        return (
            self.initialized
            and self.vision is not None
            and self.text is not None
            and self.processor is not None
        )

    async def _do_initialize(self, vision_model: str, text_model: str) -> None:
        try:
            self.vision = await self.manager.ensure_backend(vision_model)
            self.text = await self.manager.ensure_backend(text_model)
            self.processor = await asyncio.to_thread(CLIPProcessor.from_pretrained, self._pretrained)
            if self.closed:
                return
            self.initialized = True
            self.logger.success(f"Loaded CLIP: {vision_model} + {text_model}")
        except Exception as error:
            self.logger.error(f"Failed to initialize CLIP encoder: {error}")
        finally:
            self._init_task = None

    def _vision_input(self, pil: Any) -> NDArray:
        inputs = self.processor(images=pil, return_tensors="np", padding="max_length", truncation=True)
        return np.asarray(inputs["pixel_values"], dtype=np.float32)

    def _text_input(self, text: str) -> tuple[NDArray, NDArray]:
        inputs = self.processor(text=text, return_tensors="np", padding="max_length", truncation=True)
        return (
            np.asarray(inputs["input_ids"], dtype=np.int64),
            np.asarray(inputs["attention_mask"], dtype=np.int64),
        )
