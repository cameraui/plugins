import os
from typing import Any, cast

import numpy as np
import pyopencl as cl
from camera_ui_sdk import LoggerService

from opencl_utils import get_contour_detections


def create_program(device_selector: str | None = None) -> tuple[Any, Any, Any]:
    platforms = cast(Any, cl.get_platforms())

    if len(platforms) == 0:
        raise RuntimeError("Failed to find any OpenCL platforms.")

    device = None
    if device_selector and device_selector != "auto":
        # "platform:device" index pair; anything unusable falls back to auto
        try:
            platform_index, device_index = (int(part) for part in device_selector.split(":", 1))
            device = platforms[platform_index].get_devices()[device_index]
        except Exception:
            device = None

    if device is None:
        devices = platforms[0].get_devices(cl.device_type.GPU)
        if len(devices) == 0:
            devices = platforms[0].get_devices(cl.device_type.CPU)
            if len(devices) == 0:
                raise RuntimeError("Could not find OpenCL GPU or CPU device.")
        device = devices[0]

    context = cast(Any, cl.Context([device]))

    current_dir = os.path.dirname(os.path.abspath(__file__))
    full_path = os.path.join(current_dir, "opencl.cl")

    with open(full_path) as kernelFile:
        kernelStr = kernelFile.read()

    program = cl.Program(context, kernelStr)
    program.build(devices=[device])

    return context, device, program


class OpenCLMotionDetector:
    def __init__(
        self,
        ctx: tuple[Any, Any, Any],
        width: int,
        height: int,
        blur_radius: int,
        camera_logger: LoggerService,
    ):
        self.camera_logger = camera_logger
        self.width = width
        self.height = height

        self.ctx: Any = ctx[0]
        self.device: Any = ctx[1]
        self.program: Any = ctx[2]
        self.queue: Any = cl.CommandQueue(self.ctx, properties=cl.command_queue_properties.PROFILING_ENABLE)

        mf = cast(Any, cl.mem_flags)

        self.input_image: Any = cl.Image(
            self.ctx,
            mf.READ_ONLY,
            cl.ImageFormat(cl.channel_order.R, cl.channel_type.UNORM_INT8),
            shape=(self.width, self.height),
        )
        self.result_image: Any = cl.Image(
            self.ctx,
            mf.WRITE_ONLY,
            cl.ImageFormat(cl.channel_order.R, cl.channel_type.FLOAT),
            shape=(self.width, self.height),
        )
        self.background_model_buf: Any = cl.Buffer(
            self.ctx, mf.READ_WRITE, size=self.width * self.height * np.dtype(np.float32).itemsize
        )
        self.temp_buffer: Any = cl.Buffer(
            self.ctx, mf.READ_WRITE, size=self.width * self.height * np.dtype(np.float32).itemsize
        )

        self.host_result_buffer = np.zeros((self.height, self.width), dtype=np.float32)

        self.kernel = self.__create_gaussian_kernel(blur_radius)
        self.kernel_buf: Any = cl.Buffer(self.ctx, mf.READ_ONLY | mf.COPY_HOST_PTR, hostbuf=self.kernel)
        self.kernel_size = np.int32(len(self.kernel))

        max_work_group_size = self.device.get_info(cl.device_info.MAX_WORK_GROUP_SIZE)
        compute_units = self.device.get_info(cl.device_info.MAX_COMPUTE_UNITS)

        self.local_size = self.__get_optimal_work_group_size(max_work_group_size, compute_units)
        self.global_size = (
            ((self.width + self.local_size[0] - 1) // self.local_size[0]) * self.local_size[0],
            ((self.height + self.local_size[1] - 1) // self.local_size[1]) * self.local_size[1],
        )

        self.first_frame = True

        self.process_frame_kernel: Any = cl.Kernel(self.program, "process_frame")

        self.camera_logger.debug(
            {
                "device_name": self.device.name,
                "opencl_version": self.device.version,
                "compute_units": compute_units,
                "local_work_group_size": self.local_size,
            },
        )

    def process_frame(
        self,
        gray_frame: np.ndarray[Any, Any],
        motion_threshold: float,
        dilation_size: int,
        area_threshold: int,
        alpha: float,
    ) -> list[tuple[float, float, float, float]]:
        cl.enqueue_copy(
            self.queue,
            self.input_image,
            gray_frame,
            origin=(0, 0),
            region=(self.width, self.height),
        )

        self.process_frame_kernel.set_args(
            self.input_image,
            self.background_model_buf,
            self.temp_buffer,
            self.result_image,
            self.kernel_buf,
            self.kernel_size,
            np.int32(self.width),
            np.int32(self.height),
            np.float32(alpha),
            np.float32(motion_threshold),
            np.int32(dilation_size),
            np.int32(self.first_frame),
        )
        event = cast(
            Any,
            cl.enqueue_nd_range_kernel(
                self.queue,
                self.process_frame_kernel,
                self.global_size,
                self.local_size,
            ),
        )

        cl.enqueue_copy(
            self.queue,
            self.host_result_buffer,
            self.result_image,
            origin=(0, 0),
            region=(self.width, self.height),
            wait_for=[event],
        )

        motion_mask_cv = (self.host_result_buffer * 255).astype(np.uint8)
        detections = get_contour_detections(motion_mask_cv, area_threshold)

        self.first_frame = False
        return detections

    def __get_optimal_work_group_size(self, max_group: int, compute_units: int) -> tuple[int, int]:
        optimal_group_count = compute_units * 4

        for size in [32, 16, 8, 4]:
            work_groups_per_dimension = (self.width // size) * (self.height // size)
            if (
                self.width % size == 0
                and self.height % size == 0
                and size * size <= max_group
                and work_groups_per_dimension >= optimal_group_count
            ):
                return (size, size)

        return (min(max_group, self.width), 1)

    def __create_gaussian_kernel(self, radius: int) -> np.ndarray[Any, Any]:
        sigma = radius / 3.0
        x = np.arange(-radius, radius + 1)
        kernel = np.exp(-(x**2) / (2 * sigma**2))
        gaussian_kernel: np.ndarray[Any, Any] = (kernel / np.sum(kernel)).astype(np.float32)
        return gaussian_kernel

    def __del__(self) -> None:
        self.queue.finish()
