from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal

import numpy as np

from .pipeline import run_prepare

NDArray = np.ndarray[Any, Any]

Layout = Literal["nchw", "nhwc"]
Normalize = Literal["unit", "facenet", "none"]
DType = Literal["float32", "uint8"]

Outputs = Sequence[NDArray]


@dataclass(frozen=True)
class InputSpec:
    width: int
    height: int
    layout: Layout = "nchw"
    normalize: Normalize = "unit"
    dtype: DType = "float32"


class InferenceBackend(ABC):
    @property
    @abstractmethod
    def input_size(self) -> tuple[int, int]: ...

    @abstractmethod
    def metadata(self) -> Mapping[str, str]: ...

    @property
    def device(self) -> str:
        """Human-readable hardware this backend runs on (e.g. "CUDA:0", "CPU")."""
        return "unknown"

    @property
    def runtime(self) -> str | None:
        """Inference framework and version, e.g. "openvino 2025.3.0"."""
        return None

    @property
    def precision(self) -> str | None:
        """Weight precision of the loaded model: "fp32", "fp16", "int8"."""
        return None

    @abstractmethod
    async def infer(self, inputs: Sequence[Any]) -> Outputs: ...

    @abstractmethod
    def close(self) -> None: ...

    def adapt(self, image: NDArray, spec: InputSpec) -> Sequence[Any]:
        """Realize the canonical HWC uint8 RGB image into runtime model inputs."""
        from .preprocess import to_tensor

        return [to_tensor(image, spec)]

    async def run(self, image: NDArray, spec: InputSpec) -> Outputs:
        prepared = await run_prepare(lambda: list(self.adapt(image, spec)))
        return await self.infer(prepared)
