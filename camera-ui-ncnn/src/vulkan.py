from __future__ import annotations

import ctypes
import functools
import sys

import ncnn

_VK_DEVICE_TYPE_CPU = 3


@functools.cache
def gpu_count() -> int:
    if sys.platform == "linux":
        try:
            ctypes.CDLL("libvulkan.so.1")
        except OSError:
            return 0
    count = int(ncnn.get_gpu_count())
    return sum(1 for i in range(count) if ncnn.get_gpu_info(i).type() != _VK_DEVICE_TYPE_CPU)


@functools.cache
def gpu_devices() -> list[tuple[int, str]]:
    if gpu_count() == 0:
        return []
    devices: list[tuple[int, str]] = []
    for i in range(int(ncnn.get_gpu_count())):
        info = ncnn.get_gpu_info(i)
        if info.type() == _VK_DEVICE_TYPE_CPU:
            continue
        try:
            name = str(info.device_name())
        except Exception:
            name = f"GPU {i}"
        devices.append((i, name))
    return devices
