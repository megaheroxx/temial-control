"""Data coordinator: polls the app and applies live updates from its event stream."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, replace
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .api import TemialApi, TemialApiError, TemialAuthError
from .const import DOMAIN, LOGGER, POLL_INTERVAL

RECONNECT_MIN_SECONDS = 5
RECONNECT_MAX_SECONDS = 300

type TemialConfigEntry = ConfigEntry[TemialCoordinator]


@dataclass(frozen=True)
class TemialData:
    """Latest state of all devices and presets, keyed by serial number."""

    devices: dict[str, dict[str, Any]]
    presets: list[dict[str, Any]]


class TemialCoordinator(DataUpdateCoordinator[TemialData]):
    """Keeps device and preset data of one Temial Control instance."""

    config_entry: TemialConfigEntry

    def __init__(self, hass: HomeAssistant, entry: TemialConfigEntry, api: TemialApi) -> None:
        super().__init__(hass, LOGGER, config_entry=entry, name=DOMAIN, update_interval=POLL_INTERVAL)
        self.api = api

    async def _async_update_data(self) -> TemialData:
        try:
            devices = await self.api.get_devices()
            presets = await self.api.get_presets()
        except TemialAuthError as err:
            raise ConfigEntryAuthFailed(str(err)) from err
        except TemialApiError as err:
            raise UpdateFailed(str(err)) from err
        return TemialData({device["serialNumber"]: device for device in devices}, presets)

    async def async_listen_events(self) -> None:
        """Follow the event stream forever, reconnecting with backoff."""
        delay = RECONNECT_MIN_SECONDS
        while True:
            try:
                async for event, payload in self.api.events():
                    delay = RECONNECT_MIN_SECONDS
                    if event == "device":
                        self._apply_devices([payload])
                    elif event == "snapshot":
                        self._apply_devices(payload.get("devices", []))
            except TemialAuthError:
                # Polling raises ConfigEntryAuthFailed and starts the reauth flow.
                LOGGER.debug("Event stream rejected the token")
            except Exception as err:  # noqa: BLE001 - any failure of the stream just means reconnect
                LOGGER.debug("Event stream interrupted: %s", err)
            await asyncio.sleep(delay)
            delay = min(delay * 2, RECONNECT_MAX_SECONDS)

    def _apply_devices(self, devices: list[dict[str, Any]]) -> None:
        if self.data is None or not devices:
            return
        merged = {**self.data.devices, **{device["serialNumber"]: device for device in devices}}
        self.async_set_updated_data(replace(self.data, devices=merged))
