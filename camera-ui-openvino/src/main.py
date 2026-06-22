from __future__ import annotations

import asyncio
import io
from typing import Any

import openvino as ov
from camera_ui_sdk import (
    API_EVENT,
    BasePlugin,
    CameraDevice,
    ClipDetectionInterface,
    ClipDetectionPluginResponse,
    ClipTextEmbeddingResult,
    Detection,
    DeviceStorage,
    FaceDetection,
    FaceDetectionInterface,
    FaceDetectionPluginResponse,
    ImageMetadata,
    JsonSchema,
    LicensePlateDetection,
    LicensePlateDetectionInterface,
    LicensePlateDetectionPluginResponse,
    LoggerService,
    ObjectDetectionInterface,
    ObjectDetectionPluginResponse,
    PluginAPI,
    VideoFrameData,
)
from PIL import Image

from defaults import (
    CLIP_VISION_MODELS,
    DEFAULT_CLIP_VISION,
    DEFAULT_FACE_DETECTOR,
    DEFAULT_FACE_EMBEDDER,
    DEFAULT_LPD_DETECTOR,
    DEFAULT_OBJECT_MODEL,
    DEFAULT_OCR,
    DEFAULT_OPENVINO_DEVICE,
    FACE_DETECTOR_MODELS,
    FACE_EMBEDDER_MODELS,
    LPD_DETECTOR_MODELS,
    OBJECT_MODELS,
    OCR_MODELS,
    OPENVINO_DEVICES,
)
from detectors.clip_encoder import ClipEncoder
from detectors.face_detector import FaceDetector
from detectors.face_embedder import FaceEmbedder
from detectors.object_detector import ObjectDetector
from detectors.plate_detector import PlateDetector
from detectors.plate_ocr import PlateOCR
from model_manager import ModelManager
from sensors.clip_sensor import OpenVinoClipSensor
from sensors.face_sensor import OpenVinoFaceSensor
from sensors.lpd_sensor import OpenVinoLPDSensor
from sensors.object_sensor import OpenVinoObjectSensor


class OpenVinoPlugin(
    BasePlugin,
    ObjectDetectionInterface,
    FaceDetectionInterface,
    LicensePlateDetectionInterface,
    ClipDetectionInterface,
):
    def __init__(self, logger: LoggerService, api: PluginAPI, storage: DeviceStorage[Any]) -> None:
        super().__init__(logger, api, storage)
        self._core = ov.Core()
        self.model_manager = ModelManager(api, logger, self._resolve_device)

        self.object_detectors: dict[str, ObjectDetector] = {}
        self.face_detectors: dict[str, FaceDetector] = {}
        self.face_embedders: dict[str, FaceEmbedder] = {}
        self.plate_detectors: dict[str, PlateDetector] = {}
        self.ocr_models: dict[str, PlateOCR] = {}
        self.clip_encoders: dict[str, ClipEncoder] = {}

        self._sensors: dict[str, dict[str, Any]] = {}

        self.api.on(API_EVENT.FINISH_LAUNCHING, self._on_start)
        self.api.on(API_EVENT.SHUTDOWN, self._on_shutdown)

    @property
    def storage_schema(self) -> list[JsonSchema]:
        return [
            {
                "type": "string",
                "key": "device",
                "title": "Device",
                "description": (
                    "OpenVINO inference device. 'Default' auto-detects (NPU/GPU/CPU); "
                    "AUTO lets OpenVINO choose; CPU/GPU/NPU force a specific device."
                ),
                "enum": OPENVINO_DEVICES,
                "store": True,
                "defaultValue": DEFAULT_OPENVINO_DEVICE,
                "required": True,
                "onSet": self._on_device_change,
            },
        ]

    def _resolve_device(self) -> str:
        mode = self.storage.values.get("device", DEFAULT_OPENVINO_DEVICE)
        if mode and mode != "Default":
            return str(mode)

        # "Default": detect hardware and build a smart AUTO string (e.g. AUTO:NPU,GPU,CPU).
        try:
            devices = list(self._core.available_devices)
        except Exception:
            return "AUTO"

        has_npu = any("NPU" in d for d in devices)
        has_gpu = any("GPU" in d for d in devices)
        dgpus: list[str] = []
        for d in devices:
            if "GPU" not in d:
                continue
            try:
                name = str(self._core.get_property(d, "FULL_DEVICE_NAME"))
            except Exception:
                name = ""
            if "NVIDIA" in name and "dGPU" in name:
                dgpus.append(d)

        if has_npu and has_gpu:
            return "AUTO:NPU,GPU,CPU"
        if has_npu:
            return "AUTO:NPU,CPU"
        if dgpus:
            return f"AUTO:{','.join(dgpus)},CPU"
        if has_gpu:
            return "GPU"
        return "AUTO"

    async def _on_device_change(self, new_value: object, old_value: object) -> None:
        if new_value == old_value:
            return
        self.logger.log(f"Device setting changed ({old_value} -> {new_value}); reloading models")
        await self._reload_models()

    async def _reload_models(self) -> None:
        obj = list(self.object_detectors)
        fdet = list(self.face_detectors)
        femb = list(self.face_embedders)
        pdet = list(self.plate_detectors)
        ocr = list(self.ocr_models)
        clip = list(self.clip_encoders)

        await self._close_all()
        self.model_manager.reset()

        await asyncio.gather(
            *(self.get_object_detector(n) for n in obj),
            *(self.get_face_detector(n) for n in fdet),
            *(self.get_face_embedder(n) for n in femb),
            *(self.get_plate_detector(n) for n in pdet),
            *(self.get_ocr(n) for n in ocr),
            *(self.get_clip_encoder(n) for n in clip),
        )

    async def _close_all(self) -> None:
        await asyncio.gather(
            *(d.close() for d in self.object_detectors.values()),
            *(d.close() for d in self.face_detectors.values()),
            *(d.close() for d in self.plate_detectors.values()),
            *(e.close() for e in self.face_embedders.values()),
            *(e.close() for e in self.clip_encoders.values()),
            *(o.close() for o in self.ocr_models.values()),
        )
        self.object_detectors.clear()
        self.face_detectors.clear()
        self.face_embedders.clear()
        self.plate_detectors.clear()
        self.ocr_models.clear()
        self.clip_encoders.clear()

    async def _on_start(self) -> None:
        # Preload CLIP models so the first semantic search is instant
        asyncio.create_task(self._preload_clip())

    async def _preload_clip(self) -> None:
        try:
            await self.get_clip_encoder(DEFAULT_CLIP_VISION)
            self.logger.log("CLIP models preloaded")
        except Exception as e:
            self.logger.error(f"Failed to preload CLIP models: {e}")

    async def _on_shutdown(self) -> None:
        for sensors in self._sensors.values():
            for sensor in sensors.values():
                await sensor.destroy()
        self._sensors.clear()

        await self._close_all()

    async def configureCameras(self, cameras: list[CameraDevice]) -> None:
        for camera in cameras:
            await self._add_sensors(camera)

    async def onCameraAdded(self, camera: CameraDevice) -> None:
        await self._add_sensors(camera)

    async def onCameraReleased(self, cameraId: str) -> None:
        sensors = self._sensors.pop(cameraId, {})
        for sensor in sensors.values():
            await sensor.destroy()

    async def _add_sensors(self, camera: CameraDevice) -> None:
        sensors: dict[str, Any] = {}

        obj = OpenVinoObjectSensor(self, self.logger)
        await camera.addSensor(obj)
        sensors["object"] = obj

        face = OpenVinoFaceSensor(self, self.logger)
        await camera.addSensor(face)
        sensors["face"] = face

        lpd = OpenVinoLPDSensor(self, self.logger)
        await camera.addSensor(lpd)
        sensors["lpd"] = lpd

        clip = OpenVinoClipSensor(self, self.logger)
        await camera.addSensor(clip)
        sensors["clip"] = clip

        self._sensors[camera.id] = sensors

    async def get_object_detector(self, model_name: str) -> ObjectDetector:
        detector = self.object_detectors.get(model_name)
        if not detector:
            detector = ObjectDetector(self.model_manager)
            self.object_detectors[model_name] = detector
            await detector.initialize(model_name)
        return detector

    async def get_face_detector(self, model_name: str) -> FaceDetector:
        detector = self.face_detectors.get(model_name)
        if not detector:
            detector = FaceDetector(self.model_manager)
            self.face_detectors[model_name] = detector
            await detector.initialize(model_name)
        return detector

    async def get_face_embedder(self, model_name: str) -> FaceEmbedder:
        embedder = self.face_embedders.get(model_name)
        if not embedder:
            embedder = FaceEmbedder(self.model_manager)
            self.face_embedders[model_name] = embedder
            await embedder.initialize(model_name)
        return embedder

    async def get_plate_detector(self, model_name: str) -> PlateDetector:
        detector = self.plate_detectors.get(model_name)
        if not detector:
            detector = PlateDetector(self.model_manager)
            self.plate_detectors[model_name] = detector
            await detector.initialize(model_name)
        return detector

    async def get_ocr(self, model_name: str) -> PlateOCR:
        ocr = self.ocr_models.get(model_name)
        if not ocr:
            ocr = PlateOCR(self.model_manager)
            self.ocr_models[model_name] = ocr
            await ocr.initialize(model_name)
        return ocr

    async def get_clip_encoder(self, model_name: str) -> ClipEncoder:
        encoder = self.clip_encoders.get(model_name)
        if not encoder:
            encoder = ClipEncoder(self.model_manager)
            self.clip_encoders[model_name] = encoder
            await encoder.initialize(model_name)
        return encoder

    async def objectDetectionSettings(self) -> list[JsonSchema] | None:
        return [
            {
                "type": "string",
                "key": "model",
                "title": "Model",
                "description": "YOLO model for testing",
                "required": True,
                "defaultValue": DEFAULT_OBJECT_MODEL,
                "enum": list(OBJECT_MODELS.keys()),
                "store": False,
            },
        ]

    async def testObjectDetection(
        self, image_data: bytes, metadata: ImageMetadata, config: dict[str, Any]
    ) -> ObjectDetectionPluginResponse | None:
        model_name: str = config.get("model", DEFAULT_OBJECT_MODEL)
        detector = await self.get_object_detector(model_name)
        if not detector.initialized:
            return None

        detections = await detector.detect_single(image_data, metadata)
        return {"detected": len(detections) > 0, "detections": detections}

    async def detectObjects(
        self, frame: VideoFrameData, config: dict[str, Any] | None = None
    ) -> ObjectDetectionPluginResponse | None:
        model_name = (config or {}).get("model", DEFAULT_OBJECT_MODEL)
        detector = await self.get_object_detector(model_name)
        if not detector.initialized:
            return None

        results = await detector.detect_frame(frame)
        width, height = frame["width"], frame["height"]
        detections: list[Detection] = [
            {
                "label": r["label"],
                "confidence": r["confidence"],
                "box": {
                    "x": r["box"][0] / width,
                    "y": r["box"][1] / height,
                    "width": (r["box"][2] - r["box"][0]) / width,
                    "height": (r["box"][3] - r["box"][1]) / height,
                },
            }
            for r in results
        ]
        return {"detected": len(detections) > 0, "detections": detections}

    async def faceDetectionSettings(self) -> list[JsonSchema] | None:
        return [
            {
                "type": "string",
                "key": "detector_model",
                "title": "Detector Model",
                "description": "Face detection model for testing",
                "required": True,
                "defaultValue": DEFAULT_FACE_DETECTOR,
                "enum": list(FACE_DETECTOR_MODELS.keys()),
                "store": False,
            },
            {
                "type": "string",
                "key": "embedder_model",
                "title": "Embedding Model",
                "description": "Face embedding model for testing",
                "required": True,
                "defaultValue": DEFAULT_FACE_EMBEDDER,
                "enum": list(FACE_EMBEDDER_MODELS.keys()),
                "store": False,
            },
        ]

    async def testFaceDetection(
        self, image_data: bytes, metadata: ImageMetadata, config: dict[str, Any]
    ) -> FaceDetectionPluginResponse | None:
        detector_name: str = config.get("detector_model", DEFAULT_FACE_DETECTOR)
        embedder_name: str = config.get("embedder_model", DEFAULT_FACE_EMBEDDER)

        detector = await self.get_face_detector(detector_name)
        embedder = await self.get_face_embedder(embedder_name)
        if not detector.initialized or not embedder.initialized:
            return None

        face_boxes = await detector.detect_single(image_data, metadata)
        if not face_boxes:
            return {"detected": False, "detections": []}

        image = Image.open(io.BytesIO(image_data)).convert("RGB")
        width, height = image.size
        rgb_bytes = image.tobytes()

        detections: list[FaceDetection] = []
        for face in face_boxes:
            x1, y1, x2, y2 = face["box"]
            embedding = await embedder.embed_from_crop(rgb_bytes, width, height, (x1, y1, x2, y2))
            detections.append(
                {
                    "label": "person",
                    "attribute": "face",
                    "confidence": face["confidence"],
                    "box": {
                        "x": x1 / width,
                        "y": y1 / height,
                        "width": (x2 - x1) / width,
                        "height": (y2 - y1) / height,
                    },
                    "embedding": embedding,
                }
            )

        image.close()
        return {"detected": len(detections) > 0, "detections": detections}

    async def detectFaces(
        self, frame: VideoFrameData, config: dict[str, Any] | None = None
    ) -> FaceDetectionPluginResponse | None:
        cfg = config or {}
        detector_name = cfg.get("detector_model", DEFAULT_FACE_DETECTOR)
        embedder_name = cfg.get("embedder_model", DEFAULT_FACE_EMBEDDER)

        detector = await self.get_face_detector(detector_name)
        embedder = await self.get_face_embedder(embedder_name)
        if not detector.initialized or not embedder.initialized:
            return None

        face_boxes = await detector.detect_frame(frame)
        if not face_boxes:
            return {"detected": False, "detections": []}

        width, height = frame["width"], frame["height"]
        rgb_bytes = bytes(frame["data"])

        detections: list[FaceDetection] = []
        for face in face_boxes:
            x1, y1, x2, y2 = face["box"]
            embedding = await embedder.embed_from_crop(rgb_bytes, width, height, (x1, y1, x2, y2))
            detections.append(
                {
                    "label": "person",
                    "attribute": "face",
                    "confidence": face["confidence"],
                    "box": {
                        "x": x1 / width,
                        "y": y1 / height,
                        "width": (x2 - x1) / width,
                        "height": (y2 - y1) / height,
                    },
                    "embedding": embedding,
                }
            )

        return {"detected": len(detections) > 0, "detections": detections}

    async def licensePlateDetectionSettings(self) -> list[JsonSchema] | None:
        return [
            {
                "type": "string",
                "key": "detector_model",
                "title": "Detector Model",
                "description": "YOLOv9 model for plate detection testing",
                "required": True,
                "defaultValue": DEFAULT_LPD_DETECTOR,
                "enum": list(LPD_DETECTOR_MODELS.keys()),
                "store": False,
            },
            {
                "type": "string",
                "key": "ocr_model",
                "title": "OCR Model",
                "description": "CCT model for plate text recognition testing",
                "required": True,
                "defaultValue": DEFAULT_OCR,
                "enum": OCR_MODELS,
                "store": False,
            },
        ]

    async def testLicensePlateDetection(
        self, image_data: bytes, metadata: ImageMetadata, config: dict[str, Any]
    ) -> LicensePlateDetectionPluginResponse | None:
        detector_name: str = config.get("detector_model", DEFAULT_LPD_DETECTOR)
        ocr_name: str = config.get("ocr_model", DEFAULT_OCR)

        detector = await self.get_plate_detector(detector_name)
        ocr = await self.get_ocr(ocr_name)
        if not detector.initialized or not ocr.initialized:
            return None

        image = Image.open(io.BytesIO(image_data)).convert("RGB")
        width, height = image.size
        rgb_bytes = image.tobytes()
        resized = image.resize((detector.input_width, detector.input_height))
        image.close()

        raw = await detector.detect(resized)
        resized.close()

        sx, sy = width / detector.input_width, height / detector.input_height

        detections: list[LicensePlateDetection] = []
        for plate in raw:
            x1, y1, x2, y2 = (
                plate["box"][0] * sx,
                plate["box"][1] * sy,
                plate["box"][2] * sx,
                plate["box"][3] * sy,
            )
            ocr_result = await ocr.recognize_from_crop(rgb_bytes, width, height, (x1, y1, x2, y2))
            if ocr_result and ocr_result.text:
                detections.append(
                    {
                        "label": "vehicle",
                        "attribute": "license_plate",
                        "confidence": plate["confidence"],
                        "plateText": ocr_result.text,
                        "box": {
                            "x": x1 / width,
                            "y": y1 / height,
                            "width": (x2 - x1) / width,
                            "height": (y2 - y1) / height,
                        },
                    }
                )

        return {"detected": len(detections) > 0, "detections": detections}

    async def detectLicensePlates(
        self, frame: VideoFrameData, config: dict[str, Any] | None = None
    ) -> LicensePlateDetectionPluginResponse | None:
        cfg = config or {}
        detector_name = cfg.get("detector_model", DEFAULT_LPD_DETECTOR)
        ocr_name = cfg.get("ocr_model", DEFAULT_OCR)

        detector = await self.get_plate_detector(detector_name)
        ocr = await self.get_ocr(ocr_name)
        if not detector.initialized or not ocr.initialized:
            return None

        plate_boxes = await detector.detect_frame(frame)
        if not plate_boxes:
            return {"detected": False, "detections": []}

        width, height = frame["width"], frame["height"]
        rgb_bytes = bytes(frame["data"])

        detections: list[LicensePlateDetection] = []
        for plate in plate_boxes:
            x1, y1, x2, y2 = plate["box"]
            ocr_result = await ocr.recognize_from_crop(rgb_bytes, width, height, (x1, y1, x2, y2))
            if ocr_result and ocr_result.text:
                detections.append(
                    {
                        "label": "vehicle",
                        "attribute": "license_plate",
                        "confidence": plate["confidence"],
                        "plateText": ocr_result.text,
                        "box": {
                            "x": x1 / width,
                            "y": y1 / height,
                            "width": (x2 - x1) / width,
                            "height": (y2 - y1) / height,
                        },
                    }
                )

        return {"detected": len(detections) > 0, "detections": detections}

    async def clipSettings(self) -> list[JsonSchema] | None:
        return [
            {
                "type": "string",
                "key": "vision_model",
                "title": "Vision Model",
                "description": "CLIP vision model for testing",
                "required": True,
                "defaultValue": DEFAULT_CLIP_VISION,
                "enum": list(CLIP_VISION_MODELS.keys()),
                "store": False,
            },
        ]

    async def testClipEmbedding(
        self, image_data: bytes, metadata: ImageMetadata, config: dict[str, Any]
    ) -> ClipDetectionPluginResponse | None:
        model_name: str = config.get("vision_model", DEFAULT_CLIP_VISION)
        encoder = await self.get_clip_encoder(model_name)
        if not encoder.initialized:
            return None

        image = Image.open(io.BytesIO(image_data)).convert("RGB")
        embedding = await encoder.embed_image(image)
        image.close()

        if not embedding:
            return None

        return {
            "embeddings": [
                {"label": "image", "box": {"x": 0, "y": 0, "width": 1, "height": 1}, "embedding": embedding}
            ],
            "embeddingModel": encoder.embedding_model,
        }

    async def detectClipEmbedding(
        self, frame: VideoFrameData, config: dict[str, Any] | None = None
    ) -> ClipDetectionPluginResponse | None:
        model_name = (config or {}).get("vision_model", DEFAULT_CLIP_VISION)
        encoder = await self.get_clip_encoder(model_name)
        if not encoder.initialized:
            return None

        embedding = await encoder.embed_frame(frame["width"], frame["height"], bytes(frame["data"]))
        if not embedding:
            return None

        return {
            "embeddings": [
                {"label": "image", "box": {"x": 0, "y": 0, "width": 1, "height": 1}, "embedding": embedding}
            ],
            "embeddingModel": encoder.embedding_model,
        }

    async def getTextEmbedding(self, text: str) -> ClipTextEmbeddingResult:
        encoder = await self.get_clip_encoder(DEFAULT_CLIP_VISION)
        if not encoder.initialized:
            return {"embedding": [], "embeddingModel": ""}

        embedding = await encoder.embed_text(text)
        return {"embedding": embedding, "embeddingModel": encoder.embedding_model}


def __main__() -> type[OpenVinoPlugin]:
    return OpenVinoPlugin
