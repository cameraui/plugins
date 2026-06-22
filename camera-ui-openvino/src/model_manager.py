from __future__ import annotations

import asyncio
import os
from collections.abc import Callable
from typing import Any

import aiohttp
import openvino as ov
from camera_ui_sdk import LoggerService, PluginAPI

from defaults import (
    DEFAULT_CLIP_TEXT,
    DEFAULT_CLIP_VISION,
    MODEL_BASE_URL,
    MODEL_LFS_URL,
    model_version,
)


class ModelManager:
    def __init__(self, api: PluginAPI, logger: LoggerService, get_device: Callable[[], str]) -> None:
        self.model_path = os.path.join(f"{api.storagePath}/models/{model_version}")
        self.logger = logger
        self._get_device = get_device
        self._core = ov.Core()
        self._load_tasks: dict[str, asyncio.Task[Any]] = {}

    def reset(self) -> None:
        """Drop cached load tasks so models are rebuilt (e.g. after a device change)."""
        self._load_tasks.clear()

    @staticmethod
    def _rel_files(model_name: str) -> tuple[str, str]:
        # CLIP ships as one folder with vision/text pairs; everything else is <name>/<name>.
        if model_name == DEFAULT_CLIP_VISION:
            base = "clip-vit-base-patch32/vision"
        elif model_name == DEFAULT_CLIP_TEXT:
            base = "clip-vit-base-patch32/text"
        else:
            base = f"{model_name}/{model_name}"
        return f"{base}.xml", f"{base}.bin"

    async def ensure_model(self, model_name: str) -> ov.CompiledModel:
        task = self._load_tasks.get(model_name)
        if task is None:
            task = asyncio.create_task(self._load(model_name))
            self._load_tasks[model_name] = task
        return await task

    async def _load(self, model_name: str) -> ov.CompiledModel:
        xml_rel, bin_rel = self._rel_files(model_name)
        # .xml is plain text (raw endpoint); .bin holds the weights (Git LFS endpoint).
        await self._download_file(f"{MODEL_BASE_URL}/{xml_rel}", xml_rel)
        await self._download_file(f"{MODEL_LFS_URL}/{bin_rel}", bin_rel)

        xml_path = os.path.join(self.model_path, xml_rel)
        device = self._get_device()
        compiled, used = await asyncio.to_thread(self._compile, xml_path, device)
        self.logger.success(f"Loaded model: {model_name} ({used})")
        return compiled

    def _compile(self, xml_path: str, device: str) -> tuple[ov.CompiledModel, str]:
        model = self._core.read_model(xml_path)  # auto-loads sibling .bin
        # Try the requested device, then fall back so a missing GPU/NPU never breaks loading.
        tried: list[str] = []
        for dev in (device, "AUTO", "CPU"):
            if dev in tried:
                continue
            tried.append(dev)
            try:
                return self._core.compile_model(model, dev), dev
            except Exception as e:
                self.logger.log(f"compile_model on {dev} failed ({e}); trying fallback")
        raise RuntimeError(f"Could not compile model on any device (tried {tried})")

    async def _download_file(self, url: str, filename: str) -> None:
        fullpath = os.path.join(self.model_path, filename)
        if os.path.isfile(fullpath):
            return

        tmp = fullpath + ".tmp"
        os.makedirs(os.path.dirname(fullpath), exist_ok=True)

        short_name = os.path.basename(filename)
        self.logger.log(f"Downloading {short_name}...")

        async with aiohttp.ClientSession() as session, session.get(url) as response:
            if response.status < 200 or response.status >= 300:
                raise Exception(f"Error downloading {url}: {response.status}")

            total_size = int(response.headers.get("content-length", 0))
            downloaded = 0
            last_percent = 0

            with open(tmp, "wb") as f:
                async for chunk in response.content.iter_chunked(1024 * 1024):
                    if chunk:
                        downloaded += len(chunk)
                        f.write(chunk)

                        if total_size > 1024 * 1024:
                            percent = min(100, (downloaded * 100) // total_size)
                            if percent >= last_percent + 25 and percent <= 100:
                                last_percent = (percent // 25) * 25
                                self.logger.log(f"Downloading {short_name}... {last_percent}%")

            size_mb = downloaded / (1024 * 1024)
            self.logger.log(f"Downloaded {short_name} ({size_mb:.1f} MB)")

        os.rename(tmp, fullpath)
