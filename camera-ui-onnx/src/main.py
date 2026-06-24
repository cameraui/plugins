from __future__ import annotations

import asyncio
import platform
from typing import Any

import onnxruntime as ort
from camera_ui_ml import (
    BoxDetector,
    Embedder,
    PlateOcr,
    crop_rgb,
    decode_image,
    normalize_box,
    scale_box,
)
from camera_ui_ml.detectors.clip import ClipEncoder
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

from defaults import (
    CLIP_VISION_MODELS,
    DEFAULT_CLIP_TEXT,
    DEFAULT_CLIP_VISION,
    DEFAULT_EXECUTION_PROVIDER,
    DEFAULT_FACE_DETECTOR,
    DEFAULT_FACE_EMBEDDER,
    DEFAULT_LPD_DETECTOR,
    DEFAULT_OBJECT_MODEL,
    DEFAULT_OCR,
    EXECUTION_PROVIDERS,
    FACE_DETECTOR_MODELS,
    FACE_EMBEDDER_INPUT_SIZE,
    FACE_EMBEDDER_MODELS,
    LPD_DETECTOR_MODELS,
    OBJECT_MODELS,
    OCR_ALPHABET,
    OCR_INPUT_HEIGHT,
    OCR_INPUT_WIDTH,
    OCR_MAX_SLOTS,
    OCR_MODELS,
    OCR_PAD_CHAR,
)
from model_manager import OnnxModelManager, ProviderList
from sensors.clip_sensor import ONNXClipSensor
from sensors.face_sensor import ONNXFaceSensor
from sensors.lpd_sensor import ONNXLPDSensor
from sensors.object_sensor import ONNXObjectSensor


class ONNXPlugin(
    BasePlugin,
    ObjectDetectionInterface,
    FaceDetectionInterface,
    LicensePlateDetectionInterface,
    ClipDetectionInterface,
):
    def __init__(
        self, logger: LoggerService, api: PluginAPI, storage: DeviceStorage[Any]
    ) -> None:
        super().__init__(logger, api, storage)
        self.model_manager = OnnxModelManager(
            api.storagePath, logger, self._resolve_provider_lists
        )

        self.object_detectors: dict[str, BoxDetector] = {}
        self.face_detectors: dict[str, BoxDetector] = {}
        self.face_embedders: dict[str, Embedder] = {}
        self.plate_detectors: dict[str, BoxDetector] = {}
        self.ocr_models: dict[str, PlateOcr] = {}
        self.clip_encoders: dict[str, ClipEncoder] = {}

        self._sensors: dict[str, dict[str, Any]] = {}

        self.api.on(API_EVENT.FINISH_LAUNCHING, self._on_start)
        self.api.on(API_EVENT.SHUTDOWN, self._on_shutdown)

    @property
    def storage_schema(self) -> list[JsonSchema]:
        return [
            {
                "type": "string",
                "key": "execution_provider",
                "title": "Execution Provider",
                "description": (
                    "Hardware backend for inference. 'auto' selects CoreML on macOS, "
                    "CUDA on Linux/Windows (x86_64), CPU otherwise. Always falls back to CPU."
                ),
                "enum": EXECUTION_PROVIDERS,
                "store": True,
                "defaultValue": DEFAULT_EXECUTION_PROVIDER,
                "required": True,
                "onSet": self._on_provider_change,
            },
            {
                "type": "string",
                "key": "device_ids",
                "title": "CUDA Device IDs",
                "description": (
                    'GPU index(es) for CUDA, comma-separated for multi-GPU (e.g. "0" or "0,1"). '
                    "Each device gets its own inference session so detection runs in parallel across GPUs."
                ),
                "store": True,
                "defaultValue": "0",
                "onSet": self._on_provider_change,
            },
            {
                "type": "string",
                "key": "active_hardware",
                "title": "Active Hardware",
                "description": "Hardware currently running inference across loaded models (read-only).",
                "readonly": True,
                "store": False,
                "onGet": self._active_hardware,
            },
        ]

    def _active_hardware(self) -> str:
        backends = [
            detector.backend.device
            for detector in (
                *self.object_detectors.values(),
                *self.face_detectors.values(),
                *self.plate_detectors.values(),
                *self.face_embedders.values(),
                *self.ocr_models.values(),
            )
            if detector.backend is not None
        ]
        backends += [
            enc.vision.device
            for enc in self.clip_encoders.values()
            if enc.vision is not None
        ]
        if not backends:
            return "No models loaded yet"
        return ", ".join(dict.fromkeys(backends))

    def _device_ids(self) -> list[int]:
        raw = str(self.storage.values.get("device_ids", "0"))
        ids = [int(part.strip()) for part in raw.split(",") if part.strip().isdigit()]
        return ids or [0]

    def _resolve_provider_lists(self) -> list[ProviderList]:
        pref = self.storage.values.get("execution_provider", DEFAULT_EXECUTION_PROVIDER)
        system = platform.system()  # "Darwin" / "Linux" / "Windows"
        machine = platform.machine()
        available: set[str] = set(ort.get_available_providers())

        x86 = machine in ("x86_64", "AMD64")
        use_cuda = pref == "cuda" or (
            pref == "auto" and system in ("Linux", "Windows") and x86
        )
        use_coreml = pref == "coreml" or (pref == "auto" and system == "Darwin")

        if use_cuda and "CUDAExecutionProvider" in available:
            return [
                [
                    ("CUDAExecutionProvider", {"device_id": device_id}),
                    "CPUExecutionProvider",
                ]
                for device_id in self._device_ids()
            ]
        if use_coreml and "CoreMLExecutionProvider" in available:
            return [["CoreMLExecutionProvider", "CPUExecutionProvider"]]
        return [["CPUExecutionProvider"]]

    async def _on_provider_change(self, new_value: object, old_value: object) -> None:
        if new_value == old_value:
            return
        self.logger.log(
            f"Execution provider setting changed ({old_value} -> {new_value}); reloading models"
        )
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

        obj = ONNXObjectSensor(self, self.logger)
        await camera.addSensor(obj)
        sensors["object"] = obj

        face = ONNXFaceSensor(self, self.logger)
        await camera.addSensor(face)
        sensors["face"] = face

        lpd = ONNXLPDSensor(self, self.logger)
        await camera.addSensor(lpd)
        sensors["lpd"] = lpd

        clip = ONNXClipSensor(self, self.logger)
        await camera.addSensor(clip)
        sensors["clip"] = clip

        self._sensors[camera.id] = sensors

    async def get_object_detector(self, model_name: str) -> BoxDetector:
        detector = self.object_detectors.get(model_name)
        if not detector:
            detector = BoxDetector(
                self.model_manager, self.logger, name="object detector", multiclass=True
            )
            self.object_detectors[model_name] = detector
            await detector.initialize(model_name)
        return detector

    async def get_face_detector(self, model_name: str) -> BoxDetector:
        detector = self.face_detectors.get(model_name)
        if not detector:
            detector = BoxDetector(
                self.model_manager, self.logger, name="face detector"
            )
            self.face_detectors[model_name] = detector
            await detector.initialize(model_name)
        return detector

    async def get_face_embedder(self, model_name: str) -> Embedder:
        embedder = self.face_embedders.get(model_name)
        if not embedder:
            embedder = Embedder(
                self.model_manager, self.logger, size=FACE_EMBEDDER_INPUT_SIZE
            )
            self.face_embedders[model_name] = embedder
            await embedder.initialize(model_name)
        return embedder

    async def get_plate_detector(self, model_name: str) -> BoxDetector:
        detector = self.plate_detectors.get(model_name)
        if not detector:
            detector = BoxDetector(
                self.model_manager,
                self.logger,
                name="plate detector",
                parse="end2end",
                threshold=0.25,
            )
            self.plate_detectors[model_name] = detector
            await detector.initialize(model_name)
        return detector

    async def get_ocr(self, model_name: str) -> PlateOcr:
        ocr = self.ocr_models.get(model_name)
        if not ocr:
            ocr = PlateOcr(
                self.model_manager,
                self.logger,
                width=OCR_INPUT_WIDTH,
                height=OCR_INPUT_HEIGHT,
                slots=OCR_MAX_SLOTS,
                alphabet=OCR_ALPHABET,
                pad_char=OCR_PAD_CHAR,
            )
            self.ocr_models[model_name] = ocr
            await ocr.initialize(model_name)
        return ocr

    async def get_clip_encoder(self, model_name: str) -> ClipEncoder:
        encoder = self.clip_encoders.get(model_name)
        if not encoder:
            encoder = ClipEncoder(self.model_manager, self.logger)
            self.clip_encoders[model_name] = encoder
            await encoder.initialize(model_name, DEFAULT_CLIP_TEXT)
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
        model_name = (config or {}).get("model", DEFAULT_OBJECT_MODEL)
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

        rgb = decode_image(image_data)
        height, width = int(rgb.shape[0]), int(rgb.shape[1])
        raw = await detector.detect(rgb)
        if not raw:
            return {"detected": False, "detections": []}

        scale_x = width / detector.input_size[0]
        scale_y = height / detector.input_size[1]

        detections: list[FaceDetection] = []
        for _cid, conf, box in raw:
            image_box = scale_box(box, scale_x, scale_y)
            embedding = await embedder.embed(crop_rgb(rgb, image_box))
            detections.append(
                {
                    "label": "person",
                    "attribute": "face",
                    "confidence": conf,
                    "box": normalize_box(image_box, width, height),
                    "embedding": embedding,
                }
            )

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

        raw = await detector.detect_frame(frame)
        if not raw:
            return {"detected": False, "detections": []}

        width, height = frame["width"], frame["height"]
        rgb_bytes = bytes(frame["data"])

        detections: list[FaceDetection] = []
        for _cid, conf, box in raw:
            embedding = await embedder.embed_from_crop(rgb_bytes, width, height, box)
            detections.append(
                {
                    "label": "person",
                    "attribute": "face",
                    "confidence": conf,
                    "box": normalize_box(box, width, height),
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

        rgb = decode_image(image_data)
        height, width = int(rgb.shape[0]), int(rgb.shape[1])
        raw = await detector.detect(rgb)

        scale_x = width / detector.input_size[0]
        scale_y = height / detector.input_size[1]

        detections: list[LicensePlateDetection] = []
        for _cid, conf, box in raw:
            image_box = scale_box(box, scale_x, scale_y)
            ocr_result = await ocr.recognize(crop_rgb(rgb, image_box))
            if ocr_result and ocr_result.text:
                detections.append(
                    {
                        "label": "vehicle",
                        "attribute": "license_plate",
                        "confidence": conf,
                        "plateText": ocr_result.text,
                        "box": normalize_box(image_box, width, height),
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

        raw = await detector.detect_frame(frame)
        if not raw:
            return {"detected": False, "detections": []}

        width, height = frame["width"], frame["height"]
        rgb_bytes = bytes(frame["data"])

        detections: list[LicensePlateDetection] = []
        for _cid, conf, box in raw:
            ocr_result = await ocr.recognize_from_crop(rgb_bytes, width, height, box)
            if ocr_result and ocr_result.text:
                detections.append(
                    {
                        "label": "vehicle",
                        "attribute": "license_plate",
                        "confidence": conf,
                        "plateText": ocr_result.text,
                        "box": normalize_box(box, width, height),
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

        embedding = await encoder.embed_image(decode_image(image_data))
        if not embedding:
            return None

        return {
            "embeddings": [
                {
                    "label": "image",
                    "box": {"x": 0, "y": 0, "width": 1, "height": 1},
                    "embedding": embedding,
                }
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

        embedding = await encoder.embed_frame(
            frame["width"], frame["height"], bytes(frame["data"])
        )
        if not embedding:
            return None

        return {
            "embeddings": [
                {
                    "label": "image",
                    "box": {"x": 0, "y": 0, "width": 1, "height": 1},
                    "embedding": embedding,
                }
            ],
            "embeddingModel": encoder.embedding_model,
        }

    async def getTextEmbedding(self, text: str) -> ClipTextEmbeddingResult:
        encoder = await self.get_clip_encoder(DEFAULT_CLIP_VISION)
        if not encoder.initialized:
            return {"embedding": [], "embeddingModel": ""}

        embedding = await encoder.embed_text(text)
        return {"embedding": embedding, "embeddingModel": encoder.embedding_model}


def __main__() -> type[ONNXPlugin]:
    return ONNXPlugin
