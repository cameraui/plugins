from __future__ import annotations

import asyncio
from collections.abc import Callable, Mapping
from typing import Any

import numpy as np
from camera_ui_ml import BaseModelManager, InferenceBackend
from camera_ui_sdk import LoggerService

from defaults import MODEL_LFS_URL, model_version
from inference import CoralBackend

_EDGETPU_LIB = "libedgetpu.so.1"


class CoralModelManager(BaseModelManager):
    def __init__(
        self,
        storage_path: str,
        logger: LoggerService,
        get_use_edgetpu: Callable[[], bool],
        get_device: Callable[[], str | None],
    ) -> None:
        super().__init__(storage_path, logger, model_version)
        self._get_use_edgetpu = get_use_edgetpu
        self._get_device = get_device

    def model_files(self, model_name: str) -> Mapping[str, tuple[str, str]]:
        cpu_rel = f"{model_name}/{model_name}.tflite"
        edgetpu_rel = f"{model_name}/{model_name}_edgetpu.tflite"
        return {
            "cpu": (f"{MODEL_LFS_URL}/{cpu_rel}", cpu_rel),
            "edgetpu": (f"{MODEL_LFS_URL}/{edgetpu_rel}", edgetpu_rel),
        }

    async def build_backend(self, model_name: str, paths: Mapping[str, str]) -> InferenceBackend:
        use_edgetpu = self._get_use_edgetpu()
        interpreter, device = await asyncio.to_thread(
            self._build, paths["cpu"], paths["edgetpu"], use_edgetpu, self._get_device()
        )
        self.logger.success(f"Loaded model: {model_name} ({device})")
        return CoralBackend(interpreter, device)

    def _build(
        self, cpu_path: str, edgetpu_path: str, use_edgetpu: bool, device: str | None
    ) -> tuple[Any, str]:
        from ai_edge_litert.interpreter import Interpreter, load_delegate

        if use_edgetpu:
            try:
                delegate = load_delegate(_EDGETPU_LIB, {"device": device} if device else None)
                interpreter = Interpreter(model_path=edgetpu_path, experimental_delegates=[delegate])
                interpreter.allocate_tensors()
                self._warmup(interpreter)
                return interpreter, f"Edge TPU (Coral, {device})" if device else "Edge TPU (Coral)"
            except Exception as error:
                self.logger.warn(f"Edge TPU unavailable ({error}); falling back to CPU")

        interpreter = Interpreter(model_path=cpu_path)
        interpreter.allocate_tensors()
        return interpreter, "CPU"

    @staticmethod
    def _warmup(interpreter: Any) -> None:
        for detail in interpreter.get_input_details():
            interpreter.set_tensor(detail["index"], np.zeros(detail["shape"], dtype=detail["dtype"]))
        interpreter.invoke()
