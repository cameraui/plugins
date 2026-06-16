from __future__ import annotations

import asyncio
import math
from typing import Any

import numpy as np
from camera_ui_sdk import (
    API_EVENT,
    AudioDetectionInterface,
    AudioDetectionPluginResponse,
    AudioFrameData,
    AudioMetadata,
    BasePlugin,
    CameraDevice,
    Detection,
    DeviceStorage,
    JsonSchema,
    LoggerService,
    PluginAPI,
)

from defaults import DEFAULT_LISTEN_LABELS, DEFAULT_THRESHOLD, YAMNET_SAMPLES_PER_FRAME, YAMNET_TO_LABEL
from detector import AudioDetector
from sensor import YAMNetAudioSensor


class YAMNetPlugin(BasePlugin, AudioDetectionInterface):
    def __init__(self, logger: LoggerService, api: PluginAPI, storage: DeviceStorage) -> None:  # type: ignore[type-arg]
        super().__init__(logger, api, storage)

        self.sensors: dict[str, YAMNetAudioSensor] = {}
        self.audio_detectors: dict[str, AudioDetector] = {}
        self._available_labels: list[str] = list(DEFAULT_LISTEN_LABELS)

        self.api.on(API_EVENT.SHUTDOWN, self.on_shutdown)

    async def on_shutdown(self) -> None:
        await asyncio.gather(*(sensor.destroy() for sensor in self.sensors.values()))
        self.sensors.clear()

    async def configureCameras(self, cameras: list[CameraDevice]) -> None:
        for camera in cameras:
            await self.add_sensor_to_camera(camera)

    async def onCameraAdded(self, camera: CameraDevice) -> None:
        await self.add_sensor_to_camera(camera)

    async def onCameraReleased(self, cameraId: str) -> None:
        sensor = self.sensors.get(cameraId)
        if sensor:
            await sensor.destroy()
            del self.sensors[cameraId]

    async def add_sensor_to_camera(self, camera: CameraDevice) -> None:
        sensor = YAMNetAudioSensor(self.api, self.logger, self._available_labels)
        await camera.addSensor(sensor)
        self.sensors[camera.id] = sensor

    async def audioDetectionSettings(self) -> list[JsonSchema] | None:
        return [
            {
                "type": "string",
                "key": "listen_labels",
                "title": "Listen Labels",
                "description": "Audio event classes to detect",
                "defaultValue": DEFAULT_LISTEN_LABELS,
                "enum": self._available_labels,
                "multiple": True,
                "store": False,
            },
            {
                "type": "number",
                "key": "threshold",
                "title": "Confidence Threshold",
                "description": "Minimum confidence for detections (0-1)",
                "group": "Detection",
                "store": False,
                "defaultValue": DEFAULT_THRESHOLD,
                "minimum": 0.1,
                "maximum": 1.0,
                "step": 0.05,
            },
        ]

    async def testAudioDetection(
        self, audio_data: bytes, metadata: AudioMetadata, config: dict[str, Any]
    ) -> AudioDetectionPluginResponse | None:
        import numpy as np

        from audio_decode import decode_wav
        from defaults import YAMNET_SAMPLE_RATE, YAMNET_SAMPLES_PER_FRAME

        detector = self.audio_detectors.get("test")
        if not detector:
            detector = AudioDetector(self.api, self.logger)
            self.audio_detectors["test"] = detector

        await detector.initialize()

        # Decode WAV file to float32 waveform (handles PCM, A-law, mu-law, float)
        waveform, sample_rate = decode_wav(audio_data)

        # Resample to YAMNet's expected sample rate (16kHz) if needed
        if sample_rate != YAMNET_SAMPLE_RATE:
            target_samples = int(len(waveform) * YAMNET_SAMPLE_RATE / sample_rate)
            waveform = np.interp(
                np.linspace(0, len(waveform) - 1, target_samples),
                np.arange(len(waveform)),
                waveform,
            ).astype(np.float32)

        # Calculate dBFS
        rms = float(np.sqrt(np.mean(waveform**2)))
        dbfs = 20 * math.log10(max(rms, 1e-10)) if rms > 0 else -100.0

        # YAMNet expects exactly YAMNET_SAMPLES_PER_FRAME (15600) samples per inference.
        # Split the waveform into chunks and take the max score per label across all chunks.
        all_scores: dict[str, float] = {}

        for start in range(0, len(waveform), YAMNET_SAMPLES_PER_FRAME):
            chunk = waveform[start : start + YAMNET_SAMPLES_PER_FRAME]
            if len(chunk) < YAMNET_SAMPLES_PER_FRAME:
                chunk = np.pad(chunk, (0, YAMNET_SAMPLES_PER_FRAME - len(chunk)))

            scores = await detector.detect(chunk)
            for label, score in scores:
                if label not in all_scores or score > all_scores[label]:
                    all_scores[label] = score

        # Filter by configured listen labels
        listen_labels: list[str] = config.get("listen_labels", DEFAULT_LISTEN_LABELS)
        threshold: float = config.get("threshold", DEFAULT_THRESHOLD)
        listen_set = set(listen_labels)
        detections: list[Detection] = []

        for label, score in all_scores.items():
            if label in listen_set and score >= threshold:
                mapped_label = YAMNET_TO_LABEL.get(label, label)
                detections.append(
                    {
                        "label": "audio",
                        "confidence": score,
                        "box": {"x": 0, "y": 0, "width": 1, "height": 1},
                        "attribute": mapped_label,
                    }
                )

        return {
            "detected": len(detections) > 0,
            "detections": detections,
            "decibels": dbfs,
        }

    async def detectAudio(
        self, audio: AudioFrameData, config: dict[str, Any] | None = None
    ) -> AudioDetectionPluginResponse | None:
        detector = self.audio_detectors.get("test")
        if not detector:
            detector = AudioDetector(self.api, self.logger)
            self.audio_detectors["test"] = detector

        await detector.initialize()

        cfg = config or {}
        listen_labels: list[str] = cfg.get("listen_labels", DEFAULT_LISTEN_LABELS)
        threshold: float = cfg.get("threshold", DEFAULT_THRESHOLD)
        listen_set = set(listen_labels)

        # AudioFrameData provides raw samples directly
        fmt = audio.get("format", "float32")
        if fmt == "pcm16":
            waveform: np.ndarray[Any, Any] = (
                np.frombuffer(audio["data"], dtype=np.int16).astype(np.float32) / 32768.0
            )
        else:
            waveform = np.frombuffer(audio["data"], dtype=np.float32)

        # Calculate dBFS
        rms = float(np.sqrt(np.mean(waveform**2)))
        dbfs = 20 * math.log10(max(rms, 1e-10)) if rms > 0 else -100.0

        all_scores: dict[str, float] = {}
        for start in range(0, len(waveform), YAMNET_SAMPLES_PER_FRAME):
            chunk = waveform[start : start + YAMNET_SAMPLES_PER_FRAME]
            if len(chunk) < YAMNET_SAMPLES_PER_FRAME:
                chunk = np.pad(chunk, (0, YAMNET_SAMPLES_PER_FRAME - len(chunk)))

            scores = await detector.detect(chunk)
            for label, score in scores:
                if label not in all_scores or score > all_scores[label]:
                    all_scores[label] = score

        detections: list[Detection] = []
        for label, score in all_scores.items():
            if label in listen_set and score >= threshold:
                mapped_label = YAMNET_TO_LABEL.get(label, label)
                detections.append(
                    {
                        "label": "audio",
                        "confidence": score,
                        "box": {"x": 0, "y": 0, "width": 1, "height": 1},
                        "attribute": mapped_label,
                    }
                )

        return {
            "detected": len(detections) > 0,
            "detections": detections,
            "decibels": dbfs,
        }


def __main__() -> type[YAMNetPlugin]:
    return YAMNetPlugin
