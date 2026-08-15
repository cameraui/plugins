from __future__ import annotations

import asyncio
import time
from typing import TYPE_CHECKING

from camera_ui_sdk import LoggerService

from ..backend import InferenceBackend
from ..model_manager import BaseModelManager

if TYPE_CHECKING:
    from camera_ui_sdk import LoadedModel


class BaseDetector:
    name: str = "detector"

    def __init__(self, manager: BaseModelManager, logger: LoggerService) -> None:
        self.manager = manager
        self.logger = logger
        self.backend: InferenceBackend | None = None
        self.initialized = False
        self.closed = False
        self.model_name: str | None = None
        self.load_ms = 0
        self._init_task: asyncio.Task[None] | None = None

    async def initialize(self, model_name: str) -> None:
        if self.initialized:
            return
        if self._init_task is None:
            self._init_task = asyncio.create_task(self._do_initialize(model_name))
        await self._init_task

    async def close(self) -> None:
        self.closed = True
        if self._init_task is not None:
            self._init_task.cancel()
            self._init_task = None
        self.initialized = False
        if self.backend is not None:
            self.backend.close()
            self.backend = None

    async def _do_initialize(self, model_name: str) -> None:
        try:
            self.logger.log(f"Loading {self.name}: {model_name}...")
            started = time.monotonic()
            self.backend = await self.manager.ensure_backend(model_name)
            if self.closed:
                return
            await self._configure(model_name)
            self.load_ms = round((time.monotonic() - started) * 1000)
            self.model_name = model_name
            self.initialized = True
            self.logger.success(f"Loaded {self.name}: {model_name}")
        except Exception as error:
            self.logger.error(f"Failed to initialize {self.name}: {error}")
            raise
        finally:
            self._init_task = None

    async def _configure(self, model_name: str) -> None:
        """Read model-derived config (input size, labels) from ``self.backend``."""

    def loaded_model(self, role: str | None = None) -> LoadedModel | None:
        """What this detector has loaded, for the server's metrics view."""
        if not self._ready() or not self.model_name or self.backend is None:
            return None

        entry: LoadedModel = {"name": self.model_name}
        if role:
            entry["role"] = role
        if self.backend.device and self.backend.device != "unknown":
            entry["device"] = self.backend.device
        if self.backend.precision:
            entry["precision"] = self.backend.precision
        if self.load_ms:
            entry["loadMs"] = self.load_ms
        return entry

    def _ready(self) -> bool:
        return self.initialized and self.backend is not None
