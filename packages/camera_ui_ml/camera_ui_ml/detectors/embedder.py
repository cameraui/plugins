from __future__ import annotations

from camera_ui_sdk import LoggerService

from ..align import warp_face
from ..backend import InputSpec, NDArray, Normalize
from ..geometry import Box, square_box
from ..model_manager import BaseModelManager
from ..parsing import FaceLandmarks, l2_normalize
from ..preprocess import crop_rgb, frame_to_rgb
from .base import BaseDetector

# whole-picture enrolment against a live crop: cosine 0.14, located and cut like this: 1.00
FACE_PADDING = 0.25


class Embedder(BaseDetector):
    def __init__(
        self,
        manager: BaseModelManager,
        logger: LoggerService,
        *,
        size: int = 160,
        normalize: Normalize = "facenet",
        aligned: bool = False,
        name: str = "face embedder",
    ) -> None:
        super().__init__(manager, logger)
        self.name = name
        self.input_size = (size, size)
        self.normalize = normalize
        # ArcFace-style heads expect the canonical 112x112 template, a plain box
        # crop drops them from 51% to near zero
        self.aligned = aligned

    @property
    def _spec(self) -> InputSpec:
        return InputSpec(self.input_size[0], self.input_size[1], layout="nchw", normalize=self.normalize)

    async def embed(self, image: NDArray) -> list[float]:
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

    async def embed_face(self, crop: NDArray, landmarks: FaceLandmarks | None) -> list[float]:
        if not self._ready() or crop.size == 0 or landmarks is None:
            return []
        if self.aligned:
            return await self.embed(warp_face(crop, landmarks.points, self.input_size[0]))
        box = square_box(landmarks.box, crop.shape[1], crop.shape[0], FACE_PADDING)
        return await self.embed(crop_rgb(crop, box))
