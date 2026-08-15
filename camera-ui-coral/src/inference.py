from __future__ import annotations

import asyncio
from collections.abc import Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import numpy as np
from camera_ui_ml import InferenceBackend, InputSpec, NDArray, Outputs, to_tensor

from decode import decode_yolov9_sep


class CoralBackend(InferenceBackend):
    def __init__(self, interpreter: Any, device: str = "unknown") -> None:
        self._interpreter = interpreter
        self._device = device

        input_detail = interpreter.get_input_details()[0]
        self._input_index = int(input_detail["index"])
        self._input_scale, self._input_zero_point = input_detail["quantization"]
        _, height, width, _ = (int(d) for d in input_detail["shape"])
        self._input_size = (width, height)

        self._output_details = interpreter.get_output_details()
        # one interpreter isn't safe for concurrent invoke (and the Edge TPU is a single device)
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="coral-infer")

    @property
    def input_size(self) -> tuple[int, int]:
        return self._input_size

    def metadata(self) -> Mapping[str, str]:
        return {}  # tflite carries no usable class names; labels are hardcoded in the plugin

    @property
    def runtime(self) -> str:
        return "tflite (edgetpu)"

    @property
    def device(self) -> str:
        return self._device

    def adapt(self, image: NDArray, spec: InputSpec) -> Sequence[Any]:
        # Coral wants NHWC int8; ignore the caller's layout/normalize and requantize 0..255.
        local = InputSpec(spec.width, spec.height, layout="nhwc", normalize="none", dtype="uint8")
        pixels = to_tensor(image, local).astype(np.float32)
        quantized = np.round(pixels / 255.0 / self._input_scale + self._input_zero_point)
        return [np.clip(quantized, -128, 127).astype(np.int8)]

    async def infer(self, inputs: Sequence[Any]) -> Outputs:
        return await asyncio.get_event_loop().run_in_executor(self._executor, self._run, list(inputs))

    def close(self) -> None:
        self._executor.shutdown(wait=False)

    def _run(self, inputs: list[Any]) -> Outputs:
        self._interpreter.set_tensor(self._input_index, inputs[0])
        self._interpreter.invoke()

        dequantized: list[NDArray] = []
        for output in self._output_details:
            raw = np.asarray(self._interpreter.get_tensor(output["index"]), dtype=np.float32)
            scale, zero_point = output["quantization"]
            dequantized.append((raw - zero_point) * scale)

        decoded = decode_yolov9_sep(dequantized, self._input_size[0])
        return [decoded]
