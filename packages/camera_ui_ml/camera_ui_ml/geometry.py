from __future__ import annotations

from typing import TypedDict

Box = tuple[float, float, float, float]


class NormalizedBox(TypedDict):
    x: float
    y: float
    width: float
    height: float


def cxcywh_to_xyxy(cx: float, cy: float, w: float, h: float) -> Box:
    half_w = w / 2.0
    half_h = h / 2.0
    return (cx - half_w, cy - half_h, cx + half_w, cy + half_h)


def scale_box(box: Box, scale_x: float, scale_y: float) -> Box:
    x1, y1, x2, y2 = box
    return (x1 * scale_x, y1 * scale_y, x2 * scale_x, y2 * scale_y)


def clamp_box(box: Box, width: float, height: float) -> Box:
    x1, y1, x2, y2 = box
    return (
        min(max(x1, 0.0), width),
        min(max(y1, 0.0), height),
        min(max(x2, 0.0), width),
        min(max(y2, 0.0), height),
    )


def normalize_box(box: Box, width: float, height: float) -> NormalizedBox:
    x1, y1, x2, y2 = box
    return {
        "x": x1 / width,
        "y": y1 / height,
        "width": (x2 - x1) / width,
        "height": (y2 - y1) / height,
    }


def pad_box(box: Box, width: float, height: float, padding: float, min_size: int = 0) -> Box:
    """Expand a box by ``padding`` (fraction of its size) and an optional minimum
    pixel size, clamped to the frame. Used to crop faces/plates with context."""
    x1, y1, x2, y2 = box
    w = x2 - x1
    h = y2 - y1

    extra_x = max(0.0, (min_size - w) / 2.0) if min_size > 0 else 0.0
    extra_y = max(0.0, (min_size - h) / 2.0) if min_size > 0 else 0.0
    pad_x = w * padding + extra_x
    pad_y = h * padding + extra_y

    return clamp_box((x1 - pad_x, y1 - pad_y, x2 + pad_x, y2 + pad_y), width, height)
