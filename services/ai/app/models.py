"""Request and response shapes. The API (Node) mirrors these in packages/contracts/src/ai.ts."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Assessment = Literal["supported", "contradicted", "mixed", "insufficient_evidence", "not_assessed"]
ClaimKind = Literal["factual", "opinion", "prediction"]
SourceType = Literal["official_government", "established_news", "other"]
Stance = Literal["supports", "contradicts"]
Recommendation = Literal["standard_review", "senior_review", "request_more_info"]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class VerifyRequest(Strict):
    submission_id: str = Field(min_length=1, max_length=64)
    headline: str = Field(max_length=300)
    summary: str = Field(max_length=600)
    body: str = Field(max_length=25_000)
    language: Literal["te", "en"]
    location_label: str = Field(default="", max_length=300)
    incident_date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    category: str | None = Field(default=None, max_length=60)
    supporting_urls: list[str] = Field(default_factory=list, max_length=10)


class SourceRecord(Strict):
    url: str
    status: Literal["fetched", "blocked", "robots_disallowed", "unsupported_type", "too_large", "error"]
    detail: str | None = None
    title: str | None = None
    source_type: SourceType = "other"
    reliability_rationale: str = ""
    published_at: str | None = None
    retrieved_at: str
    content_sha256: str | None = None


class Evidence(Strict):
    id: str
    claim_id: str
    url: str
    stance: Stance
    excerpt: str
    excerpt_verified: bool
    source_type: SourceType
    reliability_rationale: str
    published_at: str | None
    retrieved_at: str


class Claim(Strict):
    id: str
    text: str
    kind: ClaimKind
    check_worthy: bool
    assessment: Assessment
    supporting_evidence_ids: list[str]
    contradicting_evidence_ids: list[str]
    rationale: str
    missing_evidence: list[str]
    uncertainty: str


class Meta(Strict):
    pipeline_version: str
    provider: str
    model: str
    prompt_versions: dict[str, str]
    duration_ms: int
    warnings: list[str]


class VerifyResponse(Strict):
    detected_language: Literal["te", "en", "mixed", "unknown"]
    language_matches_declared: bool
    claims: list[Claim]
    evidence: list[Evidence]
    sources: list[SourceRecord]
    recommendation: Recommendation
    meta: Meta


# ---------- assistant (Phase 5) ----------
class AssistantArticle(Strict):
    id: str = Field(max_length=64)
    headline: str = Field(max_length=300)
    summary: str = Field(max_length=600)
    body: str | None = Field(default=None, max_length=25_000)
    published_at: str
    location_label: str = ""
    trust_label: str
    corrections: list[str] = Field(default_factory=list, max_length=20)


class AnswerRequest(Strict):
    question: str = Field(min_length=3, max_length=500)
    answer_language: Literal["te", "en"]
    simple: bool = False
    articles: list[AssistantArticle] = Field(max_length=8)


class AnswerResponse(Strict):
    status: Literal["answered", "insufficient_information"]
    answer: str
    cited_article_ids: list[str]
    meta: Meta
