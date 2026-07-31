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
    STATIC_INPUT_SHAPES,
    model_version,
)
from inference import OpenVinoBackend


class OpenVinoModelManager(BaseModelManager):
    def __init__(self, storage_path: str, logger: LoggerService, get_device: Callable[[], str]) -> None:
        super().__init__(storage_path, logger, model_version)
        self._get_device = get_device
        self._core = ov.Core()
        try:
            cache_dir = self.compile_cache_dir(f"openvino-{ov.__version__.split('-')[0]}")
            self._core.set_property({"CACHE_DIR": cache_dir})
        except Exception as error:
            logger.log(f"Model compile cache unavailable ({error})")

    def model_files(self, model_name: str) -> Mapping[str, tuple[str, str]]:
        xml_rel, bin_rel = self._rel_files(model_name)
        return {
            "xml": (f"{MODEL_BASE_URL}/{xml_rel}", xml_rel),
            "bin": (f"{MODEL_LFS_URL}/{bin_rel}", bin_rel),
        }

    def clip_processor_files(self) -> Mapping[str, tuple[str, str]]:
        return {
            name: (
                f"{MODEL_BASE_URL}/clip-vit-base-patch32/{name}",
                f"clip-vit-base-patch32/{name}",
            )
            for name in self.CLIP_PROCESSOR_FILENAMES
        }

    async def build_backend(self, model_name: str, paths: Mapping[str, str]) -> InferenceBackend:
        compiled, used = await asyncio.to_thread(self._compile, model_name, paths["xml"], self._get_device())
        self.logger.success(f"Loaded model: {model_name} ({used})")
        return OpenVinoBackend(compiled, asyncio.get_running_loop(), used)

    def _compile(self, model_name: str, xml_path: str, device: str) -> tuple[Any, str]:
        model = self._core.read_model(xml_path)
        config = {"PERFORMANCE_HINT": "THROUGHPUT"}
        if _dynamic_inputs(model):
            self._make_static(model_name, model)
        candidates = [device, "AUTO", "CPU"]
        if _dynamic_inputs(model):
            # the NPU compiler aborts the whole process on dynamic input shapes
            # instead of raising, so such a model must never reach it, not even as
            # an AUTO candidate compiled in the background (dynamic outputs from
            # end2end NMS are fine)
            candidates = [self._without_npu(dev) for dev in candidates]
            if candidates[0] != device:
                self.logger.log(
                    f"{model_name} has dynamic input shapes, excluding NPU: {device} -> {candidates[0]}"
                )
        tried: list[str] = []
        for dev in candidates:
            if dev in tried:
                continue
            tried.append(dev)
            try:
                compiled = self._core.compile_model(model, dev, config)
                return compiled, self._describe_device(compiled, dev)
            except Exception as error:
                self.logger.log(f"compile_model on {dev} failed ({error}); trying fallback")
        raise RuntimeError(f"Could not compile model on any device (tried {tried})")

    def _make_static(self, model_name: str, model: ov.Model) -> None:
        shapes = STATIC_INPUT_SHAPES.get(model_name)
        if not shapes or len(shapes) != len(model.inputs):
            return
        try:
            model.reshape(dict(enumerate(shapes)))
        except Exception as error:
            self.logger.log(f"Could not pin {model_name} to static input shapes ({error})")

    def _without_npu(self, device: str) -> str:
        prefix, _, listing = device.partition(":")
        if listing:
            kept = [dev for dev in listing.split(",") if "NPU" not in dev]
            return f"{prefix}:{','.join(kept)}" if kept else "CPU"
        if "NPU" in device:
            return "CPU"
        if device != "AUTO":
            return device
        # bare AUTO may still pick the NPU, pin it to the remaining devices
        try:
            others = [dev for dev in self._core.available_devices if "NPU" not in dev]
        except Exception:
            return "CPU"
        others.sort(key=lambda dev: dev == "CPU")
        return f"AUTO:{','.join(others)}" if others else "CPU"

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


def _dynamic_inputs(model: ov.Model) -> bool:
    return any(inp.get_partial_shape().is_dynamic for inp in model.inputs)
