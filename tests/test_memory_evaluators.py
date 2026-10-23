"""Offline contract tests for the two fixed-version LongMemEval judges."""

import json
import unittest
from types import SimpleNamespace

from pydantic import ValidationError

from wandrun.evaluation.memory_evaluators import (
    BenchmarkDecision, DimensionDecision, Evidence, QualityDecision,
    benchmark_feedback, evaluate_benchmark, evaluate_quality, quality_feedback,
)


def case(task="single-session-user", question_id="q1"):
    return {
        "question_id": question_id, "question_type": task,
        "question": "What drink does the user prefer?", "answer": "Oolong tea",
        "question_date": "2026-04-11", "haystack_session_ids": ["older", "latest"],
        "haystack_dates": ["2026-03-01", "2026-04-10"],
        "haystack_sessions": [
            [{"role": "user", "content": "I used to drink coffee."},
             {"role": "assistant", "content": "Noted."}],
            [{"role": "user", "content": "Now I prefer oolong tea.", "has_answer": True},
             {"role": "assistant", "content": "I will remember oolong tea."}],
        ],
        "answer_session_ids": ["latest"],
    }


def outputs():
    return {"answer": "You prefer oolong tea.",
            "observed_memory_process": "Observed: retrieved latest session."}


def evidence(source="latest", turn=0, quote="Now I prefer oolong tea."):
    return {"session_id": source, "turn_index": turn, "quote": quote}


def dimension(score=2, reason="Accurate use of the latest preference."):
    return {"score": score, "reason": reason, "evidence": [evidence()]}


def quality_response():
    return {key: dimension() for key in (
        "factual_correctness", "update_temporal_handling", "relevance", "unsupported_claims"
    )}


class FakeJudge:
    model_name = "gpt-6-sol"

    def __init__(self, response):
        self.response = response
        self.calls = []

    def bind(self, **kwargs):
        self.calls.append(kwargs)
        return self

    async def ainvoke(self, prompt):
        self.calls.append(prompt)
        return SimpleNamespace(content=self.response)


class MemoryEvaluatorTests(unittest.IsolatedAsyncioTestCase):
    def test_structured_schema_rejects_invalid_and_missing_fields(self):
        for verdict in ("maybe", True, 1):
            with self.subTest(verdict=verdict), self.assertRaises(ValidationError):
                BenchmarkDecision.model_validate({"verdict": verdict, "reason": "yes",
                                                  "evidence": [evidence()]})
        for invalid in (None, "", "  "):
            with self.subTest(reason=invalid), self.assertRaises(ValidationError):
                BenchmarkDecision.model_validate({"verdict": "yes", "reason": invalid,
                                                  "evidence": [evidence()]})
        for value in (-1, 0.5, 3, "2", True):
            with self.subTest(score=value), self.assertRaises(ValidationError):
                DimensionDecision.model_validate(dimension(score=value))
        with self.assertRaises(ValidationError):
            QualityDecision.model_validate({"relevance": dimension()})
        with self.assertRaises(ValidationError):
            Evidence.model_validate({"session_id": "latest", "turn_index": -1, "quote": "x"})
        with self.assertRaises(ValidationError):
            QualityDecision.model_validate({**quality_response(), "unknown_dimension": dimension()})


    def test_feedback_retains_rubric_reason_citation_model_and_scores(self):
        item = BenchmarkDecision.model_validate({"verdict": "no", "reason": "Only the old drink given.",
                                                  "evidence": [evidence("older", 0, "coffee")]})
        feedback = benchmark_feedback(case(), outputs(), item, "gpt-6-sol")["results"]
        self.assertEqual(feedback[0]["key"], "benchmark_correct")
        self.assertEqual(feedback[0]["score"], 0)
        comment = json.loads(feedback[0]["comment"])
        self.assertEqual(comment["reason"], "Only the old drink given.")
        self.assertEqual(comment["evidence"], [evidence("older", 0, "coffee")])
        self.assertEqual(comment["judge_model"], "gpt-6-sol")
        self.assertIn("judge_variant", comment)

        decisions = quality_response()
        decisions["update_temporal_handling"] = dimension(1, "The update was partially used.")
        decisions["unsupported_claims"] = dimension(0, "An unsupported addition appeared.")
        results = quality_feedback(case(), outputs(), QualityDecision.model_validate(decisions),
                                   "gpt-6-sol")["results"]
        self.assertEqual({item["key"]: item["score"] for item in results}, {
            "factual_correctness": 1, "update_temporal_handling": 0.5,
            "relevance": 1, "unsupported_claims": 0, "memory_use_quality": 0.625,
        })
        for item in results:
            comment = json.loads(item["comment"])
            self.assertIn("reason", comment)
            self.assertIn("rubric", comment)
            self.assertIn("evidence", comment)
            self.assertEqual(comment["judge_model"], "gpt-6-sol")
        self.assertEqual(json.loads(results[-1]["comment"])["reason"]["update_temporal_handling"],
                         "The update was partially used.")

    def test_numeric_reference_can_be_cited_without_coercing_scores(self):
        numeric = {**case(), "answer": 3}
        decision = BenchmarkDecision.model_validate({
            "verdict": "no", "reason": "The count is omitted.",
            "evidence": [evidence("reference:answer", 0, "3")],
        })
        result = benchmark_feedback(numeric, outputs(), decision, "gpt-6-sol")
        self.assertEqual(result["results"][0]["score"], 0)
        citation = json.loads(result["results"][0]["comment"])["evidence"][0]
        self.assertEqual(citation["quote"], "3")
        self.assertIs(type(citation["turn_index"]), int)

    def test_bad_citation_is_error_not_silent_zero(self):
        bad = BenchmarkDecision.model_validate({"verdict": "yes", "reason": "Claims evidence.",
                                                 "evidence": [evidence("missing")]})
        with self.assertRaisesRegex(ValueError, "Unverifiable evidence"):
            benchmark_feedback(case(), outputs(), bad, "gpt-6-sol")
        decisions = quality_response()
        decisions["relevance"] = {**dimension(), "evidence": [evidence("latest", 99, "Now")]}
        with self.assertRaisesRegex(ValueError, "Unverifiable evidence"):
            quality_feedback(case(), outputs(), QualityDecision.model_validate(decisions), "gpt-6-sol")


    async def test_malformed_response_is_unscored_exception_without_retry(self):
        for response in ("not json", "{}", '{"verdict":"uncertain","reason":"x","evidence":[]}',
                         '{"verdict":"yes","reason":"x","evidence":[]}'):
            with self.subTest(response=response):
                judge = FakeJudge(response)
                with self.assertRaises(ValidationError):
                    await evaluate_benchmark(case(), outputs(), judge)
                self.assertEqual(len(judge.calls), 2)
        judge = FakeJudge(json.dumps({**quality_response(), "relevance": dimension(3)}))
        with self.assertRaises(ValidationError):
            await evaluate_quality(case(), outputs(), judge)
        self.assertEqual(len(judge.calls), 2)
