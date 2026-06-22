from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any, TypedDict

import numpy as np
from camera_ui_sdk import (
    JsonSchema,
    LicensePlateDetection,
    LicensePlateDetectorSensor,
    LicensePlateResult,
    ModelSpec,
    VideoFrameData,
)
from PIL import Image

from defaults import DEFAULT_LPD_DETECTOR, DEFAULT_OCR, LPD_DETECTOR_MODELS, OCR_MODELS

if TYPE_CHECKING:
    from camera_ui_sdk import LoggerService

    from main import OpenVinoPlugin


class LPDStorageValues(TypedDict):
    detector_model: str
    ocr_model: str
    confidence_threshold: float


class OpenVinoLPDSensor(LicensePlateDetectorSensor["LPDStorageValues"]):
    def __init__(
        self,
        plugin: OpenVinoPlugin,
        logger: LoggerService,
        name: str = "OpenVino License Plate",
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

        empty: LicensePlateResult = {"detected": False, "detections": []}
        if detector is None or not detector.initialized or ocr is None or not ocr.initialized:
            return [empty for _ in frames]

        # Convert frames to PIL images
        images: list[Image.Image] = []
        for frame in frames:
            np_array: np.ndarray[Any, Any] = np.frombuffer(frame["data"], dtype=np.uint8).reshape(
                (frame["height"], frame["width"], 3)
            )
            needs_resize = frame["width"] != detector.input_width or frame["height"] != detector.input_height
            img = Image.fromarray(np_array, mode="RGB")
            if needs_resize:
                img = img.resize((detector.input_width, detector.input_height))
            images.append(img)

        # Batch plate detection
        all_boxes = await detector.detect_batch(images, threshold)
        for img in images:
            img.close()

        # Per-frame: OCR detected plates
        results: list[LicensePlateResult] = []
        for i, plate_boxes in enumerate(all_boxes):
            if not plate_boxes:
                results.append(empty)
                continue

            width, height = frames[i]["width"], frames[i]["height"]
            data = frames[i]["data"]
            scale_x = width / detector.input_width
            scale_y = height / detector.input_height
            needs_scale = width != detector.input_width or height != detector.input_height

            plate_images: list[Image.Image] = []
            scaled_boxes: list[tuple[float, float, float, float]] = []
            confidences: list[float] = []
            for plate in plate_boxes:
                x1, y1, x2, y2 = plate["box"]
                if needs_scale:
                    x1, y1, x2, y2 = (
                        x1 * scale_x,
                        y1 * scale_y,
                        x2 * scale_x,
                        y2 * scale_y,
                    )
                ix1, iy1 = max(0, int(x1)), max(0, int(y1))
                ix2, iy2 = min(width, int(x2)), min(height, int(y2))
                if ix2 <= ix1 or iy2 <= iy1:
                    continue
                np_frame: np.ndarray[Any, Any] = np.frombuffer(data, dtype=np.uint8).reshape(
                    (height, width, 3)
                )
                plate_images.append(Image.fromarray(np_frame[iy1:iy2, ix1:ix2], mode="RGB"))
                scaled_boxes.append((x1, y1, x2, y2))
                confidences.append(plate["confidence"])

            if not plate_images:
                results.append(empty)
                continue

            ocr_results = await ocr.recognize_batch(plate_images)
            for img in plate_images:
                img.close()

            detections: list[LicensePlateDetection] = []
            for j, (x1, y1, x2, y2) in enumerate(scaled_boxes):
                ocr_result = ocr_results[j] if j < len(ocr_results) else None
                if ocr_result is None or not ocr_result.text:
                    continue
                detections.append(
                    {
                        "label": "vehicle",
                        "attribute": "license_plate",
                        "confidence": confidences[j],
                        "plateText": ocr_result.text,
                        "box": {
                            "x": x1 / width,
                            "y": y1 / height,
                            "width": (x2 - x1) / width,
                            "height": (y2 - y1) / height,
                        },
                    }
                )

            results.append({"detected": len(detections) > 0, "detections": detections})

        return results

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
