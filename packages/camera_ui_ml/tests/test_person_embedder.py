from __future__ import annotations

import asyncio
import io
from collections.abc import Mapping, Sequence
from typing import Any, cast

import numpy as np
from PIL import Image

from camera_ui_ml.backend import InferenceBackend, InputSpec, Outputs
from camera_ui_ml.detectors.person import PersonEmbedder
from camera_ui_ml.pipelines import embed_person_images, embed_persons
from camera_ui_ml.preprocess import to_tensor


class RecordingBackend(InferenceBackend):
    def __init__(self) -> None:
        self.tensors: list[np.ndarray[Any, Any]] = []

    @property
    def input_size(self) -> tuple[int, int]:
        return (128, 256)

    def metadata(self) -> Mapping[str, str]:
        return {}

    async def infer(self, inputs: Sequence[Any]) -> Outputs:
        self.tensors.append(inputs[0])
        return [np.array([[3.0, 4.0]], dtype=np.float16)]

    def close(self) -> None:
        pass


def embedder() -> tuple[PersonEmbedder, RecordingBackend]:
    backend = RecordingBackend()
    person = PersonEmbedder(cast(Any, None), cast(Any, None))
    person.backend = backend
    person.initialized = True
    return person, backend


def jpeg(width: int, height: int) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (width, height), (200, 10, 30)).save(out, format="JPEG")
    return out.getvalue()


def test_raw_pixels_go_in_tall_and_unnormalized() -> None:
    rgb = np.full((256, 128, 3), 200, dtype=np.uint8)
    rgb[..., 1] = 10

    tensor = to_tensor(rgb, InputSpec(128, 256, layout="nchw", normalize="none"))

    assert tensor.shape == (1, 3, 256, 128)
    assert tensor.dtype == np.float32
    assert tensor[0, 0, 0, 0] == 200.0
    assert tensor[0, 1, 0, 0] == 10.0


def test_a_picture_of_any_size_is_stretched_to_the_input_and_the_vector_normalized() -> None:
    person, backend = embedder()

    results = asyncio.run(embed_person_images(person, [jpeg(90, 300)], "person-reid-256"))

    assert backend.tensors[0].shape == (1, 3, 256, 128)
    assert results[0]["embeddingModel"] == "person-reid-256"
    assert np.allclose(results[0]["embedding"], [0.6, 0.8])


def test_a_picture_that_does_not_decode_gets_an_empty_vector() -> None:
    person, backend = embedder()

    results = asyncio.run(embed_person_images(person, [b"not a picture"], "person-reid-256"))

    assert results == [{"embedding": [], "embeddingModel": "person-reid-256"}]
    assert backend.tensors == []


def test_frames_from_the_server_arrive_at_the_input_size() -> None:
    person, backend = embedder()
    frame: Any = {"id": "0", "data": bytes(128 * 256 * 3), "width": 128, "height": 256, "format": "rgb"}

    results = asyncio.run(embed_persons(person, [frame, frame], "person-reid-256"))

    assert len(results) == 2
    assert len(backend.tensors) == 2
