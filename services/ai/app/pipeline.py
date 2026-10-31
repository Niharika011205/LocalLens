"""
The verification pipeline. The LLM proposes; deterministic code decides.

Steps: normalise → detect language → extract claims (LLM) → fetch reporter links safely → split into passages →
rank passages per claim → per-claim stance judgement (LLM) → GUARDRAILS → assessment → recommendation.

Guardrails (code, not prompt):
- Evidence can only reference passages we actually retrieved; anything else is discarded.
- Every excerpt must appear verbatim in the fetched text, or it is dropped and a warning is recorded.
- The assessment is computed from the surviving evidence, never taken from the model:
    no supporting and no contradicting evidence → "insufficient_evidence" (never "contradicted")
    only supporting → "supported"; only contradicting → "contradicted"; both → "mixed".
- No numeric confidence is produced: an LLM's self-reported confidence is not a calibrated probability.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import Protocol

from .config import PIPELINE_VERSION
from .fetcher import FetchBlocked, FetchedDocument, FetchFailed
from .llm import LLMError, LLMProvider
from .models import Claim, Evidence, Meta, SourceRecord, VerifyRequest, VerifyResponse
from .prompts import ASSESS_SCHEMA, ASSESS_SYSTEM, EXTRACT_SCHEMA, EXTRACT_SYSTEM, PROMPT_VERSIONS
from .sources import classify
from .text import Passage, detect_language, normalise, quote_in, rank_passages, to_passages

MAX_INPUT_CHARS = 8000


class Fetcher(Protocol):
    def fetch(self, url: str) -> FetchedDocument: ...


def _now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _llm_with_repair(llm: LLMProvider, system: str, user: str, schema: dict, validate: Callable[[dict], None]) -> dict:
    """One repair attempt for malformed output; transient errors propagate so the worker can back off and retry."""
    last: Exception | None = None
    for _ in range(2):
        try:
            out = llm.json(system, user, schema)
            validate(out)
            return out
        except LLMError as exc:
            if exc.transient:
                raise
            last = exc
        except (KeyError, TypeError, ValueError) as exc:
            last = exc
    raise LLMError(f"The model's output could not be used: {last}", transient=False)


def _validate_claims(out: dict) -> None:
    claims = out["claims"]
    if not isinstance(claims, list):
        raise ValueError("claims must be a list")
    for c in claims:
        if c["kind"] not in ("factual", "opinion", "prediction") or not isinstance(c["text"], str):
            raise ValueError("bad claim")


def _validate_assessment(out: dict) -> None:
    for p in out["passages"]:
        if p["stance"] not in ("supports", "contradicts", "irrelevant"):
            raise ValueError("bad stance")


def decide(supporting: int, contradicting: int) -> str:
    if supporting and contradicting:
        return "mixed"
    if contradicting:
        return "contradicted"
    if supporting:
        return "supported"
    return "insufficient_evidence"


def verify(req: VerifyRequest, llm: LLMProvider, fetcher: Fetcher, *, max_sources: int, max_claims_assessed: int) -> VerifyResponse:
    started = time.monotonic()
    warnings: list[str] = []

    # 1-2. normalise and detect language
    text = normalise(f"{req.headline}\n{req.summary}\n{req.body}")
    if len(text) > MAX_INPUT_CHARS:
        warnings.append(f"Only the first {MAX_INPUT_CHARS} characters of the report were analysed.")
        text = text[:MAX_INPUT_CHARS]
    detected = detect_language(text)

    # 3-4. claims (factual vs opinion vs prediction)
    context = f"Place: {req.location_label or 'unknown'}\nDate of incident: {req.incident_date or 'not given'}\nTopic: {req.category or 'unknown'}"
    extracted = _llm_with_repair(
        llm,
        EXTRACT_SYSTEM,
        f"{context}\n<submission>\n{text}\n</submission>",
        EXTRACT_SCHEMA,
        _validate_claims,
    )
    raw_claims = [c for c in extracted["claims"] if c["text"].strip()][:6]

    # 6-8. retrieval from the reporter's own links, with provenance
    sources: list[SourceRecord] = []
    passages: list[Passage] = []
    for url in req.supporting_urls[:max_sources]:
        source_type, rationale = classify(url)
        try:
            doc = fetcher.fetch(url)
        except FetchBlocked as exc:
            status = "robots_disallowed" if str(exc) == "robots_disallowed" else "blocked"
            sources.append(SourceRecord(url=url, status=status, detail=str(exc), source_type=source_type, reliability_rationale=rationale, retrieved_at=_now()))
            continue
        except FetchFailed as exc:
            reason = str(exc)
            status = "too_large" if reason == "too_large" else "unsupported_type" if reason == "unsupported_type" else "error"
            sources.append(SourceRecord(url=url, status=status, detail=reason, source_type=source_type, reliability_rationale=rationale, retrieved_at=_now()))
            continue
        index = len(sources)
        sources.append(
            SourceRecord(
                url=url,
                status="fetched",
                title=doc.title,
                source_type=source_type,
                reliability_rationale=rationale,
                published_at=doc.published_at,
                retrieved_at=doc.retrieved_at,
                content_sha256=doc.content_sha256,
            )
        )
        passages.extend(to_passages(index, doc.text))
    if len(req.supporting_urls) > max_sources:
        warnings.append(f"Only the first {max_sources} supporting links were checked.")
    if not req.supporting_urls:
        warnings.append("The reporter gave no supporting links, so there was nothing to check claims against.")

    passage_by_id = {p.id: p for p in passages}
    claims: list[Claim] = []
    evidence: list[Evidence] = []
    assessed = 0

    # 9-10. per-claim comparison, then guardrails
    for i, c in enumerate(raw_claims):
        claim_id = f"C{i + 1}"
        base = dict(id=claim_id, text=c["text"].strip(), kind=c["kind"], check_worthy=bool(c["check_worthy"] and c["kind"] == "factual"))
        if not base["check_worthy"]:
            claims.append(Claim(**base, assessment="not_assessed", supporting_evidence_ids=[], contradicting_evidence_ids=[], rationale="Opinions, predictions and vague statements are not fact-checked.", missing_evidence=[], uncertainty=""))
            continue
        relevant = rank_passages(base["text"], passages)
        if not relevant or assessed >= max_claims_assessed:
            why = "No retrieved source text relates to this claim." if not relevant else "Not assessed: only the most important claims are checked automatically."
            claims.append(Claim(**base, assessment="insufficient_evidence" if not relevant else "not_assessed", supporting_evidence_ids=[], contradicting_evidence_ids=[], rationale=why, missing_evidence=["An independent source that addresses this claim"] if not relevant else [], uncertainty=""))
            continue
        assessed += 1
        block = "\n".join(f'<passage id="{p.id}">\n{p.text}\n</passage>' for p in relevant)
        out = _llm_with_repair(llm, ASSESS_SYSTEM, f"Claim: {base['text']}\n{block}", ASSESS_SCHEMA, _validate_assessment)

        supporting: list[str] = []
        contradicting: list[str] = []
        seen_quotes: set[str] = set()
        for judged in out["passages"]:
            if judged["stance"] == "irrelevant":
                continue
            passage = passage_by_id.get(judged["passage_id"])
            if passage is None or passage not in relevant:
                warnings.append(f"{claim_id}: discarded a reference to a passage that was not retrieved.")
                continue
            if not quote_in(judged["quote"], passage.text):
                warnings.append(f"{claim_id}: discarded an excerpt that does not appear in the source text.")
                continue
            # The same sentence cited twice must not count as two pieces of evidence.
            quote_key = " ".join(judged["quote"].lower().split())
            if quote_key in seen_quotes:
                continue
            seen_quotes.add(quote_key)
            source = sources[passage.source_index]
            ev_id = f"E{len(evidence) + 1}"
            evidence.append(
                Evidence(
                    id=ev_id,
                    claim_id=claim_id,
                    url=source.url,
                    stance=judged["stance"],
                    excerpt=judged["quote"].strip(),
                    excerpt_verified=True,
                    source_type=source.source_type,
                    reliability_rationale=source.reliability_rationale,
                    published_at=source.published_at,
                    retrieved_at=source.retrieved_at,
                )
            )
            (supporting if judged["stance"] == "supports" else contradicting).append(ev_id)

        assessment = decide(len(supporting), len(contradicting))
        uncertainty = str(out.get("uncertainty", "")).strip()
        if assessment == "supported" and all(e.source_type == "other" for e in evidence if e.id in supporting):
            uncertainty = (uncertainty + " Support comes only from sources outside the reviewed registry.").strip()
        claims.append(
            Claim(
                **base,
                assessment=assessment,
                supporting_evidence_ids=supporting,
                contradicting_evidence_ids=contradicting,
                rationale=str(out.get("rationale", "")).strip()[:1000],
                missing_evidence=[str(m)[:300] for m in out.get("missing_evidence", [])][:5],
                uncertainty=uncertainty[:1000],
            )
        )

    # 11. recommendation for the human editor
    checked = [c for c in claims if c.check_worthy and c.assessment != "not_assessed"]
    if any(c.assessment in ("contradicted", "mixed") for c in claims):
        recommendation = "senior_review"
    elif checked and all(c.assessment == "insufficient_evidence" for c in checked):
        recommendation = "request_more_info"
    elif not checked:
        recommendation = "request_more_info"
    else:
        recommendation = "standard_review"

    return VerifyResponse(
        detected_language=detected,
        language_matches_declared=detected in (req.language, "mixed", "unknown"),
        claims=claims,
        evidence=evidence,
        sources=sources,
        recommendation=recommendation,
        meta=Meta(
            pipeline_version=PIPELINE_VERSION,
            provider=llm.name,
            model=llm.model,
            prompt_versions={k: v for k, v in PROMPT_VERSIONS.items() if k != "answer"},
            duration_ms=int((time.monotonic() - started) * 1000),
            warnings=warnings,
        ),
    )
