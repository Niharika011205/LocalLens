"""
Fetching reporter-supplied URLs safely.

Reporters type URLs; this service downloads them. Without care that is Server-Side Request Forgery (SSRF): a "supporting
link" like http://169.254.169.254/ or http://localhost:27017/ would make our server read internal services. Defences:

1. Only http(s), standard ports, no credentials in the URL.
2. DNS is resolved by us, every resolved address must be publicly routable (``ip.is_global``), and the TCP connection is
   made to that exact validated address. The hostname is used only for TLS SNI and certificate checking. This closes the
   DNS-rebinding gap where a name resolves to a public IP when checked and a private one when connected.
3. Redirects are followed manually (max 3) and every hop goes through the same checks.
4. Responses are capped in size and time, and only text/HTML is read.
5. robots.txt is honoured, and requests carry an identifying User-Agent.
"""

from __future__ import annotations

import hashlib
import ipaddress
import socket
import ssl
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit
from urllib.robotparser import RobotFileParser

import httpcore

Resolver = Callable[[str, int], list[str]]

ALLOWED_PORTS = {None, 80, 443}
TEXT_TYPES = ("text/html", "text/plain", "application/xhtml+xml")
MAX_REDIRECTS = 3


class FetchBlocked(Exception):
    """The URL or the address it resolves to is not allowed."""


class FetchFailed(Exception):
    pass


def default_resolver(host: str, port: int) -> list[str]:
    return sorted({info[4][0] for info in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)})


def assert_public(ip_text: str) -> None:
    ip = ipaddress.ip_address(ip_text.split("%", 1)[0])
    # is_global is False for private, loopback, link-local (incl. cloud metadata 169.254.169.254), CGNAT, multicast,
    # reserved and unspecified ranges. IPv4-mapped IPv6 is unwrapped first so ::ffff:127.0.0.1 is caught too.
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    if not ip.is_global:
        raise FetchBlocked(f"address {ip} is not publicly routable")


def validate_url(url: str) -> tuple[str, str, int]:
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise FetchBlocked("only http and https links are fetched")
    if not parts.hostname:
        raise FetchBlocked("the link has no host")
    if parts.username or parts.password:
        raise FetchBlocked("links with credentials are not fetched")
    if parts.port not in ALLOWED_PORTS:
        raise FetchBlocked("only standard web ports are fetched")
    port = parts.port or (443 if parts.scheme == "https" else 80)
    return parts.scheme, parts.hostname, port


class PinnedBackend(httpcore.SyncBackend):
    """Resolves, validates and connects to the validated address — never re-resolving in between."""

    def __init__(self, resolver: Resolver) -> None:
        super().__init__()
        self._resolver = resolver

    def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):  # type: ignore[override]
        try:
            addresses = self._resolver(host, port)
        except OSError as exc:
            raise FetchFailed(f"could not resolve {host}") from exc
        if not addresses:
            raise FetchFailed(f"could not resolve {host}")
        for address in addresses:
            assert_public(address)  # every address must be public, not just the first
        return super().connect_tcp(addresses[0], port, timeout=timeout, local_address=local_address, socket_options=socket_options)


@dataclass
class FetchedDocument:
    url: str
    final_url: str
    title: str | None
    text: str
    published_at: str | None
    retrieved_at: str
    content_sha256: str


class _TextExtractor(HTMLParser):
    SKIP = {"script", "style", "noscript", "template", "svg"}
    BLOCK = {"p", "div", "br", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "section", "article", "header", "footer", "blockquote"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.title: str | None = None
        self.published_at: str | None = None
        self._skip = 0
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag in self.SKIP:
            self._skip += 1
        elif tag == "title":
            self._in_title = True
        elif tag == "meta" and self.published_at is None:
            key = (a.get("property") or a.get("name") or a.get("itemprop") or "").lower()
            if key in {"article:published_time", "datepublished", "og:published_time", "date", "dc.date"} and a.get("content"):
                self.published_at = a["content"][:40]
        elif tag == "time" and self.published_at is None and a.get("datetime"):
            self.published_at = a["datetime"][:40]
        if tag in self.BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self.SKIP and self._skip:
            self._skip -= 1
        elif tag == "title":
            self._in_title = False
        if tag in self.BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        if self._skip:
            return
        if self._in_title:
            self.title = ((self.title or "") + data).strip()[:300]
            return
        self.parts.append(data)


def extract_text(html: str) -> tuple[str | None, str, str | None]:
    parser = _TextExtractor()
    parser.feed(html)
    lines = [" ".join(line.split()) for line in "".join(parser.parts).split("\n")]
    text = "\n".join(line for line in lines if line)
    return parser.title, text, parser.published_at


class SafeFetcher:
    def __init__(self, user_agent: str, timeout_s: float, max_bytes: int, resolver: Resolver = default_resolver) -> None:
        self.user_agent = user_agent
        self.timeout_s = timeout_s
        self.max_bytes = max_bytes
        self._pool = httpcore.ConnectionPool(
            ssl_context=ssl.create_default_context(),
            network_backend=PinnedBackend(resolver),
            max_connections=4,
        )
        self._robots: dict[str, RobotFileParser | None] = {}

    def _get(self, url: str) -> tuple[int, dict[str, str], bytes, str]:
        """GET with manual, re-validated redirects and a size cap. Returns (status, headers, body, final_url)."""
        current = url
        for _ in range(MAX_REDIRECTS + 1):
            validate_url(current)
            timeout = {"connect": self.timeout_s, "read": self.timeout_s, "write": self.timeout_s, "pool": self.timeout_s}
            try:
                with self._pool.stream(
                    "GET",
                    current,
                    headers=[(b"User-Agent", self.user_agent.encode()), (b"Accept", b"text/html,text/plain;q=0.9")],
                    extensions={"timeout": timeout},
                ) as response:
                    headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in response.headers}
                    if response.status in (301, 302, 303, 307, 308) and "location" in headers:
                        current = urljoin(current, headers["location"])
                        continue
                    body = bytearray()
                    for chunk in response.iter_stream():
                        body.extend(chunk)
                        if len(body) > self.max_bytes:
                            raise FetchFailed("too_large")
                    return response.status, headers, bytes(body), current
            except (FetchBlocked, FetchFailed):
                raise
            except httpcore.TimeoutException as exc:
                raise FetchFailed("timed out") from exc
            except (httpcore.ConnectError, httpcore.NetworkError, httpcore.ProtocolError, httpcore.UnsupportedProtocol) as exc:
                cause = exc.__context__ or exc.__cause__
                if isinstance(cause, FetchBlocked):
                    raise cause from None
                raise FetchFailed("could not connect") from exc
        raise FetchFailed("too many redirects")

    def robots_allows(self, url: str) -> bool:
        scheme, host, port = validate_url(url)
        origin = f"{scheme}://{host}" + ("" if port in (80, 443) else f":{port}")
        if origin not in self._robots:
            try:
                status, _, body, _ = self._get(origin + "/robots.txt")
                if 400 <= status < 500:
                    self._robots[origin] = None  # no robots.txt: allowed
                elif status >= 500:
                    self._robots[origin] = RobotFileParser()
                    self._robots[origin].disallow_all = True  # conservative when the site is failing
                else:
                    parser = RobotFileParser()
                    parser.parse(body.decode("utf-8", errors="replace").splitlines())
                    self._robots[origin] = parser
            except FetchFailed:
                self._robots[origin] = None
        parser = self._robots[origin]
        return True if parser is None else parser.can_fetch(self.user_agent, url)

    def fetch(self, url: str) -> FetchedDocument:
        validate_url(url)
        if not self.robots_allows(url):
            raise FetchBlocked("robots_disallowed")
        status, headers, body, final_url = self._get(url)
        if status >= 400:
            raise FetchFailed(f"HTTP {status}")
        content_type = headers.get("content-type", "").split(";")[0].strip().lower()
        if content_type and content_type not in TEXT_TYPES:
            raise FetchFailed("unsupported_type")
        charset = "utf-8"
        for part in headers.get("content-type", "").split(";")[1:]:
            if part.strip().lower().startswith("charset="):
                charset = part.split("=", 1)[1].strip() or "utf-8"
        try:
            decoded = body.decode(charset, errors="replace")
        except LookupError:
            decoded = body.decode("utf-8", errors="replace")
        if content_type == "text/plain":
            title, text, published = None, "\n".join(" ".join(line.split()) for line in decoded.splitlines() if line.strip()), None
        else:
            title, text, published = extract_text(decoded)
        return FetchedDocument(
            url=url,
            final_url=final_url,
            title=title,
            text=text,
            published_at=published,
            retrieved_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
            content_sha256=hashlib.sha256(body).hexdigest(),
        )
