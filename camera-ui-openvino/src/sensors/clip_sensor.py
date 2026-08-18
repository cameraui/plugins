from __future__ import annotations

from typing import TYPE_CHECKING

from camera_ui_ml import detect_clip, model_runtime
from camera_ui_sdk import (
    ClipDetectorSensor,
    ClipResult,
    ModelSpec,
    VideoFrameData,
)

from defaults import CLIP_VISION_MODELS, clip_family

if TYPE_CHECKING:
    from camera_ui_sdk import LoggerService

    from main import OpenVinoPlugin


class OpenVinoClipSensor(ClipDetectorSensor):
    def __init__(self, plugin: OpenVinoPlugin, logger: LoggerService, name: str = "OpenVino CLIP") -> None:
        super().__init__(name)
        self._plugin = plugin
        self._logger = logger

    @property
    def modelSpec(self) -> ModelSpec:
        model_name = self._plugin.clip_model()
        input_size = CLIP_VISION_MODELS.get(model_name, 224)
        return {
            "input": {"width": input_size, "height": input_size, "format": "rgb"},
            "triggerLabels": ["person", "vehicle", "animal"],
            "embeddingModel": clip_family(model_name),
            **model_runtime((self._plugin.clip_encoders.get(model_name), "encode")),
        }

    async def detectEmbeddings(self, frames: list[VideoFrameData]) -> list[ClipResult]:
        model_name = self._plugin.clip_model()
        encoder = self._plugin.clip_encoders.get(model_name)

        if encoder is None or not encoder.initialized:
            return [{"embeddings": [], "embeddingModel": clip_family(model_name)} for _ in frames]

        return await detect_clip(encoder, frames)

    async def destroy(self) -> None:
        pass

    async def on_start(self) -> None:
        await self._plugin.get_clip_encoder(self._plugin.clip_model())
        self.updateModelSpec()
