from __future__ import annotations

import asyncio
import os
from collections.abc import Callable
from typing import Any

import aiohttp
import ncnn
from camera_ui_sdk import LoggerService, PluginAPI

from defaults import MODEL_BASE_URL, MODEL_LFS_URL, model_version


class ModelManager:
    def __init__(self, api: PluginAPI, logger: LoggerService, get_use_vulkan: Callable[[], bool]) -> None:
        self.model_path = os.path.join(f"{api.storagePath}/models/{model_version}")
        self.logger = logger
        self._get_use_vulkan = get_use_vulkan
        self._load_tasks: dict[str, asyncio.Task[Any]] = {}

    def reset(self) -> None:
        """Drop cached load tasks so models are rebuilt (e.g. after a Vulkan toggle)."""
        self._load_tasks.clear()

    async def ensure_model(self, model_name: str) -> ncnn.Net:
        task = self._load_tasks.get(model_name)
        if task is None:
            task = asyncio.create_task(self._load(model_name))
            self._load_tasks[model_name] = task
        return await task

    async def _load(self, model_name: str) -> ncnn.Net:
        param_rel = f"{model_name}/{model_name}.ncnn.param"
        bin_rel = f"{model_name}/{model_name}.ncnn.bin"
        # .param is plain text (raw endpoint); .bin holds the weights (Git LFS endpoint).
        await self._download_file(f"{MODEL_BASE_URL}/{param_rel}", param_rel)
        await self._download_file(f"{MODEL_LFS_URL}/{bin_rel}", bin_rel)

        param_path = os.path.join(self.model_path, param_rel)
        bin_path = os.path.join(self.model_path, bin_rel)
        use_vulkan = self._get_use_vulkan()
        net: ncnn.Net = await asyncio.to_thread(self._build, param_path, bin_path, use_vulkan)
        self.logger.success(f"Loaded model: {model_name} (vulkan={use_vulkan})")
        return net

    @staticmethod
    def _build(param_path: str, bin_path: str, use_vulkan: bool) -> ncnn.Net:
        net = ncnn.Net()
        net.opt.use_vulkan_compute = use_vulkan
        net.load_param(param_path)
        net.load_model(bin_path)
        return net

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
