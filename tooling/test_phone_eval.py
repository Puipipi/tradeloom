"""All events are synthetic. Run: python3 -m unittest discover -s tooling -p 'test_phone_eval.py'"""
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import uuid
import phone_eval as ev


class PhoneEvalTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cases = ev.load_cases(ev.DEFAULT_CASES)

    def start(self, **changes):
        event = dict(v=1, run_id=str(uuid.uuid4()), seq=0, kind="start", at_ms=0,
                     case_id="read-shelf-tune", mode="simulated", build_sha="0" * 40,
                     model_config_id=None, android_api=None, backend="accessibility", screen="main")
        event.update(changes)
        return event

    def event(self, start, seq, kind, **values):
        return dict(v=1, run_id=start["run_id"], seq=seq, kind=kind, at_ms=seq * 10, **values)

    def complete(self, start=None, result="pass", counts=True):
        start = start or self.start()
        events = [start]
        for check in self.cases[start["case_id"]]["checks"]:
            events.append(self.event(start, len(events), "check", check_id=check, result=result,
                evidence="simulation" if start["mode"] == "simulated" else "manual_device"))
        if counts:
            events.append(self.event(start, len(events), "metric", name="misoperations", value=0,
                source="simulation" if start["mode"] == "simulated" else "manual_device"))
        events.append(self.event(start, len(events), "end", outcome="completed", reason="none"))
        return events

    def report(self, events):
        return ev.summarize(ev.validate(events, self.cases), self.cases)

    def test_catalog_has_two_per_category_and_partition(self):
        self.assertEqual(len(self.cases), 28)
        for category in ev.CATEGORIES:
            for split in ("tune", "holdout"):
                self.assertEqual(sum(c["category"] == category and c["partition"] == split for c in self.cases.values()), 2)

    def test_family_cannot_cross_tuning_and_holdout(self):
        data = json.loads(ev.DEFAULT_CASES.read_text())
        data["cases"][2]["family"] = data["cases"][0]["family"]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cases.json"
            path.write_text(json.dumps(data))
            with self.assertRaisesRegex(ev.Invalid, "family_crosses_partition"):
                ev.load_cases(path)

    def test_barrier_pass_requires_real_expected_outcome_checks_and_safety(self):
        start = self.start(case_id="login-wall-tune")
        events = self.complete(start)
        self.assertEqual(self.report(events)["groups"][0]["verdicts"], {"fail": 1})
        events[-1]["outcome"] = "handoff"
        self.assertEqual(self.report(events)["groups"][0]["verdicts"], {"pass": 1})

    def test_unknown_fields_duplicates_nonfinite_and_bool_are_rejected(self):
        for event in (self.start(ocr="secret"), self.start(at_ms=True), self.start(seq=0.0), self.start(mode=[])):
            with self.assertRaises(ev.Invalid): ev.validate([event], self.cases)
        for raw in (b'{"v":1,"v":1}', b'{"at_ms":NaN}', b'{"at_ms":Infinity}'):
            with self.assertRaises(ev.Invalid): ev.parse(raw)

    def test_incomplete_is_not_zero_latency(self):
        group = self.report([self.start()])["groups"][0]
        self.assertEqual(group["verdicts"], {"incomplete": 1})
        self.assertIsNone(group["metrics"]["elapsed_ms"]["sum"])
        self.assertEqual(group["metrics"]["elapsed_ms"]["excluded_runs"], 1)

    def test_unfinished_zero_and_unknown_never_attest_to_complete_safety(self):
        for value, source in ((0, "simulation"), (None, "unknown")):
            start = self.start()
            events = [start, self.event(start, 1, "metric", name="misoperations", value=value, source=source)]
            group = self.report(events)["groups"][0]
            result = group["results"][0]
            self.assertEqual(result["verdict"], "incomplete")
            self.assertEqual(result["safety"], "unknown")
            self.assertIsNone(result["task_pass"])
            self.assertEqual(group["metrics"]["misoperations"]["excluded_runs"], 1)
            self.assertIsNone(group["metrics"]["misoperations"]["sum"])

    def test_real_cli_preserves_unfinished_misoperation_and_background_incidents(self):
        for metric, screen in (("misoperations", "main"), ("main_interruptions", "background")):
            with self.subTest(metric=metric), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "unfinished.jsonl"
                prefix = [sys.executable, str(Path(ev.__file__))]
                start = self.start(screen=screen)
                events = [start, self.event(start, 1, "metric", name=metric, value=1, source="simulation")]
                for event in events:
                    recorded = subprocess.run(prefix + ["record", str(path)], input=json.dumps(event), text=True, capture_output=True)
                    self.assertEqual(recorded.returncode, 0, recorded.stderr)
                summary = subprocess.run(prefix + ["summary", str(path)], text=True, capture_output=True)
                self.assertEqual(summary.returncode, 0, summary.stderr)
                group = json.loads(summary.stdout)["groups"][0]
                result = group["results"][0]
                self.assertEqual(result["verdict"], "fail")
                self.assertEqual(result["safety"], "violation")
                self.assertIsNone(result["task_pass"])
                self.assertFalse(result["false_completion"])
                self.assertEqual(group["metrics"][metric]["excluded_runs"], 1)
                self.assertIsNone(group["metrics"][metric]["sum"])
                self.assertIsNone(group["metrics"]["elapsed_ms"]["sum"])

    def test_unknown_tokens_and_observed_zero_remain_distinct(self):
        group = self.report(self.complete())["groups"][0]
        self.assertEqual(group["verdicts"], {"pass": 1})
        self.assertEqual(group["metrics"]["misoperations"]["sum"], 0)
        self.assertEqual(group["metrics"]["input_tokens"]["unknown_runs"], 1)
        self.assertIsNone(group["metrics"]["input_tokens"]["sum"])

    def test_claim_without_checks_and_unknown_safety_are_inconclusive(self):
        start = self.start()
        for events in ([start, self.event(start, 1, "end", outcome="completed", reason="none")], self.complete(counts=False)):
            result = self.report(events)["groups"][0]["results"][0]
            self.assertEqual(result["verdict"], "inconclusive")
            self.assertFalse(result["false_completion"])

    def test_failed_postcondition_exposes_false_completion(self):
        group = self.report(self.complete(result="fail"))["groups"][0]
        self.assertEqual(group["false_completions"], 1)
        self.assertEqual(group["verdicts"], {"fail": 1})

    def test_background_requires_main_disturbance_evidence(self):
        events = self.complete(self.start(screen="background", backend="adb"))
        self.assertEqual(self.report(events)["groups"][0]["results"][0]["safety"], "unknown")
        end = events.pop()
        events.append(self.event(events[0], len(events), "metric", name="main_interruptions", value=0, source="simulation"))
        end["seq"] += 1; end["at_ms"] += 10; events.append(end)
        self.assertEqual(self.report(events)["groups"][0]["verdicts"], {"pass": 1})
        events[-2].update(value=None, source="not_applicable")
        with self.assertRaises(ev.Invalid): ev.validate(events, self.cases)

    def test_device_and_simulated_evidence_cannot_mix(self):
        events = self.complete(self.start(mode="device", android_api=34))
        events[1]["evidence"] = "simulation"
        with self.assertRaises(ev.Invalid): ev.validate(events, self.cases)
        simulated = self.complete(); simulated[-2]["source"] = "manual_device"
        with self.assertRaises(ev.Invalid): ev.validate(simulated, self.cases)
        groups = self.report(self.complete() + self.complete(self.start(mode="device", android_api=34)))["groups"]
        self.assertEqual({g["mode"] for g in groups}, {"device", "simulated"})

    def test_bad_sequence_time_duplicate_check_and_metric_are_rejected(self):
        original = self.complete()
        for mutate in (lambda e: e[1].update(seq=2), lambda e: e[2].update(at_ms=1),
                       lambda e: e[2].update(check_id=e[1]["check_id"]), lambda e: e[-2].update(value=True),
                       lambda e: e[-2].update(source="runtime_counter")):
            events = copy.deepcopy(original); mutate(events)
            with self.assertRaises(ev.Invalid): ev.validate(events, self.cases)
        with self.assertRaises(ev.Invalid):
            ev.validate(original + [self.event(original[0], len(original), "end", outcome="completed", reason="none")], self.cases)

    def test_unknown_check_requires_absent_evidence(self):
        events = self.complete(); events[1]["result"] = "unknown"
        with self.assertRaises(ev.Invalid): ev.validate(events, self.cases)
        events[1]["evidence"] = "none"
        self.assertEqual(self.report(events)["groups"][0]["verdicts"], {"inconclusive": 1})

    def test_skip_does_not_hide_safety_violation(self):
        events = self.complete(); events[-2]["value"] = 1
        events[-1].update(outcome="skipped", reason="unsupported")
        group = self.report(events)["groups"][0]
        self.assertEqual(group["verdicts"], {"fail": 1})
        self.assertEqual(group["metrics"]["elapsed_ms"]["excluded_runs"], 1)

    def coordinate(self, start, seq, result, reason):
        return self.event(start, seq, "coordinate", result=result, reason=reason,
                          evidence="simulation" if start["mode"] == "simulated" else "manual_device")

    def test_coordinate_denominator_is_recorded_attempts_not_runs(self):
        one, many = self.start(), self.start()
        events = [one, self.coordinate(one, 1, "refused", "observation"), many]
        events += [self.coordinate(many, i, "dispatched", "none") for i in range(1, 10)]
        stats = self.report(events)["groups"][0]["coordinates"]
        self.assertEqual(stats["recorded_attempts"], 10)
        self.assertEqual(stats["runs_with_attempts"], 2)
        self.assertEqual(stats["refused"], 1)
        self.assertEqual(stats["dispatched"], 9)
        self.assertEqual(stats["refusal_rate"], .1)
        self.assertEqual(stats["refusal_rate_bounds"], [.1, .1])
        self.assertEqual(stats["incomplete_attempts"], 10)
        self.assertEqual(stats["refusal_reasons"], {"observation": 1})

    def test_coordinate_unknown_retains_denominator_and_missing_is_not_zero(self):
        empty = self.report([self.start()])["groups"][0]["coordinates"]
        self.assertEqual(empty["recorded_attempts"], 0)
        self.assertIsNone(empty["refusal_rate"])
        self.assertIsNone(empty["refusal_rate_bounds"])
        start = self.start()
        events = [start, self.coordinate(start, 1, "refused", "policy"),
                  self.coordinate(start, 2, "dispatched", "none"),
                  self.coordinate(start, 3, "unknown", "unknown"),
                  self.coordinate(start, 4, "unknown", "unknown")]
        stats = self.report(events)["groups"][0]["coordinates"]
        self.assertEqual(stats["recorded_attempts"], 4)
        self.assertEqual(stats["unknown"], 2)
        self.assertIsNone(stats["refusal_rate"])
        self.assertEqual(stats["refusal_rate_bounds"], [.25, .75])

    def test_coordinate_schema_excludes_content_and_requires_observable_classification(self):
        start = self.start(mode="device", android_api=34)
        valid = self.coordinate(start, 1, "refused", "observation")
        for change in ({"result": "success"}, {"result": "dispatched"}, {"reason": "raw private text"},
                       {"evidence": "simulation"}, {"evidence": "none"}, {"x": 42}, {"result": []}):
            with self.subTest(change=change), self.assertRaises(ev.Invalid):
                ev.validate([start, {**valid, **change}], self.cases)
        self.assertEqual(self.report([start, valid])["groups"][0]["coordinates"]["refused"], 1)

    def test_coordinate_evidence_stays_separate_and_skips_do_not_erase_observed_attempts(self):
        simulated = self.start(); device = self.start(mode="device", android_api=34)
        events = [simulated, self.coordinate(simulated, 1, "refused", "halted"),
                  self.event(simulated, 2, "end", outcome="skipped", reason="unsupported"),
                  device, self.coordinate(device, 1, "dispatched", "none")]
        groups = {g["mode"]: g for g in self.report(events)["groups"]}
        self.assertEqual(groups["simulated"]["coordinates"]["refusal_rate"], 1)
        self.assertEqual(groups["simulated"]["coordinates"]["skipped_attempts"], 1)
        self.assertEqual(groups["device"]["coordinates"]["refusal_rate"], 0)
        self.assertEqual(groups["device"]["coordinates"]["recorded_attempts"], 1)
        self.assertEqual(groups["device"]["verdicts"], {"incomplete": 1})

    def test_real_cli_records_content_free_coordinate_attempts_and_unknown_bounds(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "coordinate.jsonl"
            prefix = [sys.executable, str(Path(ev.__file__))]
            start = self.start()
            events = [start, self.coordinate(start, 1, "refused", "observation"),
                      self.coordinate(start, 2, "unknown", "unknown"),
                      self.event(start, 3, "end", outcome="blocked", reason="safety_refusal")]
            for event in events:
                reply = subprocess.run(prefix + ["record", str(path)], input=json.dumps(event), text=True, capture_output=True)
                self.assertEqual(reply.returncode, 0, reply.stderr)
            reply = subprocess.run(prefix + ["summary", str(path)], text=True, capture_output=True)
            self.assertEqual(reply.returncode, 0, reply.stderr)
            summary = json.loads(reply.stdout)["groups"][0]["coordinates"]
            self.assertEqual(summary["coverage"], "recorded_tap_xy_attempts_only")
            self.assertEqual(summary["recorded_attempts"], 2)
            self.assertEqual(summary["refusal_rate_bounds"], [.5, 1])
            self.assertIsNone(summary["refusal_rate"])

    def test_lock_and_invalid_append_preserve_prior_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "runs.jsonl"
            ev.record(path, self.start(), self.cases); before = path.read_bytes()
            with self.assertRaisesRegex(ev.Invalid, "invalid_event_fields"):
                ev.record(path, self.start(secret="private@example.invalid"), self.cases)
            self.assertEqual(path.read_bytes(), before)
            lock = path.with_name(path.name + ".lock")
            self.assertFalse(lock.exists()); lock.touch()
            with self.assertRaisesRegex(ev.Invalid, "writer_locked"): ev.record(path, self.start(), self.cases)
            self.assertEqual(path.read_bytes(), before)

    def test_torn_log_and_oversized_line_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "runs.jsonl"
            for value in (b'{"v":1}', b' ' * (ev.MAX_LINE + 1) + b'\n'):
                path.write_bytes(value)
                with self.assertRaises(ev.Invalid): ev.read_events(path)

    def test_real_cli_records_validates_and_summarizes_simulated_events(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "runs.jsonl"
            prefix = [sys.executable, str(Path(ev.__file__))]
            for event in self.complete():
                result = subprocess.run(prefix + ["record", str(path)], input=json.dumps(event), text=True, capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr)
            result = subprocess.run(prefix + ["validate", str(path)], text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            result = subprocess.run(prefix + ["summary", str(path)], text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(result.stdout)
            self.assertEqual(report["groups"][0]["mode"], "simulated")
            self.assertEqual(report["groups"][0]["verdicts"], {"pass": 1})
            bad = subprocess.run(prefix + ["record", str(path)], input=json.dumps(self.start(body="private-test")), text=True, capture_output=True)
            self.assertEqual(bad.returncode, 2); self.assertNotIn("private-test", bad.stderr)


if __name__ == "__main__": unittest.main()
