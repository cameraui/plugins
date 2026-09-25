from __future__ import annotations

import asyncio
import io
from collections.abc import Mapping, Sequence
from typing import Any, cast

import numpy as np
from PIL import Image

from camera_ui_ml.backend import InferenceBackend, Outputs
from camera_ui_ml.detectors.segmenter import Segmenter
from camera_ui_ml.pipelines import segment_images, segment_objects

# two people side by side in the 320 input: the left one on proto channel 1, the right one on channel 0
LEFT = (80.0, 160.0, 120.0, 200.0)
RIGHT = (240.0, 160.0, 120.0, 200.0)


def box_of(cx: float, cy: float, w: float, h: float) -> dict[str, float]:
    return {"x": (cx - w / 2) / 320, "y": (cy - h / 2) / 320, "width": w / 320, "height": h / 320}


def model_outputs(
    scores: tuple[float, float] = (0.9, 0.8),
) -> tuple[np.ndarray[Any, Any], np.ndarray[Any, Any]]:
    # more anchors than channels, like the real 2100, or the layout reads transposed
    candidates = np.zeros((1, 39, 64), dtype=np.float32)
    for index, (geometry, score, channel) in enumerate(((LEFT, scores[0], 1), (RIGHT, scores[1], 0))):
        candidates[0, :4, index] = geometry
        candidates[0, 4, index] = score
        candidates[0, 7 + channel, index] = 1.0
    protos = np.full((1, 32, 80, 80), -10.0, dtype=np.float32)
    protos[0, 0, :, 40:] = 10.0
    protos[0, 1, :, :40] = 10.0
    return candidates, protos


class FixedBackend(InferenceBackend):
    def __init__(self, outputs: Outputs) -> None:
        self.outputs = outputs
        self.tensors: list[np.ndarray[Any, Any]] = []

    @property
    def input_size(self) -> tuple[int, int]:
        return (320, 320)

    def metadata(self) -> Mapping[str, str]:
        return {}

    async def infer(self, inputs: Sequence[Any]) -> Outputs:
        self.tensors.append(inputs[0])
        return self.outputs

    def close(self) -> None:
        pass


def segmenter(outputs: Outputs) -> tuple[Segmenter, FixedBackend]:
    backend = FixedBackend(outputs)
    model = Segmenter(cast(Any, None), cast(Any, None))
    model.backend = backend
    model.initialized = True
    return model, backend


def jpeg(width: int, height: int) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (width, height), (90, 90, 90)).save(out, format="JPEG")
    return out.getvalue()


def rgb() -> np.ndarray[Any, Any]:
    return np.zeros((320, 320, 3), dtype=np.uint8)


def test_the_candidate_that_covers_the_box_gives_the_mask() -> None:
    model, _ = segmenter(model_outputs())

    mask = asyncio.run(model.segment(rgb(), cast(Any, box_of(*RIGHT))))

    assert mask is not None
    assert mask["box"] == {"x": 180 / 320, "y": 60 / 320, "width": 120 / 320, "height": 200 / 320}
    assert (mask["width"], mask["height"]) == (120, 200)
    assert len(mask["data"]) == 120 * 200
    assert min(mask["data"]) > 250


def test_the_mask_comes_from_the_picked_candidate_only() -> None:
    model, _ = segmenter(model_outputs())

    mask = asyncio.run(model.segment(rgb(), cast(Any, box_of(*LEFT))))

    assert mask is not None
    pixels = np.frombuffer(mask["data"], dtype=np.uint8).reshape(mask["height"], mask["width"])
    # the left candidate reaches x 140, its mask channel ends at 160: all of it is the object
    assert pixels.min() > 250
    assert mask["box"]["x"] == 20 / 320


def test_output_order_does_not_matter() -> None:
    candidates, protos = model_outputs()
    first, _ = segmenter([candidates, protos])
    swapped, _ = segmenter([protos, candidates])

    box = cast(Any, box_of(*RIGHT))
    assert asyncio.run(first.segment(rgb(), box)) == asyncio.run(swapped.segment(rgb(), box))


def test_outputs_without_a_batch_dimension_decode_the_same() -> None:
    candidates, protos = model_outputs()
    batched, _ = segmenter([candidates, protos])
    bare, _ = segmenter([candidates[0], protos[0]])

    box = cast(Any, box_of(*RIGHT))
    assert asyncio.run(bare.segment(rgb(), box)) == asyncio.run(batched.segment(rgb(), box))


def test_nothing_at_the_box_gives_no_mask() -> None:
    model, _ = segmenter(model_outputs())

    empty_corner = {"x": 0.0, "y": 0.9, "width": 0.1, "height": 0.1}
    results = asyncio.run(segment_images(model, [{"image": jpeg(320, 320), "box": cast(Any, empty_corner)}]))

    assert results == [{}]


def test_a_weak_candidate_is_not_an_object() -> None:
    model, _ = segmenter(model_outputs(scores=(0.9, 0.1)))

    assert asyncio.run(model.segment(rgb(), cast(Any, box_of(*RIGHT)))) is None


def test_a_picture_that_does_not_decode_gives_no_mask() -> None:
    model, backend = segmenter(model_outputs())

    results = asyncio.run(
        segment_images(model, [{"image": b"not a picture", "box": cast(Any, box_of(*RIGHT))}])
    )

    assert results == [{}]
    assert backend.tensors == []


def test_any_picture_is_stretched_to_the_input() -> None:
    model, backend = segmenter(model_outputs())

    results = asyncio.run(
        segment_images(model, [{"image": jpeg(200, 500), "box": cast(Any, box_of(*RIGHT))}])
    )

    assert backend.tensors[0].shape == (1, 3, 320, 320)
    assert backend.tensors[0].max() <= 1.0
    assert "mask" in results[0]


def test_frames_from_the_server_carry_their_box() -> None:
    model, backend = segmenter(model_outputs())
    frame: Any = {
        "id": "0",
        "data": bytes(320 * 320 * 3),
        "width": 320,
        "height": 320,
        "format": "rgb",
        "box": box_of(*LEFT),
    }

    results = asyncio.run(segment_objects(model, [frame, {**frame, "box": box_of(*RIGHT)}]))

    assert len(backend.tensors) == 2
    assert [result["mask"]["box"]["x"] for result in results] == [20 / 320, 180 / 320]
