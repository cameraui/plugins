from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any, TypedDict

import numpy as np
from camera_ui_sdk import FaceDetection, FaceDetectorSensor, FaceResult, JsonSchema, ModelSpec, VideoFrameData
from PIL import Image

from defaults import DEFAULT_FACE_DETECTOR, DEFAULT_FACE_EMBEDDER, FACE_DETECTOR_MODELS, FACE_EMBEDDER_MODELS

if TYPE_CHECKING:
    from camera_ui_sdk import LoggerService

    from main import CoreMLPlugin


class FaceStorageValues(TypedDict):
    detector_model: str
    embedder_model: str
    confidence_threshold: float


class CoreMLFaceSensor(FaceDetectorSensor["FaceStorageValues"]):
    def __init__(self, plugin: CoreMLPlugin, logger: LoggerService, name: str = "CoreML Face") -> None:
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
                "description": "Face detection model",
                "group": "Face Detection",
                "enum": list(FACE_DETECTOR_MODELS.keys()),
                "store": True,
                "defaultValue": DEFAULT_FACE_DETECTOR,
                "required": True,
                "onSet": self._on_change_detector,
            },
            {
                "type": "string",
                "key": "embedder_model",
                "title": "Embedding Model",
                "description": "Face embedding model for recognition",
                "group": "Face Detection",
                "enum": list(FACE_EMBEDDER_MODELS.keys()),
                "store": True,
                "defaultValue": DEFAULT_FACE_EMBEDDER,
                "required": True,
                "onSet": self._on_change_embedder,
            },
            {
                "type": "number",
                "key": "confidence_threshold",
                "title": "Confidence Threshold",
                "description": "Minimum confidence for face detections (0-1)",
                "group": "Face Detection",
                "store": True,
                "defaultValue": 0.5,
                "minimum": 0.1,
                "maximum": 1.0,
                "step": 0.05,
                "required": True,
            },
        ]

    @property
    def modelSpec(self) -> ModelSpec:
        detector_name = self.storage.values.get("detector_model", DEFAULT_FACE_DETECTOR)
        size = FACE_DETECTOR_MODELS.get(detector_name, 320)
        embedder_name = self.storage.values.get("embedder_model", DEFAULT_FACE_EMBEDDER)
        return {
            "input": {"width": size, "height": size, "format": "rgb"},
            "triggerLabels": ["person"],
            "embeddingModel": embedder_name,
        }

    async def detectFaces(self, frames: list[VideoFrameData]) -> list[FaceResult]:
        detector_name = self.storage.values.get("detector_model", DEFAULT_FACE_DETECTOR)
        embedder_name = self.storage.values.get("embedder_model", DEFAULT_FACE_EMBEDDER)
        threshold = self.storage.values.get("confidence_threshold", 0.5)

        detector = self._plugin.face_detectors.get(detector_name)
        embedder = self._plugin.face_embedders.get(embedder_name)

        empty: FaceResult = {"detected": False, "detections": []}
        if detector is None or not detector.initialized or embedder is None or not embedder.initialized:
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

        # Batch face detection
        all_boxes = await detector.detect_batch(images, threshold)
        for img in images:
            img.close()

        # Per-frame: embed detected faces
        results: list[FaceResult] = []
        for i, face_boxes in enumerate(all_boxes):
            if not face_boxes:
                results.append(empty)
                continue

            width, height = frames[i]["width"], frames[i]["height"]
            data = frames[i]["data"]
            scale_x = width / detector.input_width
            scale_y = height / detector.input_height
            needs_scale = width != detector.input_width or height != detector.input_height

            face_images: list[Image.Image] = []
            scaled_boxes: list[tuple[float, float, float, float]] = []
            for face in face_boxes:
                x1, y1, x2, y2 = face["box"]
                if needs_scale:
                    x1, y1, x2, y2 = x1 * scale_x, y1 * scale_y, x2 * scale_x, y2 * scale_y
                ix1, iy1 = max(0, int(x1)), max(0, int(y1))
                ix2, iy2 = min(width, int(x2)), min(height, int(y2))
                if ix2 <= ix1 or iy2 <= iy1:
                    continue
                np_frame: np.ndarray[Any, Any] = np.frombuffer(data, dtype=np.uint8).reshape(
                    (height, width, 3)
                )
                face_images.append(Image.fromarray(np_frame[iy1:iy2, ix1:ix2], mode="RGB"))
                scaled_boxes.append((x1, y1, x2, y2))

            if not face_images:
                results.append(empty)
                continue

            embeddings = await embedder.embed_batch(face_images)
            for img in face_images:
                img.close()

            detections: list[FaceDetection] = []
            for j, (x1, y1, x2, y2) in enumerate(scaled_boxes):
                detections.append(
                    {
                        "label": "person",
                        "attribute": "face",
                        "confidence": face_boxes[j]["confidence"],
                        "box": {
                            "x": x1 / width,
                            "y": y1 / height,
                            "width": (x2 - x1) / width,
                            "height": (y2 - y1) / height,
                        },
                        "embedding": embeddings[j] if j < len(embeddings) else [],
                    }
                )

            results.append({"detected": len(detections) > 0, "detections": detections})

        return results

    async def destroy(self) -> None:
        pass

    async def on_assigned(self) -> None:
        detector_name = self.storage.values.get("detector_model", DEFAULT_FACE_DETECTOR)
        embedder_name = self.storage.values.get("embedder_model", DEFAULT_FACE_EMBEDDER)
        await asyncio.gather(
            self._plugin.get_face_detector(detector_name),
            self._plugin.get_face_embedder(embedder_name),
        )

    async def _on_change_detector(self, new_model: str, _old_model: str) -> None:
        if new_model != _old_model:
            await self._plugin.get_face_detector(new_model)
            self._logger.log(f"Face detector changed to {new_model}")

    async def _on_change_embedder(self, new_model: str, _old_model: str) -> None:
        if new_model != _old_model:
            await self._plugin.get_face_embedder(new_model)
            self._logger.log(f"Face embedder changed to {new_model}")
