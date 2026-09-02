from __future__ import annotations

import asyncio
import os
from collections.abc import Callable, Mapping, Sequence
from typing import Any

import numpy as np
import onnxruntime as ort
from camera_ui_ml import BaseModelManager, InferenceBackend
from camera_ui_sdk import LoggerService

from defaults import (
    LEGACY_RUNTIME,
    MODEL_BASE_URL,
    MODEL_LFS_URL,
    model_version,
)
from inference import OnnxBackend

# onnxruntime provider list, e.g. ["CUDAExecutionProvider", "CPUExecutionProvider"]
ProviderList = Sequence[Any]

_ORT_TO_NP: dict[str, Any] = {
    "tensor(float)": np.float32,
    "tensor(float16)": np.float16,
    "tensor(double)": np.float64,
    "tensor(int64)": np.int64,
    "tensor(int32)": np.int32,
    "tensor(uint8)": np.uint8,
    "tensor(bool)": np.bool_,
}


class OnnxModelManager(BaseModelManager):
    def __init__(
        self,
        storage_path: str,
        logger: LoggerService,
        get_provider_lists: Callable[[], list[ProviderList]],
    ) -> None:
        super().__init__(storage_path, logger, model_version)
        self._get_provider_lists = get_provider_lists
        self._hinted_legacy = False

    def model_files(self, model_name: str) -> Mapping[str, tuple[str, str]]:
        rel = self._rel_path(model_name)
        return {"model": (f"{MODEL_LFS_URL}/{rel}", rel)}

    def clip_processor_files(self) -> Mapping[str, tuple[str, str]]:
        return {
            name: (
                f"{MODEL_BASE_URL}/clip-vit-base-patch32/{name}",
                f"clip-vit-base-patch32/{name}",
            )
            for name in self.CLIP_PROCESSOR_FILENAMES
        }

    async def build_backend(self, model_name: str, paths: Mapping[str, str]) -> InferenceBackend:
        sessions = await asyncio.to_thread(self._build_sessions, paths["model"])
        active = sessions[0].get_providers()
        self.logger.success(f"Loaded model: {model_name} ({active[0] if active else 'CPUExecutionProvider'})")
        return OnnxBackend(sessions)

    def _build_sessions(self, path: str) -> list[Any]:
        provider_lists = self._get_provider_lists() or [["CPUExecutionProvider"]]
        return [self._create_session(path, list(providers)) for providers in provider_lists]

    def _create_session(self, path: str, providers: list[Any]) -> Any:
        try:
            if providers == ["CPUExecutionProvider"]:
                return self._create_cpu_session(path)
            session = ort.InferenceSession(path, providers=providers)
            self._warmup(session)
            return session
        except Exception as error:
            if providers == ["CPUExecutionProvider"]:
                raise
            self.logger.warn(f"Accelerated provider unavailable ({error}); falling back to CPU")
            self._hint_legacy(providers)
            return self._create_cpu_session(path)

    def _hint_legacy(self, providers: list[Any]) -> None:
        if self._hinted_legacy:
            return
        names = {p[0] if isinstance(p, tuple) else p for p in providers}
        if not names & {"CUDAExecutionProvider", "TensorrtExecutionProvider"}:
            return
        self._hinted_legacy = True
        if LEGACY_RUNTIME:
            self.logger.warn(
                "CUDA detection with this plugin needs the CUDA 12 libraries: in Docker use the "
                "ghcr.io/cameraui/camera.ui:nvidia-cuda12 image. On CUDA 13 (:nvidia image) install "
                "the regular ONNX plugin instead"
            )
            return
        self.logger.warn(
            "CUDA detection needs the CUDA 13 libraries and an NVIDIA driver 580 or newer: in Docker "
            "use the ghcr.io/cameraui/camera.ui:nvidia image. Stuck on CUDA 12 or a GPU before "
            "GTX 1650 (Maxwell, Pascal, Volta)? Use the :nvidia-cuda12 image with the ONNX Legacy plugin"
        )

    def _create_cpu_session(self, path: str) -> Any:
        cache_dir = self.compile_cache_dir(f"onnxruntime-{ort.__version__}")
        optimized = os.path.join(cache_dir, os.path.basename(path))
        if os.path.isfile(optimized):
            try:
                options = ort.SessionOptions()
                options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
                return ort.InferenceSession(optimized, options, providers=["CPUExecutionProvider"])
            except Exception:
                os.remove(optimized)
        options = ort.SessionOptions()
        options.optimized_model_filepath = optimized
        return ort.InferenceSession(path, options, providers=["CPUExecutionProvider"])

    @staticmethod
    def _warmup(session: Any) -> None:
        feeds: dict[str, Any] = {}
        for inp in session.get_inputs():
            shape = [dim if isinstance(dim, int) and dim > 0 else 1 for dim in inp.shape]
            feeds[inp.name] = np.zeros(shape, dtype=_ORT_TO_NP.get(inp.type, np.float32))
        session.run(None, feeds)

    @staticmethod
    def _rel_path(model_name: str) -> str:
        if model_name.startswith("clip-") and model_name.endswith(("-vision", "-text")):
            family, _, tower = model_name.rpartition("-")
            return f"{family}/{tower}.onnx"
        return f"{model_name}/{model_name}.onnx"
