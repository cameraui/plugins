from __future__ import annotations

from typing import TYPE_CHECKING, TypedDict

from camera_ui_ml import detect_faces, model_runtime, reset_stored_settings
from camera_ui_sdk import (
    FaceDetectorSensor,
    FaceResult,
    JsonSchema,
    ModelSpec,
    VideoFrameData,
)

from defaults import (
    DEFAULT_FACE_DETECTOR,
    DEFAULT_OPTION,
    FACE_DETECTOR_MODELS,
    resolve_model,
)

if TYPE_CHECKING:
    from camera_ui_sdk import CameraDevice, LoggerService

    from main import NCNNPlugin


class FaceStorageValues(TypedDict):
    detector_model: str


class NCNNFaceSensor(FaceDetectorSensor["FaceStorageValues"]):
    def __init__(
        self,
        plugin: NCNNPlugin,
        camera: CameraDevice,
        logger: LoggerService,
        name: str = "NCNN Face",
    ) -> None:
        super().__init__(name)
        self._camera = camera
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
                "enum": [DEFAULT_OPTION, *FACE_DETECTOR_MODELS],
                "store": True,
                "defaultValue": DEFAULT_OPTION,
                "required": True,
                "onSet": self._on_change_detector,
            },
            {
                "type": "button",
                "key": "reset_defaults",
                "title": "Reset to Defaults",
                "description": "Reset all settings to their default values",
                "group": "Face Detection",
                "color": "danger",
                "onSet": self._reset_settings,
            },
        ]

    @property
    def modelSpec(self) -> ModelSpec:
        detector_name = resolve_model(self.storage.values.get("detector_model"), DEFAULT_FACE_DETECTOR)
        size = FACE_DETECTOR_MODELS.get(detector_name, 320)
        return {
            "input": {"width": size, "height": size, "format": "rgb"},
            "triggerLabels": ["person"],
            **model_runtime((self._plugin.face_detectors.get(detector_name), "detect")),
        }

    async def detectFaces(self, frames: list[VideoFrameData]) -> list[FaceResult]:
        detector_name = resolve_model(self.storage.values.get("detector_model"), DEFAULT_FACE_DETECTOR)
        threshold = self._camera_confidence(0.5)

        detector = self._plugin.face_detectors.get(detector_name)
        if detector is None or not detector.initialized:
            return [{"detected": False, "detections": []} for _ in frames]

        return await detect_faces(detector, frames, threshold)

    async def destroy(self) -> None:
        pass

    async def on_start(self) -> None:
        detector_name = resolve_model(self.storage.values.get("detector_model"), DEFAULT_FACE_DETECTOR)
        await self._plugin.get_face_detector(detector_name)
        self.updateModelSpec()

    async def _on_change_detector(self, new_model: str, _old_model: str) -> None:
        if new_model != _old_model:
            resolved = resolve_model(new_model, DEFAULT_FACE_DETECTOR)
            await self._plugin.get_face_detector(resolved)
            self.updateModelSpec()
            self._logger.log(f"Face detector changed to {resolved}")

    async def _reset_settings(self) -> None:
        await reset_stored_settings(self.storage)
        self._logger.log("Settings reset to defaults")

    def _camera_confidence(self, fallback: float) -> float:
        settings = self._camera.detectionSettings.get("face") or {}
        value = settings.get("confidence")
        return float(value) if value is not None else fallback
