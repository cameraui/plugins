from __future__ import annotations

import asyncio
import os
import shutil
from collections.abc import Callable, Mapping
from typing import Any

import coremltools as ct
from camera_ui_ml import BaseModelManager, InferenceBackend
from camera_ui_sdk import LoggerService

from defaults import MODEL_BASE_URL, MODEL_LFS_URL, model_version
from inference import CoreMlBackend

_COMPUTE_UNITS: dict[str, Any] = {
    "ALL": ct.ComputeUnit.ALL,
    "CPU_AND_NE": ct.ComputeUnit.CPU_AND_NE,
    "CPU_AND_GPU": ct.ComputeUnit.CPU_AND_GPU,
    "CPU_ONLY": ct.ComputeUnit.CPU_ONLY,
}

_DEVICE_LABELS = {
    "ALL": "Neural Engine + GPU + CPU",
    "CPU_AND_NE": "Neural Engine + CPU",
    "CPU_AND_GPU": "GPU + CPU",
    "CPU_ONLY": "CPU",
}


class CoreMlModelManager(BaseModelManager):
    def __init__(
        self,
        storage_path: str,
        logger: LoggerService,
        get_compute_units: Callable[[], str],
    ) -> None:
        super().__init__(storage_path, logger, model_version)
        self._get_compute_units = get_compute_units

    def model_files(self, model_name: str) -> Mapping[str, tuple[str, str]]:
        pkg = f"{model_name}.mlpackage"
        weights = f"{pkg}/Data/com.apple.CoreML/weights/weight.bin"
        model = f"{pkg}/Data/com.apple.CoreML/model.mlmodel"
        manifest = f"{pkg}/Manifest.json"
        return {
            "weights": (f"{MODEL_LFS_URL}/{weights}", weights),
            "model": (f"{MODEL_BASE_URL}/{model}", model),
            "manifest": (f"{MODEL_BASE_URL}/{manifest}", manifest),
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
        pkg_path = os.path.join(self.model_path, f"{model_name}.mlpackage")
        mode = self._get_compute_units()
        units = _COMPUTE_UNITS.get(mode, ct.ComputeUnit.ALL)
        model, spec = await asyncio.to_thread(self._load_model, model_name, pkg_path, units)
        self.logger.success(f"Loaded model: {model_name} ({mode})")
        return CoreMlBackend(model, spec, _DEVICE_LABELS.get(mode, mode))

    def _load_model(self, model_name: str, pkg_path: str, compute_units: Any) -> tuple[Any, Any]:
        # spec always comes from the source package: a cached CompiledMLModel
        # has no get_spec
        spec = ct.utils.load_spec(pkg_path)

        compiled_path = os.path.join(
            self.compile_cache_dir(f"coremltools-{ct.__version__}"),
            f"{model_name}.mlmodelc",
        )
        if os.path.isdir(compiled_path):
            try:
                return ct.models.CompiledMLModel(compiled_path, compute_units=compute_units), spec
            except Exception:
                shutil.rmtree(compiled_path, ignore_errors=True)

        model = ct.models.MLModel(pkg_path, compute_units=compute_units)
        try:
            tmp_path = compiled_path + ".tmp"
            shutil.rmtree(tmp_path, ignore_errors=True)
            shutil.copytree(model.get_compiled_model_path(), tmp_path)
            os.rename(tmp_path, compiled_path)
        except Exception as error:
            self.logger.log(f"Could not persist compiled model ({error})")
        return model, spec
