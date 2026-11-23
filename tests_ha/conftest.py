"""Fixtures for the Temial Control integration tests."""

import time

import pytest

from pytest_homeassistant_custom_component.common import MockConfigEntry
from pytest_homeassistant_custom_component.test_util.aiohttp import AiohttpClientMocker

from homeassistant.core import HomeAssistant

from custom_components.temial_control.const import DOMAIN

pytest_plugins = "pytest_homeassistant_custom_component"

URL = "http://temial.local:3000"
SERIAL = "2104118837"
PRESETS = [
    {"id": "p1", "name": "Sencha", "temperature": 80, "duration": 120, "volume": 300, "preWashTime": 0},
    {"id": "p2", "name": "Assam", "temperature": 95, "duration": 240, "volume": 400, "preWashTime": 10},
]


def make_device(**overrides) -> dict:
    """A device as returned by GET /api/devices, currently brewing."""
    now = int(time.time() * 1000)
    device = {
        "serialNumber": SERIAL,
        "connected": True,
        "connectedAt": now,
        "lastSeen": now,
        "deviceStatus": {
            "lidClosed": True,
            "chamberPresent": True,
            "enoughFreshWater": False,
            "wasteWaterTankPresent": True,
            "wasteWaterTankFull": False,
            "wiFiSignalStrength": 78,
            "softwareVersion": "6.5.2",
            "waterHardness": "2",
        },
        "brewStatus": {"temperature": 94, "pumpedVolume": 260, "remainingTotalTime": 135, "phase": 3},
        "brewStatusAt": now,
        "versions": None,
        "lastBrew": {**PRESETS[0], "sentAt": now},
    }
    device.update(overrides)
    return device


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    """Allow loading the integration from custom_components."""
    return


async def setup_integration(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    devices: list[dict] | None = None,
    events: str | None = None,
) -> MockConfigEntry:
    """Mock the app API and set up a config entry."""
    aioclient_mock.get(f"{URL}/api/devices", json=[make_device()] if devices is None else devices)
    aioclient_mock.get(f"{URL}/api/presets", json=PRESETS)
    if events is None:
        aioclient_mock.get(f"{URL}/api/events", status=503)
    else:
        aioclient_mock.get(f"{URL}/api/events", text=events)

    entry = MockConfigEntry(domain=DOMAIN, data={"url": URL, "token": None}, unique_id=URL)
    entry.add_to_hass(hass)
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry
