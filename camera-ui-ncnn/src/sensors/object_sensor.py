from __future__ import annotations

from typing import TYPE_CHECKING, TypedDict

from camera_ui_sdk import (
    JsonSchema,
    ObjectDetectorSensor,
    ObjectModelSpec,
    ObjectResult,
    TrackedDetection,
    VideoFrameData,
)

from defaults import DEFAULT_OBJECT_MODEL, OBJECT_MODELS

if TYPE_CHECKING:
    from camera_ui_sdk import LoggerService

    from main import NCNNPlugin


class ObjectStorageValues(TypedDict):
    model: str
    confidence_threshold: float


class NCNNObjectSensor(ObjectDetectorSensor["ObjectStorageValues"]):
    def __init__(self, plugin: NCNNPlugin, logger: LoggerService, name: str = "NCNN Object") -> None:
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
        model_name = self.storage.values["model"]
        detector = self._plugin.object_detectors.get(model_name)

        if detector is None or not detector.initialized:
            return {"detected": False, "detections": []}

        width, height = frame["width"], frame["height"]
        raw = await detector.detect_frame(frame, self.storage.values["confidence_threshold"])

        detections: list[TrackedDetection] = []
        for det in raw:
            detections.append(
                {
                    "label": det["label"],
                    "confidence": det["confidence"],
                    "box": {
                        "x": det["box"][0] / width,
                        "y": det["box"][1] / height,
                        "width": (det["box"][2] - det["box"][0]) / width,
                        "height": (det["box"][3] - det["box"][1]) / height,
                    },
                }
            )

        return {"detected": len(detections) > 0, "detections": detections}

    async def destroy(self) -> None:
        pass

    async def on_assigned(self) -> None:
        model_name = self.storage.values["model"]
        await self._plugin.get_object_detector(model_name)

    async def _on_change_model(self, new_model: str, _old_model: str) -> None:
        if new_model != _old_model:
            await self._plugin.get_object_detector(new_model)
            self._logger.log(f"Object model changed to {new_model}")
