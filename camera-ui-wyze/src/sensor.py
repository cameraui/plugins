from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from camera_ui_sdk import MotionSensor

if TYPE_CHECKING:
    from wyzeapy.services.camera_service import Camera as WyzeCamera
    from wyzeapy.services.camera_service import CameraService


class WyzeMotionSensor(MotionSensor):
    def __init__(self, camera_service: CameraService, wyze_camera: WyzeCamera) -> None:
        super().__init__("Wyze Motion")
        self._camera_service = camera_service
        self._wyze_camera = wyze_camera
        self._last_event_ts: int = 0
        self._loop: asyncio.AbstractEventLoop | None = None

    async def on_start(self) -> None:
        self._loop = asyncio.get_running_loop()
        await self._camera_service.register_for_updates(self._wyze_camera, self._on_camera_update)

    async def on_stop(self) -> None:
        await self._camera_service.deregister_for_updates(self._wyze_camera)
        self._loop = None

    def _on_camera_update(self, camera: WyzeCamera) -> None:
        # Called from wyzeapy's updater thread — hop back to the asyncio loop.
        if self._loop and self._loop.is_running():
            self._loop.call_soon_threadsafe(self._update_from_camera, camera)

    def _update_from_camera(self, camera: WyzeCamera) -> None:
        if camera.last_event_ts > self._last_event_ts:
            self.reportDetections(True)
            self._last_event_ts = camera.last_event_ts
        else:
            self.reportDetections(False)
