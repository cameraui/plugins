from __future__ import annotations

from typing import TYPE_CHECKING

from camera_ui_ml import embed_faces, model_runtime
from camera_ui_sdk import (
    FaceEmbedderSensor,
    FaceEmbeddingResult,
    ModelSpec,
    VideoFrameData,
)

from defaults import FACE_EMBEDDER_CROP_SIZE, FACE_LANDMARK_MODEL

if TYPE_CHECKING:
    from camera_ui_sdk import LoggerService

    from main import CoreMLPlugin


class CoreMLFaceEmbedderSensor(FaceEmbedderSensor):
    def __init__(
        self, plugin: CoreMLPlugin, logger: LoggerService, name: str = "CoreML Face Embedder"
    ) -> None:
        super().__init__(name)
        self._plugin = plugin
        self._logger = logger

    @property
    def modelSpec(self) -> ModelSpec:
        space = self._plugin.face_embedder_space()
        return {
            # the crop arrives padded around the face box, wider than the head's
            # own input: the landmark model needs the context, the warp the pixels
            "input": {"width": FACE_EMBEDDER_CROP_SIZE, "height": FACE_EMBEDDER_CROP_SIZE, "format": "rgb"},
            "triggerLabels": [],
            "embeddingModel": space,
            **model_runtime(
                (self._plugin.face_landmarkers.get(FACE_LANDMARK_MODEL), "landmarks"),
                (self._plugin.face_embedders.get(space), "embed"),
            ),
        }

    async def embedFaces(self, frames: list[VideoFrameData]) -> list[FaceEmbeddingResult]:
        space = self._plugin.face_embedder_space()
        embedder = self._plugin.face_embedders.get(space)
        landmarker = self._plugin.face_landmarkers.get(FACE_LANDMARK_MODEL)

        if embedder is None or not embedder.initialized or landmarker is None or not landmarker.initialized:
            return [{"embedding": [], "embeddingModel": space} for _ in frames]

        return await embed_faces(landmarker, embedder, frames, space)

    async def destroy(self) -> None:
        pass

    async def on_start(self) -> None:
        await self._plugin.get_face_embedder(self._plugin.face_embedder_space())
        await self._plugin.get_face_landmarker()
        self.updateModelSpec()
