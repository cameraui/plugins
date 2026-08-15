from __future__ import annotations

import asyncio
import itertools
import threading
from collections import Counter
from collections.abc import Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import onnxruntime as ort
from camera_ui_ml import InferenceBackend, Outputs

_PROVIDER_LABELS = {
    "CUDAExecutionProvider": "CUDA",
    "TensorrtExecutionProvider": "TensorRT",
    "ROCMExecutionProvider": "ROCm",
    "CoreMLExecutionProvider": "CoreML",
    "DmlExecutionProvider": "DirectML",
    "CPUExecutionProvider": "CPU",
}


class OnnxBackend(InferenceBackend):
    def __init__(self, sessions: list[Any]) -> None:
        self._sessions = sessions
        self._by_thread: dict[str, Any] = {}
        self._counter = itertools.count()
        self._input_names: list[str] = [str(inp.name) for inp in sessions[0].get_inputs()]

        shape = sessions[0].get_inputs()[0].shape  # box detectors are NCHW [1, 3, H, W]
        self._input_size = (_dim(shape, 3), _dim(shape, 2))
        self._metadata: dict[str, str] = {
            str(key): str(value) for key, value in sessions[0].get_modelmeta().custom_metadata_map.items()
        }
        self._device = _device_label(sessions)

        accelerated = any(s.get_providers()[0] != "CPUExecutionProvider" for s in sessions)
        workers_per_session = 2 if accelerated else 1
        self._executor = ThreadPoolExecutor(
            max_workers=len(sessions) * workers_per_session,
            initializer=self._bind_thread,
            thread_name_prefix="onnx-infer",
        )

    @property
    def input_size(self) -> tuple[int, int]:
        return self._input_size

    def metadata(self) -> Mapping[str, str]:
        return self._metadata

    @property
    def runtime(self) -> str:
        return f"onnxruntime {ort.__version__}"

    @property
    def device(self) -> str:
        return self._device

    async def infer(self, inputs: Sequence[Any]) -> Outputs:
        return await asyncio.get_event_loop().run_in_executor(self._executor, self._run, list(inputs))

    def close(self) -> None:
        self._executor.shutdown(wait=False)

    def _bind_thread(self) -> None:
        index = next(self._counter) % len(self._sessions)
        self._by_thread[threading.current_thread().name] = self._sessions[index]

    def _run(self, inputs: list[Any]) -> Outputs:
        session = self._by_thread.get(threading.current_thread().name, self._sessions[0])
        feed = dict(zip(self._input_names, inputs, strict=False))
        outputs: list[Any] = session.run(None, feed)
        return outputs


def _device_label(sessions: list[Any]) -> str:
    actives = [s.get_providers()[0] for s in sessions]
    counts = Counter(_PROVIDER_LABELS.get(name, name) for name in actives)
    return ", ".join(f"{label} ×{count}" if count > 1 else label for label, count in counts.items())


def _dim(shape: Sequence[Any], index: int) -> int:
    # Non-box models have <4 dims or symbolic dynamic dims (str) → fall back to 0.
    try:
        return int(shape[index])
    except (TypeError, ValueError, IndexError):
        return 0
