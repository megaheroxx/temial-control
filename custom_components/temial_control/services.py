"""Actions (services) to brew tea from automations."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant, ServiceCall, callback
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError
from homeassistant.helpers import config_validation as cv, device_registry as dr

from .api import TemialApiError, TemialNotConnectedError
from .const import DOMAIN, LIMITS, NAME_MAX
from .coordinator import TemialCoordinator

SERVICE_BREW = "brew"
SERVICE_BREW_PRESET = "brew_preset"
ATTR_DEVICE_ID = "device_id"
ATTR_PRESET = "preset"
ATTR_START_IN = "start_in_minutes"


def _bounded(key: str) -> vol.All:
    low, high = LIMITS[key]
    return vol.All(vol.Coerce(int), vol.Range(min=low, max=high))


BREW_SCHEMA = vol.Schema(
    {
        vol.Required(ATTR_DEVICE_ID): cv.string,
        vol.Required("name"): vol.All(cv.string, vol.Strip, vol.Length(min=1, max=NAME_MAX)),
        vol.Required("temperature"): _bounded("temperature"),
        vol.Required("duration"): _bounded("duration"),
        vol.Required("volume"): _bounded("volume"),
        vol.Optional("pre_wash_time", default=0): _bounded("pre_wash_time"),
        vol.Optional(ATTR_START_IN): vol.All(vol.Coerce(int), vol.Range(min=0, max=1440)),
    }
)

BREW_PRESET_SCHEMA = vol.Schema(
    {
        vol.Required(ATTR_DEVICE_ID): cv.string,
        vol.Required(ATTR_PRESET): vol.All(cv.string, vol.Strip, vol.Length(min=1)),
        vol.Optional(ATTR_START_IN): vol.All(vol.Coerce(int), vol.Range(min=0, max=1440)),
    }
)


def recipe_from_preset(preset: dict[str, Any]) -> dict[str, Any]:
    """Build the API recipe from a preset returned by the app."""
    recipe = {key: preset[key] for key in ("name", "temperature", "duration", "volume", "preWashTime")}
    # Lets the Temial show the preset's name instead of "Manual tea".
    recipe["presetId"] = preset["id"]
    # Further infusions start a multi-infusion brew; the next ones are started from the app.
    if preset.get("infusions"):
        recipe["infusions"] = preset["infusions"]
    return recipe


async def async_brew(coordinator: TemialCoordinator, serial_number: str, recipe: dict[str, Any]) -> None:
    """Send a brew command and translate API errors for the UI."""
    try:
        await coordinator.api.brew(serial_number, recipe)
    except TemialNotConnectedError as err:
        raise HomeAssistantError(
            translation_domain=DOMAIN,
            translation_key="not_connected",
            translation_placeholders={"serial_number": serial_number},
        ) from err
    except TemialApiError as err:
        raise HomeAssistantError(
            translation_domain=DOMAIN,
            translation_key="brew_failed",
            translation_placeholders={"error": str(err)},
        ) from err


def _with_timer(recipe: dict[str, Any], call: ServiceCall) -> dict[str, Any]:
    """Adds the optional timer: the Temial waits this long before brewing."""
    if minutes := call.data.get(ATTR_START_IN):
        return {**recipe, "startInSeconds": minutes * 60}
    return recipe


def _resolve_device(hass: HomeAssistant, device_id: str) -> tuple[TemialCoordinator, str]:
    device = dr.async_get(hass).async_get(device_id)
    serial = next((ident for domain, ident in device.identifiers if domain == DOMAIN), None) if device else None
    if device is None or serial is None:
        raise ServiceValidationError(
            translation_domain=DOMAIN,
            translation_key="not_a_temial",
            translation_placeholders={"device_id": device_id},
        )
    # Since HA 2026.10 a device belongs to exactly one entry; config_entries is deprecated.
    entry_ids = [device.config_entry_id] if hasattr(device, "config_entry_id") else device.config_entries
    for entry_id in entry_ids:
        entry = hass.config_entries.async_get_entry(entry_id)
        if entry and entry.domain == DOMAIN and entry.state is ConfigEntryState.LOADED:
            return entry.runtime_data, serial
    raise ServiceValidationError(translation_domain=DOMAIN, translation_key="not_loaded")


@callback
def async_setup_services(hass: HomeAssistant) -> None:
    """Register the brew actions."""

    async def brew(call: ServiceCall) -> None:
        coordinator, serial = _resolve_device(hass, call.data[ATTR_DEVICE_ID])
        recipe = {
            "name": call.data["name"],
            "temperature": call.data["temperature"],
            "duration": call.data["duration"],
            "volume": call.data["volume"],
            "preWashTime": call.data["pre_wash_time"],
        }
        await async_brew(coordinator, serial, _with_timer(recipe, call))

    async def brew_preset(call: ServiceCall) -> None:
        coordinator, serial = _resolve_device(hass, call.data[ATTR_DEVICE_ID])
        wanted = call.data[ATTR_PRESET].casefold()
        presets = coordinator.data.presets
        preset = next((p for p in presets if wanted in (p["name"].casefold(), p["id"])), None)
        if preset is None:
            raise ServiceValidationError(
                translation_domain=DOMAIN,
                translation_key="preset_not_found",
                translation_placeholders={
                    "preset": call.data[ATTR_PRESET],
                    "available": ", ".join(p["name"] for p in presets) or "–",
                },
            )
        await async_brew(coordinator, serial, _with_timer(recipe_from_preset(preset), call))

    hass.services.async_register(DOMAIN, SERVICE_BREW, brew, schema=BREW_SCHEMA)
    hass.services.async_register(DOMAIN, SERVICE_BREW_PRESET, brew_preset, schema=BREW_PRESET_SCHEMA)
