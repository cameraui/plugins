from __future__ import annotations

import asyncio
import subprocess
from collections.abc import Mapping

from camera_ui_ml import BaseModelManager, InferenceBackend
from camera_ui_sdk import LoggerService

from defaults import MODEL_LFS_URL, model_version
from inference import HailoBackend

_ARCH_DISPLAY = {"hailo8": "Hailo-8", "hailo8l": "Hailo-8L"}
_DEFAULT_ARCH = "hailo8l"  # Raspberry Pi AI Kit chip


def _detect_arch() -> str | None:
    # Detect the Hailo chip by parsing `hailortcli fw-control identify`.
    try:
        result = subprocess.run(
            ["hailortcli", "fw-control", "identify"],
            capture_output=True,
            text=True,
            check=False,
            timeout=15,
        )
    except Exception:
        return None
    if result.returncode != 0:
        return None
    for line in result.stdout.splitlines():
        if "Device Architecture" in line:
            lowered = line.lower()
            if "hailo8l" in lowered:
                return "hailo8l"
            if "hailo8" in lowered:
                return "hailo8"
            break
    return None


class HailoModelManager(BaseModelManager):
    def __init__(self, storage_path: str, logger: LoggerService) -> None:
        super().__init__(storage_path, logger, model_version)
        self._arch: str | None = None
        self._arch_task: asyncio.Task[None] | None = None

    async def ensure_backend(self, model_name: str) -> InferenceBackend:
        await self._ensure_arch()
        return await super().ensure_backend(model_name)

    def model_files(self, model_name: str) -> Mapping[str, tuple[str, str]]:
        arch = self._arch or _DEFAULT_ARCH
        rel = f"{model_name}/{model_name}.{arch}.hef"
        return {"hef": (f"{MODEL_LFS_URL}/{rel}", rel)}

    async def build_backend(self, model_name: str, paths: Mapping[str, str]) -> InferenceBackend:
        arch = self._arch or _DEFAULT_ARCH
        device = _ARCH_DISPLAY.get(arch, arch)
        backend = await asyncio.to_thread(HailoBackend, paths["hef"], device)
        self.logger.success(f"Loaded model: {model_name} ({device})")
        return backend

    async def _ensure_arch(self) -> None:
        if self._arch_task is None:
            self._arch_task = asyncio.create_task(self._detect_arch_async())
        await self._arch_task

    async def _detect_arch_async(self) -> None:
        self._arch = await asyncio.to_thread(_detect_arch)
        if self._arch is None:
            self.logger.warn(f"Could not detect Hailo device; assuming {_DEFAULT_ARCH}")
        else:
            self.logger.log(f"Available devices: {_ARCH_DISPLAY.get(self._arch, self._arch)}")
