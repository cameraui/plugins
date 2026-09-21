from __future__ import annotations

import asyncio

import numpy as np

from camera_ui_ml.align import ARCFACE_DST_112, umeyama_similarity, warp_face
from camera_ui_ml.backend import InputSpec
from camera_ui_ml.detectors.embedder import Embedder
from camera_ui_ml.geometry import square_box
from camera_ui_ml.parsing import FaceLandmarks, parse_yunet
from camera_ui_ml.pipelines import _embed_crops
from camera_ui_ml.preprocess import to_tensor

STRIDES = (8, 16, 32)


def yunet_outputs(
    size: int, stride: int, cell: int, box: tuple[float, float], points: np.ndarray
) -> list[np.ndarray]:
    outputs: list[np.ndarray] = []
    counts = [(size // s) ** 2 for s in STRIDES]
    for shape in (1, 1, 4, 10):
        for index, s in enumerate(STRIDES):
            block = np.zeros((1, counts[index], shape), dtype=np.float32)
            if s == stride:
                if shape == 1:
                    block[0, cell, 0] = 1.0
                elif shape == 4:
                    block[0, cell] = [box[0], box[1], np.log(2.0), np.log(2.0)]
                else:
                    block[0, cell, :] = points.flatten()
            outputs.append(block)
    return outputs


def test_decodes_a_face_from_the_grid():
    cols = 256 // 16
    points = np.tile([0.5, 0.5], 5).astype(np.float32)
    found = parse_yunet(yunet_outputs(256, 16, cols * 3 + 4, (0.5, 0.5), points), 256, threshold=0.6)

    assert len(found) == 1
    face = found[0]
    # cell (col 4, row 3) plus the half-cell offset, box is two strides wide
    assert face.box[0] == 4.5 * 16 - 16
    assert face.box[1] == 3.5 * 16 - 16
    assert face.score == 1.0
    assert face.points.shape == (5, 2)
    assert face.points[0].tolist() == [4.5 * 16, 3.5 * 16]


def test_ignores_faces_below_the_threshold():
    cols = 256 // 8
    outputs = yunet_outputs(256, 8, cols, (0.5, 0.5), np.tile([0.5, 0.5], 5).astype(np.float32))
    outputs[0] = outputs[0] * 0.25  # cls drops, score is sqrt(cls * obj)

    assert parse_yunet(outputs, 256, threshold=0.6) == []


def test_warps_the_landmarks_onto_the_template():
    # a face rotated and shifted in its crop: after the warp the five points
    # must sit on the canonical template, whatever the crop looked like
    angle = np.deg2rad(20.0)
    rotation = np.array([[np.cos(angle), -np.sin(angle)], [np.sin(angle), np.cos(angle)]])
    source = (ARCFACE_DST_112 * 1.6) @ rotation.T + np.array([40.0, 25.0])

    matrix = umeyama_similarity(source, ARCFACE_DST_112)
    mapped = source @ matrix[:, :2].T + matrix[:, 2]

    assert np.allclose(mapped, ARCFACE_DST_112, atol=1e-6)


def test_warp_returns_the_template_size():
    crop = np.zeros((200, 160, 3), dtype=np.uint8)
    crop[60:140, 40:120] = 255
    points = np.array(
        [[60.0, 80.0], [100.0, 80.0], [80.0, 100.0], [65.0, 120.0], [95.0, 120.0]], dtype=np.float32
    )

    warped = warp_face(crop, points)

    assert warped.shape == (112, 112, 3)


def test_bgr_flip_reorders_the_channels():
    rgb = np.zeros((4, 4, 3), dtype=np.uint8)
    rgb[:, :, 0] = 10
    rgb[:, :, 2] = 30

    as_rgb = to_tensor(rgb, InputSpec(4, 4, normalize="none"))
    as_bgr = to_tensor(rgb, InputSpec(4, 4, normalize="none", channels="bgr"))

    assert as_rgb[0, 0, 0, 0] == 10
    assert as_bgr[0, 0, 0, 0] == 30
    assert as_bgr.flags["C_CONTIGUOUS"]


def test_arcface_normalization_maps_to_minus_one_and_one():
    image = np.zeros((2, 2, 3), dtype=np.uint8)
    image[0, 0] = 255

    tensor = to_tensor(image, InputSpec(2, 2, normalize="arcface"))

    assert np.isclose(tensor.max(), 1.0)
    assert np.isclose(tensor.min(), -1.0)


class FakeLandmarker:
    def __init__(self, found: FaceLandmarks | None) -> None:
        self.found = found

    async def points(self, crop: np.ndarray) -> FaceLandmarks | None:
        return self.found


class FakeEmbedder(Embedder):
    def __init__(self, aligned: bool) -> None:
        self.aligned = aligned
        self.input_size = (112, 112)
        self.seen: list[tuple[int, ...]] = []

    def _ready(self) -> bool:
        return True

    async def embed(self, image: np.ndarray) -> list[float]:
        self.seen.append(image.shape)
        return [1.0]


def face_at(box: tuple[float, float, float, float]) -> FaceLandmarks:
    return FaceLandmarks(score=0.9, box=box, points=np.array(ARCFACE_DST_112, dtype=np.float32))


def test_square_box_pads_the_longer_side_and_stays_square():
    assert square_box((100, 100, 140, 180), 640, 640, 0.25) == (60.0, 80.0, 180.0, 200.0)


def test_plain_head_embeds_the_located_face_not_the_whole_picture():
    embedder = FakeEmbedder(aligned=False)
    picture = np.zeros((640, 640, 3), dtype=np.uint8)

    results = asyncio.run(
        _embed_crops(FakeLandmarker(face_at((100, 100, 140, 180))), embedder, [picture], "space")
    )

    assert embedder.seen == [(120, 120, 3)]
    assert results[0]["embedding"] == [1.0]
    assert results[0]["embeddingModel"] == "space"
    assert results[0]["quality"] == 0.9


def test_no_face_means_no_vector_for_either_head():
    picture = np.zeros((64, 64, 3), dtype=np.uint8)
    for aligned in (True, False):
        results = asyncio.run(_embed_crops(FakeLandmarker(None), FakeEmbedder(aligned), [picture], "space"))
        assert results == [{"embedding": [], "embeddingModel": "space"}]


def test_found_points_come_back_in_the_pictures_own_scale():
    picture = np.zeros((224, 112, 3), dtype=np.uint8)

    results = asyncio.run(
        _embed_crops(FakeLandmarker(face_at((0, 0, 112, 112))), FakeEmbedder(True), [picture], "space")
    )

    expected = [(float(x / 112), float(y / 224)) for x, y in ARCFACE_DST_112]
    assert np.allclose(results[0]["landmarks"], expected, atol=1e-6)


def test_stored_points_spare_the_search_for_the_face():
    class Unused(FakeLandmarker):
        async def points(self, crop: np.ndarray) -> FaceLandmarks | None:
            raise AssertionError("the face was searched again")

    picture = np.zeros((112, 112, 3), dtype=np.uint8)
    stored = [(float(x / 112), float(y / 112)) for x, y in ARCFACE_DST_112]

    results = asyncio.run(_embed_crops(Unused(None), FakeEmbedder(True), [picture], "space", [stored]))

    assert results[0]["embedding"] == [1.0]
    assert "quality" not in results[0]
