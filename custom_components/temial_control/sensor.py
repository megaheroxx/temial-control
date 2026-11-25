"""Sensors for Temial Control."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorEntityDescription,
    SensorStateClass,
)
from homeassistant.const import EntityCategory, UnitOfTemperature, UnitOfTime, UnitOfVolume
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.helpers.typing import StateType

from .coordinator import TemialConfigEntry, TemialCoordinator
from .entity import TemialEntity, async_track_devices, brew_status, device_status, is_brewing


@dataclass(frozen=True, kw_only=True)
class TemialSensorDescription(SensorEntityDescription):
    """Describes a Temial sensor."""

    value_fn: Callable[[dict[str, Any]], StateType]


def _while_brewing(key: str) -> Callable[[dict[str, Any]], StateType]:
    return lambda device: brew_status(device).get(key) if is_brewing(device) else None


SENSORS: tuple[TemialSensorDescription, ...] = (
    TemialSensorDescription(
        key="remaining_time",
        translation_key="remaining_time",
        device_class=SensorDeviceClass.DURATION,
        native_unit_of_measurement=UnitOfTime.SECONDS,
        value_fn=lambda device: brew_status(device).get("remainingTotalTime") if is_brewing(device) else 0,
    ),
    TemialSensorDescription(
        key="temperature",
        translation_key="temperature",
        device_class=SensorDeviceClass.TEMPERATURE,
        state_class=SensorStateClass.MEASUREMENT,
        native_unit_of_measurement=UnitOfTemperature.CELSIUS,
        # The device reports values like 72.19999 °C.
        suggested_display_precision=0,
        value_fn=_while_brewing("temperature"),
    ),
    TemialSensorDescription(
        key="pumped_volume",
        translation_key="pumped_volume",
        device_class=SensorDeviceClass.VOLUME,
        native_unit_of_measurement=UnitOfVolume.MILLILITERS,
        suggested_display_precision=0,
        value_fn=_while_brewing("pumpedVolume"),
    ),
    TemialSensorDescription(
        key="last_tea",
        translation_key="last_tea",
        value_fn=lambda device: (device.get("lastBrew") or {}).get("name"),
    ),
    TemialSensorDescription(
        key="brew_phase",
        translation_key="brew_phase",
        entity_category=EntityCategory.DIAGNOSTIC,
        value_fn=_while_brewing("phase"),
    ),
    TemialSensorDescription(
        key="wifi_signal",
        translation_key="wifi_signal",
        entity_category=EntityCategory.DIAGNOSTIC,
        state_class=SensorStateClass.MEASUREMENT,
        value_fn=lambda device: device_status(device).get("wiFiSignalStrength"),
    ),
    TemialSensorDescription(
        key="firmware",
        translation_key="firmware",
        entity_category=EntityCategory.DIAGNOSTIC,
        value_fn=lambda device: device_status(device).get("softwareVersion"),
    ),
    TemialSensorDescription(
        key="water_hardness",
        translation_key="water_hardness",
        entity_category=EntityCategory.DIAGNOSTIC,
        value_fn=lambda device: device_status(device).get("waterHardness"),
    ),
)


async def async_setup_entry(
    hass: HomeAssistant, entry: TemialConfigEntry, async_add_entities: AddConfigEntryEntitiesCallback
) -> None:
    """Set up sensors for every Temial."""
    async_track_devices(
        entry,
        async_add_entities,
        lambda coordinator, serial: (TemialSensor(coordinator, serial, description) for description in SENSORS),
    )


class TemialSensor(TemialEntity, SensorEntity):
    """A value reported by a Temial."""

    entity_description: TemialSensorDescription

    def __init__(self, coordinator: TemialCoordinator, serial_number: str, description: TemialSensorDescription) -> None:
        super().__init__(coordinator, serial_number, description.key)
        self.entity_description = description

    @property
    def native_value(self) -> StateType:
        return self.entity_description.value_fn(self.device)
