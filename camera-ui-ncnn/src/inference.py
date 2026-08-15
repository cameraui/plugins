from __future__ import annotations

import asyncio
from collections.abc import Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import ncnn
import numpy as np
from camera_ui_ml import InferenceBackend, InputSpec, NDArray, Outputs, to_tensor


class NcnnBackend(InferenceBackend):
    def __init__(
        self,
        net: Any,
        input_size: tuple[int, int],
        device: str = "unknown",
        workers: int = 2,
    ) -> None:
        self._net = net
        self._input_size = input_size
        self._device = device
        self._input_names = list(net.input_names())
        self._output_names = list(net.output_names())
        self._executor = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="ncnn-infer")

    @property
    def input_size(self) -> tuple[int, int]:
        return self._input_size

    def metadata(self) -> Mapping[str, str]:
        return {}  # ncnn .param carries no class names

    @property
    def runtime(self) -> str:
        return f"ncnn {getattr(ncnn, '__version__', '')}".strip()

    @property
    def device(self) -> str:
        return self._device

    def adapt(self, image: NDArray, spec: InputSpec) -> Sequence[Any]:
        # to_tensor yields a batched tensor; ncnn wants a single float32 Mat (no batch).
        tensor = np.ascontiguousarray(to_tensor(image, spec)[0].astype(np.float32))
        return [ncnn.Mat(tensor)]

    async def infer(self, inputs: Sequence[Any]) -> Outputs:
        return await asyncio.get_event_loop().run_in_executor(self._executor, self._run, list(inputs))

    def close(self) -> None:
        self._executor.shutdown(wait=False)

    def _run(self, inputs: list[Any]) -> Outputs:
        extractor = self._net.create_extractor()
        for name, mat in zip(self._input_names, inputs, strict=False):
            extractor.input(name, mat)
        outputs: list[NDArray] = []
        for name in self._output_names:
            _, mat = extractor.extract(name)
            outputs.append(np.array(mat))
        return outputs
