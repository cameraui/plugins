from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import numpy as np
import openvino as ov
from camera_ui_ml import InferenceBackend, Outputs


class OpenVinoBackend(InferenceBackend):
    def __init__(self, compiled: Any, loop: asyncio.AbstractEventLoop, device: str = "unknown") -> None:
        self._compiled = compiled
        self._loop = loop
        self._device = device
        self._output_count = len(compiled.outputs)
        self._queue = ov.AsyncInferQueue(compiled)
        self._queue.set_callback(self._on_done)
        self._dispatch = ThreadPoolExecutor(max_workers=1, thread_name_prefix="ov-dispatch")
        pshape = compiled.inputs[0].get_partial_shape()
        self._input_size = (_dim(pshape, 3), _dim(pshape, 2))

    @property
    def input_size(self) -> tuple[int, int]:
        return self._input_size

    def metadata(self) -> Mapping[str, str]:
        return {}  # OpenVINO IR carries no class names

    @property
    def device(self) -> str:
        return self._device

    async def infer(self, inputs: Sequence[Any]) -> Outputs:
        future: asyncio.Future[Outputs] = self._loop.create_future()
        await self._loop.run_in_executor(self._dispatch, self._queue.start_async, list(inputs), future)
        return await future

    def close(self) -> None:
        with contextlib.suppress(Exception):
            self._queue.wait_all()
        self._dispatch.shutdown(wait=False)

    def _on_done(self, request: Any, future: asyncio.Future[Outputs]) -> None:
        try:
            outputs: list[np.ndarray[Any, Any]] = [
                np.array(request.get_output_tensor(index).data) for index in range(self._output_count)
            ]
            self._loop.call_soon_threadsafe(_set_result, future, outputs)
        except Exception as error:  # noqa: BLE001 - forwarded to the awaiting caller
            self._loop.call_soon_threadsafe(_set_exception, future, error)


def _set_result(future: asyncio.Future[Outputs], value: Outputs) -> None:
    if not future.done():
        future.set_result(value)


def _set_exception(future: asyncio.Future[Outputs], error: BaseException) -> None:
    if not future.done():
        future.set_exception(error)


def _dim(pshape: Any, index: int) -> int:
    try:
        dim = pshape[index]
        return int(dim.get_length()) if dim.is_static else 0
    except Exception:
        return 0
