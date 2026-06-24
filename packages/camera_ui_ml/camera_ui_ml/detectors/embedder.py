from __future__ import annotations

from camera_ui_sdk import LoggerService

from ..backend import InputSpec, NDArray
from ..geometry import Box
from ..model_manager import BaseModelManager
from ..parsing import l2_normalize
from ..preprocess import frame_to_rgb
from .base import BaseDetector


class Embedder(BaseDetector):
    def __init__(
        self,
        manager: BaseModelManager,
        logger: LoggerService,
        *,
        size: int = 160,
        name: str = "face embedder",
    ) -> None:
        super().__init__(manager, logger)
        self.name = name
        self.input_size = (size, size)

    @property
    def _spec(self) -> InputSpec:
        return InputSpec(self.input_size[0], self.input_size[1], layout="nchw", normalize="facenet")

    async def embed(self, image: NDArray) -> list[float]:
        """Embed an HWC uint8 RGB face crop."""
        if not self._ready():
            return []
        assert self.backend is not None
        outputs = await self.backend.run(image, self._spec)
        return [float(value) for value in l2_normalize(outputs[0])]

    async def embed_from_crop(self, frame_data: bytes, width: int, height: int, box: Box) -> list[float]:
        if not self._ready():
            return []

        x1 = max(0, int(box[0]))
        y1 = max(0, int(box[1]))
        x2 = min(width, int(box[2]))
        y2 = min(height, int(box[3]))
        if x2 <= x1 or y2 <= y1:
            return []

        rgb = frame_to_rgb(frame_data, width, height)
        return await self.embed(rgb[y1:y2, x1:x2])
