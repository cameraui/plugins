from __future__ import annotations

import asyncio
from collections.abc import Callable, Mapping
from typing import Any

import openvino as ov
from camera_ui_ml import BaseModelManager, InferenceBackend
from camera_ui_sdk import LoggerService

from defaults import (
    DEFAULT_CLIP_TEXT,
    DEFAULT_CLIP_VISION,
    MODEL_BASE_URL,
    MODEL_LFS_URL,
    model_version,
)
from inference import OpenVinoBackend


class OpenVinoModelManager(BaseModelManager):
    def __init__(self, storage_path: str, logger: LoggerService, get_device: Callable[[], str]) -> None:
        super().__init__(storage_path, logger, model_version)
        self._get_device = get_device
        self._core = ov.Core()

    def model_files(self, model_name: str) -> Mapping[str, tuple[str, str]]:
        xml_rel, bin_rel = self._rel_files(model_name)
        return {
            "xml": (f"{MODEL_BASE_URL}/{xml_rel}", xml_rel),
            "bin": (f"{MODEL_LFS_URL}/{bin_rel}", bin_rel),
        }

    def clip_processor_files(self) -> Mapping[str, tuple[str, str]]:
        return {
            name: (f"{MODEL_BASE_URL}/clip-vit-base-patch32/{name}", f"clip-vit-base-patch32/{name}")
            for name in self.CLIP_PROCESSOR_FILENAMES
        }

    async def build_backend(self, model_name: str, paths: Mapping[str, str]) -> InferenceBackend:
        compiled, used = await asyncio.to_thread(self._compile, paths["xml"], self._get_device())
        self.logger.success(f"Loaded model: {model_name} ({used})")
        return OpenVinoBackend(compiled, asyncio.get_running_loop(), used)

    def _compile(self, xml_path: str, device: str) -> tuple[Any, str]:
        model = self._core.read_model(xml_path)
        config = {"PERFORMANCE_HINT": "THROUGHPUT"}
        tried: list[str] = []
        for dev in (device, "AUTO", "CPU"):
            if dev in tried:
                continue
            tried.append(dev)
            try:
                compiled = self._core.compile_model(model, dev, config)
                return compiled, self._describe_device(compiled, dev)
            except Exception as error:
                self.logger.log(f"compile_model on {dev} failed ({error}); trying fallback")
        raise RuntimeError(f"Could not compile model on any device (tried {tried})")

    @staticmethod
    def _describe_device(compiled: Any, requested: str) -> str:
        # Selectors like AUTO hide what actually runs — report the resolved device(s) too.
        try:
            resolved = ",".join(compiled.get_property("EXECUTION_DEVICES"))
        except Exception:
            return requested
        if not resolved or resolved == requested:
            return requested
        return f"{requested} -> {resolved}"

    @staticmethod
    def _rel_files(model_name: str) -> tuple[str, str]:
        if model_name == DEFAULT_CLIP_VISION:
            base = "clip-vit-base-patch32/vision"
        elif model_name == DEFAULT_CLIP_TEXT:
            base = "clip-vit-base-patch32/text"
        else:
            base = f"{model_name}/{model_name}"
        return f"{base}.xml", f"{base}.bin"
