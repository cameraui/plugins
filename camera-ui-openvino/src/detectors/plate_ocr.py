from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from typing import TYPE_CHECKING, Any

import numpy as np
from PIL import Image

from defaults import OCR_ALPHABET, OCR_INPUT_HEIGHT, OCR_INPUT_WIDTH, OCR_MAX_SLOTS, OCR_PAD_CHAR

if TYPE_CHECKING:
    from model_manager import ModelManager


class OcrResult:
    def __init__(self, text: str, confidence: float) -> None:
        self.text = text
        self.confidence = confidence


class PlateOCR:
    def __init__(self, manager: ModelManager) -> None:
        self.manager = manager
        self.initialized = False
        self.executor: ThreadPoolExecutor | None = ThreadPoolExecutor(max_workers=2)

        self.model: Any = None

        self.closed = False
        self._init_task: asyncio.Task[None] | None = None

    async def initialize(self, model_name: str) -> None:
        if self.initialized:
            return
        if self._init_task is None:
            self._init_task = asyncio.create_task(self._do_initialize(model_name))
        await self._init_task

    async def _do_initialize(self, model_name: str) -> None:
        try:
            self.model = await self.manager.ensure_model(model_name)
            if self.closed:
                return

            self.initialized = True
            self.manager.logger.success(f"Loaded OCR: {model_name}")
        except Exception as e:
            self.manager.logger.error(f"Failed to initialize plate OCR: {e}")
        finally:
            self._init_task = None

    async def recognize(self, plate_image: Image.Image) -> OcrResult | None:
        if not self.initialized or self.model is None:
            return None

        resized = plate_image.convert("RGB").resize((OCR_INPUT_WIDTH, OCR_INPUT_HEIGHT))
        # CCT IR input is uint8 NHWC [1, 64, 128, 3] (0-255).
        input_array = np.expand_dims(np.asarray(resized, dtype=np.uint8), axis=0)
        resized.close()

        outputs = await asyncio.get_event_loop().run_in_executor(self.executor, self._predict, input_array)
        return self._decode_output(outputs)

    async def recognize_from_crop(
        self, frame_data: bytes, width: int, height: int, box: tuple[float, float, float, float]
    ) -> OcrResult | None:
        if not self.initialized or self.model is None:
            return None

        x1, y1, x2, y2 = (
            max(0, int(box[0])),
            max(0, int(box[1])),
            min(width, int(box[2])),
            min(height, int(box[3])),
        )
        if x2 <= x1 or y2 <= y1:
            return None

        np_array: np.ndarray[Any, Any] = np.frombuffer(frame_data, dtype=np.uint8).reshape((height, width, 3))
        image = Image.fromarray(np_array[y1:y2, x1:x2], mode="RGB")
        result = await self.recognize(image)
        image.close()
        return result

    async def recognize_batch(self, plate_images: list[Image.Image]) -> list[OcrResult | None]:
        if not self.initialized or self.model is None:
            return [None for _ in plate_images]
        return [await self.recognize(img) for img in plate_images]

    async def close(self) -> None:
        self.closed = True
        if self._init_task:
            self._init_task.cancel()
            self._init_task = None
        self.initialized = False
        self.model = None
        if self.executor:
            self.executor.shutdown(wait=False)
            self.executor = None

    def _predict(self, input_array: np.ndarray[Any, Any]) -> list[np.ndarray[Any, Any]]:
        result = self.model([input_array])
        return [np.array(result[port]) for port in self.model.outputs]

    @staticmethod
    def _decode_output(outputs: list[np.ndarray[Any, Any]]) -> OcrResult | None:
        plate_logits = None
        for arr in outputs:
            if arr.ndim == 3 and arr.shape[1] == OCR_MAX_SLOTS:
                plate_logits = arr[0]

        if plate_logits is None:
            return None

        char_indices = np.argmax(plate_logits, axis=1)
        exp_logits = np.exp(plate_logits - np.max(plate_logits, axis=1, keepdims=True))
        softmax = exp_logits / np.sum(exp_logits, axis=1, keepdims=True)
        char_confidences = np.array([softmax[i, char_indices[i]] for i in range(OCR_MAX_SLOTS)])

        text = ""
        confidences: list[float] = []
        for i in range(OCR_MAX_SLOTS):
            char = OCR_ALPHABET[char_indices[i]]
            if char == OCR_PAD_CHAR:
                break
            text += char
            confidences.append(float(char_confidences[i]))

        if not text:
            return None

        return OcrResult(text=text, confidence=sum(confidences) / len(confidences) if confidences else 0.0)
