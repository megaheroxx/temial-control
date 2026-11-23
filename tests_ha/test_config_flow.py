"""Tests for the config flow."""

from unittest.mock import patch

import aiohttp
import pytest

from pytest_homeassistant_custom_component.common import MockConfigEntry
from pytest_homeassistant_custom_component.test_util.aiohttp import AiohttpClientMocker

from homeassistant.config_entries import SOURCE_USER
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType

from custom_components.temial_control.const import DOMAIN

from .conftest import URL

CONFIG_URL = f"{URL}/api/config"


@pytest.fixture(autouse=True)
def skip_setup():
    """Creating an entry should not set it up in these tests."""
    with patch("custom_components.temial_control.async_setup_entry", return_value=True):
        yield


async def start(hass: HomeAssistant, user_input: dict) -> dict:
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": SOURCE_USER})
    assert result["type"] is FlowResultType.FORM
    return await hass.config_entries.flow.async_configure(result["flow_id"], user_input)


async def test_create_entry(hass: HomeAssistant, aioclient_mock: AiohttpClientMocker) -> None:
    aioclient_mock.get(CONFIG_URL, json={"limits": {}})
    result = await start(hass, {"url": f" {URL}/ ", "token": " geheim "})

    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["title"] == "Temial Control (temial.local:3000)"
    assert result["data"] == {"url": URL, "token": "geheim"}
    assert aioclient_mock.mock_calls[0][3] == {"Authorization": "Bearer geheim"}


async def test_empty_token_is_stored_as_none(hass: HomeAssistant, aioclient_mock: AiohttpClientMocker) -> None:
    aioclient_mock.get(CONFIG_URL, json={"limits": {}})
    result = await start(hass, {"url": URL, "token": "  "})
    assert result["data"] == {"url": URL, "token": None}


@pytest.mark.parametrize(
    ("mock", "error"),
    [
        ({"exc": aiohttp.ClientConnectionError()}, "cannot_connect"),
        ({"exc": TimeoutError()}, "cannot_connect"),
        ({"status": 401, "json": {"error": "Token fehlt"}}, "invalid_auth"),
        ({"status": 200, "text": "kein json"}, "cannot_connect"),
    ],
)
async def test_errors(hass: HomeAssistant, aioclient_mock: AiohttpClientMocker, mock: dict, error: str) -> None:
    aioclient_mock.get(CONFIG_URL, **mock)
    result = await start(hass, {"url": URL})
    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": error}


async def test_invalid_url(hass: HomeAssistant, aioclient_mock: AiohttpClientMocker) -> None:
    result = await start(hass, {"url": "192.168.178.20:3000"})
    assert result["errors"] == {"url": "invalid_url"}
    assert aioclient_mock.call_count == 0


async def test_already_configured(hass: HomeAssistant, aioclient_mock: AiohttpClientMocker) -> None:
    MockConfigEntry(domain=DOMAIN, data={"url": URL, "token": None}, unique_id=URL).add_to_hass(hass)
    result = await start(hass, {"url": URL})
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "already_configured"


async def test_reauth_updates_token(hass: HomeAssistant, aioclient_mock: AiohttpClientMocker) -> None:
    entry = MockConfigEntry(domain=DOMAIN, data={"url": URL, "token": "alt"}, unique_id=URL)
    entry.add_to_hass(hass)
    aioclient_mock.get(CONFIG_URL, json={"limits": {}})

    result = await entry.start_reauth_flow(hass)
    assert result["step_id"] == "reauth_confirm"
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {"token": "neu"})

    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "reauth_successful"
    assert entry.data == {"url": URL, "token": "neu"}
