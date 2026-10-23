"""Fixed LongMemEval correctness and observable memory-use judges.

Each async evaluator makes exactly one model request. Invalid model output or an
unverifiable citation raises, so the caller can leave that run unscored rather
than recording a fabricated zero. The judge must support LangChain ``bind``
and ``ainvoke`` and expose its actual ``model_name``.
"""

from __future__ import annotations

import json
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from typing_extensions import Annotated


JUDGE_VARIANT = "longmemeval-official-qa-v1+memory-use-v1"
Nonempty = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]

# These are the official evaluate_qa.py rules, retaining its task-specific
# distinctions. Only the requested response format is changed to structured
# yes/no plus an auditable reason and source citation.
_COMMON = ("I will give you a question, a correct answer, and a response from a model. "
           "Please answer yes if the response contains the correct answer. Otherwise, answer no. "
           "If the response is equivalent to the correct answer or contains all the intermediate steps "
           "to get the correct answer, you should also answer yes. If the response only contains a "
           "subset of the information required by the answer, answer no.")
_TEMPORAL = (_COMMON + " In addition, do not penalize off-by-one errors for the number of days. "
             "If the question asks for the number of days/weeks/months, etc., and the model makes "
             "off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's "
             "response is still correct.")
_UPDATE = ("I will give you a question, a correct answer, and a response from a model. "
           "Please answer yes if the response contains the correct answer. Otherwise, answer no. "
           "If the response contains some previous information along with an updated answer, "
           "the response should be considered as correct as long as the updated answer is the "
           "required answer.")
_PREFERENCE = ("I will give you a question, a rubric for desired personalized response, "
               "and a response from a model. Please answer yes if the response satisfies the "
               "desired response. Otherwise, answer no. The model does not need to reflect all "
               "the points in the rubric. The response is correct as long as it recalls and "
               "utilizes the user's personal information correctly.")
_ABSTENTION = ("I will give you an unanswerable question, an explanation, and a response from "
               "a model. Please answer yes if the model correctly identifies the question as "
               "unanswerable. The model could say that the information is incomplete, or some "
               "other information is given but the asked information is not.")
_RUBRICS = {
    "single-session-user": _COMMON,
    "single-session-assistant": _COMMON,
    "multi-session": _COMMON,
    "temporal-reasoning": _TEMPORAL,
    "knowledge-update": _UPDATE,
    "single-session-preference": _PREFERENCE,
}
_QUALITY_RUBRICS = {
    "factual_correctness": "Are claims in the answer faithful to the dated original sessions? Penalize incorrect facts, even if the answer sounds plausible.",
    "update_temporal_handling": "Does the answer respect the latest applicable updates and the question date, and reason about time accurately? Do not infer a memory mechanism from the result.",
    "relevance": "Does the response answer the specific question without losing needed details or adding unrelated material? For unanswerable questions, appropriate abstention is relevant.",
    "unsupported_claims": "Are claims free of unsupported additions or invented memory/process claims? Score high for no unsupported claims; a justified abstention is not an unsupported claim.",
}


class Evidence(BaseModel):
    """An exact quote at a 0-based source turn or in the final answer/process."""

    model_config = ConfigDict(extra="forbid", strict=True)
    session_id: Nonempty  # original session id, run:answer, run:process, or reference:answer
    turn_index: int = Field(ge=0)
    quote: Nonempty


class BenchmarkDecision(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    verdict: Literal["yes", "no"]
    reason: Nonempty
    evidence: list[Evidence] = Field(min_length=1)


class DimensionDecision(BaseModel):
    """0=poor, 1=partial/mixed, 2=good; all dimensions higher-is-better."""

    model_config = ConfigDict(extra="forbid", strict=True)
    score: int = Field(strict=True, ge=0, le=2)
    reason: Nonempty
    evidence: list[Evidence] = Field(min_length=1)


class QualityDecision(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    factual_correctness: DimensionDecision
    update_temporal_handling: DimensionDecision
    relevance: DimensionDecision
    unsupported_claims: DimensionDecision


def benchmark_prompt(case: dict, outputs: dict) -> str:
    """Project the official rubric; abstention in question_id takes precedence over task type."""
    question_id = case["question_id"]
    task = case["question_type"]
    rubric = _ABSTENTION if "_abs" in question_id else _RUBRICS[task]
    label = "Explanation" if "_abs" in question_id else (
        "Rubric" if task == "single-session-preference" else "Correct Answer"
    )
    return (f"Judge variant: {JUDGE_VARIANT}. Follow this official LongMemEval rubric:\n{rubric}\n\n"
            f"Question: {case['question']}\n\n{label}: {case['answer']}\n\n"
            f"Model Response: {outputs['answer']}\n\n"
            "Is the model response correct? Give verdict yes or no, a specific reason, and at least "
            "one exact short quote from run:answer or reference:answer with turn_index 0. "
            "Do not introduce stricter requirements than the rubric.")


def quality_prompt(case: dict, outputs: dict) -> str:
    """Project all original dated turns and observed process without inventing agent internals."""
    sessions = case["haystack_sessions"]
    dates = case["haystack_dates"]
    ids = case["haystack_session_ids"]
    if len(sessions) != len(dates) or len(sessions) != len(ids) or len(set(ids)) != len(ids):
        raise ValueError("Original sessions, dates, and IDs must align uniquely")
    dated_sessions = [
        {"session_id": sid, "date": date, "turns": [
            {"turn_index": i, **turn} for i, turn in enumerate(session)
        ]} for sid, date, session in zip(ids, dates, sessions, strict=True)
    ]
    record = {
        "question_id": case["question_id"], "question_type": case["question_type"],
        "question": case["question"], "question_date": case["question_date"],
        "reference_answer": case["answer"],
        "answer_session_ids": case["answer_session_ids"],
        "dated_original_sessions": dated_sessions,
        "run:answer": outputs["answer"],
        "run:process": outputs["observed_memory_process"],
    }
    return (f"Judge variant: {JUDGE_VARIANT}. Assess the answer AND only the observed memory/process "
            "against the complete original dated sessions. Do not infer retrieval, storage, summaries, "
            "or other memory mechanisms not present in run:process. Score each of four dimensions "
            "independently: 0 poor, 1 mixed/partial, 2 good; higher is better. "
            "For every dimension provide a specific reason and at least one exact short quote. "
            "Cite an original session_id with its 0-based turn_index, or run:answer / run:process "
            "with turn_index 0. No fabricated citations. The case data follows:\n"
            + json.dumps({"rubrics": _QUALITY_RUBRICS, "case": record}, ensure_ascii=False))


def _source_texts(case: dict, outputs: dict) -> dict[tuple[str, int], str]:
    sources = {("run:answer", 0): outputs["answer"],
               ("reference:answer", 0): str(case["answer"])}
    process = outputs.get("observed_memory_process", "")
    if process:
        sources[("run:process", 0)] = process
    for sid, session in zip(case["haystack_session_ids"], case["haystack_sessions"], strict=True):
        for index, turn in enumerate(session):
            source = (sid, index)
            if source in sources:
                raise ValueError(f"Ambiguous evidence source {source!r}")
            sources[source] = turn["content"]
    return sources


def _check_evidence(evidence: list[Evidence], sources: dict[tuple[str, int], str]) -> None:
    for item in evidence:
        text = sources.get((item.session_id, item.turn_index))
        if not isinstance(text, str) or item.quote not in text:
            raise ValueError(f"Unverifiable evidence at {item.session_id!r} turn {item.turn_index}")


def _feedback(key: str, score: float, decision: DimensionDecision | BenchmarkDecision,
              rubric: str, model_name: str) -> dict:
    return {"key": key, "score": score, "comment": json.dumps({
        "judge_variant": JUDGE_VARIANT, "judge_model": model_name,
        "rubric": rubric, "reason": decision.reason,
        "evidence": [item.model_dump() for item in decision.evidence],
    }, ensure_ascii=False)}


def benchmark_feedback(case: dict, outputs: dict, decision: BenchmarkDecision,
                       model_name: str) -> dict:
    """Pure LangSmith feedback projection; invalid citations raise instead of scoring zero."""
    _check_evidence(decision.evidence, _source_texts(case, outputs))
    rubric = _ABSTENTION if "_abs" in case["question_id"] else _RUBRICS[case["question_type"]]
    return {"results": [_feedback("benchmark_correct", float(decision.verdict == "yes"),
                                  decision, rubric, model_name)]}


def quality_feedback(case: dict, outputs: dict, decision: QualityDecision,
                     model_name: str) -> dict:
    """Emit four 0/0.5/1 dimensions and their arithmetic mean, all with reasons."""
    sources = _source_texts(case, outputs)
    results = []
    for key, rubric in _QUALITY_RUBRICS.items():
        dimension = getattr(decision, key)
        _check_evidence(dimension.evidence, sources)
        results.append(_feedback(key, dimension.score / 2, dimension, rubric, model_name))
    aggregate = {
        "judge_variant": JUDGE_VARIANT, "judge_model": model_name,
        "rubric": "Arithmetic mean of the four independently scored higher-is-better dimensions (0/0.5/1).",
        "reason": {key: getattr(decision, key).reason for key in _QUALITY_RUBRICS},
        "evidence": {key: [item.model_dump() for item in getattr(decision, key).evidence]
                     for key in _QUALITY_RUBRICS},
    }
    results.append({"key": "memory_use_quality",
                    "score": sum(item["score"] for item in results) / len(results),
                    "comment": json.dumps(aggregate, ensure_ascii=False)})
    return {"results": results}


async def _judge(judge, schema: type[BaseModel], prompt: str) -> BaseModel:
    """Use native JSON-schema output, since this adapter supports response_format, not tool parsing."""
    response_format = {"type": "json_schema", "json_schema": {
        "name": schema.__name__, "strict": True, "schema": schema.model_json_schema(),
    }}
    message = await judge.bind(response_format=response_format).ainvoke(prompt)
    content = message.content
    if not isinstance(content, str):
        raise ValueError("Judge response must be a JSON string")
    return schema.model_validate_json(content)


async def evaluate_benchmark(case: dict, outputs: dict, judge) -> dict:
    """One official benchmark judgment; returns LangSmith EvaluationResults shape."""
    prompt = benchmark_prompt(case, outputs)
    decision = await _judge(judge, BenchmarkDecision, prompt)
    return benchmark_feedback(case, outputs, decision, judge.model_name)


async def evaluate_quality(case: dict, outputs: dict, judge) -> dict:
    """One evidence-grounded four-dimension judgment; returns EvaluationResults shape."""
    prompt = quality_prompt(case, outputs)
    decision = await _judge(judge, QualityDecision, prompt)
    return quality_feedback(case, outputs, decision, judge.model_name)
