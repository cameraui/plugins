from __future__ import annotations

from typing import TYPE_CHECKING

from camera_ui_ml import detect_clip
from camera_ui_sdk import (
    ClipDetectorSensor,
    ClipResult,
    JsonSchema,
    ModelSpec,
    VideoFrameData,
)
from typing_extensions import TypedDict

from defaults import CLIP_VISION_MODELS, DEFAULT_CLIP_EMBEDDER, DEFAULT_CLIP_VISION

if TYPE_CHECKING:
    from camera_ui_sdk import LoggerService

    from main import CoreMLPlugin


class ClipStorageValues(TypedDict):
    vision_model: str


class CoreMLClipSensor(ClipDetectorSensor["ClipStorageValues"]):
    def __init__(self, plugin: CoreMLPlugin, logger: LoggerService, name: str = "CoreML CLIP") -> None:
        super().__init__(name)
        self._plugin = plugin
        self._logger = logger

    @property
    def storage_schema(self) -> list[JsonSchema]:
        return [
            {
                "type": "string",
                "key": "vision_model",
                "title": "Vision Model",
                "description": "CLIP vision model for embedding generation",
                "group": "CLIP",
                "enum": list(CLIP_VISION_MODELS.keys()),
                "store": True,
                "defaultValue": DEFAULT_CLIP_VISION,
                "required": True,
                "onSet": self._on_change_model,
            },
        ]

    @property
    def modelSpec(self) -> ModelSpec:
        model_name = self.storage.values.get("vision_model", DEFAULT_CLIP_VISION)
        input_size = CLIP_VISION_MODELS.get(model_name, 224)
        return {
            "input": {"width": input_size, "height": input_size, "format": "rgb"},
            "triggerLabels": ["person", "vehicle", "animal"],
            "embeddingModel": DEFAULT_CLIP_EMBEDDER,
        }

    async def detectEmbeddings(self, frames: list[VideoFrameData]) -> list[ClipResult]:
        model_name = self.storage.values.get("vision_model", DEFAULT_CLIP_VISION)
        encoder = self._plugin.clip_encoders.get(model_name)

        if encoder is None or not encoder.initialized:
            return [{"embeddings": [], "embeddingModel": DEFAULT_CLIP_EMBEDDER} for _ in frames]

        return await detect_clip(encoder, frames)

    async def destroy(self) -> None:
        pass

    async def on_assigned(self) -> None:
        model_name = self.storage.values.get("vision_model", DEFAULT_CLIP_VISION)
        await self._plugin.get_clip_encoder(model_name)

    async def _on_change_model(self, _old: str, new: str) -> None:
        self._logger.log(f"Switching CLIP vision model to {new}")
        await self._plugin.get_clip_encoder(new)
