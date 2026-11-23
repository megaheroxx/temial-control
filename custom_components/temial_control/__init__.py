"""The Temial Control integration."""

from __future__ import annotations

from homeassistant.const import CONF_TOKEN, CONF_URL
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.typing import ConfigType

from .api import TemialApi
from .const import DOMAIN, PLATFORMS
from .coordinator import TemialConfigEntry, TemialCoordinator
from .services import async_setup_services

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Register actions once, independent of config entries."""
    async_setup_services(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: TemialConfigEntry) -> bool:
    """Connect to a Temial Control instance."""
    api = TemialApi(async_get_clientsession(hass), entry.data[CONF_URL], entry.data.get(CONF_TOKEN))
    coordinator = TemialCoordinator(hass, entry, api)
    await coordinator.async_config_entry_first_refresh()
    entry.runtime_data = coordinator

    entry.async_create_background_task(hass, coordinator.async_listen_events(), f"{DOMAIN}_events")
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: TemialConfigEntry) -> bool:
    """Unload a config entry; the event stream task is cancelled automatically."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
