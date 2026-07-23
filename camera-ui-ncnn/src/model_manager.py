from __future__ import annotations

import asyncio
from collections.abc import Callable, Mapping
from typing import Any

import ncnn
from camera_ui_ml import BaseModelManager, InferenceBackend
from camera_ui_sdk import LoggerService

from defaults import (
    FACE_DETECTOR_MODELS,
    LPD_DETECTOR_MODELS,
    MODEL_BASE_URL,
    MODEL_LFS_URL,
    OBJECT_MODELS,
    model_version,
)
from inference import NcnnBackend
from vulkan import gpu_count

# pnnx-converted .param carries no input dims; sizes come from the registry.
_BOX_INPUT_SIZES = {**OBJECT_MODELS, **FACE_DETECTOR_MODELS, **LPD_DETECTOR_MODELS}


class NcnnModelManager(BaseModelManager):
    def __init__(
        self,
        storage_path: str,
        logger: LoggerService,
        get_use_vulkan: Callable[[], bool],
    ) -> None:
        super().__init__(storage_path, logger, model_version)
        self._get_use_vulkan = get_use_vulkan

    def model_files(self, model_name: str) -> Mapping[str, tuple[str, str]]:
        param_rel = f"{model_name}/{model_name}.ncnn.param"
        bin_rel = f"{model_name}/{model_name}.ncnn.bin"
        return {
            "param": (f"{MODEL_BASE_URL}/{param_rel}", param_rel),
            "bin": (f"{MODEL_LFS_URL}/{bin_rel}", bin_rel),
        }

    async def build_backend(self, model_name: str, paths: Mapping[str, str]) -> InferenceBackend:
        use_vulkan = self._get_use_vulkan() and gpu_count() > 0
        net = await asyncio.to_thread(self._build, paths["param"], paths["bin"], use_vulkan)
        size = _box_input_size(model_name)
        device = "Vulkan (GPU)" if use_vulkan else "CPU"
        self.logger.success(f"Loaded model: {model_name} ({device})")
        return NcnnBackend(net, size, device)

    @staticmethod
    def _build(param_path: str, bin_path: str, use_vulkan: bool) -> Any:
        net = ncnn.Net()
        net.opt.use_vulkan_compute = use_vulkan
        net.load_param(param_path)
        net.load_model(bin_path)
        return net


def _box_input_size(model_name: str) -> tuple[int, int]:
    # Embedder/OCR aren't in the registry; (0, 0) is harmless for them.
    px = _BOX_INPUT_SIZES.get(model_name, 0)
    return (px, px)
