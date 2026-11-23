"""Config flow for Temial Control."""

from __future__ import annotations

from collections.abc import Mapping
import re
from typing import Any
from urllib.parse import urlparse

import voluptuous as vol

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.const import CONF_TOKEN, CONF_URL
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import TemialApi, TemialApiError, TemialAuthError
from .const import DOMAIN

URL_PATTERN = re.compile(r"^https?://[^/\s]+$")

USER_SCHEMA = vol.Schema(
    {
        vol.Required(CONF_URL): str,
        vol.Optional(CONF_TOKEN): str,
    }
)
REAUTH_SCHEMA = vol.Schema({vol.Optional(CONF_TOKEN): str})


def _clean_token(user_input: Mapping[str, Any]) -> str | None:
    return (user_input.get(CONF_TOKEN) or "").strip() or None


class TemialConfigFlow(ConfigFlow, domain=DOMAIN):
    """Ask for the app URL and optional API token."""

    VERSION = 1

    async def _validate(self, url: str, token: str | None) -> str | None:
        """Return an error key, or None if URL and token work."""
        try:
            await TemialApi(async_get_clientsession(self.hass), url, token).get_config()
        except TemialAuthError:
            return "invalid_auth"
        except TemialApiError:
            return "cannot_connect"
        return None

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            url = user_input[CONF_URL].strip().rstrip("/")
            token = _clean_token(user_input)
            if not URL_PATTERN.match(url):
                errors[CONF_URL] = "invalid_url"
            else:
                await self.async_set_unique_id(url)
                self._abort_if_unique_id_configured()
                if (error := await self._validate(url, token)) is not None:
                    errors["base"] = error
                else:
                    return self.async_create_entry(
                        title=f"Temial Control ({urlparse(url).netloc})",
                        data={CONF_URL: url, CONF_TOKEN: token},
                    )

        return self.async_show_form(
            step_id="user",
            data_schema=self.add_suggested_values_to_schema(USER_SCHEMA, user_input or {CONF_URL: "http://"}),
            errors=errors,
        )

    async def async_step_reauth(self, entry_data: Mapping[str, Any]) -> ConfigFlowResult:
        """The token was rejected; ask for a new one."""
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        entry = self._get_reauth_entry()
        errors: dict[str, str] = {}
        if user_input is not None:
            token = _clean_token(user_input)
            if (error := await self._validate(entry.data[CONF_URL], token)) is not None:
                errors["base"] = error
            else:
                return self.async_update_reload_and_abort(entry, data_updates={CONF_TOKEN: token})

        return self.async_show_form(step_id="reauth_confirm", data_schema=REAUTH_SCHEMA, errors=errors)
