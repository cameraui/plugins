from __future__ import annotations

import asyncio
from typing import Any, cast

from camera_ui_ml import DETECTION_FLOOR, detect_faces, detect_objects
from camera_ui_ml.detectors.box import BoxDetector
from camera_ui_ml.parsing import RawDetection, nms

PERSON = 0
VEHICLE = 1


def test_nms_drops_duplicates_of_one_class():
    raw: list[RawDetection] = [
        (PERSON, 0.6, (10.0, 10.0, 50.0, 110.0)),
        (PERSON, 0.9, (12.0, 11.0, 51.0, 112.0)),
        (PERSON, 0.3, (11.0, 10.0, 50.0, 111.0)),
    ]
    kept = nms(raw)
    assert kept == [(PERSON, 0.9, (12.0, 11.0, 51.0, 112.0))]


def test_nms_keeps_overlapping_boxes_of_other_classes():
    rider = (PERSON, 0.8, (10.0, 10.0, 50.0, 110.0))
    bicycle = (VEHICLE, 0.4, (8.0, 40.0, 52.0, 115.0))
    assert nms([bicycle, rider]) == [rider, bicycle]


def test_nms_keeps_neighbours_apart():
    left = (PERSON, 0.7, (0.0, 0.0, 40.0, 100.0))
    right = (PERSON, 0.5, (30.0, 0.0, 70.0, 100.0))
    assert len(nms([left, right])) == 2


class FakeDetector:
    def __init__(self, raw: list[RawDetection]) -> None:
        self.labels = {PERSON: "person", VEHICLE: "vehicle"}
        self.raw = raw
        self.asked: list[float | None] = []

    async def detect_frame(self, frame: Any, threshold: float | None = None) -> list[RawDetection]:
        self.asked.append(threshold)
        return [d for d in self.raw if threshold is None or d[1] >= threshold]


FRAME: Any = {"data": b"", "width": 100, "height": 100, "format": "rgb"}


def test_objects_ship_from_the_floor_without_user_thresholds():
    fake = FakeDetector(
        [
            (PERSON, 0.3, (10.0, 10.0, 30.0, 60.0)),
            (VEHICLE, 0.9, (40.0, 40.0, 90.0, 80.0)),
            (PERSON, 0.2, (60.0, 10.0, 80.0, 60.0)),
        ]
    )
    result = asyncio.run(detect_objects(cast(BoxDetector, fake), FRAME))
    assert fake.asked == [DETECTION_FLOOR]
    assert [(d["label"], d["confidence"]) for d in result["detections"]] == [
        ("person", 0.3),
        ("vehicle", 0.9),
    ]
    assert result["detected"]


def test_faces_ship_from_the_floor():
    fake = FakeDetector([(0, 0.27, (10.0, 10.0, 30.0, 30.0))])
    results = asyncio.run(detect_faces(cast(BoxDetector, fake), [FRAME]))
    assert fake.asked == [DETECTION_FLOOR]
    assert len(results[0]["detections"]) == 1
