"""
The news assistant (Phase 5): answers questions grounded ONLY in published articles the API retrieved for it.

Guardrails in code:
- With no articles, the answer is "insufficient information" without calling a model at all.
- Citations must be ids of articles that were provided; anything else is removed.
- An answer the model marks as not supported by the articles, or that cites nothing, becomes "insufficient information".
"""

from __future__ import annotations

import time

from .config import ASSISTANT_VERSION
from .llm import LLMProvider
from .models import AnswerRequest, AnswerResponse, Meta
from .pipeline import _llm_with_repair
from .prompts import ANSWER_SCHEMA, ANSWER_SYSTEM, PROMPT_VERSIONS

INSUFFICIENT = {
    "en": "I could not find enough information in published LocalLens articles to answer that.",
    "te": "దీనికి సమాధానం ఇవ్వడానికి ప్రచురించిన LocalLens వార్తలలో తగినంత సమాచారం దొరకలేదు.",
}

TRUST_NOTE = {
    "editor_verified": "verified by LocalLens editors",
    "citizen_reviewed": "citizen report, reviewed but not independently verified",
    "official_unverified": "official source, not independently verified",
    "developing": "developing story",
    "reporter_post": "posted by a local reporter, NOT checked by editors",
    "external_source": "headline from another news site, NOT checked by LocalLens",
}


def _validate(out: dict) -> None:
    if not isinstance(out["answer"], str) or not isinstance(out["cited_article_ids"], list):
        raise ValueError("bad answer")


def answer(req: AnswerRequest, llm: LLMProvider) -> AnswerResponse:
    started = time.monotonic()
    meta = lambda warnings: Meta(  # noqa: E731
        pipeline_version=ASSISTANT_VERSION,
        provider=llm.name,
        model=llm.model,
        prompt_versions={"answer": PROMPT_VERSIONS["answer"]},
        duration_ms=int((time.monotonic() - started) * 1000),
        warnings=warnings,
    )
    if not req.articles:
        return AnswerResponse(status="insufficient_information", answer=INSUFFICIENT[req.answer_language], cited_article_ids=[], meta=meta([]))

    blocks = []
    for a in req.articles:
        corrections = "".join(f"\nCorrection: {c}" for c in a.corrections)
        blocks.append(
            f'<article id="{a.id}" published="{a.published_at}" place="{a.location_label}" label="{TRUST_NOTE.get(a.trust_label, a.trust_label)}">\n'
            f"{a.headline}\n{a.summary}\n{a.body or '(text withdrawn: this article was retracted)'}{corrections}\n</article>"
        )
    style = "very simple Telugu that anyone can understand" if req.simple and req.answer_language == "te" else ("Telugu" if req.answer_language == "te" else "English")
    user = f"Answer in {style}.\nQuestion: {req.question}\n" + "\n".join(blocks)
    out = _llm_with_repair(llm, ANSWER_SYSTEM, user, ANSWER_SCHEMA, _validate)

    allowed = {a.id for a in req.articles}
    cited = [c for c in dict.fromkeys(out["cited_article_ids"]) if c in allowed]
    warnings = [] if len(cited) == len(out["cited_article_ids"]) else ["Removed citations to articles that were not provided."]
    if not out["enough_information"] or not cited or not out["answer"].strip():
        return AnswerResponse(status="insufficient_information", answer=INSUFFICIENT[req.answer_language], cited_article_ids=[], meta=meta(warnings))
    return AnswerResponse(status="answered", answer=out["answer"].strip()[:3000], cited_article_ids=cited, meta=meta(warnings))
