"""Tests for setup, entities, buttons, actions and the event stream."""

import asyncio
import json

import pytest

from pytest_homeassistant_custom_component.common import MockConfigEntry
from pytest_homeassistant_custom_component.test_util.aiohttp import AiohttpClientMocker

from homeassistant.config_entries import ConfigEntryState
from homeassistant.const import STATE_OFF, STATE_ON, STATE_UNAVAILABLE
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError
from homeassistant.helpers import device_registry as dr

from custom_components.temial_control.const import DOMAIN

from .conftest import PRESETS, SERIAL, URL, make_device, setup_integration

BREW_URL = f"{URL}/api/devices/{SERIAL}/brew"
PREFIX = f"temial_{SERIAL}"


def brew_payloads(aioclient_mock: AiohttpClientMocker) -> list[dict]:
    return [data for method, url, data, _ in aioclient_mock.mock_calls if method == "POST" and str(url) == BREW_URL]


def temial_device(hass: HomeAssistant) -> dr.DeviceEntry:
    entry = hass.config_entries.async_entries(DOMAIN)[0]
    device = dr.async_get(hass).async_get_device_by_identifier((DOMAIN, SERIAL), entry.entry_id)
    assert device is not None
    return device


def device_id(hass: HomeAssistant) -> str:
    return temial_device(hass).id


async def test_entities_reflect_device_state(hass: HomeAssistant, aioclient_mock: AiohttpClientMocker) -> None:
    entry = await setup_integration(hass, aioclient_mock)
    assert entry.state is ConfigEntryState.LOADED

    assert hass.states.get(f"sensor.{PREFIX}_remaining_time").state == "135"
    assert hass.states.get(f"sensor.{PREFIX}_brew_temperature").state == "94"
    assert hass.states.get(f"sensor.{PREFIX}_pumped_volume").state == "260"
    assert hass.states.get(f"sensor.{PREFIX}_last_tea").state == "Sencha"
    assert hass.states.get(f"sensor.{PREFIX}_firmware").state == "6.5.2"
    assert hass.states.get(f"binary_sensor.{PREFIX}_connected").state == STATE_ON
    assert hass.states.get(f"binary_sensor.{PREFIX}_brewing").state == STATE_ON
    assert hass.states.get(f"binary_sensor.{PREFIX}_lid_closed").state == STATE_ON
    assert hass.states.get(f"binary_sensor.{PREFIX}_fresh_water_missing").state == STATE_ON
    assert hass.states.get(f"binary_sensor.{PREFIX}_waste_water_tank_full").state == STATE_OFF
    assert hass.states.get(f"button.{PREFIX}_brew_sencha") is not None
    assert hass.states.get(f"button.{PREFIX}_brew_assam") is not None

    device = temial_device(hass)
    assert device.manufacturer == "Vorwerk"
    assert device.sw_version == "6.5.2"


async def test_finished_brew_and_offline_device(hass: HomeAssistant, aioclient_mock: AiohttpClientMocker) -> None:
    await setup_integration(hass, aioclient_mock, devices=[make_device(connected=False, brewStatusAt=0)])

    assert hass.states.get(f"binary_sensor.{PREFIX}_connected").state == STATE_OFF
    assert hass.states.get(f"binary_sensor.{PREFIX}_lid_closed").state == STATE_UNAVAILABLE
    assert hass.states.get(f"sensor.{PREFIX}_remaining_time").state == STATE_UNAVAILABLE


async def test_button_brews_preset(hass: HomeAssistant, aioclient_mock: AiohttpClientMocker) -> None:
    await setup_integration(hass, aioclient_mock)
    aioclient_mock.post(BREW_URL, status=202, json={"sent": True})

    await hass.services.async_call("button", "press", {"entity_id": f"button.{PREFIX}_brew_assam"}, blocking=True)

    assert brew_payloads(aioclient_mock) == [
        {"name": "Assam", "temperature": 95, "duration": 240, "volume": 400, "preWashTime": 10, "presetId": "p2"}
    ]


async def test_brew_action(hass: HomeAssistant, aioclient_mock: AiohttpClientMocker) -> None:
    await setup_integration(hass, aioclient_mock)
    aioclient_mock.post(BREW_URL, status=202, json={"sent": True})

    await hass.services.async_call(
        DOMAIN,
        "brew",
        {"device_id": device_id(hass), "name": " Earl Grey ", "temperature": 95, "duration": 200, "volume": 350},
        blocking=True,
    )

    assert brew_payloads(aioclient_mock) == [
        {"name": "Earl Grey", "temperature": 95, "duration": 200, "volume": 350, "preWashTime": 0}
    ]


async def test_brew_action_rejects_out_of_range(hass: HomeAssistant, aioclient_mock: AiohttpClientMocker) -> None:
    await setup_integration(hass, aioclient_mock)
    with pytest.raises(Exception, match="value must be at most 100"):
        await hass.services.async_call(
            DOMAIN,
            "brew",
            {"device_id": device_id(hass), "name": "Zu heiß", "temperature": 120, "duration": 200, "volume": 350},
            blocking=True,
        )
    assert brew_payloads(aioclient_mock) == []


async def test_brew_preset_action(hass: HomeAssistant, aioclient_mock: AiohttpClientMocker) -> None:
    await setup_integration(hass, aioclient_mock)
    aioclient_mock.post(BREW_URL, status=202, json={"sent": True})

    await hass.services.async_call(
        DOMAIN, "brew_preset", {"device_id": device_id(hass), "preset": "sencha"}, blocking=True
    )
    assert brew_payloads(aioclient_mock) == [
        {**{key: PRESETS[0][key] for key in ("name", "temperature", "duration", "volume", "preWashTime")}, "presetId": "p1"}
    ]

    with pytest.raises(ServiceValidationError) as err:
        await hass.services.async_call(
            DOMAIN, "brew_preset", {"device_id": device_id(hass), "preset": "Mate"}, blocking=True
        )
    assert err.value.translation_key == "preset_not_found"
    assert err.value.translation_placeholders == {"preset": "Mate", "available": "Sencha, Assam"}


async def test_brew_preset_with_timer(hass: HomeAssistant, aioclient_mock: AiohttpClientMocker) -> None:
    await setup_integration(hass, aioclient_mock)
    aioclient_mock.post(BREW_URL, status=202, json={"sent": True})

    await hass.services.async_call(
        DOMAIN, "brew_preset", {"device_id": device_id(hass), "preset": "Assam", "start_in_minutes": 30}, blocking=True
    )
    assert brew_payloads(aioclient_mock) == [
        {"name": "Assam", "temperature": 95, "duration": 240, "volume": 400, "preWashTime": 10, "presetId": "p2", "startInSeconds": 1800}
    ]


async def test_brew_on_disconnected_device(hass: HomeAssistant, aioclient_mock: AiohttpClientMocker) -> None:
    await setup_integration(hass, aioclient_mock)
    aioclient_mock.post(BREW_URL, status=409, json={"error": "Device is not connected"})

    with pytest.raises(HomeAssistantError) as err:
        await hass.services.async_call(
            DOMAIN, "brew_preset", {"device_id": device_id(hass), "preset": "Sencha"}, blocking=True
        )
    assert err.value.translation_key == "not_connected"


async def test_event_stream_pushes_updates(hass: HomeAssistant, aioclient_mock: AiohttpClientMocker) -> None:
    updated = make_device(deviceStatus={**make_device()["deviceStatus"], "lidClosed": False})
    events = f": keepalive\n\nevent: device\ndata: {json.dumps(updated)}\n\n"
    entry = await setup_integration(hass, aioclient_mock, events=events)

    for _ in range(100):
        if hass.states.get(f"binary_sensor.{PREFIX}_lid_closed").state == STATE_OFF:
            break
        await asyncio.sleep(0.01)
    assert hass.states.get(f"binary_sensor.{PREFIX}_lid_closed").state == STATE_OFF

    assert await hass.config_entries.async_unload(entry.entry_id)
    assert entry.state is ConfigEntryState.NOT_LOADED


async def test_rejected_token_starts_reauth(hass: HomeAssistant, aioclient_mock: AiohttpClientMocker) -> None:
    aioclient_mock.get(f"{URL}/api/devices", status=401, json={"error": "Token fehlt oder ist falsch"})

    entry = MockConfigEntry(domain=DOMAIN, data={"url": URL, "token": "alt"}, unique_id=URL)
    entry.add_to_hass(hass)
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()

    assert entry.state is ConfigEntryState.SETUP_ERROR
    flows = hass.config_entries.flow.async_progress_by_handler(DOMAIN)
    assert [flow["context"]["source"] for flow in flows] == ["reauth"]


async def test_unreachable_app_retries(hass: HomeAssistant, aioclient_mock: AiohttpClientMocker) -> None:
    aioclient_mock.get(f"{URL}/api/devices", exc=TimeoutError())

    entry = MockConfigEntry(domain=DOMAIN, data={"url": URL, "token": None}, unique_id=URL)
    entry.add_to_hass(hass)
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()

    assert entry.state is ConfigEntryState.SETUP_RETRY
