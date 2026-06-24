from __future__ import annotations

import asyncio
from collections.abc import Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import numpy as np
from camera_ui_ml import (
    InferenceBackend,
    InputSpec,
    NDArray,
    Outputs,
    to_pil,
    to_tensor,
)
from coremltools.proto import FeatureTypes_pb2 as ft

_ARRAY_DTYPES: dict[int, Any] = {
    ft.ArrayFeatureType.FLOAT32: np.float32,
    ft.ArrayFeatureType.FLOAT16: np.float16,
    ft.ArrayFeatureType.DOUBLE: np.float64,
    ft.ArrayFeatureType.INT32: np.int32,
}


class CoreMlBackend(InferenceBackend):
    def __init__(self, model: Any, device: str = "unknown", workers: int = 2) -> None:
        self._model = model
        self._device = device
        spec = model.get_spec()
        inputs = spec.description.input

        self._input_names = [str(i.name) for i in inputs]
        self._output_names = [str(o.name) for o in spec.description.output]
        self._input_dtypes = [_input_dtype(i) for i in inputs]
        self._image_input = inputs[0].type.WhichOneof("Type") == "imageType"
        self._input_size = _input_size(inputs[0])
        self._metadata: dict[str, str] = {
            str(key): str(value) for key, value in spec.description.metadata.userDefined.items()
        }
        self._executor = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="coreml-infer")

    @property
    def input_size(self) -> tuple[int, int]:
        return self._input_size

    def metadata(self) -> Mapping[str, str]:
        return self._metadata

    @property
    def device(self) -> str:
        return self._device

    def adapt(self, image: NDArray, spec: InputSpec) -> Sequence[Any]:
        if self._image_input:
            return [to_pil(image, spec.width, spec.height)]
        return [to_tensor(image, spec)]

    async def infer(self, inputs: Sequence[Any]) -> Outputs:
        return await asyncio.get_event_loop().run_in_executor(self._executor, self._run, list(inputs))

    def close(self) -> None:
        self._executor.shutdown(wait=False)

    def _run(self, inputs: list[Any]) -> Outputs:
        feed: dict[str, Any] = {}
        for name, value, dtype in zip(self._input_names, inputs, self._input_dtypes, strict=False):
            if dtype is not None and hasattr(value, "astype"):
                value = value.astype(dtype, copy=False)
            feed[name] = value
        out = self._model.predict(feed)
        return [np.asarray(out[name]) for name in self._output_names]


def _input_dtype(inp: Any) -> Any:
    if inp.type.WhichOneof("Type") == "multiArrayType":
        return _ARRAY_DTYPES.get(inp.type.multiArrayType.dataType)
    return None


def _input_size(inp: Any) -> tuple[int, int]:
    kind = inp.type.WhichOneof("Type")
    if kind == "imageType":
        return (int(inp.type.imageType.width), int(inp.type.imageType.height))
    if kind == "multiArrayType":
        shape = inp.type.multiArrayType.shape
        if len(shape) >= 4:  # box detectors are NCHW [1, 3, H, W]
            return (int(shape[3]), int(shape[2]))
    return (0, 0)
