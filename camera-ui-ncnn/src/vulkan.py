from __future__ import annotations

import ctypes
import functools
import sys
from typing import Any

import ncnn

_VK_DEVICE_TYPE_CPU = 3
_VK_VENDOR_BROADCOM = 0x14E4  # raspberry pi's v3d, inference there is about 30x slower than on its cpu


@functools.cache
def gpu_count() -> int:
    if sys.platform == "linux":
        try:
            ctypes.CDLL("libvulkan.so.1")
        except OSError:
            return 0
    count = int(ncnn.get_gpu_count())
    return sum(1 for i in range(count) if _usable(ncnn.get_gpu_info(i)))


@functools.cache
def gpu_devices() -> list[tuple[int, str]]:
    if gpu_count() == 0:
        return []
    devices: list[tuple[int, str]] = []
    for i in range(int(ncnn.get_gpu_count())):
        info = ncnn.get_gpu_info(i)
        if not _usable(info):
            continue
        try:
            name = str(info.device_name())
        except Exception:
            name = f"GPU {i}"
        devices.append((i, name))
    return devices


def _usable(info: Any) -> bool:
    return int(info.type()) != _VK_DEVICE_TYPE_CPU and int(info.vendor_id()) != _VK_VENDOR_BROADCOM
