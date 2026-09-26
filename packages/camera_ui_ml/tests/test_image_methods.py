from __future__ import annotations

import asyncio
import io
from typing import Any, cast

import numpy as np
from PIL import Image

from camera_ui_ml import (
    DETECTION_FLOOR,
    detect_faces_in_image,
    detect_objects_in_image,
    detect_plates_in_image,
    normalize_box,
    requested_threshold,
)
from camera_ui_ml.detectors.box import BoxDetector
from camera_ui_ml.detectors.ocr import OcrResult, PlateOcr
from camera_ui_ml.parsing import RawDetection

PERSON = 0
METADATA: Any = {"width": 200, "height": 100}


def png(width: int = 200, height: int = 100) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (width, height), (120, 120, 120)).save(out, format="PNG")
    return out.getvalue()


class FakeDetector:
    def __init__(self, raw: list[RawDetection], default: float = 0.5) -> None:
        self.labels = {PERSON: "person"}
        self.input_size = (100, 100)
        self.raw = raw
        self.default = default
        self.asked: list[float | None] = []

    async def detect(self, image: Any, threshold: float | None = None) -> list[RawDetection]:
        self.asked.append(threshold)
        limit = self.default if threshold is None else threshold
        return [d for d in self.raw if d[1] >= limit]

    async def detect_single(self, image: bytes, metadata: Any, threshold: float | None = None) -> list[Any]:
        raw = await self.detect(image, threshold)
        return [(cid, conf, normalize_box(box, *self.input_size)) for cid, conf, box in raw]


class FakeOcr:
    def __init__(self, results: list[OcrResult | None]) -> None:
        self.results = results
        self.crops: list[tuple[int, int]] = []

    async def recognize(self, image: Any) -> OcrResult | None:
        self.crops.append((int(image.shape[1]), int(image.shape[0])))
        return self.results.pop(0)


def test_a_test_method_keeps_the_detector_default_unless_asked():
    assert requested_threshold(None) is None
    assert requested_threshold({}) is None
    assert requested_threshold({"model": "yolo"}) is None


def test_a_requested_threshold_never_goes_below_the_floor():
    assert requested_threshold({"threshold": 0.4}) == 0.4
    assert requested_threshold({"threshold": 1}) == 1.0
    assert requested_threshold({"threshold": 0.05}) == DETECTION_FLOOR


def test_a_threshold_that_is_no_number_is_ignored():
    assert requested_threshold({"threshold": "0.3"}) is None
    assert requested_threshold({"threshold": True}) is None


def test_objects_in_a_picture_follow_the_requested_threshold():
    fake = FakeDetector([(PERSON, 0.35, (10.0, 10.0, 30.0, 60.0)), (PERSON, 0.8, (50.0, 10.0, 70.0, 60.0))])
    detector = cast(BoxDetector, fake)

    default = asyncio.run(detect_objects_in_image(detector, png(), METADATA))
    asked = asyncio.run(detect_objects_in_image(detector, png(), METADATA, 0.25))

    assert fake.asked == [None, 0.25]
    assert [d["confidence"] for d in default["detections"]] == [0.8]
    assert [d["confidence"] for d in asked["detections"]] == [0.35, 0.8]
    assert asked["detections"][0]["label"] == "person"
    assert asked["detections"][0]["box"] == {"x": 0.1, "y": 0.1, "width": 0.2, "height": 0.5}


def test_faces_in_a_picture_follow_the_requested_threshold():
    fake = FakeDetector([(0, 0.3, (10.0, 10.0, 20.0, 20.0))])
    result = asyncio.run(detect_faces_in_image(cast(BoxDetector, fake), png(), METADATA, 0.25))
    assert fake.asked == [0.25]
    assert result["detected"]
    assert result["detections"][0]["attribute"] == "face"


def test_plates_in_a_picture_carry_the_ocr_confidence():
    fake = FakeDetector([(0, 0.4, (10.0, 20.0, 30.0, 40.0)), (0, 0.9, (50.0, 20.0, 90.0, 40.0))])
    ocr = FakeOcr([OcrResult("B1", 0.4), OcrResult("", 0.0)])
    result = asyncio.run(detect_plates_in_image(cast(BoxDetector, fake), cast(PlateOcr, ocr), png(), 0.25))

    assert fake.asked == [0.25]
    # the model's 100x100 input scaled onto the 200x100 picture
    assert ocr.crops[0] == (40, 20)
    assert len(result["detections"]) == 1
    plate = result["detections"][0]
    assert plate["plateText"] == "B1"
    assert plate["ocrConfidence"] == 0.4
    assert plate["confidence"] == 0.4
    assert np.allclose(list(plate["box"].values()), [0.1, 0.2, 0.2, 0.2])
