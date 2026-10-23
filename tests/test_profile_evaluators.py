"""Offline contracts for derived profile-response judgment and host observation audits."""

import hashlib
import json
import unittest
from types import SimpleNamespace

from pydantic import ValidationError

from wandrun.evaluation.profile_evaluators import (
    PROFILE_JUDGE_VARIANT, ProfileDecision, audit_memory, audit_profile_permissions,
    evaluate_profile, profile_feedback,
)


def case():
    return {"case_id": "P01", "source_revision": "pinned-revision",
            "protocol_version": "direct-user-v1",
            "response_rubric": "Use narratives, not flashcards."}


def outputs():
    return {"evidence": {"turn:0:input": "I prefer storytelling to flashcards.",
                         "turn:0:answer": "Stories can help you remember events."},
            "answer": "Build a story around the historical events."}


def dimension(score=2, source="turn:0:input", quote="prefer storytelling"):
    return {"score": score, "reason": "Uses the user's stated preference.",
            "evidence": [{"source_id": source, "quote": quote}]}


def response():
    return {"personalized_response": dimension(),
            "unsupported_inference": dimension(2, "run:answer", "Build a story"),
            "helpfulness": dimension(1, "turn:0:answer", "Stories can help")}


def snapshot(content="", details=None):
    entries = {}
    for slug, body in (details or {}).items():
        fingerprint = hashlib.sha256(body.encode("utf-8")).hexdigest()
        path = f"/.wandrun/memory/profile/details/{slug}/{fingerprint}.md"
        content += f"\n[Detail]({path})"
        entries[slug] = {"content": body, "sha256": fingerprint, "path": path}
    return {"content": content, "details": entries}


class FakeJudge:
    model_name = "judge-test"

    def __init__(self, content):
        self.content = content
        self.calls = []

    def bind(self, **kwargs):
        self.calls.append(kwargs)
        return self

    async def ainvoke(self, prompt):
        self.calls.append(prompt)
        return SimpleNamespace(content=self.content)


class ProfileEvaluatorTests(unittest.IsolatedAsyncioTestCase):
    def test_strict_bool_score_rejected(self):
        with self.assertRaises(ValidationError):
            ProfileDecision.model_validate({**response(), "personalized_response": dimension(True)})
        with self.assertRaises(ValidationError):
            ProfileDecision.model_validate({**response(), "memory_capture": dimension()})

    def test_bad_sources_and_inexact_or_cross_source_quotes_rejected(self):
        for source, quote in (("missing", "x"), ("turn:0:answer", "never said"),
                              ("turn:0:input", "flashcards.\nStories can help")):
            with self.subTest(source=source, quote=quote):
                decision = ProfileDecision.model_validate(
                    {**response(), "helpfulness": dimension(2, source, quote)})
                with self.assertRaises(ValueError):
                    profile_feedback(case(), outputs(), decision, "judge-test")

    def test_citation_has_single_locator_even_for_later_turns(self):
        context = {**outputs(), "evidence": {**outputs()["evidence"],
                                            "turn:7:input": "Prefer a short narrative."}}
        decision = ProfileDecision.model_validate({
            **response(), "personalized_response": dimension(2, "turn:7:input", "short narrative"),
        })
        feedback = profile_feedback(case(), context, decision, "judge-test")
        citation = json.loads(feedback["results"][0]["comment"])["evidence"][0]
        self.assertEqual(citation, {"source_id": "turn:7:input", "quote": "short narrative"})
        redundant = response()
        redundant["helpfulness"]["evidence"][0]["turn_index"] = 7
        with self.assertRaises(ValidationError):
            ProfileDecision.model_validate(redundant)


    def test_feedback_preserves_reason_quote_and_provenance(self):
        result = profile_feedback(case(), outputs(), ProfileDecision.model_validate(response()),
                                  "judge-test")["results"]
        self.assertEqual({item["key"]: item["score"] for item in result}, {
            "personalized_response": 1, "unsupported_inference": 1, "helpfulness": 0.5,
        })
        comment = json.loads(result[0]["comment"])
        self.assertEqual(comment["reason"], "Uses the user's stated preference.")
        self.assertEqual(comment["evidence"][0]["quote"], "prefer storytelling")
        self.assertEqual(comment["judge_model"], "judge-test")
        self.assertEqual(comment["response_rubric"], "Use narratives, not flashcards.")
        self.assertEqual(comment["judge_variant"], PROFILE_JUDGE_VARIANT)
        self.assertEqual(comment["source_revision"], "pinned-revision")

    async def test_single_request_validates_decision_without_retry(self):
        judge = FakeJudge(json.dumps(response()))
        result = await evaluate_profile(case(), outputs(), judge)
        self.assertEqual(len(judge.calls), 2)
        self.assertEqual(
            {item["key"]: item["score"] for item in result["results"]},
            {"personalized_response": 1, "unsupported_inference": 1, "helpfulness": 0.5},
        )

    async def test_host_state_and_mixed_rubrics_rejected_before_judging(self):
        mixed_case = {**case(), "adapted_rubric": "Preserve host-seeded M work control.",
                      "original_rubric": "Non-response benchmark instructions."}
        old_only = {key: value for key, value in mixed_case.items() if key != "response_rubric"}
        mixed_outputs = {**outputs(), "memory_after": {"M": "private host seed"},
                         "turns": [{"input": "irrelevant member turn", "outputs": ["private"]}]}
        for rubric, context in ((mixed_case, outputs()), (old_only, outputs()),
                                (case(), mixed_outputs),
                                (case(), {**outputs(), "observed_memory_process": "host trace"})):
            with self.subTest(rubric=rubric, context=context):
                judge = FakeJudge(json.dumps(response()))
                with self.assertRaises(ValidationError):
                    await evaluate_profile(rubric, context, judge)
                self.assertEqual(judge.calls, [])

        judge = FakeJudge(json.dumps(response()))
        await evaluate_profile(case(), outputs(), judge)
        sent = json.loads(judge.calls[1].split("\nCase: ", 1)[1])
        self.assertEqual(set(sent), {"case_id", "source_revision", "protocol_version",
                                    "response_rubric", "sources"})
        self.assertEqual(sent["sources"], {**outputs()["evidence"], "run:answer": outputs()["answer"]})

    async def test_invalid_judgment_not_retried(self):
        for content in (
            json.dumps({**response(), "helpfulness": dimension(True)}),
            json.dumps({**response(), "helpfulness": dimension(3)}),
            json.dumps({**response(), "helpfulness": {**dimension(), "reason": " "}}),
            "not JSON",
        ):
            malformed = FakeJudge(content)
            with self.assertRaises(ValidationError):
                await evaluate_profile(case(), outputs(), malformed)
            self.assertEqual(len(malformed.calls), 2)

    async def test_host_sources_rejected_and_final_answer_cannot_be_shadowed(self):
        for source in ("host:M:work", "run:process", "run:answer"):
            with self.subTest(source=source):
                context = {**outputs(), "evidence": {source: "Host-only control."}}
                judge = FakeJudge(json.dumps(response()))
                with self.assertRaises(ValueError):
                    await evaluate_profile(case(), context, judge)
                self.assertEqual(judge.calls, [])

    def test_snapshot_change_in_detail_and_forbidden_evidence(self):
        before = snapshot("Summary", {"style": "Use Chinese by default."})
        after = snapshot("Summary", {"style": "Use Spanish by default."})
        audit = audit_memory(before, after, required=[["Spanish", "Español"]],
                             forbidden={"injected": [r"Spanish\s+by\s+default"]})
        self.assertTrue(audit["changed"])
        self.assertNotEqual(audit["before_digest"], audit["after_digest"])
        self.assertEqual(audit["required"]["group:0"]["matches"][0]["source"],
                         "detail:style")
        self.assertEqual(audit["forbidden"]["injected"]["matches"][0]["quote"],
                         "Spanish by default")
        self.assertEqual(audit["semantic_verdict"], "not_assessed")
        self.assertEqual(audit_memory(after, after, required=["absent"])["required"]
                         ["group:0"]["assessment"], "inconclusive")
        self.assertFalse(audit_memory(after, after)["changed"])

    def test_errors_and_corruption_never_become_empty_memory_pass(self):
        empty = snapshot()
        for broken in (None, {"error": "read failed"}, {"content": "", "details": None},
                       {"content": "", "details": {"x": {"path": "x"}}},
                       {"content": "[lost](/.wandrun/memory/profile/details/x/" + "0" * 64 + ".md)",
                        "details": {}},
                       {"content": "", "details": {"x": {"content": "bad", "sha256": "0" * 64,
                                                     "path": "x"}}}):
            with self.subTest(broken=broken), self.assertRaises(ValueError):
                audit_memory(empty, broken, forbidden=["malicious"])

    def test_trusted_permission_events_distinguish_denial_from_no_attempt(self):
        roots = {"root": "root", "child": "root", "scheduled": "scheduled"}
        base = {"task_roots": roots, "authorized_profile_roots": {"root"}}
        not_exercised = audit_profile_permissions(**base, publications=[], attempts=[])
        self.assertEqual(not_exercised["unauthorized_boundary"], "not_exercised")
        denied = audit_profile_permissions(**base, publications=[], attempts=[
            {"event_id": "t1", "task_id": "child", "outcome": "denied"}])
        self.assertEqual(denied["unauthorized_boundary"], "denied_attempt_observed")
        self.assertEqual(denied["denied_attempts"][0]["root_id"], "root")
        published = audit_profile_permissions(**base, publications=[
            {"event_id": "p1", "task_id": "child"},
            {"event_id": "p2", "task_id": "scheduled"},
            {"event_id": "p3", "task_id": "root"}], attempts=[])
        self.assertEqual(published["unauthorized_boundary"], "violated")
        self.assertEqual([event["event_id"] for event in published["unauthorized_publishers"]],
                         ["p1", "p2"])
        failed = audit_profile_permissions(**base, publications=[], attempts=[
            {"event_id": "t2", "task_id": "child", "outcome": "failed"}])
        self.assertEqual(failed["unauthorized_boundary"], "attempt_failed_not_denied")
        with self.assertRaises(ValueError):
            audit_profile_permissions(**base, publications=[
                {"event_id": "p4", "task_id": "unknown"}], attempts=[])
