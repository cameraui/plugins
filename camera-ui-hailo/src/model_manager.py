from __future__ import annotations

import asyncio
from collections.abc import Callable, Mapping

from camera_ui_ml import BaseModelManager, InferenceBackend
from camera_ui_sdk import LoggerService

from defaults import MODEL_LFS_URL, model_version
from inference import HailoBackend

_ARCH_DISPLAY = {"hailo8": "Hailo-8", "hailo8l": "Hailo-8L"}
_DEFAULT_ARCH = "hailo8l"  # Raspberry Pi AI Kit chip


def _detect_arch(device_id: str | None) -> str | None:
    # the wheel has no hailortcli, so ask the device directly
    try:
        from hailo_platform import Device

        with Device(device_id) as device:
            arch = str(device.control.identify().device_architecture).lower()
    except Exception:
        return None
    if arch.startswith("hailo8l"):
        return "hailo8l"
    if arch.startswith("hailo8"):
        return "hailo8"
    return None


class HailoModelManager(BaseModelManager):
    def __init__(
        self, storage_path: str, logger: LoggerService, get_device_id: Callable[[], str | None]
    ) -> None:
        super().__init__(storage_path, logger, model_version)
        self._arch: str | None = None
        self._arch_task: asyncio.Task[None] | None = None
        self._get_device_id = get_device_id

    async def ensure_backend(self, model_name: str) -> InferenceBackend:
        await self._ensure_arch()
        return await super().ensure_backend(model_name)

    def model_files(self, model_name: str) -> Mapping[str, tuple[str, str]]:
        arch = self._arch or _DEFAULT_ARCH
        rel = f"{model_name}/{model_name}.{arch}.hef"
        return {"hef": (f"{MODEL_LFS_URL}/{rel}", rel)}

    async def build_backend(self, model_name: str, paths: Mapping[str, str]) -> InferenceBackend:
        arch = self._arch or _DEFAULT_ARCH
        device_id = self._get_device_id()
        device = _ARCH_DISPLAY.get(arch, arch) + (f" ({device_id})" if device_id else "")
        backend = await asyncio.to_thread(HailoBackend, paths["hef"], device, device_id)
        self.logger.success(f"Loaded model: {model_name} ({device})")
        return backend

    async def _ensure_arch(self) -> None:
        if self._arch_task is None:
            self._arch_task = asyncio.create_task(self._detect_arch_async())
        await self._arch_task

    async def _detect_arch_async(self) -> None:
        self._arch = await asyncio.to_thread(_detect_arch, self._get_device_id())
        if self._arch is None:
            self.logger.warn(f"Could not detect Hailo device; assuming {_DEFAULT_ARCH}")
        else:
            self.logger.log(f"Available devices: {_ARCH_DISPLAY.get(self._arch, self._arch)}")
