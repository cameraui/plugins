from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, TypedDict

from camera_ui_ml import detect_plates
from camera_ui_sdk import (
    JsonSchema,
    LicensePlateDetectorSensor,
    LicensePlateResult,
    ModelSpec,
    VideoFrameData,
)

from defaults import DEFAULT_LPD_DETECTOR, DEFAULT_OCR, LPD_DETECTOR_MODELS, OCR_MODELS

if TYPE_CHECKING:
    from camera_ui_sdk import LoggerService

    from main import CoreMLPlugin


class LPDStorageValues(TypedDict):
    detector_model: str
    ocr_model: str
    confidence_threshold: float


class CoreMLLPDSensor(LicensePlateDetectorSensor["LPDStorageValues"]):
    def __init__(
        self,
        plugin: CoreMLPlugin,
        logger: LoggerService,
        name: str = "CoreML License Plate",
    ) -> None:
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
                "description": "YOLOv9 model for plate detection",
                "group": "License Plate",
                "enum": list(LPD_DETECTOR_MODELS.keys()),
                "store": True,
                "defaultValue": DEFAULT_LPD_DETECTOR,
                "required": True,
                "onSet": self._on_change_detector,
            },
            {
                "type": "string",
                "key": "ocr_model",
                "title": "OCR Model",
                "description": "CCT model for plate text recognition",
                "group": "License Plate",
                "enum": OCR_MODELS,
                "store": True,
                "defaultValue": DEFAULT_OCR,
                "required": True,
                "onSet": self._on_change_ocr,
            },
            {
                "type": "number",
                "key": "confidence_threshold",
                "title": "Confidence Threshold",
                "description": "Minimum confidence for plate detections (0-1)",
                "group": "License Plate",
                "store": True,
                "defaultValue": 0.3,
                "minimum": 0.1,
                "maximum": 1.0,
                "step": 0.05,
                "required": True,
            },
        ]

    @property
    def modelSpec(self) -> ModelSpec:
        detector_name = self.storage.values.get("detector_model", DEFAULT_LPD_DETECTOR)
        size = LPD_DETECTOR_MODELS.get(detector_name, 384)
        return {
            "input": {"width": size, "height": size, "format": "rgb"},
            "triggerLabels": ["vehicle"],
        }

    async def detectLicensePlates(self, frames: list[VideoFrameData]) -> list[LicensePlateResult]:
        detector_name = self.storage.values.get("detector_model", DEFAULT_LPD_DETECTOR)
        ocr_name = self.storage.values.get("ocr_model", DEFAULT_OCR)
        threshold = self.storage.values.get("confidence_threshold", 0.3)

        detector = self._plugin.plate_detectors.get(detector_name)
        ocr = self._plugin.ocr_models.get(ocr_name)

        if detector is None or not detector.initialized or ocr is None or not ocr.initialized:
            return [{"detected": False, "detections": []} for _ in frames]

        return await detect_plates(detector, ocr, frames, threshold)

    async def destroy(self) -> None:
        pass

    async def on_assigned(self) -> None:
        detector_name = self.storage.values.get("detector_model", DEFAULT_LPD_DETECTOR)
        ocr_name = self.storage.values.get("ocr_model", DEFAULT_OCR)
        await asyncio.gather(
            self._plugin.get_plate_detector(detector_name),
            self._plugin.get_ocr(ocr_name),
        )

    async def _on_change_detector(self, new_model: str, _old_model: str) -> None:
        if new_model != _old_model:
            await self._plugin.get_plate_detector(new_model)
            self._logger.log(f"Plate detector changed to {new_model}")

    async def _on_change_ocr(self, new_model: str, _old_model: str) -> None:
        if new_model != _old_model:
            await self._plugin.get_ocr(new_model)
            self._logger.log(f"OCR model changed to {new_model}")
