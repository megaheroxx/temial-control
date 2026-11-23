"""Constants for the Temial Control integration."""

from datetime import timedelta
import logging

from homeassistant.const import Platform

DOMAIN = "temial_control"
LOGGER = logging.getLogger(__package__)

PLATFORMS = [Platform.BINARY_SENSOR, Platform.BUTTON, Platform.SENSOR]

# Fallback polling; live updates arrive via the app's event stream.
POLL_INTERVAL = timedelta(seconds=30)

# A brew status older than this counts as finished (the device stops reporting).
BREW_STALE_SECONDS = 60

# Same bounds as the app (src/validation.ts).
LIMITS = {
    "temperature": (40, 100),
    "duration": (10, 1800),
    "volume": (50, 1000),
    "pre_wash_time": (0, 60),
}
NAME_MAX = 40
