from __future__ import annotations

from typing import TYPE_CHECKING, TypedDict

from camera_ui_ml import model_runtime, reset_stored_settings, segment_objects
from camera_ui_sdk import (
    JsonSchema,
    ModelSpec,
    SegmentationFrame,
    SegmentationResult,
    SegmenterSensor,
)

from defaults import DEFAULT_OPTION, DEFAULT_SEGMENTATION_MODEL, SEGMENTATION_MODELS, resolve_model

if TYPE_CHECKING:
    from camera_ui_sdk import LoggerService

    from main import NCNNPlugin


class SegmenterStorageValues(TypedDict):
    model: str


class NCNNSegmenterSensor(SegmenterSensor["SegmenterStorageValues"]):
    def __init__(self, plugin: NCNNPlugin, logger: LoggerService, name: str = "NCNN Segmenter") -> None:
        super().__init__(name)
        self._plugin = plugin
        self._logger = logger

    @property
    def storage_schema(self) -> list[JsonSchema]:
        return [
            {
                "type": "string",
                "key": "model",
                "title": "Model",
                "description": "Model that outlines people, vehicles and animals",
                "group": "Segmentation",
                "enum": [DEFAULT_OPTION, *SEGMENTATION_MODELS],
                "store": True,
                "defaultValue": DEFAULT_OPTION,
                "required": True,
                "onSet": self._on_change_model,
            },
            {
                "type": "button",
                "key": "reset_defaults",
                "title": "Reset to Defaults",
                "description": "Reset all settings to their default values",
                "group": "Segmentation",
                "color": "danger",
                "onSet": self._reset_settings,
            },
        ]

    @property
    def modelSpec(self) -> ModelSpec:
        return {
            "input": {"width": 320, "height": 320, "format": "rgb"},
            "triggerLabels": ["person", "vehicle", "animal"],
            **model_runtime((self._plugin.segmenters.get(self._model()), "segment")),
        }

    async def segmentObjects(self, frames: list[SegmentationFrame]) -> list[SegmentationResult]:
        segmenter = self._plugin.segmenters.get(self._model())
        if segmenter is None or not segmenter.initialized:
            return [{} for _ in frames]
        return await segment_objects(segmenter, frames)

    async def destroy(self) -> None:
        pass

    async def on_start(self) -> None:
        await self._plugin.get_segmenter(self._model())
        self.updateModelSpec()

    async def _on_change_model(self, new_model: str, _old_model: str) -> None:
        if new_model != _old_model:
            resolved = resolve_model(new_model, DEFAULT_SEGMENTATION_MODEL)
            await self._plugin.get_segmenter(resolved)
            self.updateModelSpec()
            self._logger.log(f"Segmentation model changed to {resolved}")

    async def _reset_settings(self) -> None:
        await reset_stored_settings(self.storage)
        self._logger.log("Settings reset to defaults")

    def _model(self) -> str:
        return resolve_model(self.storage.values.get("model"), DEFAULT_SEGMENTATION_MODEL)
