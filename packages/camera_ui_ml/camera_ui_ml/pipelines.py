from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, cast

import numpy as np
from camera_ui_sdk import (
    ClipEmbedding,
    ClipResult,
    Detection,
    DetectionLabel,
    FaceDetection,
    FaceDetectionPluginResponse,
    FaceEmbeddingResult,
    FaceResult,
    ImageMetadata,
    LicensePlateDetection,
    LicensePlateDetectionPluginResponse,
    LicensePlateResult,
    ObjectDetectionPluginResponse,
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
from .detectors.person import PersonEmbedder
from .detectors.segmenter import Segmenter
from .geometry import normalize_box, scale_box
from .parsing import FaceLandmarks
from .preprocess import crop_rgb, decode_image, frame_to_rgb

if TYPE_CHECKING:
    from camera_ui_sdk import (
        ObjectMask,
        PersonEmbeddingResult,
        SegmentationFrame,
        SegmentationImage,
        SegmentationResult,
    )

    from .detectors.clip import ClipEncoder


DETECTION_FLOOR = 0.25


def requested_threshold(config: Mapping[str, Any] | None) -> float | None:
    """The ``threshold`` a caller put into a test method's config, never below the floor.

    None when the caller set none, the detector then keeps its own default.
    """
    value = config.get("threshold") if config else None
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return max(float(value), DETECTION_FLOOR)


async def detect_objects(
    detector: BoxDetector,
    frame: VideoFrameData,
    threshold: float = DETECTION_FLOOR,
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
    frames: list[VideoFrameData],
    threshold: float = DETECTION_FLOOR,
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
    threshold: float = DETECTION_FLOOR,
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


async def detect_objects_in_image(
    detector: BoxDetector,
    image: bytes,
    metadata: ImageMetadata,
    threshold: float | None = None,
) -> ObjectDetectionPluginResponse:
    raw = await detector.detect_single(image, metadata, threshold)
    detections: list[Detection] = [
        {
            "label": cast(DetectionLabel, detector.labels.get(cid, "unknown")),
            "confidence": conf,
            "box": box,
        }
        for cid, conf, box in raw
    ]
    return {"detected": len(detections) > 0, "detections": detections}


async def detect_faces_in_image(
    detector: BoxDetector,
    image: bytes,
    metadata: ImageMetadata,
    threshold: float | None = None,
) -> FaceDetectionPluginResponse:
    raw = await detector.detect_single(image, metadata, threshold)
    detections: list[FaceDetection] = [
        {"label": "person", "attribute": "face", "confidence": conf, "box": box} for _cid, conf, box in raw
    ]
    return {"detected": len(detections) > 0, "detections": detections}


async def detect_plates_in_image(
    detector: BoxDetector,
    ocr: PlateOcr,
    image: bytes,
    threshold: float | None = None,
) -> LicensePlateDetectionPluginResponse:
    rgb = decode_image(image)
    height, width = int(rgb.shape[0]), int(rgb.shape[1])
    raw = await detector.detect(rgb, threshold)
    scale_x = width / detector.input_size[0]
    scale_y = height / detector.input_size[1]

    detections: list[LicensePlateDetection] = []
    for _cid, conf, box in raw:
        image_box = scale_box(box, scale_x, scale_y)
        result = await ocr.recognize(crop_rgb(rgb, image_box))
        if result is None or not result.text:
            continue
        detections.append(
            {
                "label": "vehicle",
                "attribute": "license_plate",
                "confidence": float(conf),
                "ocrConfidence": float(result.confidence),
                "plateText": result.text,
                "box": normalize_box(image_box, width, height),
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
        if points and embedder.aligned:
            found = face = _stored_face(crop, points)
        else:
            found = await landmarker.best(crop)
            face = landmarker.sure(found)
        result: FaceEmbeddingResult = {
            "embedding": await embedder.embed_face(crop, face),
            "embeddingModel": space,
        }
        if face is not None and result["embedding"]:
            size = (crop.shape[1], crop.shape[0])
            result["landmarks"] = [(float(x / size[0]), float(y / size[1])) for x, y in face.points]
        # clarity, also under the threshold: 0 means no face, so only from a detector that ran
        if not points and landmarker.initialized:
            result["quality"] = found.score if found is not None else 0.0
        results.append(result)
    return results


async def embed_persons(
    embedder: PersonEmbedder,
    frames: list[VideoFrameData],
    space: str,
) -> list[PersonEmbeddingResult]:
    crops = [
        frame_to_rgb(bytes(frame["data"]), frame["width"], frame["height"], frame.get("format", "rgb"))
        for frame in frames
    ]
    return [{"embedding": await embedder.embed(crop), "embeddingModel": space} for crop in crops]


async def embed_person_images(
    embedder: PersonEmbedder,
    images: list[bytes],
    space: str,
) -> list[PersonEmbeddingResult]:
    results: list[PersonEmbeddingResult] = []
    for data in images:
        try:
            crop = decode_image(data)
        except Exception:
            crop = np.zeros((0, 0, 3), dtype=np.uint8)
        results.append({"embedding": await embedder.embed(crop), "embeddingModel": space})
    return results


async def segment_objects(segmenter: Segmenter, frames: list[SegmentationFrame]) -> list[SegmentationResult]:
    results: list[SegmentationResult] = []
    for frame in frames:
        rgb = frame_to_rgb(bytes(frame["data"]), frame["width"], frame["height"], frame.get("format", "rgb"))
        results.append(_segmentation(await segmenter.segment(rgb, frame["box"])))
    return results


async def segment_images(segmenter: Segmenter, images: list[SegmentationImage]) -> list[SegmentationResult]:
    results: list[SegmentationResult] = []
    for item in images:
        try:
            rgb = decode_image(bytes(item["image"]))
        except Exception:
            results.append({})
            continue
        results.append(_segmentation(await segmenter.segment(rgb, item["box"])))
    return results


def _segmentation(mask: ObjectMask | None) -> SegmentationResult:
    return {"mask": mask} if mask is not None else {}


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
