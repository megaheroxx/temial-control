"""Shared entity helpers."""

from __future__ import annotations

from collections.abc import Callable, Iterable
import time
from typing import Any

from homeassistant.core import callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity import Entity
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import BREW_STALE_SECONDS, DOMAIN
from .coordinator import TemialConfigEntry, TemialCoordinator


def device_status(device: dict[str, Any]) -> dict[str, Any]:
    """Return the latest deviceStatus message (empty if none yet)."""
    return device.get("deviceStatus") or {}


def brew_status(device: dict[str, Any]) -> dict[str, Any]:
    """Return the latest brewStatus message (empty if none yet)."""
    return device.get("brewStatus") or {}


def is_brewing(device: dict[str, Any]) -> bool:
    """Whether a brew is running, based on a recent brew status with time left."""
    received_ms = device.get("brewStatusAt") or 0
    recent = time.time() * 1000 - received_ms < BREW_STALE_SECONDS * 1000
    return recent and (brew_status(device).get("remainingTotalTime") or 0) > 0


class TemialEntity(CoordinatorEntity[TemialCoordinator]):
    """Base entity bound to one Temial (by serial number)."""

    _attr_has_entity_name = True
    # Most values are meaningless while the device is offline.
    _requires_connection = True

    def __init__(self, coordinator: TemialCoordinator, serial_number: str, key: str) -> None:
        super().__init__(coordinator)
        self._serial_number = serial_number
        self._attr_unique_id = f"{serial_number}_{key}"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, serial_number)},
            name=f"Temial {serial_number}",
            manufacturer="Vorwerk",
            model="Temial",
            serial_number=serial_number,
            sw_version=device_status(self.device).get("softwareVersion"),
            configuration_url=coordinator.api.url,
        )

    @property
    def device(self) -> dict[str, Any]:
        """Latest state of this device as reported by the app."""
        return self.coordinator.data.devices.get(self._serial_number, {})

    @property
    def available(self) -> bool:
        if not super().available or not self.device:
            return False
        return bool(self.device.get("connected")) or not self._requires_connection


def async_track_devices(
    entry: TemialConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
    factory: Callable[[TemialCoordinator, str], Iterable[Entity]],
) -> None:
    """Add entities for every device, including devices that show up later."""
    coordinator = entry.runtime_data
    known: set[str] = set()

    @callback
    def add_new_devices() -> None:
        new = [serial for serial in coordinator.data.devices if serial not in known]
        if not new:
            return
        known.update(new)
        async_add_entities([entity for serial in new for entity in factory(coordinator, serial)])

    add_new_devices()
    entry.async_on_unload(coordinator.async_add_listener(add_new_devices))
