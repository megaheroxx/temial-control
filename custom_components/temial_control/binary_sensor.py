"""Binary sensors for Temial Control."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
    BinarySensorEntityDescription,
)
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .coordinator import TemialConfigEntry, TemialCoordinator
from .entity import TemialEntity, async_track_devices, device_status, is_brewing


@dataclass(frozen=True, kw_only=True)
class TemialBinarySensorDescription(BinarySensorEntityDescription):
    """Describes a Temial binary sensor."""

    value_fn: Callable[[dict[str, Any]], bool | None]
    requires_connection: bool = True


def _status_flag(key: str, invert: bool = False) -> Callable[[dict[str, Any]], bool | None]:
    def value(device: dict[str, Any]) -> bool | None:
        flag = device_status(device).get(key)
        return None if flag is None else bool(flag) != invert

    return value


BINARY_SENSORS: tuple[TemialBinarySensorDescription, ...] = (
    TemialBinarySensorDescription(
        key="connected",
        translation_key="connected",
        device_class=BinarySensorDeviceClass.CONNECTIVITY,
        entity_category=EntityCategory.DIAGNOSTIC,
        requires_connection=False,
        value_fn=lambda device: bool(device.get("connected")),
    ),
    TemialBinarySensorDescription(
        key="brewing",
        translation_key="brewing",
        device_class=BinarySensorDeviceClass.RUNNING,
        value_fn=is_brewing,
    ),
    TemialBinarySensorDescription(
        key="lid_closed",
        translation_key="lid_closed",
        value_fn=_status_flag("lidClosed"),
    ),
    TemialBinarySensorDescription(
        key="chamber_present",
        translation_key="chamber_present",
        value_fn=_status_flag("chamberPresent"),
    ),
    TemialBinarySensorDescription(
        key="fresh_water_missing",
        translation_key="fresh_water_missing",
        device_class=BinarySensorDeviceClass.PROBLEM,
        value_fn=_status_flag("enoughFreshWater", invert=True),
    ),
    TemialBinarySensorDescription(
        key="waste_tank_full",
        translation_key="waste_tank_full",
        device_class=BinarySensorDeviceClass.PROBLEM,
        value_fn=_status_flag("wasteWaterTankFull"),
    ),
    TemialBinarySensorDescription(
        key="waste_tank_missing",
        translation_key="waste_tank_missing",
        device_class=BinarySensorDeviceClass.PROBLEM,
        value_fn=_status_flag("wasteWaterTankPresent", invert=True),
    ),
)


async def async_setup_entry(
    hass: HomeAssistant, entry: TemialConfigEntry, async_add_entities: AddConfigEntryEntitiesCallback
) -> None:
    """Set up binary sensors for every Temial."""
    async_track_devices(
        entry,
        async_add_entities,
        lambda coordinator, serial: (
            TemialBinarySensor(coordinator, serial, description) for description in BINARY_SENSORS
        ),
    )


class TemialBinarySensor(TemialEntity, BinarySensorEntity):
    """An on/off state reported by a Temial."""

    entity_description: TemialBinarySensorDescription

    def __init__(
        self, coordinator: TemialCoordinator, serial_number: str, description: TemialBinarySensorDescription
    ) -> None:
        super().__init__(coordinator, serial_number, description.key)
        self.entity_description = description
        self._requires_connection = description.requires_connection

    @property
    def is_on(self) -> bool | None:
        return self.entity_description.value_fn(self.device)
