from __future__ import annotations

import asyncio
import os
from typing import Any

import aiohttp
import coremltools as ct
from camera_ui_sdk import LoggerService, PluginAPI

from defaults import MODEL_BASE_URL, MODEL_LFS_URL, model_version


class ModelManager:
    def __init__(self, api: PluginAPI, logger: LoggerService) -> None:
        self.model_path = os.path.join(f"{api.storagePath}/models/{model_version}")
        self.logger = logger
        self._load_tasks: dict[str, asyncio.Task[Any]] = {}

    async def ensure_model(self, model_name: str) -> ct.models.MLModel:
        task = self._load_tasks.get(model_name)
        if task is None:
            task = asyncio.create_task(self._load(model_name))
            self._load_tasks[model_name] = task
        return await task

    async def _load(self, model_name: str) -> ct.models.MLModel:
        await self._download_mlpackage(model_name)
        ml_path = os.path.join(self.model_path, f"{model_name}.mlpackage")
        model: ct.models.MLModel = await asyncio.to_thread(ct.models.MLModel, ml_path)
        self.logger.success(f"Loaded model: {model_name}")
        return model

    async def _download_mlpackage(self, model_name: str) -> None:
        ml_package = f"{model_name}.mlpackage"
        files = [
            f"{ml_package}/Data/com.apple.CoreML/weights/weight.bin",
            f"{ml_package}/Data/com.apple.CoreML/model.mlmodel",
            f"{ml_package}/Manifest.json",
        ]
        for f in files:
            base = MODEL_LFS_URL if f.endswith(".bin") else MODEL_BASE_URL
            url = f"{base}/{f}"
            await self._download_file(url, f)

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
