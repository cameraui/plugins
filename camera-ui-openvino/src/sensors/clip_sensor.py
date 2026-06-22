from __future__ import annotations

from typing import TYPE_CHECKING

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

    from main import OpenVinoPlugin


class ClipStorageValues(TypedDict):
    vision_model: str


class OpenVinoClipSensor(ClipDetectorSensor["ClipStorageValues"]):
    def __init__(self, plugin: OpenVinoPlugin, logger: LoggerService, name: str = "OpenVino CLIP") -> None:
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

        empty: ClipResult = {"embeddings": [], "embeddingModel": DEFAULT_CLIP_EMBEDDER}
        if encoder is None or not encoder.initialized:
            return [empty for _ in frames]

        embeddings = await encoder.embed_frames(frames)

        results: list[ClipResult] = []
        for i, emb in enumerate(embeddings):
            if not emb:
                results.append(empty)
                continue

            label = frames[i].get("label", "unknown")
            results.append(
                {
                    "embeddings": [
                        {
                            "label": label,
                            "box": {"x": 0, "y": 0, "width": 1, "height": 1},
                            "embedding": emb,
                        }
                    ],
                    "embeddingModel": encoder.embedding_model,
                }
            )

        return results

    async def destroy(self) -> None:
        pass

    async def on_assigned(self) -> None:
        model_name = self.storage.values.get("vision_model", DEFAULT_CLIP_VISION)
        await self._plugin.get_clip_encoder(model_name)

    async def _on_change_model(self, _old: str, new: str) -> None:
        self._logger.log(f"Switching CLIP vision model to {new}")
        await self._plugin.get_clip_encoder(new)
