from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import TYPE_CHECKING, cast

import numpy as np
from camera_ui_sdk import (
    ClipEmbedding,
    ClipResult,
    DetectionLabel,
    FaceDetection,
    FaceEmbeddingResult,
    FaceResult,
    LicensePlateDetection,
    LicensePlateResult,
    ObjectResult,
    Point,
    TrackedDetection,
    VideoFrameData,
)

from .backend import NDArray
from .detectors.box import BoxDetector
from .detectors.embedder import Embedder
from .detectors.landmarks import LandmarkDetector
from .detectors.ocr import PlateOcr
from .geometry import normalize_box
from .parsing import FaceLandmarks
from .preprocess import decode_image, frame_to_rgb

if TYPE_CHECKING:
    from .detectors.clip import ClipEncoder


async def detect_objects(
    detector: BoxDetector,
    frame: VideoFrameData,
    threshold: float | Mapping[str, float] | None = None,
) -> ObjectResult:
    per_label = threshold if isinstance(threshold, Mapping) else None
    floor = min(per_label.values()) if per_label else cast("float | None", threshold)
    raw = await detector.detect_frame(frame, floor)
    width, height = frame["width"], frame["height"]
    detections: list[TrackedDetection] = [
        {
            "label": cast(DetectionLabel, detector.labels.get(cid, "unknown")),
            "confidence": conf,
            "box": normalize_box(box, width, height),
        }
        for cid, conf, box in raw
    ]
    if per_label:
        min_conf = floor if floor is not None else 0.0
        detections = [d for d in detections if d["confidence"] >= per_label.get(d["label"], min_conf)]
    return {"detected": len(detections) > 0, "detections": detections}


async def detect_faces(
    detector: BoxDetector,
    frames: list[VideoFrameData],
    threshold: float | None = None,
) -> list[FaceResult]:
    tasks = [_detect_faces_one(detector, frame, threshold) for frame in frames]
    return list(await asyncio.gather(*tasks))


async def _detect_faces_one(
    detector: BoxDetector,
    frame: VideoFrameData,
    threshold: float | None,
) -> FaceResult:
    raw = await detector.detect_frame(frame, threshold)
    if not raw:
        return {"detected": False, "detections": []}

    width, height = frame["width"], frame["height"]
    detections: list[FaceDetection] = [
        {
            "label": "person",
            "attribute": "face",
            "confidence": conf,
            "box": normalize_box(box, width, height),
        }
        for _cid, conf, box in raw
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
                "confidence": float(conf),
                "ocrConfidence": float(result.confidence),
                "plateText": result.text,
                "box": normalize_box(box, width, height),
            }
        )
    return {"detected": len(detections) > 0, "detections": detections}


async def embed_faces(
    landmarker: LandmarkDetector,
    embedder: Embedder,
    frames: list[VideoFrameData],
    space: str,
) -> list[FaceEmbeddingResult]:
    crops = [
        frame_to_rgb(bytes(frame["data"]), frame["width"], frame["height"], frame.get("format", "rgb"))
        for frame in frames
    ]
    return await _embed_crops(landmarker, embedder, crops, space)


async def embed_face_images(
    landmarker: LandmarkDetector,
    embedder: Embedder,
    images: list[bytes],
    space: str,
    landmarks: list[list[Point] | None] | None = None,
) -> list[FaceEmbeddingResult]:
    crops = []
    for data in images:
        try:
            crops.append(decode_image(data))
        except Exception:
            crops.append(np.zeros((0, 0, 3), dtype=np.uint8))
    return await _embed_crops(landmarker, embedder, crops, space, landmarks)


async def _embed_crops(
    landmarker: LandmarkDetector,
    embedder: Embedder,
    crops: list[NDArray],
    space: str,
    known: list[list[Point] | None] | None = None,
) -> list[FaceEmbeddingResult]:
    results: list[FaceEmbeddingResult] = []
    for index, crop in enumerate(crops):
        points = known[index] if known and index < len(known) else None
        # a plain head is cut around the face box, which stored points do not carry
        face = _stored_face(crop, points) if points and embedder.aligned else await landmarker.points(crop)
        result: FaceEmbeddingResult = {
            "embedding": await embedder.embed_face(crop, face),
            "embeddingModel": space,
        }
        if face is not None and result["embedding"]:
            size = (crop.shape[1], crop.shape[0])
            result["landmarks"] = [(float(x / size[0]), float(y / size[1])) for x, y in face.points]
            if not points:
                result["quality"] = face.score
        results.append(result)
    return results


def _stored_face(crop: NDArray, points: list[Point]) -> FaceLandmarks | None:
    if crop.size == 0 or len(points) != 5:
        return None
    scaled = np.asarray(points, dtype=np.float32) * (crop.shape[1], crop.shape[0])
    left, top = scaled.min(axis=0)
    right, bottom = scaled.max(axis=0)
    return FaceLandmarks(score=1.0, box=(float(left), float(top), float(right), float(bottom)), points=scaled)


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
