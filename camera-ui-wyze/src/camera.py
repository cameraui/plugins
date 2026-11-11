from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING
from urllib.parse import urlencode

from camera_ui_sdk import CameraDevice

from sensor import WyzeMotionSensor

if TYPE_CHECKING:
    from wyzeapy.services.camera_service import Camera as WyzeCamera
    from wyzeapy.services.camera_service import CameraService


class WyzeStreaming:
    def __init__(self, wyze_camera: Callable[[], WyzeCamera], camera_device: CameraDevice) -> None:
        self._wyze_camera = wyze_camera
        self._camera_device = camera_device

    async def streamUrl(self, source_id: str) -> str:
        source = self._camera_device.getSourceById(source_id)
        camera = self._wyze_camera()
        # device_params follow the account, so a new IP from the router is picked up
        params = {
            "uid": camera.device_params.get("p2p_id", ""),
            "enr": getattr(camera, "enr", camera.raw_dict.get("enr", "")),
            "mac": camera.mac,
            "model": camera.product_model,
            "dtls": "true" if camera.device_params.get("dtls", 0) == 1 else "false",
            "subtype": "sd" if source and source.role == "low-resolution" else "hd",
        }
        return f"wyze://{camera.device_params.get('ip', '')}?{urlencode(params)}"


class Camera:
    def __init__(
        self,
        wyze_camera: WyzeCamera,
        camera_service: CameraService,
        camera_device: CameraDevice,
    ) -> None:
        self.wyze_camera = wyze_camera
        self._camera_service = camera_service
        self._camera_device = camera_device
        self._motion_sensor: WyzeMotionSensor | None = None

    async def initialize(self) -> None:
        await self._camera_device.implement(WyzeStreaming(lambda: self.wyze_camera, self._camera_device))
        await self._attach()

    async def bind(self, wyze_camera: WyzeCamera, camera_service: CameraService) -> None:
        await self.unbind()
        self.wyze_camera = wyze_camera
        self._camera_service = camera_service
        await self._attach()

    async def unbind(self) -> None:
        if self._motion_sensor:
            await self._camera_device.removeSensor(self._motion_sensor.id)
            self._motion_sensor = None
        await self._camera_device.disconnect()

    async def _attach(self) -> None:
        self._motion_sensor = WyzeMotionSensor(self._camera_service, self.wyze_camera)
        await self._camera_device.addSensor(self._motion_sensor)
        await self._camera_device.connect()
