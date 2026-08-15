from __future__ import annotations

import asyncio
import shutil
from typing import Any

from camera_ui_ml import normalize_box, reset_stored_settings
from camera_ui_sdk import (
    API_EVENT,
    BasePlugin,
    CameraDevice,
    Detection,
    DeviceStorage,
    ImageMetadata,
    JsonSchema,
    LoggerService,
    ObjectDetectionInterface,
    ObjectDetectionPluginResponse,
    PluginAPI,
    VideoFrameData,
)

from defaults import (
    COCO_TO_CLASS,
    DEFAULT_OBJECT_MODEL,
    DEFAULT_OPTION,
    OBJECT_LABELS,
    OBJECT_MODELS,
    resolve_model,
)
from detector import HailoDetector
from model_manager import HailoModelManager
from sensors.object_sensor import HailoObjectSensor


def _scan_device_ids() -> list[str]:
    try:
        from hailo_platform import Device

        return [str(device_id) for device_id in Device.scan()]
    except Exception:
        return []


class HailoPlugin(BasePlugin, ObjectDetectionInterface):
    def __init__(self, logger: LoggerService, api: PluginAPI, storage: DeviceStorage[Any]) -> None:
        super().__init__(logger, api, storage)
        self.model_manager = HailoModelManager(api.storagePath, logger, self._resolve_device_id)
        self._device_ids = _scan_device_ids()

        self.object_detectors: dict[str, HailoDetector] = {}
        self._sensors: dict[str, dict[str, Any]] = {}

        self.api.on(API_EVENT.SHUTDOWN, self._on_shutdown)

    @property
    def storage_schema(self) -> list[JsonSchema]:
        return [
            {
                "type": "string",
                "key": "device_id",
                "title": "Hailo Device",
                "description": (
                    "Which Hailo device runs inference when several are installed. "
                    + (
                        f"Detected: {', '.join(self._device_ids)}."
                        if self._device_ids
                        else "No Hailo device detected."
                    )
                ),
                "enum": ["auto", *self._device_ids],
                "store": True,
                "defaultValue": "auto",
                "onSet": self._on_device_change,
            },
            {
                "type": "string",
                "key": "active_hardware",
                "title": "Active Hardware",
                "description": "Hardware currently running inference across loaded models.",
                "readonly": True,
                "store": False,
                "onGet": self._active_hardware,
            },
            {
                "type": "button",
                "key": "reset_defaults",
                "title": "Reset to Defaults",
                "description": "Reset all plugin settings to their default values",
                "color": "danger",
                "onSet": self._reset_settings,
            },
            {
                "type": "button",
                "key": "redownload_models",
                "title": "Re-download Models",
                "description": "Clear the local model cache and download the latest models again.",
                "onSet": self._redownload_models,
            },
        ]

    async def configureCameras(self, cameras: list[CameraDevice]) -> None:
        for camera in cameras:
            await self._add_sensors(camera)

    async def onCameraAdded(self, camera: CameraDevice) -> None:
        await self._add_sensors(camera)

    async def onCameraReleased(self, cameraId: str) -> None:
        sensors = self._sensors.pop(cameraId, {})
        for sensor in sensors.values():
            await sensor.destroy()

    async def get_object_detector(self, model_name: str) -> HailoDetector:
        detector = self.object_detectors.get(model_name)
        if not detector:
            detector = HailoDetector(self.model_manager, self.logger, COCO_TO_CLASS)
            self.object_detectors[model_name] = detector
            try:
                await detector.initialize(model_name)
            except Exception:
                self.object_detectors.pop(model_name, None)
                raise
            # HEF carries no embedded class names; inject the (mapped) labels.
            detector.labels = {index: str(label) for index, label in OBJECT_LABELS.items()}
        else:
            await detector.initialize(model_name)
        return detector

    async def objectDetectionSettings(self) -> list[JsonSchema] | None:
        return [
            {
                "type": "string",
                "key": "model",
                "title": "Model",
                "description": "YOLO model for testing",
                "required": True,
                "defaultValue": DEFAULT_OPTION,
                "enum": [DEFAULT_OPTION, *OBJECT_MODELS],
                "store": False,
            },
        ]

    async def testObjectDetection(
        self, image_data: bytes, metadata: ImageMetadata, config: dict[str, Any]
    ) -> ObjectDetectionPluginResponse | None:
        model_name: str = resolve_model(config.get("model"), DEFAULT_OBJECT_MODEL)
        detector = await self.get_object_detector(model_name)
        if not detector.initialized:
            return None

        raw = await detector.detect_single(image_data, metadata)
        detections: list[Detection] = [
            {
                "label": detector.labels.get(cid, "unknown"),  # type: ignore[typeddict-item]
                "confidence": conf,
                "box": box,
            }
            for cid, conf, box in raw
        ]
        return {"detected": len(detections) > 0, "detections": detections}

    async def detectObjects(
        self, frame: VideoFrameData, config: dict[str, Any] | None = None
    ) -> ObjectDetectionPluginResponse | None:
        model_name = resolve_model((config or {}).get("model"), DEFAULT_OBJECT_MODEL)
        detector = await self.get_object_detector(model_name)
        if not detector.initialized:
            return None

        raw = await detector.detect_frame(frame)
        width, height = frame["width"], frame["height"]
        detections: list[Detection] = [
            {
                "label": detector.labels.get(cid, "unknown"),  # type: ignore[typeddict-item]
                "confidence": conf,
                "box": normalize_box(box, width, height),
            }
            for cid, conf, box in raw
        ]
        return {"detected": len(detections) > 0, "detections": detections}

    async def _add_sensors(self, camera: CameraDevice) -> None:
        sensors: dict[str, Any] = {}

        obj = HailoObjectSensor(self, camera, self.logger)
        await camera.addSensor(obj)
        sensors["object"] = obj

        self._sensors[camera.id] = sensors

    def _active_hardware(self) -> str:
        backends = [
            detector.backend.device
            for detector in self.object_detectors.values()
            if detector.backend is not None
        ]
        if not backends:
            return "No models loaded yet"
        return ", ".join(dict.fromkeys(backends))

    def _resolve_device_id(self) -> str | None:
        raw = str(self.storage.values.get("device_id", "auto"))
        return raw if raw and raw != "auto" else None

    async def _on_device_change(self, new_value: object, old_value: object) -> None:
        if new_value == old_value:
            return
        self.logger.log(f"Hailo device changed ({old_value} -> {new_value}); reloading models")
        await self._reload_models()

    async def _reload_models(self) -> None:
        obj = list(self.object_detectors)
        await self._close_all()
        self.model_manager.reset()
        await asyncio.gather(*(self.get_object_detector(n) for n in obj), return_exceptions=True)

    async def _reset_settings(self) -> None:
        await reset_stored_settings(self.storage)
        self.logger.log("Settings reset to defaults")

    async def _redownload_models(self, _new: object = None, _old: object = None) -> None:
        self.logger.log("Re-downloading models (clearing cache)...")
        shutil.rmtree(self.model_manager.model_path, ignore_errors=True)
        await self._reload_models()
        self.logger.success("Models re-downloaded")

    async def _close_all(self) -> None:
        await asyncio.gather(*(d.close() for d in self.object_detectors.values()))
        self.object_detectors.clear()

    async def _on_shutdown(self) -> None:
        for sensors in self._sensors.values():
            for sensor in sensors.values():
                await sensor.destroy()
        self._sensors.clear()

        await self._close_all()


def __main__() -> type[HailoPlugin]:
    return HailoPlugin
