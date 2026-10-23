"""Validate persisted pairwise queue contents before exposing them for blind review.

No LangSmith client or network calls: the publisher supplies the fetched queue
entries and a trusted inventory read from the A/B experiments, not queue labels.
This detects a backend mispairing; it does not repair the remote queue.
"""

from collections.abc import Mapping, Sequence


def validate_pairwise_entries(
    entries: Sequence[Mapping], runs: Mapping[str, Mapping],
) -> dict[str, dict[str, str]]:
    """Require exactly one distinct A/B pair per example and full inventory coverage.

    runs maps run ID to {variant: 'A'|'B', example_id: str}. Entries are persisted
    queue rows with example_id and runs=[{id, reference_example_id}, ...]. Check
    the fetched rows AFTER creation, not merely the intended enqueue arguments.
    Invalid/missing/duplicated pairs raise ValueError; callers must not publish
    a review link on failure. Returns example -> {A: run_id, B: run_id}, with
    variants resolved from the trusted inventory, never from queue labels.
    """
    if not isinstance(runs, Mapping) or not runs:
        raise ValueError("nonempty trusted experiment inventory required")
    variants_by_example: dict[str, set[str]] = {}
    for run_id, run in runs.items():
        if (not isinstance(run_id, str) or not run_id.strip() or not isinstance(run, Mapping)
                or run.get("variant") not in ("A", "B")
                or not isinstance(run.get("example_id"), str) or not run["example_id"].strip()):
            raise ValueError("invalid trusted run identity")
        variants = variants_by_example.setdefault(run["example_id"], set())
        if run["variant"] in variants:
            raise ValueError(f"duplicate experiment variant for example {run['example_id']!r}")
        variants.add(run["variant"])
    if any(variants != {"A", "B"} for variants in variants_by_example.values()):
        raise ValueError("each example requires one A run and one B run")
    if not isinstance(entries, Sequence) or isinstance(entries, (str, bytes)):
        raise ValueError("persisted queue entries required")
    seen_runs: set[str] = set()
    seen_examples: set[str] = set()
    validated_pairs: dict[str, dict[str, str]] = {}
    for entry in entries:
        if not isinstance(entry, Mapping):
            raise ValueError("invalid queue entry")
        example_id, pair = entry.get("example_id"), entry.get("runs")
        if (not isinstance(example_id, str) or example_id not in variants_by_example
                or example_id in seen_examples):
            raise ValueError("unknown or repeated queue example")
        if not isinstance(pair, (list, tuple)) or len(pair) != 2:
            raise ValueError(f"example {example_id!r} requires exactly two runs")
        ids = []
        for run in pair:
            if not isinstance(run, Mapping) or not isinstance(run.get("id"), str):
                raise ValueError("invalid queued run identity")
            run_id = run["id"]
            if run_id not in runs or run_id in seen_runs or run_id in ids:
                raise ValueError("unknown, reused, or identical paired run")
            if (run.get("reference_example_id") != example_id
                    or runs[run_id]["example_id"] != example_id):
                raise ValueError("paired runs must reference the same trusted example")
            ids.append(run_id)
        if {runs[run_id]["variant"] for run_id in ids} != {"A", "B"}:
            raise ValueError("pair must contain one actual A run and one actual B run")
        seen_runs.update(ids)
        seen_examples.add(example_id)
        validated_pairs[example_id] = {runs[run_id]["variant"]: run_id for run_id in ids}
    if seen_runs != set(runs):
        raise ValueError("queue does not cover the full A/B experiment inventory")
    return validated_pairs
