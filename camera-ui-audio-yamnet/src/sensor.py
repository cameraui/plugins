from __future__ import annotations

import math
from typing import TYPE_CHECKING, Any, TypedDict

import numpy as np
from camera_ui_sdk import (
    AudioDetectorSensor,
    AudioFrameData,
    AudioModelSpec,
    AudioResult,
    JsonSchema,
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
    from camera_ui_sdk import LoggerService, PluginAPI


class YAMNetStorageValues(TypedDict):
    listen_labels: list[str]
    threshold: float


class YAMNetAudioSensor(AudioDetectorSensor[YAMNetStorageValues]):
    def __init__(
        self,
        api: PluginAPI,
        logger: LoggerService,
        available_labels: list[str],
        name: str = "YAMNet Audio",
    ) -> None:
        super().__init__(name)

        self._api = api
        self._logger = logger
        self._detector: AudioDetector | None = None
        self._available_labels = available_labels
        self._listen_set: set[str] = set(DEFAULT_LISTEN_LABELS)
        self._threshold: float = DEFAULT_THRESHOLD
        self._frame_count: int = 0

    @property
    def storage_schema(self) -> list[JsonSchema]:
        return [
            {
                "type": "string",
                "key": "listen_labels",
                "title": "Listen Labels",
                "description": "Audio event classes to detect",
                "group": "Detection",
                "store": True,
                "defaultValue": DEFAULT_LISTEN_LABELS,
                "enum": self._available_labels if self._available_labels else DEFAULT_LISTEN_LABELS,
                "multiple": True,
                "onSet": self._on_change_labels,
            },
            {
                "type": "number",
                "key": "threshold",
                "title": "Confidence Threshold",
                "description": "Minimum confidence for detections (0-1)",
                "group": "Detection",
                "store": True,
                "defaultValue": DEFAULT_THRESHOLD,
                "minimum": 0.1,
                "maximum": 1.0,
                "step": 0.05,
                "required": True,
                "onSet": self._on_change_threshold,
            },
            {
                "type": "button",
                "key": "reset_settings",
                "title": "Reset to Defaults",
                "description": "Reset all settings to default values",
                "color": "danger",
                "group": "Detection",
                "onSet": self._reset_settings,
            },
        ]

    @property
    def modelSpec(self) -> AudioModelSpec:
        return {
            "input": {
                "sampleRate": YAMNET_SAMPLE_RATE,
                "channels": YAMNET_CHANNELS,
                "format": YAMNET_FORMAT,
                "samplesPerFrame": YAMNET_SAMPLES_PER_FRAME,
            },
        }

    async def detectAudio(self, audio: AudioFrameData) -> AudioResult:
        if self._detector is None or not self._detector.initialized:
            return {"detected": False, "detections": []}

        waveform: np.ndarray[Any, Any] = np.frombuffer(audio["data"], dtype=np.float32)

        self._frame_count += 1

        rms = float(np.sqrt(np.mean(waveform**2)))
        dbfs = 20 * math.log10(max(rms, 1e-10)) if rms > 0 else -100.0

        scores = await self._detector.detect(waveform)

        detections = build_detections(scores, self._listen_set, self._threshold)

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

    async def on_assigned(self) -> None:
        listen_labels = self.storage.values.get("listen_labels", DEFAULT_LISTEN_LABELS)
        self._listen_set = set(listen_labels)
        self._threshold = self.storage.values.get("threshold", DEFAULT_THRESHOLD)

        try:
            self._detector = AudioDetector(self._api, self._logger)
            await self._detector.initialize()

            if self._detector.labels:
                self._available_labels.clear()
                self._available_labels.extend(self._detector.labels)
        except Exception as e:
            self._logger.error(f"Failed to initialize audio detector: {e}")

    async def on_deassigned(self) -> None:
        if self._detector:
            await self._detector.close()
            self._detector = None

    async def _on_change_labels(self, new_labels: list[str], _old_labels: list[str]) -> None:
        self._listen_set = set(new_labels)

    async def _on_change_threshold(self, new_threshold: float, _old_threshold: float) -> None:
        self._threshold = new_threshold

    async def _reset_settings(self) -> None:
        if self.storage:
            await self.storage.setValue("listen_labels", DEFAULT_LISTEN_LABELS)
            await self.storage.setValue("threshold", DEFAULT_THRESHOLD)
