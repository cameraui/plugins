from __future__ import annotations

from typing import Any

import numpy as np

from .geometry import Box, cxcywh_to_xyxy

NDArray = np.ndarray[Any, Any]
RawDetection = tuple[int, float, Box]


def channels_first(output: NDArray) -> NDArray:
    squeezed = np.squeeze(output)
    if squeezed.ndim != 2:
        return squeezed
    return squeezed if squeezed.shape[0] <= squeezed.shape[1] else squeezed.T


def parse_yolov9(results: NDArray, threshold: float) -> list[RawDetection]:
    scores = results[4:]
    detections: list[RawDetection] = []
    for class_id, index in np.argwhere(scores > threshold):
        confidence = float(results[class_id + 4, index])
        cx = float(results[0, index])
        cy = float(results[1, index])
        w = float(results[2, index])
        h = float(results[3, index])
        detections.append((int(class_id), confidence, cxcywh_to_xyxy(cx, cy, w, h)))
    return detections


def parse_end2end(rows: NDArray, threshold: float) -> list[RawDetection]:
    detections: list[RawDetection] = []
    for row in rows:
        score = float(row[6])
        if score <= threshold:
            continue
        detections.append(
            (
                int(row[5]),
                score,
                (float(row[1]), float(row[2]), float(row[3]), float(row[4])),
            )
        )
    return detections


def decode_ocr(logits: NDArray, alphabet: str, pad_char: str = "_") -> tuple[str, float]:
    chars: list[str] = []
    confidences: list[float] = []
    for slot in logits:
        index = int(np.argmax(slot))
        char = alphabet[index] if index < len(alphabet) else pad_char
        if char == pad_char:
            break
        shifted = np.exp(slot - np.max(slot))
        confidences.append(float(shifted[index] / np.sum(shifted)))
        chars.append(char)
    return "".join(chars), (float(np.mean(confidences)) if confidences else 0.0)


def l2_normalize(vector: NDArray) -> NDArray:
    flat = np.asarray(vector, dtype=np.float32).flatten()
    norm = float(np.linalg.norm(flat))
    return flat / norm if norm > 0.0 else flat


def nms(detections: list[RawDetection], iou_threshold: float = 0.45) -> list[RawDetection]:
    if not detections:
        return []

    boxes = np.array([d[2] for d in detections], dtype=np.float32)
    scores = np.array([d[1] for d in detections], dtype=np.float32)
    order = scores.argsort()[::-1]

    keep: list[int] = []
    while order.size > 0:
        best = int(order[0])
        keep.append(best)
        if order.size == 1:
            break
        rest = order[1:]
        order = rest[_iou(boxes[best], boxes[rest]) <= iou_threshold]

    return [detections[i] for i in keep]


def _iou(box: NDArray, others: NDArray) -> NDArray:
    x1 = np.maximum(box[0], others[:, 0])
    y1 = np.maximum(box[1], others[:, 1])
    x2 = np.minimum(box[2], others[:, 2])
    y2 = np.minimum(box[3], others[:, 3])

    inter = np.clip(x2 - x1, 0.0, None) * np.clip(y2 - y1, 0.0, None)
    area = (box[2] - box[0]) * (box[3] - box[1])
    areas = (others[:, 2] - others[:, 0]) * (others[:, 3] - others[:, 1])
    union = area + areas - inter
    return np.where(union > 0.0, inter / union, 0.0)
