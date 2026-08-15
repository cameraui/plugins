from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import numpy as np
from camera_ui_ml import InferenceBackend, Outputs

# NOTE: this HailoRT runtime path has no CPU emulation, so it is verified only on a Hailo device.


class HailoBackend(InferenceBackend):
    def __init__(self, hef_path: str, device: str = "unknown", device_id: str | None = None) -> None:
        from hailo_platform import HEF, FormatType, HailoSchedulingAlgorithm, VDevice

        params = VDevice.create_params()
        params.scheduling_algorithm = HailoSchedulingAlgorithm.ROUND_ROBIN
        if device_id:
            params.device_ids = [device_id]
        self._vdevice = VDevice(params)
        self._hef = HEF(hef_path)

        self._infer_model = self._vdevice.create_infer_model(hef_path)
        self._infer_model.set_batch_size(1)
        self._infer_model.input().set_format_type(FormatType.UINT8)
        self._config_ctx = self._infer_model.configure()
        self._model = self._config_ctx.__enter__()

        self._output_infos = self._hef.get_output_vstream_infos()
        self._output_names = [info.name for info in self._output_infos]
        self._output_dtypes = {
            info.name: getattr(np, str(info.format.type).rsplit(".", maxsplit=1)[-1].lower())
            for info in self._output_infos
        }
        h, w = (
            int(self._hef.get_input_vstream_infos()[0].shape[0]),
            int(self._hef.get_input_vstream_infos()[0].shape[1]),
        )
        self._input_size = (w, h)
        self._device = device
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="hailo-infer")

    @property
    def input_size(self) -> tuple[int, int]:
        return self._input_size

    def metadata(self) -> Mapping[str, str]:
        return {}  # HEF carries no usable class names; labels are hardcoded in the plugin

    @property
    def runtime(self) -> str:
        return "hailort"

    @property
    def device(self) -> str:
        return self._device

    async def infer(self, inputs: Sequence[Any]) -> Outputs:
        return await asyncio.get_event_loop().run_in_executor(self._executor, self._run, list(inputs))

    def close(self) -> None:
        self._executor.shutdown(wait=False)
        with contextlib.suppress(Exception):
            self._config_ctx.__exit__(None, None, None)

    def _run(self, inputs: list[Any]) -> Outputs:
        frame = np.ascontiguousarray(inputs[0])
        output_buffers = {
            name: np.empty(self._infer_model.output(name).shape, dtype=self._output_dtypes[name])
            for name in self._output_names
        }
        bindings = self._model.create_bindings(output_buffers=output_buffers)
        bindings.input().set_buffer(frame)

        self._model.wait_for_async_ready(timeout_ms=10000)
        job = self._model.run_async([bindings], lambda _completion: None)
        job.wait(10000)

        # HAILO_NMS output: a single per-class structure (list indexed by class id).
        return [bindings.output(self._output_names[0]).get_buffer()]
