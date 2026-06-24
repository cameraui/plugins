from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, cast

from camera_ui_sdk import (
    ClipEmbedding,
    ClipResult,
    DetectionLabel,
    FaceDetection,
    FaceResult,
    LicensePlateDetection,
    LicensePlateResult,
    ObjectResult,
    TrackedDetection,
    VideoFrameData,
)

from .detectors.box import BoxDetector
from .detectors.embedder import Embedder
from .detectors.ocr import PlateOcr
from .geometry import normalize_box

if TYPE_CHECKING:
    from .detectors.clip import ClipEncoder


async def detect_objects(
    detector: BoxDetector, frame: VideoFrameData, threshold: float | None = None
) -> ObjectResult:
    raw = await detector.detect_frame(frame, threshold)
    width, height = frame["width"], frame["height"]
    detections: list[TrackedDetection] = [
        {
            "label": cast(DetectionLabel, detector.labels.get(cid, "unknown")),
            "confidence": conf,
            "box": normalize_box(box, width, height),
        }
        for cid, conf, box in raw
    ]
    return {"detected": len(detections) > 0, "detections": detections}


async def detect_faces(
    detector: BoxDetector,
    embedder: Embedder,
    frames: list[VideoFrameData],
    threshold: float | None = None,
) -> list[FaceResult]:
    tasks = [_detect_faces_one(detector, embedder, frame, threshold) for frame in frames]
    return list(await asyncio.gather(*tasks))


async def _detect_faces_one(
    detector: BoxDetector,
    embedder: Embedder,
    frame: VideoFrameData,
    threshold: float | None,
) -> FaceResult:
    raw = await detector.detect_frame(frame, threshold)
    if not raw:
        return {"detected": False, "detections": []}

    width, height = frame["width"], frame["height"]
    data = bytes(frame["data"])
    embeddings = await asyncio.gather(
        *(embedder.embed_from_crop(data, width, height, box) for _cid, _conf, box in raw)
    )
    detections: list[FaceDetection] = [
        {
            "label": "person",
            "attribute": "face",
            "confidence": conf,
            "box": normalize_box(box, width, height),
            "embedding": embedding,
        }
        for (_cid, conf, box), embedding in zip(raw, embeddings, strict=False)
    ]
    return {"detected": len(detections) > 0, "detections": detections}


async def detect_plates(
    detector: BoxDetector,
    ocr: PlateOcr,
    frames: list[VideoFrameData],
    threshold: float | None = None,
) -> list[LicensePlateResult]:
    tasks = [_detect_plates_one(detector, ocr, frame, threshold) for frame in frames]
    return list(await asyncio.gather(*tasks))


async def _detect_plates_one(
    detector: BoxDetector, ocr: PlateOcr, frame: VideoFrameData, threshold: float | None
) -> LicensePlateResult:
    raw = await detector.detect_frame(frame, threshold)
    if not raw:
        return {"detected": False, "detections": []}

    width, height = frame["width"], frame["height"]
    data = bytes(frame["data"])
    ocr_results = await asyncio.gather(
        *(ocr.recognize_from_crop(data, width, height, box) for _cid, _conf, box in raw)
    )
    detections: list[LicensePlateDetection] = []
    for (_cid, conf, box), result in zip(raw, ocr_results, strict=False):
        if result is None or not result.text:
            continue
        detections.append(
            {
                "label": "vehicle",
                "attribute": "license_plate",
                "confidence": conf,
                "plateText": result.text,
                "box": normalize_box(box, width, height),
            }
        )
    return {"detected": len(detections) > 0, "detections": detections}


async def detect_clip(encoder: ClipEncoder, frames: list[VideoFrameData]) -> list[ClipResult]:
    embeddings = await encoder.embed_frames(frames)
    results: list[ClipResult] = []
    for frame, embedding in zip(frames, embeddings, strict=False):
        items: list[ClipEmbedding] = []
        if embedding:
            items.append(
                {
                    "label": frame.get("label") or "image",
                    "box": {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0},
                    "embedding": embedding,
                }
            )
        results.append({"embeddings": items, "embeddingModel": encoder.embedding_model})
    return results
