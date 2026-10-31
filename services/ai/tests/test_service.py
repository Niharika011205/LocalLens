"""
Tests for the AI service. The model is replaced by a scripted fake (tests only) so the guardrails can be checked
deterministically; the fetcher is replaced by fixed documents, except in the SSRF tests which use the real backend.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.config import ConfigError, load_settings
from app.fetcher import FetchBlocked, FetchedDocument, FetchFailed, PinnedBackend, SafeFetcher, assert_public, validate_url
from app.llm import LLMError
from app.main import create_app
from app.models import AnswerRequest, AssistantArticle, VerifyRequest
from app.pipeline import decide, verify
from app.assistant import answer
from app.text import detect_language, quote_in, rank_passages, to_passages

TOKEN = "t" * 40
SETTINGS = load_settings({"AI_SERVICE_TOKEN": TOKEN, "LLM_PROVIDER": "none"})


class ScriptedLLM:
    """Returns queued outputs in order; raises queued exceptions. Records prompts for inspection."""

    name = "scripted"
    model = "scripted-test-model"

    def __init__(self, *outputs):
        self.outputs = list(outputs)
        self.prompts: list[str] = []

    def json(self, system, user, schema, max_tokens=4000):
        self.prompts.append(user)
        out = self.outputs.pop(0)
        if isinstance(out, Exception):
            raise out
        return out


class FixedFetcher:
    def __init__(self, docs: dict[str, str | Exception]):
        self.docs = docs

    def fetch(self, url):
        value = self.docs[url]
        if isinstance(value, Exception):
            raise value
        return FetchedDocument(url=url, final_url=url, title="Notice", text=value, published_at="2026-10-18", retrieved_at="2026-10-20T10:00:00+00:00", content_sha256="abc")


NOTICE = (
    "The Mandal Revenue Office announced that the Tenali–Guntur road will be closed from 12 October to 15 October for culvert repairs.\n"
    "Traffic will be diverted through Kollipara during the closure."
)
REQ = VerifyRequest(
    submission_id="s1",
    headline="Tenali Guntur road closed for repairs",
    summary="The road will be closed from 12 October to 15 October.",
    body="Officials said the Tenali Guntur road will be closed from 12 October to 15 October for culvert repairs. Residents are angry.",
    language="en",
    location_label="Tenali, Guntur",
    supporting_urls=["https://guntur.ap.gov.in/notice", "https://blog.example.com/post"],
)
CLAIMS = {
    "claims": [
        {"text": "The Tenali Guntur road will be closed from 12 October to 15 October for culvert repairs.", "kind": "factual", "check_worthy": True},
        {"text": "Residents are angry.", "kind": "opinion", "check_worthy": False},
    ]
}


def run(llm, docs=None):
    fetcher = FixedFetcher(docs or {"https://guntur.ap.gov.in/notice": NOTICE, "https://blog.example.com/post": FetchFailed("HTTP 404")})
    return verify(REQ, llm, fetcher, max_sources=5, max_claims_assessed=3)


# ---------- pipeline guardrails ----------
def test_supported_claim_with_verified_quote_and_provenance():
    quote = "the Tenali–Guntur road will be closed from 12 October to 15 October for culvert repairs."
    llm = ScriptedLLM(CLAIMS, {"passages": [{"passage_id": "S1P1", "stance": "supports", "quote": quote}], "rationale": "The notice states the dates.", "missing_evidence": [], "uncertainty": "Dates could change."})
    result = run(llm)
    c1, c2 = result.claims
    assert c1.assessment == "supported" and c1.supporting_evidence_ids == ["E1"]
    assert c2.kind == "opinion" and c2.assessment == "not_assessed"
    ev = result.evidence[0]
    assert ev.excerpt_verified and ev.source_type == "official_government" and ev.published_at == "2026-10-18"
    assert result.sources[1].status == "error"
    assert result.recommendation == "standard_review"
    assert result.meta.prompt_versions == {"extract_claims": "claims-v1", "assess_claim": "assess-v1"}
    # Untrusted text is wrapped as data
    assert "<submission>" in llm.prompts[0] and '<passage id="S1P1">' in llm.prompts[1]


def test_the_same_excerpt_cited_twice_counts_once():
    quote = "the Tenali–Guntur road will be closed from 12 October to 15 October for culvert repairs."
    twice = [{"passage_id": "S1P1", "stance": "supports", "quote": quote}, {"passage_id": "S1P1", "stance": "supports", "quote": "  " + quote.upper()}]
    result = run(ScriptedLLM(CLAIMS, {"passages": twice, "rationale": "x", "missing_evidence": [], "uncertainty": ""}))
    assert result.claims[0].supporting_evidence_ids == ["E1"] and len(result.evidence) == 1


def test_invented_quotes_and_unknown_passages_are_discarded():
    llm = ScriptedLLM(
        CLAIMS,
        {
            "passages": [
                {"passage_id": "S1P1", "stance": "supports", "quote": "The Collector confirmed the closure on television yesterday."},
                {"passage_id": "S9P9", "stance": "supports", "quote": "Made-up passage from nowhere at all."},
            ],
            "rationale": "x",
            "missing_evidence": [],
            "uncertainty": "",
        },
    )
    result = run(llm)
    assert result.evidence == []
    assert result.claims[0].assessment == "insufficient_evidence"  # not "supported", and never "contradicted"
    assert any("does not appear in the source text" in w for w in result.meta.warnings)
    assert any("not retrieved" in w for w in result.meta.warnings)


def test_conflicting_evidence_is_kept_as_mixed_and_sent_to_a_senior_editor():
    notice2 = "Officials clarified the Tenali Guntur road will not be closed in October; repairs were postponed to December."
    docs = {"https://guntur.ap.gov.in/notice": NOTICE, "https://blog.example.com/post": notice2}
    llm = ScriptedLLM(
        CLAIMS,
        {
            "passages": [
                {"passage_id": "S1P1", "stance": "supports", "quote": "the Tenali–Guntur road will be closed from 12 October to 15 October"},
                {"passage_id": "S2P1", "stance": "contradicts", "quote": "repairs were postponed to December."},
            ],
            "rationale": "Two sources disagree.",
            "missing_evidence": ["A dated notice confirming the final schedule"],
            "uncertainty": "",
        },
    )
    result = run(llm, docs)
    assert result.claims[0].assessment == "mixed"
    assert result.recommendation == "senior_review"
    assert {e.stance for e in result.evidence} == {"supports", "contradicts"}


def test_no_links_means_insufficient_evidence_without_calling_the_model_for_assessment():
    req = REQ.model_copy(update={"supporting_urls": []})
    llm = ScriptedLLM(CLAIMS)  # only the extraction output is queued
    result = verify(req, llm, FixedFetcher({}), max_sources=5, max_claims_assessed=3)
    assert result.claims[0].assessment == "insufficient_evidence"
    assert result.recommendation == "request_more_info"
    assert len(llm.prompts) == 1


def test_decision_table():
    assert decide(0, 0) == "insufficient_evidence"
    assert decide(2, 0) == "supported"
    assert decide(0, 1) == "contradicted"
    assert decide(1, 1) == "mixed"


def test_transient_model_errors_propagate_and_bad_output_is_retried_once():
    with pytest.raises(LLMError) as exc:
        run(ScriptedLLM(LLMError("down", transient=True)))
    assert exc.value.transient
    # Malformed then valid: repaired on the second attempt
    result = run(ScriptedLLM({"claims": [{"text": "x", "kind": "weird", "check_worthy": True}]}, {"claims": []}))
    assert result.claims == []
    with pytest.raises(LLMError) as exc2:
        run(ScriptedLLM({"nope": 1}, {"nope": 2}))
    assert not exc2.value.transient


# ---------- text helpers ----------
def test_language_detection_and_passages():
    assert detect_language("గుంటూరు జిల్లాలో రోడ్డు మరమ్మతులు ప్రారంభమయ్యాయి") == "te"
    assert detect_language("Road repairs started in Guntur district today") == "en"
    passages = to_passages(0, "\n".join(["para " * 50] * 6))
    assert len(passages) > 1 and passages[0].id == "S1P1"
    assert rank_passages("unrelated words entirely", passages) == []
    assert quote_in("ROAD will be  closed", "The road will be closed tomorrow") is True
    assert quote_in("short", "short text") is False  # too short to be meaningful evidence


# ---------- SSRF defences (real backend, no network needed) ----------
@pytest.mark.parametrize("ip", ["127.0.0.1", "10.0.0.5", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "::ffff:127.0.0.1", "0.0.0.0"])
def test_non_public_addresses_are_blocked(ip):
    with pytest.raises(FetchBlocked):
        assert_public(ip)


def test_public_address_allowed():
    assert_public("8.8.8.8")


@pytest.mark.parametrize("url", ["ftp://example.com/x", "file:///etc/passwd", "http://user:pass@example.com/", "http://example.com:8080/", "javascript:alert(1)"])
def test_disallowed_urls(url):
    with pytest.raises(FetchBlocked):
        validate_url(url)


def test_hostnames_resolving_to_private_addresses_are_blocked_at_connect_time():
    # A public-looking name that resolves to the metadata service (DNS rebinding / internal pointer).
    backend = PinnedBackend(lambda host, port: ["169.254.169.254"])
    with pytest.raises(FetchBlocked):
        backend.connect_tcp("innocent.example.com", 80)
    mixed = PinnedBackend(lambda host, port: ["93.184.216.34", "127.0.0.1"])
    with pytest.raises(FetchBlocked):
        mixed.connect_tcp("innocent.example.com", 80)


def test_safe_fetcher_refuses_localhost_end_to_end():
    fetcher = SafeFetcher("test-agent", 2, 1000, resolver=lambda host, port: ["127.0.0.1"])
    with pytest.raises(FetchBlocked):
        fetcher.fetch("http://localhost-alias.example/")


# ---------- assistant ----------
ARTICLE = AssistantArticle(id="a1", headline="Pension applications open", summary="Apply by 15 November at the village secretariat.", body="Applications for the pension scheme close on 15 November.", published_at="2026-10-20", location_label="Tenali", trust_label="official_unverified")


def test_assistant_answers_with_only_provided_citations():
    llm = ScriptedLLM({"enough_information": True, "answer": "Apply by 15 November.", "cited_article_ids": ["a1", "invented"]})
    result = answer(AnswerRequest(question="When is the pension deadline?", answer_language="en", articles=[ARTICLE]), llm)
    assert result.status == "answered" and result.cited_article_ids == ["a1"]
    assert result.meta.warnings == ["Removed citations to articles that were not provided."]
    assert "not independently verified" in llm.prompts[0]


def test_assistant_says_so_when_information_is_insufficient():
    no_articles = answer(AnswerRequest(question="What happened in Kollipara?", answer_language="te", articles=[]), ScriptedLLM())
    assert no_articles.status == "insufficient_information" and "తగినంత" in no_articles.answer
    unsupported = answer(AnswerRequest(question="Who won the match?", answer_language="en", articles=[ARTICLE]), ScriptedLLM({"enough_information": False, "answer": "Team A", "cited_article_ids": []}))
    assert unsupported.status == "insufficient_information" and unsupported.cited_article_ids == []


# ---------- HTTP surface ----------
def test_http_requires_token_and_maps_errors():
    # A permanent error gets one repair attempt before the request fails, hence two queued.
    app = create_app(SETTINGS, llm=ScriptedLLM(LLMError("down", transient=True), LLMError("bad", transient=False), LLMError("bad", transient=False)), fetcher=FixedFetcher({}))
    client = TestClient(app)
    body = REQ.model_dump() | {"supporting_urls": []}
    assert client.get("/healthz").json()["status"] == "ok"
    assert client.post("/v1/verify", json=body).status_code == 401
    assert client.post("/v1/verify", json=body, headers={"X-Service-Token": "wrong"}).status_code == 401
    transient = client.post("/v1/verify", json=body, headers={"X-Service-Token": TOKEN})
    assert transient.status_code == 503 and transient.json()["error"]["transient"] is True
    permanent = client.post("/v1/verify", json=body, headers={"X-Service-Token": TOKEN})
    assert permanent.status_code == 422 and permanent.json()["error"]["transient"] is False
    assert client.post("/v1/verify", json=body | {"extra": 1}, headers={"X-Service-Token": TOKEN}).status_code == 422


def test_settings_validation():
    with pytest.raises(ConfigError):
        load_settings({"AI_SERVICE_TOKEN": "short"})
    with pytest.raises(ConfigError):
        load_settings({"AI_SERVICE_TOKEN": TOKEN, "LLM_PROVIDER": "openai"})
