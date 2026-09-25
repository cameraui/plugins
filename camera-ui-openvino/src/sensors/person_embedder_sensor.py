from __future__ import annotations

from typing import TYPE_CHECKING

from camera_ui_ml import embed_persons, model_runtime
from camera_ui_sdk import (
    ModelSpec,
    PersonEmbedderSensor,
    PersonEmbeddingResult,
    VideoFrameData,
)

from defaults import PERSON_EMBEDDER_HEIGHT, PERSON_EMBEDDER_MODEL, PERSON_EMBEDDER_WIDTH

if TYPE_CHECKING:
    from camera_ui_sdk import LoggerService

    from main import OpenVinoPlugin


class OpenVinoPersonEmbedderSensor(PersonEmbedderSensor):
    def __init__(
        self, plugin: OpenVinoPlugin, logger: LoggerService, name: str = "OpenVino Person Embedder"
    ) -> None:
        super().__init__(name)
        self._plugin = plugin
        self._logger = logger

    @property
    def modelSpec(self) -> ModelSpec:
        return {
            "input": {"width": PERSON_EMBEDDER_WIDTH, "height": PERSON_EMBEDDER_HEIGHT, "format": "rgb"},
            "triggerLabels": ["person"],
            "embeddingModel": PERSON_EMBEDDER_MODEL,
            **model_runtime((self._plugin.person_embedders.get(PERSON_EMBEDDER_MODEL), "embed")),
        }

    async def embedPersons(self, frames: list[VideoFrameData]) -> list[PersonEmbeddingResult]:
        embedder = self._plugin.person_embedders.get(PERSON_EMBEDDER_MODEL)
        if embedder is None or not embedder.initialized:
            return [{"embedding": [], "embeddingModel": PERSON_EMBEDDER_MODEL} for _ in frames]

        return await embed_persons(embedder, frames, PERSON_EMBEDDER_MODEL)

    async def destroy(self) -> None:
        pass

    async def on_start(self) -> None:
        await self._plugin.get_person_embedder()
        self.updateModelSpec()
