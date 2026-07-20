from __future__ import annotations

import asyncio
import csv
import os
from concurrent.futures import ThreadPoolExecutor
from typing import TYPE_CHECKING, Any

import aiohttp
import numpy as np

from defaults import YAMNET_LABELS_URL, YAMNET_MODEL_URL

if TYPE_CHECKING:
    from camera_ui_sdk import LoggerService, PluginAPI


class AudioDetector:
    def __init__(self, api: PluginAPI, logger: LoggerService) -> None:
        self.api = api
        self.logger = logger

        self.model_path = os.path.join(f"{self.api.storagePath}/models")
        os.makedirs(self.model_path, exist_ok=True)
        marker = os.path.join(self.model_path, ".backupignore")
        if not os.path.isfile(marker):
            open(marker, "a").close()
        self.initialized = False
        self.executor: ThreadPoolExecutor | None = ThreadPoolExecutor(max_workers=2)

        self.interpreter: Any = None
        self.input_details: list[Any] = []
        self.output_details: list[Any] = []
        self.labels: list[str] = []

        self.closed = False
        self._init_task: asyncio.Task[None] | None = None

    async def initialize(self) -> None:
        if self.initialized:
            return
        if self._init_task is None:
            self._init_task = asyncio.create_task(self._do_initialize())
        await self._init_task

    async def _do_initialize(self) -> None:
        try:
            model_file = "yamnet.tflite"
            labels_file = "yamnet_class_map.csv"
            await self._download_file(YAMNET_MODEL_URL, model_file)
            if self.closed:
                return
            await self._download_file(YAMNET_LABELS_URL, labels_file)
            if self.closed:
                return

            labels_path = os.path.join(self.model_path, labels_file)
            self.labels = await asyncio.to_thread(self._load_labels, labels_path)

            model_path = os.path.join(self.model_path, model_file)
            self.interpreter = await asyncio.to_thread(self._load_model, model_path)

            if self.closed:
                return

            self.input_details = self.interpreter.get_input_details()
            self.output_details = self.interpreter.get_output_details()

            self.initialized = True
            self.logger.log(f"YAMNet model loaded ({len(self.labels)} classes)")
        except Exception as e:
            self.logger.error(f"Failed to initialize YAMNet: {e}")
        finally:
            self._init_task = None

    def _load_model(self, model_path: str) -> Any:
        from ai_edge_litert.interpreter import Interpreter  # type: ignore[import-untyped]

        interpreter = Interpreter(model_path=model_path)
        interpreter.allocate_tensors()
        return interpreter

    def _load_labels(self, labels_path: str) -> list[str]:
        labels: list[str] = []
        with open(labels_path) as f:
            reader = csv.reader(f)
            next(reader)
            for row in reader:
                if len(row) >= 3:
                    labels.append(row[2])
        return labels

    async def detect(self, waveform: np.ndarray[Any, Any]) -> list[tuple[str, float]]:
        if not self.initialized or self.interpreter is None:
            return []

        return await asyncio.get_event_loop().run_in_executor(self.executor, self._run_inference, waveform)

    def _run_inference(self, waveform: np.ndarray[Any, Any]) -> list[tuple[str, float]]:
        if self.interpreter is None:
            return []

        input_data = waveform.astype(np.float32)

        self.interpreter.set_tensor(self.input_details[0]["index"], input_data)
        self.interpreter.invoke()

        # YAMNet outputs [num_frames, num_classes]
        scores: np.ndarray[Any, Any] = self.interpreter.get_tensor(self.output_details[0]["index"])

        avg_scores: np.ndarray[Any, Any] = np.mean(scores, axis=0)

        results: list[tuple[str, float]] = []
        for i, score in enumerate(avg_scores):
            if i < len(self.labels):
                results.append((self.labels[i], float(score)))

        return results

    async def close(self) -> None:
        self.closed = True
        self.initialized = False
        if self._init_task is not None:
            self._init_task.cancel()
            self._init_task = None
        self.interpreter = None
        self.labels = []
        if self.executor:
            self.executor.shutdown(wait=False)
            self.executor = None

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
