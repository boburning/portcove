"""Run existing unittest suites with human stderr and bounded inner-case JSON.

This is test reporting, not a native qualification runner. Keep the suite's
failure outcome even when report generation fails.
"""

import hashlib
import importlib.util
import json
from pathlib import Path
import platform
import sys
import time
import traceback
import unittest


MAX_RECORDS = 2048
MAX_REPORT_BYTES = 2 * 1024 * 1024
MODULE = "_portcove_contract"


def bounded(value):
    return str(value).encode("utf-8")[:4096].decode("utf-8", errors="ignore")


def identity(test):
    value = test.id()
    return value.removeprefix(MODULE + ".")


class CaseResults(unittest.TextTestResult):
    def __init__(self, *args):
        super().__init__(*args)
        self.records = []
        self.active = None
        self.reporting_error = None

    def append(self, record):
        if any(item is record for item in self.records):
            return
        if len(self.records) >= MAX_RECORDS:
            self.reporting_error = "Python case report exceeds record limit"
            # Method records and original failures outrank successful subtests.
            # If all slots already describe failures, keep the earlier failures.
            candidates = [index for index, item in enumerate(self.records)
                          if item["kind"] == "subtest" and item["status"] == "passed"]
            failed = record["status"] in ("failed", "error", "unexpected-success") or any(
                item["status"] in ("failed", "error", "unexpected-success")
                for item in record["additional_outcomes"]
            )
            if failed and not candidates:
                candidates = [index for index, item in enumerate(self.records)
                              if item["status"] == "passed" and not item["additional_outcomes"]]
            if not candidates or (record["kind"] != "test" and not failed):
                return
            self.records.pop(candidates[0])
        self.records.append(record)

    def startTest(self, test):
        super().startTest(test)
        self.active = {
            "id": identity(test), "kind": "test", "status": "passed",
            "reason": None, "additional_outcomes": [], "duration_ms": None,
            "started": time.perf_counter(),
        }
        # Reserve the parent before subtests, so overflow retains its first failure.
        self.append(self.active)

    def stopTest(self, test):
        record = self.active
        self.active = None
        record["duration_ms"] = (time.perf_counter() - record.pop("started")) * 1000
        super().stopTest(test)

    def outcome(self, test, status, reason):
        if self.active is not None:
            if self.active["reason"] is None:
                self.active.update(status=status, reason=bounded(reason))
            else:
                if len(self.active["additional_outcomes"]) >= 16:
                    self.reporting_error = "Python case exceeds outcome limit"
                    return
                self.active["additional_outcomes"].append({"status": status, "reason": bounded(reason)})
            self.append(self.active)
        else:
            # setUpClass/setUpModule failures and skips have no startTest event.
            self.append({"id": identity(test), "kind": "fixture", "status": status,
                         "reason": bounded(reason), "additional_outcomes": [], "duration_ms": None})

    def addFailure(self, test, err):
        super().addFailure(test, err)
        self.outcome(test, "failed", "".join(traceback.format_exception_only(*err[:2])))

    def addError(self, test, err):
        super().addError(test, err)
        self.outcome(test, "error", "".join(traceback.format_exception_only(*err[:2])))

    def addSkip(self, test, reason):
        super().addSkip(test, reason)
        if hasattr(test, "test_case"):
            self.append({"id": identity(test), "kind": "subtest", "status": "skipped",
                         "reason": bounded(reason), "additional_outcomes": [], "duration_ms": None})
        else:
            self.outcome(test, "skipped", reason)

    def addExpectedFailure(self, test, err):
        super().addExpectedFailure(test, err)
        self.outcome(test, "expected-failure", "".join(traceback.format_exception_only(*err[:2])))

    def addUnexpectedSuccess(self, test):
        super().addUnexpectedSuccess(test)
        self.outcome(test, "unexpected-success", "expected failure passed")

    def addSubTest(self, test, subtest, err):
        super().addSubTest(test, subtest, err)
        reason = None if err is None else bounded("".join(traceback.format_exception_only(*err[:2])))
        status = "passed" if err is None else ("failed" if issubclass(err[0], test.failureException) else "error")
        # unittest exposes no subtest-start callback. Do not invent a duration.
        self.append({"id": identity(subtest), "kind": "subtest", "status": status,
                     "reason": reason, "additional_outcomes": [], "duration_ms": None})
        if err is not None:
            self.outcome(test, status, reason)


def test_ids(suite):
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            yield from test_ids(item)
        else:
            yield identity(item)


def main():
    if len(sys.argv) != 2:
        raise RuntimeError("usage: python-test-results.py <unittest suite.py>")
    filename = Path(sys.argv[1]).resolve(strict=True)
    before = filename.read_bytes()
    reporter_before = Path(__file__).read_bytes()
    spec = importlib.util.spec_from_file_location(MODULE, filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[MODULE] = module
    spec.loader.exec_module(module)
    suite = unittest.defaultTestLoader.loadTestsFromModule(module)
    selected = list(test_ids(suite))
    if not selected or len(selected) > MAX_RECORDS or len(set(selected)) != len(selected):
        raise RuntimeError("Python selected inventory must be nonempty, unique and bounded")
    started = time.perf_counter()
    result = unittest.TextTestRunner(stream=sys.stderr, verbosity=2, resultclass=CaseResults).run(suite)
    status = 0 if result.wasSuccessful() else 1
    try:
        if filename.read_bytes() != before:
            raise RuntimeError("Python suite changed during execution")
        if Path(__file__).read_bytes() != reporter_before:
            raise RuntimeError("Python reporter changed during execution")
        report = {
            "format_version": 1, "runner": "python-unittest", "platform": sys.platform,
            "python": platform.python_version(), "source": str(filename),
            "source_sha256": hashlib.sha256(before).hexdigest(),
            "reporter_sha256": hashlib.sha256(reporter_before).hexdigest(),
            "selected": selected, "tests_run": result.testsRun, "suite_exit_status": status,
            "exit_status": status or (1 if result.reporting_error else 0),
            "incomplete_reason": result.reporting_error,
            "duration_ms": (time.perf_counter() - started) * 1000, "cases": result.records,
        }
        encoded = json.dumps(report, ensure_ascii=True, allow_nan=False)
        if len(encoded.encode("utf-8")) > MAX_REPORT_BYTES:
            raise RuntimeError("Python case report exceeds byte limit")
        print(encoded, flush=True)
    except Exception:
        traceback.print_exc(file=sys.stderr)
        return status or 1
    return status or (1 if result.reporting_error else 0)


if __name__ == "__main__":
    sys.exit(main())
