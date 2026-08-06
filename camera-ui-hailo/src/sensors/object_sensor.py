from __future__ import annotations

from typing import TYPE_CHECKING, TypedDict

from camera_ui_ml import detect_objects, reset_stored_settings
from camera_ui_sdk import (
    JsonSchema,
    ObjectDetectorSensor,
    ObjectModelSpec,
    ObjectResult,
    VideoFrameData,
)

from defaults import DEFAULT_OBJECT_MODEL, DEFAULT_OPTION, OBJECT_MODELS, resolve_model

if TYPE_CHECKING:
    from camera_ui_sdk import LoggerService

    from main import HailoPlugin


class ObjectStorageValues(TypedDict):
    model: str
    confidence_threshold: float


class HailoObjectSensor(ObjectDetectorSensor["ObjectStorageValues"]):
    def __init__(self, plugin: HailoPlugin, logger: LoggerService, name: str = "Hailo Object") -> None:
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
                "enum": [DEFAULT_OPTION, *OBJECT_MODELS],
                "store": True,
                "defaultValue": DEFAULT_OPTION,
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
            {
                "type": "button",
                "key": "reset_defaults",
                "title": "Reset to Defaults",
                "description": "Reset all settings to their default values",
                "group": "Object Detection",
                "color": "danger",
                "onSet": self._reset_settings,
            },
        ]

    @property
    def modelSpec(self) -> ObjectModelSpec:
        return {"input": {"width": 640, "height": 640, "format": "rgb"}}

    async def detectObjects(self, frame: VideoFrameData) -> ObjectResult:
        detector = self._plugin.object_detectors.get(
            resolve_model(self.storage.values.get("model"), DEFAULT_OBJECT_MODEL)
        )
        if detector is None or not detector.initialized:
            return {"detected": False, "detections": []}
        return await detect_objects(detector, frame, self.storage.values["confidence_threshold"])

    async def destroy(self) -> None:
        pass

    async def on_start(self) -> None:
        model_name = resolve_model(self.storage.values.get("model"), DEFAULT_OBJECT_MODEL)
        await self._plugin.get_object_detector(model_name)

    async def _on_change_model(self, new_model: str, _old_model: str) -> None:
        if new_model != _old_model:
            await self._plugin.get_object_detector(resolve_model(new_model, DEFAULT_OBJECT_MODEL))
            self._logger.log(f"Object model changed to {new_model}")

    async def _reset_settings(self) -> None:
        await reset_stored_settings(self.storage)
        self._logger.log("Settings reset to defaults")
