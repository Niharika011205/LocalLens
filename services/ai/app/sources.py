"""
Source classification. Reliability is a property we assign from a registry — never from search ranking.
The registry is deliberately small; it is configuration to be reviewed by the editorial team, not a truth list.
A "trusted" source can still be wrong or outdated: the pipeline keeps conflicting evidence instead of dropping it.
"""

from __future__ import annotations

from urllib.parse import urlsplit

OFFICIAL_SUFFIXES = (".gov.in", ".nic.in")
# Established news organisations covering Andhra Pradesh. Extend through review, not ad hoc.
ESTABLISHED_NEWS = {
    "thehindu.com",
    "newindianexpress.com",
    "deccanchronicle.com",
    "timesofindia.indiatimes.com",
    "indianexpress.com",
    "eenadu.net",
    "sakshi.com",
    "andhrajyothy.com",
    "ptinews.com",
}


def classify(url: str) -> tuple[str, str]:
    host = (urlsplit(url).hostname or "").lower()
    if host == "gov.in" or host.endswith(OFFICIAL_SUFFIXES):
        return "official_government", f"{host} is an Indian government domain; official notices are primary records but can be outdated."
    if any(host == d or host.endswith("." + d) for d in ESTABLISHED_NEWS):
        return "established_news", f"{host} is an established news organisation; its reporting is secondary evidence."
    return "other", f"{host} is not in the reviewed source registry; treat with caution and check provenance."
