import unittest

from wandrun.evaluation.pairwise import validate_pairwise_entries


def inventory():
    return {f"{example}-{variant}": {"example_id": example, "variant": variant}
            for example in ("C01", "C02") for variant in ("A", "B")}


def entries():
    return [{"example_id": example, "runs": [
        {"id": f"{example}-{variant}", "reference_example_id": example}
        for variant in order]}
        for example, order in (("C01", ("A", "B")), ("C02", ("B", "A")))]


class PairwiseTests(unittest.TestCase):
    def test_distinct_ab_runs_same_example_accepts_blind_order(self):
        self.assertEqual(validate_pairwise_entries(entries(), inventory()), {
            "C01": {"A": "C01-A", "B": "C01-B"},
            "C02": {"A": "C02-A", "B": "C02-B"},
        })

    def test_same_actual_run_twice_rejected_even_with_different_claimed_labels(self):
        queue = entries()
        queue[0]["runs"][1] = {**queue[0]["runs"][0], "variant": "B"}
        with self.assertRaisesRegex(ValueError, "identical"):
            validate_pairwise_entries(queue, inventory())

    def test_wrong_reference_and_cross_example_runs_rejected(self):
        for second in ({"id": "C01-B", "reference_example_id": "C02"},
                       {"id": "C02-B", "reference_example_id": "C01"}):
            with self.subTest(second=second):
                queue = entries()
                queue[0]["runs"][1] = second
                with self.assertRaisesRegex(ValueError, "same trusted example"):
                    validate_pairwise_entries(queue, inventory())

    def test_untrusted_run_duplicate_or_missing_examples_rejected(self):
        queues = [[], entries()[:1], [*entries(), entries()[0]]]
        unknown = entries()
        unknown[0]["runs"][1]["id"] = "unregistered-run"
        queues.append(unknown)
        for queue in queues:
            with self.subTest(queue=queue), self.assertRaises(ValueError):
                validate_pairwise_entries(queue, inventory())

    def test_two_distinct_a_runs_do_not_make_an_ab_pair(self):
        runs = inventory()
        runs["C01-A2"] = {"example_id": "C01", "variant": "A"}
        queue = entries()
        queue[0]["runs"][1]["id"] = "C01-A2"
        with self.assertRaises(ValueError):
            validate_pairwise_entries(queue, runs)

    def test_invalid_inventory_or_queue_is_not_reviewable(self):
        broken_inventories = [{}, {"run": {"example_id": "C01", "variant": "A"}},
                              {"run": {"example_id": "C01", "variant": "C"}}]
        for runs in broken_inventories:
            with self.subTest(runs=runs), self.assertRaises(ValueError):
                validate_pairwise_entries(entries(), runs)
        for broken in (None, {}, "rows", [None], [{"example_id": "C01", "runs": []}]):
            with self.subTest(queue=broken), self.assertRaises(ValueError):
                validate_pairwise_entries(broken, inventory())

