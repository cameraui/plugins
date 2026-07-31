from __future__ import annotations

from typing import TYPE_CHECKING

from camera_ui_sdk import CameraDevice

from sensor import WyzeMotionSensor

if TYPE_CHECKING:
    from wyzeapy.services.camera_service import Camera as WyzeCamera
    from wyzeapy.services.camera_service import CameraService


class Camera:
    def __init__(
        self,
        wyze_camera: WyzeCamera,
        camera_service: CameraService,
        camera_device: CameraDevice,
    ) -> None:
        self._camera_device = camera_device
        self._motion_sensor = WyzeMotionSensor(camera_service, wyze_camera)

    async def initialize(self) -> None:
        await self._camera_device.addSensor(self._motion_sensor)
        await self._camera_device.connect()
