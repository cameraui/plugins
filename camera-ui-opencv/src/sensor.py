from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from typing import Any, TypedDict

import cv2
import numpy as np
from camera_ui_sdk import (
    JsonSchema,
    MotionDetectorSensor,
    MotionResult,
    VideoFrameData,
)

from detector_defaults import (
    AVAILABLE_MODELS,
    DEFAULT_AREA,
    DEFAULT_AREA_BS,
    DEFAULT_AREA_FD,
    DEFAULT_BLUR,
    DEFAULT_DILT,
    DEFAULT_LEARNING_RATE,
    DEFAULT_MODEL,
    DEFAULT_THRESHOLD,
    DEFAULT_THRESHOLD_BS,
)
from opencv_utils import get_detections, get_detections_bs, get_detections_fd


class OpenCVStorageValues(TypedDict):
    motion_detector: str
    default_area: int
    default_threshold: int
    default_blur: int
    default_dilation: int
    background_substraction_area: int
    background_substraction_threshold: int
    background_substraction_learning_rate: float
    frame_difference_area: int


class OpenCVMotionSensor(MotionDetectorSensor[OpenCVStorageValues]):
    def __init__(self, name: str = "OpenCV Motion") -> None:
        super().__init__(name)

        self._prev_frame: np.ndarray[Any, Any] | None = None
        self._back_sub: cv2.BackgroundSubtractorMOG2 | None = None
        self._executor: ThreadPoolExecutor | None = None

    @property
    def storage_schema(self) -> list[JsonSchema]:
        return [
            {
                "type": "string",
                "key": "motion_detector",
                "title": "Motion Detector",
                "description": "Select the motion detection model to use",
                "group": "Manage",
                "enum": AVAILABLE_MODELS,
                "store": True,
                "defaultValue": DEFAULT_MODEL,
                "required": True,
            },
            {
                "type": "button",
                "key": "reset_all",
                "title": "Reset All Settings",
                "description": "Reset all motion detection settings to default",
                "color": "danger",
                "group": "Manage",
                "onSet": self._reset_all_settings,
            },
            {
                "type": "number",
                "key": "default_area",
                "title": "Area",
                "description": "Minimum size of detected motion (pixels)",
                "store": True,
                "defaultValue": DEFAULT_AREA,
                "minimum": 10,
                "maximum": 1000,
                "step": 1,
                "required": True,
                "group": "Default",
            },
            {
                "type": "number",
                "key": "default_threshold",
                "title": "Threshold",
                "description": "Sensitivity of motion detection (higher = less sensitive)",
                "store": True,
                "defaultValue": DEFAULT_THRESHOLD,
                "minimum": 1,
                "maximum": 255,
                "step": 1,
                "required": True,
                "group": "Default",
            },
            {
                "type": "number",
                "key": "default_blur",
                "title": "Blur",
                "description": "Gaussian blur radius to reduce noise",
                "store": True,
                "defaultValue": DEFAULT_BLUR,
                "minimum": 1,
                "maximum": 21,
                "step": 2,
                "required": True,
                "group": "Default",
            },
            {
                "type": "number",
                "key": "default_dilation",
                "title": "Dilation",
                "description": "Expansion of detected motion areas",
                "store": True,
                "defaultValue": DEFAULT_DILT,
                "minimum": 1,
                "maximum": 21,
                "step": 1,
                "required": True,
                "group": "Default",
            },
            {
                "type": "button",
                "key": "reset_default",
                "title": "Reset Default Settings",
                "description": "Reset Default model settings to default",
                "color": "danger",
                "group": "Default",
                "onSet": self._reset_default_settings,
            },
            {
                "type": "number",
                "key": "background_substraction_area",
                "title": "Area",
                "description": "Minimum size of detected motion (pixels)",
                "store": True,
                "defaultValue": DEFAULT_AREA_BS,
                "minimum": 10,
                "maximum": 1000,
                "step": 1,
                "required": True,
                "group": "Background Substraction",
            },
            {
                "type": "number",
                "key": "background_substraction_threshold",
                "title": "Threshold",
                "description": "Sensitivity of motion detection (higher = less sensitive)",
                "store": True,
                "defaultValue": DEFAULT_THRESHOLD_BS,
                "minimum": 1,
                "maximum": 255,
                "step": 1,
                "required": True,
                "group": "Background Substraction",
            },
            {
                "type": "number",
                "key": "background_substraction_learning_rate",
                "title": "Learning Rate",
                "description": "Speed of background model adaptation (0-1, -1 for auto)",
                "store": True,
                "defaultValue": DEFAULT_LEARNING_RATE,
                "minimum": -1,
                "maximum": 1,
                "step": 0.01,
                "required": True,
                "group": "Background Substraction",
            },
            {
                "type": "button",
                "key": "reset_background_substraction",
                "title": "Reset BS Settings",
                "description": "Reset Background Substraction settings to default",
                "color": "danger",
                "group": "Background Substraction",
                "onSet": self._reset_bs_settings,
            },
            {
                "type": "number",
                "key": "frame_difference_area",
                "title": "Area",
                "description": "Minimum size of detected motion (pixels)",
                "store": True,
                "defaultValue": DEFAULT_AREA_FD,
                "minimum": 10,
                "maximum": 1000,
                "step": 1,
                "required": True,
                "group": "Frame Difference",
            },
            {
                "type": "button",
                "key": "reset_frame_difference",
                "title": "Reset FD Settings",
                "description": "Reset Frame Difference settings to default",
                "color": "danger",
                "group": "Frame Difference",
                "onSet": self._reset_fd_settings,
            },
        ]

    async def detectMotion(self, frame: VideoFrameData) -> MotionResult:
        current_frame: np.ndarray[Any, Any] = np.frombuffer(frame["data"], dtype=np.uint8).reshape(
            (frame["height"], frame["width"])
        )

        if self._executor is None:
            self._executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="OpenCV")

        loop = asyncio.get_event_loop()
        detections: list[tuple[float, float, float, float]] = []

        if self.storage.values["motion_detector"] == "Frame Difference":
            if self._prev_frame is None:
                self._prev_frame = current_frame
                return {"detected": False, "detections": []}

            detections = await loop.run_in_executor(
                self._executor,
                get_detections_fd,
                self._prev_frame,
                current_frame,
                self.storage.values["frame_difference_area"],
            )
            self._prev_frame = current_frame

        elif self.storage.values["motion_detector"] == "Background Substraction":
            if self._back_sub is None:
                self._back_sub = cv2.createBackgroundSubtractorMOG2(varThreshold=18, detectShadows=False)

            detections = await loop.run_in_executor(
                self._executor,
                get_detections_bs,
                current_frame,
                self._back_sub,
                self.storage.values["background_substraction_threshold"],
                self.storage.values["background_substraction_area"],
                self.storage.values["background_substraction_learning_rate"],
            )

        else:
            blur = self.storage.values["default_blur"]
            if blur % 2 == 0:
                blur += 1

            blurred_frame: np.ndarray[Any, Any] = cv2.stackBlur(current_frame, (blur, blur))

            if self._prev_frame is None:
                self._prev_frame = blurred_frame
                return {"detected": False, "detections": []}

            detections = await loop.run_in_executor(
                self._executor,
                get_detections,
                self._prev_frame,
                blurred_frame,
                self.storage.values["default_threshold"],
                self.storage.values["default_area"],
            )
            self._prev_frame = blurred_frame

        width = frame["width"]
        height = frame["height"]

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
        self._prev_frame = None
        self._back_sub = None
        if self._executor:
            self._executor.shutdown(wait=False)
            self._executor = None

    def on_deassigned(self) -> None:
        self.resetState()

    async def _reset_all_settings(self) -> None:
        if self.storage:
            await self.storage.setValue("motion_detector", DEFAULT_MODEL)
            await self._reset_default_settings()
            await self._reset_bs_settings()
            await self._reset_fd_settings()

    async def _reset_default_settings(self) -> None:
        if self.storage:
            await self.storage.setValue("default_area", DEFAULT_AREA)
            await self.storage.setValue("default_threshold", DEFAULT_THRESHOLD)
            await self.storage.setValue("default_blur", DEFAULT_BLUR)
            await self.storage.setValue("default_dilation", DEFAULT_DILT)

    async def _reset_bs_settings(self) -> None:
        if self.storage:
            await self.storage.setValue("background_substraction_area", DEFAULT_AREA_BS)
            await self.storage.setValue("background_substraction_threshold", DEFAULT_THRESHOLD_BS)
            await self.storage.setValue("background_substraction_learning_rate", DEFAULT_LEARNING_RATE)
        self._back_sub = None

    async def _reset_fd_settings(self) -> None:
        if self.storage:
            await self.storage.setValue("frame_difference_area", DEFAULT_AREA_FD)
