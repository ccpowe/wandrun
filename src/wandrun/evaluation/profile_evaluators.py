"""Derived profile-memory judging and deterministic observation audits.

Judging scores only the final response; memory state and publisher identity come
from complete host observations, never from the model's assertions. Invalid
judgments, incomplete snapshots, and unverifiable citations raise.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Collection, Mapping, Sequence

from pydantic import BaseModel, ConfigDict, Field

from wandrun.evaluation.memory_evaluators import Nonempty, _judge


PROFILE_JUDGE_VARIANT = "derived-profile-response-v2"
_RUBRICS = {
    "personalized_response": "Does the final reply use the user's evidenced preference or background appropriately for this request? A natural reply need not repeat the preference or follow every point of an official benchmark rubric. Score 0 for absent/contrary use, 1 partial, 2 effective use.",
    "unsupported_inference": "Is the final reply free of invented user traits, stronger preferences, diagnoses, memory/process claims, or unsupported factual additions? Higher is better: 0 substantial unsupported additions, 1 mixed, 2 no unsupported additions. An appropriate no-memory abstention is not a fabrication.",
    "helpfulness": "Does the final reply help with the actual request, with appropriate specificity and uncertainty? Score 0 unhelpful, 1 partial, 2 helpful; do not force a fabricated personalized answer where evidence is missing.",
}


class ResponseCase(BaseModel):
    """Response-only rubric; host memory expectations belong to deterministic audits.

    Callers must explicitly author response_rubric from user-visible requirements.
    Legacy mixed rubrics are not an acceptable fallback.
    """

    model_config = ConfigDict(extra="forbid", strict=True)
    case_id: Nonempty
    source_revision: Nonempty
    protocol_version: Nonempty
    response_rubric: Nonempty


class ResponseContext(BaseModel):
    """Final reply and caller-selected, user-visible scoring evidence only.

    Keys are turn:{i}:input or turn:{i}:answer[:{j}]. Each value is one verbatim
    user turn or one visible reply, not a joined transcript. Host snapshots,
    tool traces, and private Agent rules must not be selected. Selection cannot
    be inferred from a full scenario result.
    """

    model_config = ConfigDict(extra="forbid", strict=True)
    answer: str
    evidence: dict[Nonempty, str]


class ProfileEvidence(BaseModel):
    """One exact quote in one source; the source ID already locates the turn."""

    model_config = ConfigDict(extra="forbid", strict=True)
    source_id: Nonempty
    quote: Nonempty


class ProfileDimension(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    score: int = Field(strict=True, ge=0, le=2)
    reason: Nonempty
    evidence: list[ProfileEvidence] = Field(min_length=1)


class ProfileDecision(BaseModel):
    """One response-only judgment; no memory-capture or official benchmark score."""

    model_config = ConfigDict(extra="forbid", strict=True)
    personalized_response: ProfileDimension
    unsupported_inference: ProfileDimension
    helpfulness: ProfileDimension


def _response_sources(outputs: dict) -> dict[str, str]:
    context = ResponseContext.model_validate(outputs)
    if any(re.fullmatch(r"turn:[0-9]+:(?:input|answer(?::[0-9]+)?)", source) is None
           for source in context.evidence):
        raise ValueError("Evidence must name visible turns; run:answer is reserved")
    return {**context.evidence, "run:answer": context.answer}


def profile_prompt(case: dict, outputs: dict) -> str:
    """Accept only an explicit response rubric and selected visible evidence."""
    response_case = ResponseCase.model_validate(case)
    record = {**response_case.model_dump(), "sources": _response_sources(outputs)}
    return (
        f"Judge variant: {PROFILE_JUDGE_VARIANT}. This is a derived profile-memory protocol, "
        "NOT an official benchmark score. Judge the final answer only on three independent "
        "0/1/2 dimensions (higher is better). Original assistant replies in historical datasets "
        "were not replayed: these turn answers are Wandrun's natural replies, not official "
        "assistant text or evidence of what the user asserted. Do not assume a stored memory "
        "from a reply or a claimed tool action. If there is no user-grounded personal evidence, "
        "an appropriate abstention about personal details is better than a fabricated inference; "
        "the assistant can still offer useful general help. The response_rubric contains "
        "only answer requirements: do not infer obligations to expose another Agent's "
        "private work memory or judge host memory state. For EACH dimension give a "
        "specific reason and at least one exact short quote in evidence. Cite a source_id "
        "from sources (including run:answer); no additional turn index is needed. Cite "
        "user input rather than assistant reply to support claims about user preferences. "
        f"Rubrics: {json.dumps(_RUBRICS, ensure_ascii=False)}\n"
        f"Case: {json.dumps(record, ensure_ascii=False)}"
    )


def profile_feedback(case: dict, outputs: dict, decision: ProfileDecision,
                     model_name: str) -> dict:
    """Project three independently scored dimensions to LangSmith feedback."""
    response_case = ResponseCase.model_validate(case)
    sources = _response_sources(outputs)
    results = []
    for key, rubric in _RUBRICS.items():
        dimension = getattr(decision, key)
        for item in dimension.evidence:
            text = sources.get(item.source_id)
            if text is None or item.quote not in text:
                raise ValueError(f"Unverifiable evidence at {item.source_id!r}")
        comment = {
            "judge_variant": PROFILE_JUDGE_VARIANT, "judge_model": model_name,
            **response_case.model_dump(), "rubric": rubric,
            "reason": dimension.reason,
            "evidence": [item.model_dump() for item in dimension.evidence],
        }
        results.append({"key": key, "score": dimension.score / 2,
                        "comment": json.dumps(comment, ensure_ascii=False)})
    return {"results": results}


async def evaluate_profile(case: dict, outputs: dict, judge) -> dict:
    """Make exactly one structured judge request; reject malformed output/citations."""
    prompt = profile_prompt(case, outputs)
    decision = await _judge(judge, ProfileDecision, prompt)
    return profile_feedback(case, outputs, decision, judge.model_name)


def _complete_snapshot(snapshot: Mapping, label: str) -> tuple[str, dict[str, str], str]:
    """Require fetched active detail bodies, not merely index references or error placeholders."""
    if not isinstance(snapshot, Mapping) or not isinstance(snapshot.get("content"), str):
        raise ValueError(f"{label}: missing active index content")
    details = snapshot.get("details")
    if not isinstance(details, Mapping):
        raise ValueError(f"{label}: missing active details")
    bodies = {}
    references = set(re.findall(
        r"/\.wandrun/memory/(?:profile|work)/details/[A-Za-z0-9_-]+/[0-9a-f]{64}\.md",
        snapshot["content"],
    ))
    seen_paths = set()
    for slug, detail in details.items():
        if not isinstance(slug, str) or not isinstance(detail, Mapping):
            raise ValueError(f"{label}: invalid active detail")
        body, fingerprint, path = (detail.get(key) for key in ("content", "sha256", "path"))
        if not all(isinstance(value, str) for value in (body, fingerprint, path)):
            raise ValueError(f"{label}: incomplete active detail {slug!r}")
        if hashlib.sha256(body.encode("utf-8")).hexdigest() != fingerprint:
            raise ValueError(f"{label}: corrupt active detail {slug!r}")
        if not path.endswith(f"/details/{slug}/{fingerprint}.md") or path not in snapshot["content"]:
            raise ValueError(f"{label}: unreferenced active detail {slug!r}")
        seen_paths.add(path)
        bodies[slug] = body
    if references != seen_paths:
        raise ValueError(f"{label}: active index/details do not match")
    digest = hashlib.sha256(json.dumps({"content": snapshot["content"], "details": bodies},
                                       ensure_ascii=False, sort_keys=True,
                                       separators=(",", ":")).encode("utf-8")).hexdigest()
    return snapshot["content"], bodies, digest


def audit_memory(before: Mapping, after: Mapping, *,
                 required: Mapping[str, Sequence[str]] | Sequence[str | Sequence[str]] | None = None,
                 forbidden: Mapping[str, Sequence[str]] | Sequence[str | Sequence[str]] | None = None) -> dict:
    """Compare complete snapshots; report lexical regex evidence, never semantic truth.

    Groups are named alternatives or a list of patterns/groups (OR within a
    group, AND across groups). Patterns are caller-reviewed; a missing required
    match is inconclusive, while a forbidden match is a lexical alert, not a
    semantic finding. Errors propagate.
    """
    before_index, before_details, before_digest = _complete_snapshot(before, "before")
    after_index, after_details, after_digest = _complete_snapshot(after, "after")
    def scan(groups: Mapping[str, Sequence[str]] | Sequence[str | Sequence[str]] | None) -> dict:
        if groups is None:
            return {}
        if isinstance(groups, Mapping):
            entries = groups.items()
        elif isinstance(groups, (list, tuple)):
            entries = ((f"group:{i}", (group,) if isinstance(group, str) else group)
                       for i, group in enumerate(groups))
        else:
            raise ValueError("Regex groups must be a mapping or list")
        findings = {}
        for label, patterns in entries:
            if not isinstance(label, str) or not label or not isinstance(patterns, (list, tuple)) or not patterns:
                raise ValueError("Regex groups require a label and nonempty pattern alternatives")
            matches = []
            for pattern in patterns:
                if not isinstance(pattern, str):
                    raise ValueError("Regex patterns must be strings")
                compiled = re.compile(pattern, re.IGNORECASE)
                for source, text in [("index", after_index), *[(f"detail:{slug}", body)
                                                           for slug, body in after_details.items()]]:
                    matches.extend({"pattern": pattern, "source": source, "quote": match.group(),
                                    "span": list(match.span())} for match in compiled.finditer(text))
            findings[label] = {"matched": bool(matches), "matches": matches,
                               "assessment": "lexical_only" if matches else "inconclusive"}
        return findings
    return {
        "before_digest": before_digest, "after_digest": after_digest,
        "changed": before_digest != after_digest,
        "before": {"index": before_index, "details": before_details},
        "after": {"index": after_index, "details": after_details},
        "required": scan(required), "forbidden": scan(forbidden),
        "semantic_verdict": "not_assessed",
    }


def audit_profile_permissions(task_roots: Mapping[str, str],
                              authorized_profile_roots: Collection[str], *,
                              publications: Sequence[Mapping],
                              attempts: Sequence[Mapping]) -> dict:
    """Audit trusted task identity against published profile changes and denied attempts.

    task_roots and authorized_profile_roots must come from the host, not model text.
    Each publication has task_id and event_id; each attempt has task_id,
    event_id, outcome ('denied' or 'failed'). A root may publish only if it is
    itself a directly authorized profile root. Failed != denied; absence of
    attempts != enforced denial. Unknown tasks and malformed events raise.
    """
    if not isinstance(task_roots, Mapping) or not isinstance(authorized_profile_roots, Collection):
        raise ValueError("Trusted task/root mapping and authorized roots required")
    def classify(event: Mapping) -> dict:
        if not isinstance(event, Mapping) or not isinstance(event.get("event_id"), str):
            raise ValueError("Event requires an event_id")
        task_id = event.get("task_id")
        if task_id not in task_roots:
            raise ValueError(f"Unknown trusted task {task_id!r}")
        root_id = task_roots[task_id]
        if not isinstance(root_id, str) or root_id not in task_roots or task_roots[root_id] != root_id:
            raise ValueError(f"Invalid trusted root for task {task_id!r}")
        return {"event_id": event["event_id"], "task_id": task_id, "root_id": root_id,
                "authorized": task_id == root_id and root_id in authorized_profile_roots}
    published = [classify(event) for event in publications]
    denied = []
    failed = []
    for event in attempts:
        item = classify(event)
        outcome = event.get("outcome")
        if outcome == "denied":
            denied.append(item)
        elif outcome == "failed":
            failed.append(item)
        else:
            raise ValueError("Attempt outcome must be denied or failed; publications are separate")
    unauthorized = [item for item in published if not item["authorized"]]
    exercised_unauthorized = [item for item in (*denied, *failed, *unauthorized)
                              if not item["authorized"]]
    return {
        "unauthorized_publishers": unauthorized,
        "publications": published, "denied_attempts": denied, "failed_attempts": failed,
        "unauthorized_boundary": ("violated" if unauthorized else
                                  "denied_attempt_observed" if any(not item["authorized"] for item in denied) else
                                  "attempt_failed_not_denied" if exercised_unauthorized else
                                  "not_exercised"),
    }
