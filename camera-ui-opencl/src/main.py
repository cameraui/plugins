from __future__ import annotations

import asyncio
import io
import os
import tempfile
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import cv2
import numpy as np
import pyopencl as cl
from camera_ui_sdk import (
    API_EVENT,
    BasePlugin,
    CameraDevice,
    Detection,
    DeviceStorage,
    JsonSchema,
    LoggerService,
    MotionDetectionInterface,
    MotionDetectionPluginResponse,
    PluginAPI,
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
from sensor import OpenCLMotionSensor


class OpenCL(BasePlugin, MotionDetectionInterface):
    def __init__(self, logger: LoggerService, api: PluginAPI, storage: DeviceStorage) -> None:
        super().__init__(logger, api, storage)
        self._log_available_devices()

        self.sensors: dict[str, OpenCLMotionSensor] = {}
        self.motion_detection_running = False

        # self.api.on(API_EVENT.FINISH_LAUNCHING, self.on_finish_launching)
        self.api.on(API_EVENT.SHUTDOWN, self.on_shutdown)

    async def on_shutdown(self) -> None:
        for sensor in self.sensors.values():
            sensor.resetState()

        self.sensors.clear()

    async def configureCameras(self, cameras: list[CameraDevice]) -> None:
        for camera in cameras:
            await self.add_sensor_to_camera(camera)

    async def onCameraAdded(self, camera: CameraDevice) -> None:
        await self.add_sensor_to_camera(camera)

    async def onCameraReleased(self, cameraId: str) -> None:
        sensor = self.sensors.get(cameraId)
        if sensor:
            sensor.resetState()
            del self.sensors[cameraId]

    async def add_sensor_to_camera(self, camera: CameraDevice) -> None:
        sensor = OpenCLMotionSensor(camera)

        if not sensor.isAvailable:
            self.logger.error("OpenCL is not available on this system")
            return

        await camera.addSensor(sensor)

        self.sensors[camera.id] = sensor

    async def motionDetectionSettings(self) -> list[JsonSchema] | None:
        schemas: list[JsonSchema] = [
            {
                "type": "number",
                "key": "area",
                "title": "Area",
                "description": "Minimum size of detected motion (pixels)",
                "store": False,
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
                "description": "Sensitivity of motion detection (higher = less sensitive)",
                "store": False,
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
                "store": False,
                "defaultValue": DEFAULT_BLUR,
                "minimum": 1,
                "maximum": 21,
                "step": 1,
                "required": True,
            },
            {
                "type": "number",
                "key": "dilation",
                "title": "Dilation",
                "description": "Expansion of detected motion areas",
                "store": False,
                "defaultValue": DEFAULT_DILT,
                "minimum": 1,
                "maximum": 21,
                "step": 1,
                "required": True,
            },
        ]

        return schemas

    async def testMotionDetection(
        self, video_data: bytes, config: dict[str, Any]
    ) -> MotionDetectionPluginResponse:
        if self.motion_detection_running:
            raise Exception("Motion detection already running")

        self.motion_detection_running = True

        ctx = create_program()

        input_buffer = io.BytesIO(video_data)

        temp_input = os.path.join(tempfile.gettempdir(), f"input_{uuid.uuid4()}.mp4")
        temp_output = os.path.join(tempfile.gettempdir(), f"output_{uuid.uuid4()}.mp4")

        detections: list[Detection] = []

        try:
            with open(temp_input, "wb") as f:
                f.write(input_buffer.getvalue())

            input_buffer.close()
            del input_buffer

            cap = cv2.VideoCapture(temp_input)

            width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
            fps = int(cap.get(cv2.CAP_PROP_FPS))

            fourcc = cv2.VideoWriter.fourcc("a", "v", "c", "1")
            out = cv2.VideoWriter(temp_output, fourcc, fps, (width, height), True)

            blur = config.get("blur", DEFAULT_BLUR)
            threshold = config.get("threshold", DEFAULT_THRESHOLD)
            area = config.get("area", DEFAULT_AREA)
            dilation = config.get("dilation", DEFAULT_DILT)

            opencl_detector = OpenCLMotionDetector(ctx, width, height, blur, self.logger)

            executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="OpenCV")

            try:
                while cap.isOpened():
                    ret, frame = cap.read()
                    if not ret:
                        break

                    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

                    dets = await asyncio.get_event_loop().run_in_executor(
                        executor,
                        opencl_detector.process_frame,
                        gray,
                        threshold,
                        dilation,
                        area,
                        DEFAULT_ALPHA,
                    )

                    for x1, y1, x2, y2 in dets:
                        detections.append(
                            {
                                "label": "motion",
                                "confidence": 1.0,
                                "box": {
                                    "x": x1 / width,
                                    "y": y1 / height,
                                    "width": (x2 - x1) / width,
                                    "height": (y2 - y1) / height,
                                },
                            }
                        )

                    for x1, y1, x2, y2 in dets:
                        pt1: cv2.typing.Point = (int(x1), int(y1))
                        pt2: cv2.typing.Point = (int(x2), int(y2))
                        cv2.rectangle(frame, pt1, pt2, (0, 255, 0), 2)

                    out.write(frame)

                    del frame

            finally:
                cap.release()
                out.release()
                executor.shutdown()
                del opencl_detector

            with open(temp_output, "rb") as f:
                result_bytes = f.read()

            return {
                "detected": len(detections) > 0,
                "detections": detections,
                "videoData": result_bytes,
            }

        finally:
            self.motion_detection_running = False

            for temp_file in (temp_input, temp_output):
                try:
                    if os.path.exists(temp_file):
                        os.unlink(temp_file)
                except Exception as e:
                    self.logger.error(f"Error cleaning up {temp_file}: {e}")

    async def detectMotion(
        self, frames: list[VideoFrameData], config: dict[str, Any] | None = None
    ) -> MotionDetectionPluginResponse | None:
        if not frames:
            return {"detected": False, "detections": []}

        cfg = config or {}
        blur = cfg.get("blur", DEFAULT_BLUR)
        threshold = cfg.get("threshold", DEFAULT_THRESHOLD)
        area = cfg.get("area", DEFAULT_AREA)
        dilation = cfg.get("dilation", DEFAULT_DILT)

        width, height = frames[0]["width"], frames[0]["height"]

        ctx = create_program()
        opencl_detector = OpenCLMotionDetector(ctx, width, height, blur, self.logger)
        executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="OpenCL")

        all_detections: list[Detection] = []

        try:
            for frame in frames:
                gray: np.ndarray[Any, Any] = np.frombuffer(frame["data"], dtype=np.uint8).reshape(
                    (frame["height"], frame["width"])
                )

                dets = await asyncio.get_event_loop().run_in_executor(
                    executor,
                    opencl_detector.process_frame,
                    gray,
                    threshold,
                    dilation,
                    area,
                    DEFAULT_ALPHA,
                )

                for x1, y1, x2, y2 in dets:
                    all_detections.append(
                        {
                            "label": "motion",
                            "confidence": 1.0,
                            "box": {
                                "x": x1 / width,
                                "y": y1 / height,
                                "width": (x2 - x1) / width,
                                "height": (y2 - y1) / height,
                            },
                        }
                    )
        finally:
            executor.shutdown(wait=False)
            del opencl_detector

        return {"detected": len(all_detections) > 0, "detections": all_detections}

    def _log_available_devices(self) -> None:
        try:
            platforms = cl.get_platforms()
        except Exception:
            platforms = []
        if not platforms:
            self.logger.warn(
                "No OpenCL platform found — install an OpenCL ICD / GPU driver, motion detection cannot start"
            )
            return
        described = "; ".join(
            f"{p.name}: {', '.join(d.name for d in p.get_devices()) or 'no devices'}" for p in platforms
        )
        self.logger.log(f"Available OpenCL devices: {described}")


def __main__() -> type[OpenCL]:
    return OpenCL
