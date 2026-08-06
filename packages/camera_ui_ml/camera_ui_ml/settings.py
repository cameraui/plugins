from __future__ import annotations

from typing import Any, cast

from camera_ui_sdk import DeviceStorage


async def reset_stored_settings(storage: DeviceStorage[Any]) -> None:
    for schema in storage.schemas:
        entry = cast("dict[str, Any]", schema)
        if entry.get("store") and "defaultValue" in entry:
            await storage.setValue(entry["key"], entry["defaultValue"])
