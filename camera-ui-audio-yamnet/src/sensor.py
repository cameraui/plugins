from __future__ import annotations

import math
from typing import TYPE_CHECKING, Any

import numpy as np
from camera_ui_sdk import (
    AudioDetectorSensor,
    AudioFrameData,
    AudioModelSpec,
    AudioResult,
)

from defaults import (
    DEFAULT_LISTEN_LABELS,
    DEFAULT_THRESHOLD,
    YAMNET_CHANNELS,
    YAMNET_FORMAT,
    YAMNET_SAMPLE_RATE,
    YAMNET_SAMPLES_PER_FRAME,
)
from detector import AudioDetector, build_detections

if TYPE_CHECKING:
    from camera_ui_sdk import CameraDevice, LoggerService, ModelRuntime, PluginAPI


class YAMNetAudioSensor(AudioDetectorSensor):
    def __init__(
        self,
        api: PluginAPI,
        logger: LoggerService,
        camera: CameraDevice,
        name: str = "YAMNet Audio",
    ) -> None:
        super().__init__(name)

        self._api = api
        self._logger = logger
        self._camera = camera
        self._detector: AudioDetector | None = None
        self._listen_set: set[str] = set(DEFAULT_LISTEN_LABELS)
        self._frame_count: int = 0

    @property
    def modelSpec(self) -> AudioModelSpec:
        runtime: ModelRuntime = self._detector.model_runtime() if self._detector else {}
        return {
            "input": {
                "sampleRate": YAMNET_SAMPLE_RATE,
                "channels": YAMNET_CHANNELS,
                "format": YAMNET_FORMAT,
                "samplesPerFrame": YAMNET_SAMPLES_PER_FRAME,
            },
            **runtime,
        }

    async def detectAudio(self, audio: AudioFrameData) -> AudioResult:
        if self._detector is None or not self._detector.initialized:
            return {"detected": False, "detections": []}

        waveform: np.ndarray[Any, Any] = np.frombuffer(audio["data"], dtype=np.float32)

        self._frame_count += 1

        rms = float(np.sqrt(np.mean(waveform**2)))
        dbfs = 20 * math.log10(max(rms, 1e-10)) if rms > 0 else -100.0

        scores = await self._detector.detect(waveform)

        detections = build_detections(scores, self._listen_set, self._confidence())

        if detections:
            det_str = ", ".join(f"{d.get('attribute', d['label'])}={d['confidence']:.3f}" for d in detections)
            self._logger.log(f"Audio detected: [{det_str}]")

        return {
            "detected": len(detections) > 0,
            "detections": detections,
            "decibels": dbfs,
        }

    async def destroy(self) -> None:
        if self._detector:
            await self._detector.close()
            self._detector = None

    async def on_start(self) -> None:
        try:
            self._detector = AudioDetector(self._api, self._logger)
            await self._detector.initialize()
            self.updateModelSpec()
        except Exception as e:
            self._logger.error(f"Failed to initialize audio detector: {e}")

    async def on_stop(self) -> None:
        if self._detector:
            await self._detector.close()
            self._detector = None

    def _confidence(self) -> float:
        settings = self._camera.detectionSettings.get("audio") or {}
        value = settings.get("confidence")
        return float(value) if value is not None else DEFAULT_THRESHOLD
