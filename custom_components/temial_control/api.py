"""Client for the Temial Control REST API and event stream."""

from __future__ import annotations

from collections.abc import AsyncIterator
import json
from typing import Any

import aiohttp

REQUEST_TIMEOUT = aiohttp.ClientTimeout(total=15)
# The app sends a keepalive every 25 s, so a longer silence means the stream is dead.
EVENTS_TIMEOUT = aiohttp.ClientTimeout(total=None, sock_connect=15, sock_read=90)


class TemialApiError(Exception):
    """The app could not be reached or returned an error."""


class TemialAuthError(TemialApiError):
    """The API token is missing or wrong."""


class TemialNotConnectedError(TemialApiError):
    """The Temial is known but currently not connected to the app."""


class TemialApi:
    """Talks to one Temial Control instance."""

    def __init__(self, session: aiohttp.ClientSession, url: str, token: str | None) -> None:
        self._session = session
        self.url = url.rstrip("/")
        self._token = token

    @property
    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._token}"} if self._token else {}

    async def _request(self, method: str, path: str, payload: dict[str, Any] | None = None) -> Any:
        try:
            async with self._session.request(
                method, f"{self.url}{path}", json=payload, headers=self._headers, timeout=REQUEST_TIMEOUT
            ) as resp:
                if resp.status == 401:
                    raise TemialAuthError("API-Token fehlt oder ist falsch")
                if resp.status == 204:
                    return None
                body = await resp.json(content_type=None)
                error = body.get("error") if isinstance(body, dict) else None
                if resp.status == 409:
                    raise TemialNotConnectedError(error or "Die Temial ist nicht verbunden")
                if resp.status >= 400:
                    raise TemialApiError(error or f"HTTP {resp.status}")
                return body
        except (aiohttp.ClientError, TimeoutError, ValueError) as err:
            raise TemialApiError(f"Temial Control unter {self.url} nicht erreichbar: {err}") from err

    async def get_config(self) -> dict[str, Any]:
        """Return the app configuration; used to validate URL and token."""
        return await self._request("GET", "/api/config")

    async def get_devices(self) -> list[dict[str, Any]]:
        """Return all known devices with their latest state."""
        return await self._request("GET", "/api/devices")

    async def get_presets(self) -> list[dict[str, Any]]:
        """Return all brew presets."""
        return await self._request("GET", "/api/presets")

    async def brew(self, serial_number: str, recipe: dict[str, Any]) -> None:
        """Send a brew command to a device."""
        await self._request("POST", f"/api/devices/{serial_number}/brew", recipe)

    async def events(self) -> AsyncIterator[tuple[str, Any]]:
        """Yield (event, data) pairs from the server-sent event stream until it ends."""
        async with self._session.get(
            f"{self.url}/api/events", headers=self._headers, timeout=EVENTS_TIMEOUT
        ) as resp:
            if resp.status == 401:
                raise TemialAuthError("API-Token fehlt oder ist falsch")
            if resp.status >= 400:
                raise TemialApiError(f"Event-Stream: HTTP {resp.status}")

            event: str | None = None
            data: list[str] = []
            async for raw in resp.content:
                line = raw.decode("utf-8").rstrip("\r\n")
                if not line:
                    if event and data:
                        yield event, json.loads("\n".join(data))
                    event, data = None, []
                elif line.startswith(":"):
                    continue
                elif line.startswith("event:"):
                    event = line[6:].strip()
                elif line.startswith("data:"):
                    data.append(line[5:].lstrip())
