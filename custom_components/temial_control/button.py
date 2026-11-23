"""One "brew" button per preset and Temial."""

from __future__ import annotations

from typing import Any

from homeassistant.components.button import ButtonEntity
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .coordinator import TemialConfigEntry, TemialCoordinator
from .entity import TemialEntity
from .services import async_brew, recipe_from_preset


async def async_setup_entry(
    hass: HomeAssistant, entry: TemialConfigEntry, async_add_entities: AddConfigEntryEntitiesCallback
) -> None:
    """Add buttons for all device/preset pairs, including ones created later."""
    coordinator = entry.runtime_data
    known: set[tuple[str, str]] = set()

    @callback
    def add_new_buttons() -> None:
        new = [
            (serial, preset)
            for serial in coordinator.data.devices
            for preset in coordinator.data.presets
            if (serial, preset["id"]) not in known
        ]
        if not new:
            return
        known.update((serial, preset["id"]) for serial, preset in new)
        async_add_entities(TemialPresetButton(coordinator, serial, preset) for serial, preset in new)

    add_new_buttons()
    entry.async_on_unload(coordinator.async_add_listener(add_new_buttons))


class TemialPresetButton(TemialEntity, ButtonEntity):
    """Brews a preset on a Temial."""

    _attr_icon = "mdi:tea"

    def __init__(self, coordinator: TemialCoordinator, serial_number: str, preset: dict[str, Any]) -> None:
        super().__init__(coordinator, serial_number, f"brew_{preset['id']}")
        self._preset_id = preset["id"]
        self._attr_translation_key = "brew_preset"
        self._attr_translation_placeholders = {"preset": preset["name"]}

    @property
    def _preset(self) -> dict[str, Any] | None:
        return next((p for p in self.coordinator.data.presets if p["id"] == self._preset_id), None)

    @property
    def available(self) -> bool:
        # A preset deleted in the app leaves its button unavailable.
        return super().available and self._preset is not None

    async def async_press(self) -> None:
        preset = self._preset
        if preset is not None:
            await async_brew(self.coordinator, self._serial_number, recipe_from_preset(preset))
