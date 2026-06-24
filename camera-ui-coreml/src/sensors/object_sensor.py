from __future__ import annotations

from typing import TYPE_CHECKING, TypedDict

from camera_ui_ml import detect_objects
from camera_ui_sdk import (
    JsonSchema,
    ObjectDetectorSensor,
    ObjectModelSpec,
    ObjectResult,
    VideoFrameData,
)

from defaults import DEFAULT_OBJECT_MODEL, OBJECT_MODELS

if TYPE_CHECKING:
    from camera_ui_sdk import LoggerService

    from main import CoreMLPlugin


class ObjectStorageValues(TypedDict):
    model: str
    confidence_threshold: float


class CoreMLObjectSensor(ObjectDetectorSensor["ObjectStorageValues"]):
    def __init__(self, plugin: CoreMLPlugin, logger: LoggerService, name: str = "CoreML Object") -> None:
        super().__init__(name)
        self._plugin = plugin
        self._logger = logger

    @property
    def storage_schema(self) -> list[JsonSchema]:
        return [
            {
                "type": "string",
                "key": "model",
                "title": "Model",
                "description": "YOLO model for object detection",
                "group": "Object Detection",
                "enum": list(OBJECT_MODELS.keys()),
                "store": True,
                "defaultValue": DEFAULT_OBJECT_MODEL,
                "required": True,
                "onSet": self._on_change_model,
            },
            {
                "type": "number",
                "key": "confidence_threshold",
                "title": "Confidence Threshold",
                "description": "Minimum confidence for detections (0-1)",
                "group": "Object Detection",
                "store": True,
                "defaultValue": 0.5,
                "minimum": 0.1,
                "maximum": 1.0,
                "step": 0.05,
                "required": True,
            },
        ]

    @property
    def modelSpec(self) -> ObjectModelSpec:
        return {"input": {"width": 320, "height": 320, "format": "rgb"}}

    async def detectObjects(self, frame: VideoFrameData) -> ObjectResult:
        detector = self._plugin.object_detectors.get(self.storage.values["model"])
        if detector is None or not detector.initialized:
            return {"detected": False, "detections": []}
        return await detect_objects(detector, frame, self.storage.values["confidence_threshold"])

    async def destroy(self) -> None:
        pass

    async def on_assigned(self) -> None:
        model_name = self.storage.values["model"]
        await self._plugin.get_object_detector(model_name)

    async def _on_change_model(self, new_model: str, _old_model: str) -> None:
        if new_model != _old_model:
            await self._plugin.get_object_detector(new_model)
            self._logger.log(f"Object model changed to {new_model}")
