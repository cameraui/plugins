from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from camera_ui_sdk import ModelRuntime


def model_runtime(*loaded: tuple[Any | None, str]) -> ModelRuntime:
    runtime: ModelRuntime = {}
    models = []
    framework: str | None = None

    for holder, role in loaded:
        if holder is None:
            continue

        if hasattr(holder, "loaded_models"):
            models.extend(holder.loaded_models(role))
        elif (entry := holder.loaded_model(role)) is not None:
            models.append(entry)

        for backend in (
            getattr(holder, "backend", None),
            getattr(holder, "vision", None),
        ):
            if framework is None and backend is not None and backend.runtime:
                framework = backend.runtime

    if models:
        runtime["models"] = models
    if framework:
        runtime["runtime"] = framework

    return runtime
