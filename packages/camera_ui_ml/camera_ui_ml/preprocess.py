from __future__ import annotations

import io
from typing import Any

import numpy as np
from PIL import Image

from .backend import InputSpec
from .geometry import Box

NDArray = np.ndarray[Any, Any]


def frame_to_rgb(data: bytes, width: int, height: int, fmt: str = "rgb") -> NDArray:
    pixels = np.frombuffer(data, dtype=np.uint8)
    if fmt == "rgb":
        return pixels.reshape((height, width, 3))
    if fmt == "rgba":
        return pixels.reshape((height, width, 4))[:, :, :3]
    if fmt == "gray":
        return np.repeat(pixels.reshape((height, width, 1)), 3, axis=2)
    raise ValueError(f"Unsupported frame format for detection: {fmt}")


def decode_image(data: bytes) -> NDArray:
    return np.asarray(Image.open(io.BytesIO(data)).convert("RGB"))


def resize_rgb(rgb: NDArray, width: int, height: int) -> NDArray:
    if rgb.shape[1] == width and rgb.shape[0] == height:
        return rgb
    return np.asarray(Image.fromarray(rgb, mode="RGB").resize((width, height)))


def to_pil(rgb: NDArray, width: int | None = None, height: int | None = None) -> Image.Image:
    image = Image.fromarray(rgb, mode="RGB")
    if width is not None and height is not None and (image.width != width or image.height != height):
        image = image.resize((width, height))
    return image


def to_tensor(rgb: NDArray, spec: InputSpec) -> NDArray:
    resized = resize_rgb(rgb, spec.width, spec.height)

    arr: NDArray
    if spec.normalize == "unit":
        arr = resized.astype(np.float32) / 255.0
    elif spec.normalize == "facenet":
        arr = (resized.astype(np.float32) - 127.5) / 128.0
    else:  # "none"
        arr = resized.astype(np.uint8 if spec.dtype == "uint8" else np.float32)

    if spec.layout == "nchw":
        arr = arr.transpose(2, 0, 1)

    return np.ascontiguousarray(np.expand_dims(arr, axis=0))


def crop_rgb(rgb: NDArray, box: Box) -> NDArray:
    x1, y1, x2, y2 = (int(round(v)) for v in box)
    return rgb[y1:y2, x1:x2]
