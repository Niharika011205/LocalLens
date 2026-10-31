"""Configuration from environment variables, validated once at startup."""

from __future__ import annotations

import os
from dataclasses import dataclass

PIPELINE_VERSION = "verify-1.0.0"
ASSISTANT_VERSION = "assist-1.0.0"


class ConfigError(Exception):
    pass


@dataclass(frozen=True)
class Settings:
    service_token: str
    llm_provider: str  # "ollama" | "anthropic" | "none"
    ollama_url: str
    ollama_model: str
    anthropic_model: str
    anthropic_effort: str
    llm_timeout_s: float
    fetch_timeout_s: float
    max_fetch_bytes: int
    max_sources: int
    max_claims_assessed: int
    user_agent: str


def _read_env_file(path: str) -> dict[str, str]:
    """Minimal KEY=VALUE reader for a local, git-ignored services/ai/.env (development convenience)."""
    values: dict[str, str] = {}
    if os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, value = line.split("=", 1)
                    values[key.strip()] = value.strip()
    return values


def load_settings(env: dict[str, str] | None = None) -> Settings:
    if env is None:
        # Real environment variables win over the file.
        e = _read_env_file(os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env")) | dict(os.environ)
    else:
        e = dict(env)
    token = e.get("AI_SERVICE_TOKEN", "")
    if len(token) < 32:
        raise ConfigError("AI_SERVICE_TOKEN must be set to at least 32 characters (shared secret with the API)")
    provider = e.get("LLM_PROVIDER", "ollama").lower()
    if provider not in {"ollama", "anthropic", "none"}:
        raise ConfigError("LLM_PROVIDER must be ollama, anthropic or none")
    effort = e.get("ANTHROPIC_EFFORT", "medium")
    if effort not in {"low", "medium", "high", "xhigh", "max"}:
        raise ConfigError("ANTHROPIC_EFFORT must be low, medium, high, xhigh or max")
    return Settings(
        service_token=token,
        llm_provider=provider,
        ollama_url=e.get("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/"),
        ollama_model=e.get("OLLAMA_MODEL", "llama3.2"),
        anthropic_model=e.get("ANTHROPIC_MODEL", "claude-opus-5-5"),
        anthropic_effort=effort,
        llm_timeout_s=float(e.get("LLM_TIMEOUT_S", "300")),
        fetch_timeout_s=float(e.get("FETCH_TIMEOUT_S", "10")),
        max_fetch_bytes=int(e.get("MAX_FETCH_BYTES", str(2 * 1024 * 1024))),
        max_sources=int(e.get("MAX_SOURCES", "5")),
        max_claims_assessed=int(e.get("MAX_CLAIMS_ASSESSED", "3")),
        user_agent=e.get("FETCH_USER_AGENT", "LocalLensVerifier/1.0 (+https://locallens.example/bot)"),
    )
