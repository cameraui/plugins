from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, TypedDict

from camera_ui_ml import detect_faces
from camera_ui_sdk import (
    FaceDetectorSensor,
    FaceResult,
    JsonSchema,
    ModelSpec,
    VideoFrameData,
)

from defaults import (
    DEFAULT_FACE_DETECTOR,
    DEFAULT_FACE_EMBEDDER,
    FACE_DETECTOR_MODELS,
    FACE_EMBEDDER_MODELS,
)

if TYPE_CHECKING:
    from camera_ui_sdk import LoggerService

    from main import CoreMLPlugin


class FaceStorageValues(TypedDict):
    detector_model: str
    embedder_model: str
    confidence_threshold: float


class CoreMLFaceSensor(FaceDetectorSensor["FaceStorageValues"]):
    def __init__(self, plugin: CoreMLPlugin, logger: LoggerService, name: str = "CoreML Face") -> None:
        super().__init__(name)
        self._plugin = plugin
        self._logger = logger

    @property
    def storage_schema(self) -> list[JsonSchema]:
        return [
            {
                "type": "string",
                "key": "detector_model",
                "title": "Detector Model",
                "description": "Face detection model",
                "group": "Face Detection",
                "enum": list(FACE_DETECTOR_MODELS.keys()),
                "store": True,
                "defaultValue": DEFAULT_FACE_DETECTOR,
                "required": True,
                "onSet": self._on_change_detector,
            },
            {
                "type": "string",
                "key": "embedder_model",
                "title": "Embedding Model",
                "description": "Face embedding model for recognition",
                "group": "Face Detection",
                "enum": list(FACE_EMBEDDER_MODELS.keys()),
                "store": True,
                "defaultValue": DEFAULT_FACE_EMBEDDER,
                "required": True,
                "onSet": self._on_change_embedder,
            },
            {
                "type": "number",
                "key": "confidence_threshold",
                "title": "Confidence Threshold",
                "description": "Minimum confidence for face detections (0-1)",
                "group": "Face Detection",
                "store": True,
                "defaultValue": 0.5,
                "minimum": 0.1,
                "maximum": 1.0,
                "step": 0.05,
                "required": True,
            },
        ]

    @property
    def modelSpec(self) -> ModelSpec:
        detector_name = self.storage.values.get("detector_model", DEFAULT_FACE_DETECTOR)
        size = FACE_DETECTOR_MODELS.get(detector_name, 320)
        embedder_name = self.storage.values.get("embedder_model", DEFAULT_FACE_EMBEDDER)
        return {
            "input": {"width": size, "height": size, "format": "rgb"},
            "triggerLabels": ["person"],
            "embeddingModel": embedder_name,
        }

    async def detectFaces(self, frames: list[VideoFrameData]) -> list[FaceResult]:
        detector_name = self.storage.values.get("detector_model", DEFAULT_FACE_DETECTOR)
        embedder_name = self.storage.values.get("embedder_model", DEFAULT_FACE_EMBEDDER)
        threshold = self.storage.values.get("confidence_threshold", 0.5)

        detector = self._plugin.face_detectors.get(detector_name)
        embedder = self._plugin.face_embedders.get(embedder_name)

        if detector is None or not detector.initialized or embedder is None or not embedder.initialized:
            return [{"detected": False, "detections": []} for _ in frames]

        return await detect_faces(detector, embedder, frames, threshold)

    async def destroy(self) -> None:
        pass

    async def on_assigned(self) -> None:
        detector_name = self.storage.values.get("detector_model", DEFAULT_FACE_DETECTOR)
        embedder_name = self.storage.values.get("embedder_model", DEFAULT_FACE_EMBEDDER)
        await asyncio.gather(
            self._plugin.get_face_detector(detector_name),
            self._plugin.get_face_embedder(embedder_name),
        )

    async def _on_change_detector(self, new_model: str, _old_model: str) -> None:
        if new_model != _old_model:
            await self._plugin.get_face_detector(new_model)
            self._logger.log(f"Face detector changed to {new_model}")

    async def _on_change_embedder(self, new_model: str, _old_model: str) -> None:
        if new_model != _old_model:
            await self._plugin.get_face_embedder(new_model)
            self._logger.log(f"Face embedder changed to {new_model}")
