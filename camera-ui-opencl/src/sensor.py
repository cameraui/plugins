from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import suppress
from typing import Any, TypedDict

import numpy as np
from camera_ui_sdk import (
    CameraDevice,
    JsonSchema,
    MotionDetectorSensor,
    MotionResult,
    VideoFrameData,
)

from detector_defaults import (
    DEFAULT_ALPHA,
    DEFAULT_AREA,
    DEFAULT_BLUR,
    DEFAULT_DILT,
    DEFAULT_THRESHOLD,
)
from opencl_detector import OpenCLMotionDetector, create_program


class OpenCLStorageValues(TypedDict):
    area: int
    threshold: float
    blur: int
    dilation: int


class OpenCLMotionSensor(MotionDetectorSensor[OpenCLStorageValues]):
    def __init__(self, camera_device: CameraDevice, name: str = "OpenCL Motion") -> None:
        super().__init__(name)

        self._camera_device = camera_device
        self._opencl_ctx: tuple[Any, Any, Any] | None = None
        self._opencl_detector: OpenCLMotionDetector | None = None
        self._executor: ThreadPoolExecutor | None = None
        self._is_available = False

        with suppress(Exception):
            self._opencl_ctx = create_program()
            self._is_available = True

    @property
    def storage_schema(self) -> list[JsonSchema]:
        return [
            {
                "type": "number",
                "key": "area",
                "title": "Area",
                "description": "Minimum size of detected motion (pixels)",
                "store": True,
                "defaultValue": DEFAULT_AREA,
                "minimum": 10,
                "maximum": 1000,
                "step": 1,
                "required": True,
            },
            {
                "type": "number",
                "key": "threshold",
                "title": "Threshold",
                "description": "Sensitivity of motion detection (0-1, higher = less sensitive)",
                "store": True,
                "defaultValue": DEFAULT_THRESHOLD,
                "minimum": 0,
                "maximum": 1,
                "step": 0.01,
                "required": True,
            },
            {
                "type": "number",
                "key": "blur",
                "title": "Blur",
                "description": "Gaussian blur radius to reduce noise",
                "store": True,
                "defaultValue": DEFAULT_BLUR,
                "minimum": 1,
                "maximum": 21,
                "step": 2,
                "required": True,
            },
            {
                "type": "number",
                "key": "dilation",
                "title": "Dilation",
                "description": "Expansion of detected motion areas",
                "store": True,
                "defaultValue": DEFAULT_DILT,
                "minimum": 1,
                "maximum": 21,
                "step": 2,
                "required": True,
            },
            {
                "type": "button",
                "key": "reset_defaults",
                "title": "Reset to Defaults",
                "description": "Reset motion detection settings to default",
                "color": "danger",
                "onSet": self._reset_to_defaults,
            },
        ]

    @property
    def isAvailable(self) -> bool:
        return self._is_available

    async def detectMotion(self, frame: VideoFrameData) -> MotionResult:
        if not self._opencl_ctx:
            return {"detected": False, "detections": []}

        current_frame: np.ndarray[Any, Any] = np.frombuffer(frame["data"], dtype=np.uint8).reshape(
            (frame["height"], frame["width"])
        )

        width = frame["width"]
        height = frame["height"]

        if self._executor is None:
            self._executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="OpenCL")

        loop = asyncio.get_event_loop()

        if self._opencl_detector is None:
            self._opencl_detector = await loop.run_in_executor(
                self._executor,
                OpenCLMotionDetector,
                self._opencl_ctx,
                width,
                height,
                self.storage.values["blur"],
                self._camera_device.logger,
            )

        detections = await loop.run_in_executor(
            self._executor,
            self._opencl_detector.process_frame,
            current_frame,
            self.storage.values["threshold"],
            self.storage.values["dilation"],
            self.storage.values["area"],
            DEFAULT_ALPHA,
        )

        return {
            "detected": len(detections) > 0,
            "detections": [
                {
                    "label": "motion",
                    "confidence": 1.0,
                    "box": {
                        "x": det[0] / width,
                        "y": det[1] / height,
                        "width": (det[2] - det[0]) / width,
                        "height": (det[3] - det[1]) / height,
                    },
                }
                for det in detections
            ],
        }

    def resetState(self) -> None:
        self._opencl_detector = None
        if self._executor:
            self._executor.shutdown(wait=False)
            self._executor = None

    def on_deassigned(self) -> None:
        self.resetState()

    async def _reset_to_defaults(self) -> None:
        if self.storage:
            await self.storage.setValue("area", DEFAULT_AREA)
            await self.storage.setValue("threshold", DEFAULT_THRESHOLD)
            await self.storage.setValue("blur", DEFAULT_BLUR)
            await self.storage.setValue("dilation", DEFAULT_DILT)
