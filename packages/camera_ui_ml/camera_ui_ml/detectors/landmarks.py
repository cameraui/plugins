from __future__ import annotations

from camera_ui_sdk import LoggerService

from ..backend import InputSpec, NDArray
from ..model_manager import BaseModelManager
from ..parsing import FaceLandmarks, parse_yunet
from .base import BaseDetector

FACE_SURE_AT = 0.8


class LandmarkDetector(BaseDetector):
    def __init__(
        self,
        manager: BaseModelManager,
        logger: LoggerService,
        *,
        size: int = 256,
        threshold: float = FACE_SURE_AT,
        name: str = "face landmarks",
    ) -> None:
        super().__init__(manager, logger)
        self.name = name
        self.input_size = (size, size)
        self.threshold = threshold

    @property
    def _spec(self) -> InputSpec:
        # YuNet is trained on raw 0-255 BGR; feeding RGB halves the hit rate
        return InputSpec(
            self.input_size[0], self.input_size[1], layout="nchw", normalize="none", channels="bgr"
        )

    async def _configure(self, model_name: str) -> None:
        assert self.backend is not None
        self.input_size = self.backend.input_size

    async def points(self, crop: NDArray) -> FaceLandmarks | None:
        if not self._ready() or crop.size == 0:
            return None
        assert self.backend is not None

        width, height = self.input_size
        outputs = await self.backend.run(crop, self._spec)
        found = parse_yunet(outputs, width, self.threshold)
        if not found:
            return None

        best = max(found, key=lambda candidate: candidate.score)
        scale_x, scale_y = crop.shape[1] / width, crop.shape[0] / height
        return FaceLandmarks(
            score=best.score,
            box=(best.box[0] * scale_x, best.box[1] * scale_y, best.box[2] * scale_x, best.box[3] * scale_y),
            points=best.points * (scale_x, scale_y),
        )
