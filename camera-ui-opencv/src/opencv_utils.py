from typing import Any

import cv2
import numpy as np

DEFAULT_AREA_THRESHOLD = 500
DEFAULT_THRESHOLD = 50
DEFAULT_DILATION_SIZE = 5
DEFAULT_MASK_KERNEL = np.array((9, 9), dtype=np.uint8)
DEFAULT_LEARNING_RATE = 0.08


def get_mask(
    frame1: np.ndarray[Any, Any],
    frame2: np.ndarray[Any, Any],
    kernel: np.ndarray[Any, Any] = DEFAULT_MASK_KERNEL,
) -> cv2.typing.MatLike:
    frame_diff = cv2.subtract(frame2, frame1)
    frame_diff = cv2.medianBlur(frame_diff, 3)

    mask = cv2.adaptiveThreshold(
        frame_diff, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 11, 3
    )
    mask = cv2.medianBlur(mask, 3)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=1)

    return mask


# fg_mask is binary only while the subtractors run detectShadows=False; with shadows on,
# the 127 shadow pixels need a threshold gate here before they reach findContours
def get_motion_mask(fg_mask: cv2.typing.MatLike) -> cv2.typing.MatLike:
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))

    motion_mask = cv2.medianBlur(fg_mask, 3)
    motion_mask = cv2.morphologyEx(motion_mask, cv2.MORPH_OPEN, kernel, iterations=1)
    motion_mask = cv2.morphologyEx(motion_mask, cv2.MORPH_CLOSE, kernel, iterations=1)

    return motion_mask


def get_contour_detections(
    mask: cv2.typing.MatLike, area_threshold: int = DEFAULT_AREA_THRESHOLD
) -> list[tuple[float, float, float, float]]:
    cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    detections: list[tuple[float, float, float, float]] = []
    for cnt in cnts:
        x, y, w, h = cv2.boundingRect(cnt)
        area = w * h
        if area > area_threshold:
            detections.append((x, y, x + w, y + h))
    return detections


def get_detections(
    blurred_frame1: cv2.typing.MatLike,
    blurred_frame2: cv2.typing.MatLike,
    threshold: int = DEFAULT_THRESHOLD,
    area_threshold: int = DEFAULT_AREA_THRESHOLD,
    dilation_size: int = DEFAULT_DILATION_SIZE,
) -> list[tuple[float, float, float, float]]:
    delta_frame = cv2.absdiff(blurred_frame1, blurred_frame2)
    thresh_frame = cv2.threshold(delta_frame, threshold, 255, cv2.THRESH_BINARY)[1]
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (dilation_size, dilation_size))
    thresh_frame = cv2.dilate(thresh_frame, kernel, iterations=1)
    return get_contour_detections(thresh_frame, area_threshold)


def get_detections_fd(
    frame1: np.ndarray[Any, Any],
    frame2: np.ndarray[Any, Any],
    area_threshold: int = DEFAULT_AREA_THRESHOLD,
) -> list[tuple[float, float, float, float]]:
    mask = get_mask(frame1, frame2, DEFAULT_MASK_KERNEL)
    return get_contour_detections(mask, area_threshold)


def get_detections_bs(
    frame: np.ndarray[Any, Any],
    backSub: cv2.BackgroundSubtractorMOG2 | cv2.BackgroundSubtractorKNN,
    area_threshold: int = DEFAULT_AREA_THRESHOLD,
    learning_rate: float = DEFAULT_LEARNING_RATE,
) -> list[tuple[float, float, float, float]]:
    fg_mask = backSub.apply(frame, learningRate=learning_rate)
    motion_mask = get_motion_mask(fg_mask)
    return get_contour_detections(motion_mask, area_threshold)
