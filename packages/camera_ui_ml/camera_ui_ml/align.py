from __future__ import annotations

from typing import Any

import numpy as np
from PIL import Image

NDArray = np.ndarray[Any, Any]

ARCFACE_DST_112 = np.array(
    [
        [38.2946, 51.6963],
        [73.5318, 51.5014],
        [56.0252, 71.7366],
        [41.5493, 92.3655],
        [70.7299, 92.2041],
    ],
    dtype=np.float64,
)


def umeyama_similarity(src: NDArray, dst: NDArray) -> NDArray:
    """Least-squares similarity transform (rotation, uniform scale, translation)
    mapping ``src`` onto ``dst``, as a (2, 3) affine matrix."""
    src = np.asarray(src, dtype=np.float64)
    dst = np.asarray(dst, dtype=np.float64)
    n, dim = src.shape

    src_mean, dst_mean = src.mean(axis=0), dst.mean(axis=0)
    src_demean, dst_demean = src - src_mean, dst - dst_mean

    cov = dst_demean.T @ src_demean / n
    u, s, vt = np.linalg.svd(cov)

    d = np.ones(dim)
    if np.linalg.det(u) * np.linalg.det(vt) < 0:
        d[-1] = -1.0
    rotation = u @ np.diag(d) @ vt

    variance = (src_demean**2).sum() / n
    scale = 1.0 if variance == 0 else float((s * d).sum() / variance)

    matrix = np.zeros((2, 3), dtype=np.float64)
    matrix[:, :2] = scale * rotation
    matrix[:, 2] = dst_mean - scale * rotation @ src_mean
    return matrix


def warp_face(rgb: NDArray, points: NDArray, size: int = 112) -> NDArray:
    """Warp a face onto the canonical ``size`` x ``size`` template from its five points."""
    scale = size / 112.0
    matrix = umeyama_similarity(np.asarray(points, dtype=np.float64), ARCFACE_DST_112 * scale)

    # PIL maps destination pixels back to the source, so it wants the inverse
    full = np.vstack([matrix, [0.0, 0.0, 1.0]])
    inverse = np.linalg.inv(full)[:2]

    warped = Image.fromarray(rgb).transform(
        (size, size), Image.Transform.AFFINE, tuple(inverse.flatten()), resample=Image.Resampling.BILINEAR
    )
    return np.asarray(warped)
