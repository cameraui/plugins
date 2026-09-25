from __future__ import annotations

import numpy as np
from camera_ui_sdk import LoggerService
from PIL import Image

from ..backend import InputSpec, NDArray
from ..model_manager import BaseModelManager
from ..parsing import l2_normalize
from .base import BaseDetector


class PersonEmbedder(BaseDetector):
    def __init__(
        self,
        manager: BaseModelManager,
        logger: LoggerService,
        *,
        width: int = 128,
        height: int = 256,
        name: str = "person embedder",
    ) -> None:
        super().__init__(manager, logger)
        self.name = name
        self.input_size = (width, height)

    @property
    def _spec(self) -> InputSpec:
        # the re-ID graph takes raw 0-255 RGB and normalizes inside
        return InputSpec(self.input_size[0], self.input_size[1], layout="nchw", normalize="none")

    async def embed(self, rgb: NDArray) -> list[float]:
        if not self._ready() or rgb.size == 0:
            return []
        assert self.backend is not None

        width, height = self.input_size
        if rgb.shape[1] != width or rgb.shape[0] != height:
            # stretched, never padded: the model was measured on the tight box, resized bilinear
            rgb = np.asarray(
                Image.fromarray(rgb, mode="RGB").resize((width, height), Image.Resampling.BILINEAR)
            )
        outputs = await self.backend.run(rgb, self._spec)
        return [float(value) for value in l2_normalize(outputs[0])]
