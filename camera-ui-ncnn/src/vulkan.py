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
