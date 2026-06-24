from __future__ import annotations

import asyncio
import os
from abc import ABC, abstractmethod
from collections.abc import Mapping

import aiohttp
from camera_ui_sdk import LoggerService

from .backend import InferenceBackend

_CHUNK = 1024 * 1024


class BaseModelManager(ABC):
    def __init__(self, storage_path: str, logger: LoggerService, version: str) -> None:
        self.logger = logger
        self.model_path = os.path.join(storage_path, "models", version)
        self._load_tasks: dict[str, asyncio.Task[InferenceBackend]] = {}

    async def ensure_backend(self, model_name: str) -> InferenceBackend:
        task = self._load_tasks.get(model_name)
        if task is None:
            task = asyncio.create_task(self._load(model_name))
            self._load_tasks[model_name] = task
        return await task

    def reset(self) -> None:
        self._load_tasks.clear()

    @abstractmethod
    def model_files(self, model_name: str) -> Mapping[str, tuple[str, str]]:
        """Map of file key → (download_url, path relative to ``model_path``)."""

    @abstractmethod
    async def build_backend(self, model_name: str, paths: Mapping[str, str]) -> InferenceBackend:
        """Build the runtime backend from the (already downloaded) local paths."""

    async def _load(self, model_name: str) -> InferenceBackend:
        files = self.model_files(model_name)
        for url, rel in files.values():
            await self._download(url, rel)

        paths = {key: os.path.join(self.model_path, rel) for key, (_url, rel) in files.items()}
        return await self.build_backend(model_name, paths)

    async def _download(self, url: str, rel: str) -> None:
        full_path = os.path.join(self.model_path, rel)
        if os.path.isfile(full_path):
            return

        os.makedirs(os.path.dirname(full_path), exist_ok=True)
        tmp_path = full_path + ".tmp"
        name = os.path.basename(rel)
        self.logger.log(f"Downloading {name}...")

        async with aiohttp.ClientSession() as session, session.get(url) as response:
            if response.status < 200 or response.status >= 300:
                raise RuntimeError(f"Error downloading {url}: {response.status}")

            total = int(response.headers.get("content-length", 0))
            downloaded = 0
            last_step = 0

            with open(tmp_path, "wb") as handle:
                async for chunk in response.content.iter_chunked(_CHUNK):
                    if not chunk:
                        continue
                    downloaded += len(chunk)
                    handle.write(chunk)
                    if total > _CHUNK:
                        percent = min(100, downloaded * 100 // total)
                        if percent >= last_step + 25:
                            last_step = (percent // 25) * 25
                            self.logger.log(f"Downloading {name}... {last_step}%")

        os.rename(tmp_path, full_path)
        self.logger.log(f"Downloaded {name} ({downloaded / _CHUNK:.1f} MB)")
