"""Deterministic text helpers: normalisation, language detection, passages, ranking, quote verification."""

from __future__ import annotations

import math
import re
import unicodedata
from dataclasses import dataclass

_WORD = re.compile(r"[^\W_]{3,}", re.UNICODE)
_CONTROL = re.compile(r"[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]")


def normalise(text: str) -> str:
    """NFC, no control characters, collapsed whitespace (newlines kept between paragraphs)."""
    text = _CONTROL.sub("", unicodedata.normalize("NFC", text))
    lines = [" ".join(line.split()) for line in text.splitlines()]
    return "\n".join(line for line in lines if line).strip()


def detect_language(text: str) -> str:
    """Counts letters in the Telugu Unicode block vs Latin letters. No model needed, never fails."""
    telugu = sum(1 for ch in text if "ఀ" <= ch <= "౿")
    latin = sum(1 for ch in text if ch.isascii() and ch.isalpha())
    total = telugu + latin
    if total < 10:
        return "unknown"
    share = telugu / total
    if share >= 0.7:
        return "te"
    if share <= 0.1:
        return "en"
    return "mixed"


def words(text: str) -> set[str]:
    return {w.lower() for w in _WORD.findall(unicodedata.normalize("NFC", text))}


@dataclass
class Passage:
    id: str
    source_index: int
    text: str


def to_passages(source_index: int, text: str, target_chars: int = 700, max_passages: int = 40) -> list[Passage]:
    """Groups paragraphs into ~700-character passages so a claim is compared with focused text, not whole pages."""
    out: list[Passage] = []
    buf = ""
    for para in text.split("\n"):
        if buf and len(buf) + len(para) > target_chars:
            out.append(Passage(f"S{source_index + 1}P{len(out) + 1}", source_index, buf.strip()))
            buf = ""
        buf += para + "\n"
        if len(out) >= max_passages:
            break
    if buf.strip() and len(out) < max_passages:
        out.append(Passage(f"S{source_index + 1}P{len(out) + 1}", source_index, buf.strip()))
    return out


def rank_passages(claim: str, passages: list[Passage], top: int = 4, min_overlap: int = 2) -> list[Passage]:
    """Word-overlap ranking, length-normalised. Passages sharing fewer than two words with the claim are discarded."""
    claim_words = words(claim)
    scored = []
    for p in passages:
        overlap = len(claim_words & words(p.text))
        if overlap >= min_overlap:
            scored.append((overlap / math.sqrt(len(words(p.text)) + 1), p))
    scored.sort(key=lambda s: s[0], reverse=True)
    return [p for _, p in scored[:top]]


def _squash(text: str) -> str:
    return " ".join(unicodedata.normalize("NFC", text).replace("“", '"').replace("”", '"').replace("’", "'").split()).lower()


def quote_in(quote: str, passage: str) -> bool:
    """An excerpt counts only if it appears in the fetched text (ignoring case, whitespace and curly quotes)."""
    q = _squash(quote).strip(" .\"'")
    return len(q) >= 12 and q in _squash(passage)
