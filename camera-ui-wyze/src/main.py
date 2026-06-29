from __future__ import annotations

from functools import partial
from typing import Any
from urllib.parse import urlencode

from camera_ui_sdk import (
    API_EVENT,
    BasePlugin,
    CameraConfig,
    CameraConfigInputSettings,
    CameraDevice,
    DeviceStorage,
    DiscoveredCamera,
    DiscoveryProvider,
    FormSubmitResponse,
    JsonSchema,
    JsonSchemaWithoutCallbacks,
    LoggerService,
    PluginAPI,
)
from wyzeapy import Wyzeapy
from wyzeapy.services.camera_service import Camera as WyzeCamera
from wyzeapy.services.camera_service import CameraService
from wyzeapy.wyze_auth_lib import Token

from camera import Camera
from wyze_types import WyzeConfig


class Wyze(BasePlugin[WyzeConfig], DiscoveryProvider):
    def __init__(self, logger: LoggerService, api: PluginAPI, storage: DeviceStorage[WyzeConfig]) -> None:
        super().__init__(logger, api, storage)

        self._wyze_client: Wyzeapy | None = None
        self._camera_service: CameraService | None = None

        self._wyze_cameras: dict[str, WyzeCamera] = {}  # mac -> WyzeCamera
        self._camera_controllers: dict[str, Camera] = {}  # mac -> Camera
        self._existing_cameras: dict[str, CameraDevice] = {}  # cameraId -> CameraDevice

        self.api.on(API_EVENT.FINISH_LAUNCHING, self._start)
        self.api.on(API_EVENT.SHUTDOWN, self._stop)

    @property
    def storage_schema(self) -> list[JsonSchema]:
        return [
            {
                "type": "string",
                "key": "username",
                "title": "Email",
                "description": "Wyze account email",
                "format": "email",
                "required": True,
                "store": True,
            },
            {
                "type": "string",
                "key": "password",
                "title": "Password",
                "description": "Wyze account password",
                "format": "password",
                "required": True,
                "store": True,
            },
            {
                "type": "string",
                "key": "apiId",
                "title": "API ID",
                "description": "Wyze Developer API ID (from developer.wyze.com)",
                "required": True,
                "store": True,
            },
            {
                "type": "string",
                "key": "apiKey",
                "title": "API Key",
                "description": "Wyze Developer API Key (from developer.wyze.com)",
                "required": True,
                "store": True,
            },
            {
                "type": "string",
                "key": "accessToken",
                "title": "Access Token",
                "description": "Wyze API Access Token",
                "hidden": True,
                "store": True,
            },
            {
                "type": "string",
                "key": "refreshToken",
                "title": "Refresh Token",
                "description": "Wyze API Refresh Token",
                "hidden": True,
                "store": True,
            },
            {
                "type": "submit",
                "key": "onLogin",
                "title": "Login",
                "description": "Login to Wyze",
                "color": "success",
                "onClick": partial(self._on_form_submit, "onLogin"),
            },
        ]

    async def onDiscoverCameras(self) -> list[DiscoveredCamera]:
        return self._get_discovered_cameras()

    async def onGetCameraSettings(self, camera: DiscoveredCamera) -> list[JsonSchemaWithoutCallbacks]:
        return []

    async def onAdoptCamera(
        self, camera: DiscoveredCamera, cameraSettings: dict[str, object]
    ) -> CameraConfig:
        mac = camera["id"].replace("wyze:", "")
        wyze_camera = self._wyze_cameras.get(mac)

        if not wyze_camera:
            raise ValueError(f"Wyze camera {mac} not found")

        stream_url = self._build_wyze_url(wyze_camera)
        sd_url = self._build_wyze_url(wyze_camera, subtype="sd")

        sources: list[CameraConfigInputSettings] = [
            {
                "name": "HD Stream",
                "role": "high-resolution",
                "urls": [stream_url],
                "useForSnapshot": True,
                "hotMode": False,
                "preload": False,
            },
            {
                "name": "SD Stream",
                "role": "low-resolution",
                "urls": [sd_url],
                "useForSnapshot": False,
                "hotMode": False,
                "preload": False,
            },
        ]

        return {
            "name": wyze_camera.nickname,
            "nativeId": mac,
            "isCloud": False,
            "info": {
                "manufacturer": "Wyze",
                "model": wyze_camera.product_model,
                "hardware": wyze_camera.product_model,
                "firmwareVersion": getattr(wyze_camera, "firmware_ver", ""),
            },
            "sources": sources,
        }

    async def configureCameras(self, cameras: list[CameraDevice]) -> None:
        for camera in cameras:
            self._existing_cameras[camera.id] = camera

    async def onCameraAdded(self, camera: CameraDevice) -> None:
        self._existing_cameras[camera.id] = camera

        mac = camera.nativeId
        if not mac:
            self.logger.warn(f"Camera {camera.name} has no nativeId")
            return

        wyze_camera = self._wyze_cameras.get(mac)
        if wyze_camera and self._camera_service:
            await self._initialize_camera(wyze_camera, camera)

    async def onCameraReleased(self, cameraId: str) -> None:
        camera_device = self._existing_cameras.pop(cameraId, None)
        if camera_device and camera_device.nativeId:
            self._camera_controllers.pop(camera_device.nativeId, None)

            wyze_camera = self._wyze_cameras.get(camera_device.nativeId)
            if wyze_camera:
                await self.api.deviceManager.pushDiscoveredCameras([self._to_discovered_camera(wyze_camera)])

    async def _start(self) -> None:
        if self.storage.values.get("accessToken") and self.storage.values.get("refreshToken"):
            try:
                await self._connect()
            except Exception as e:
                self.logger.error(f"Failed to connect to Wyze: {e}")

    async def _stop(self) -> None:
        self._camera_controllers.clear()
        self._wyze_cameras.clear()
        self._wyze_client = None
        self._camera_service = None

    async def _connect(self) -> None:
        self._wyze_client = await Wyzeapy.create()

        token = None
        access_token: str | None = self.storage.values.get("accessToken")
        refresh_token: str | None = self.storage.values.get("refreshToken")

        if access_token and refresh_token:
            token = Token(access_token=access_token, refresh_token=refresh_token)

        await self._wyze_client.login(
            self.storage.values["username"],
            self.storage.values["password"],
            self.storage.values["apiId"],
            self.storage.values["apiKey"],
            token,
        )

        self._wyze_client.register_for_token_callback(self._on_token_update)

        self._camera_service = await self._wyze_client.camera_service
        cameras = await self._camera_service.get_cameras()

        await self._update_discovered_cameras(cameras)

    def _on_token_update(self, token: Token) -> None:
        self.storage.values["accessToken"] = token.access_token
        self.storage.values["refreshToken"] = token.refresh_token
        self.storage.save()

    async def _update_discovered_cameras(self, cameras: list[WyzeCamera]) -> None:
        for camera in cameras:
            self._wyze_cameras[camera.mac] = camera

            await self._initialize_existing_camera(camera)

        await self._push_discovered_cameras()

    async def _initialize_existing_camera(self, wyze_camera: WyzeCamera) -> None:
        mac = wyze_camera.mac
        if mac in self._camera_controllers:
            return

        camera_device = next((c for c in self._existing_cameras.values() if c.nativeId == mac), None)

        if camera_device and self._camera_service:
            await self._initialize_camera(wyze_camera, camera_device)

    async def _initialize_camera(self, wyze_camera: WyzeCamera, camera_device: CameraDevice) -> None:
        if wyze_camera.mac in self._camera_controllers:
            return

        if not self._camera_service:
            return

        controller = Camera(wyze_camera, self._camera_service, camera_device)
        await controller.initialize()
        self._camera_controllers[wyze_camera.mac] = controller
        self.logger.log(f"Initialized camera: {wyze_camera.nickname}")

    async def _push_discovered_cameras(self) -> None:
        discovered = self._get_discovered_cameras()
        if discovered:
            await self.api.deviceManager.pushDiscoveredCameras(discovered)

    def _get_discovered_cameras(self) -> list[DiscoveredCamera]:
        discovered: list[DiscoveredCamera] = []

        for mac, wyze_camera in self._wyze_cameras.items():
            if any(c.nativeId == mac for c in self._existing_cameras.values()):
                continue

            discovered.append(self._to_discovered_camera(wyze_camera))

        return discovered

    def _to_discovered_camera(self, camera: WyzeCamera) -> DiscoveredCamera:
        return {
            "id": f"wyze:{camera.mac}",
            "name": camera.nickname,
            "manufacturer": "Wyze",
            "model": camera.product_model,
        }

    def _build_wyze_url(self, camera: WyzeCamera, subtype: str = "hd") -> str:
        params: dict[str, Any] = {
            "uid": camera.device_params.get("p2p_id", ""),
            "enr": getattr(camera, "enr", camera.raw_dict.get("enr", "")),
            "mac": camera.mac,
            "model": camera.product_model,
            "dtls": "true" if camera.device_params.get("dtls", 0) == 1 else "false",
            "subtype": subtype,
        }
        ip = camera.device_params.get("ip", "")
        return f"wyze://{ip}?{urlencode(params)}"

    async def _on_form_submit(self, action_id: str, values: WyzeConfig) -> FormSubmitResponse | None:
        if action_id != "onLogin":
            return None

        try:
            self._wyze_client = await Wyzeapy.create()
            await self._wyze_client.login(
                values["username"],
                values["password"],
                values["apiId"],
                values["apiKey"],
            )

            self.storage.values = values
            self.storage.save()

            self._wyze_client.register_for_token_callback(self._on_token_update)

            self._camera_service = await self._wyze_client.camera_service
            cameras = await self._camera_service.get_cameras()
            await self._update_discovered_cameras(cameras)

            return {"toast": {"message": "Logged in successfully!", "type": "success"}}

        except Exception as e:
            self.logger.error(f"Login failed: {e}")
            return {"toast": {"message": f"Login failed: {e}", "type": "error"}}


def __main__() -> type[Wyze]:
    return Wyze
