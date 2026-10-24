"""Inert failure/recovery contracts; no account, sudo, unit or namespace runs."""

import importlib.util
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("readiness", Path(__file__).with_name("qualify-hosted-native-linux.py"))
readiness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(readiness)


class HostedReadiness(unittest.TestCase):
    def setUp(self):
        self.group = SimpleNamespace(empty=Mock(return_value=True), last_observation="observed-unpopulated")
        self.supervisor = {
            "unit_properties": Mock(return_value={"generation": "old", "settled": False}),
            "inspect_unit_identity": Mock(),
            "systemctl": Mock(return_value=(1, b"ambiguous response")),
            "settled_unit": lambda value: value["settled"],
        }

    def test_wrong_generation_refuses_kill_even_when_held_cgroup_is_empty(self):
        self.supervisor["inspect_unit_identity"].side_effect = RuntimeError("generation changed")
        with self.assertRaisesRegex(RuntimeError, "generation changed"):
            readiness.settle_observed(self.supervisor, "owned.service", "old", self.group)
        self.supervisor["systemctl"].assert_not_called()

    def test_positive_original_cgroup_and_settled_unit_need_no_signal(self):
        self.supervisor["unit_properties"].return_value = {"settled": True}
        result = readiness.settle_observed(self.supervisor, "owned.service", "old", self.group)
        self.assertTrue(result["cgroup_empty"] and result["unit_settled"])
        self.supervisor["systemctl"].assert_not_called()

    def test_failed_kill_response_requires_actual_readback_to_resolve_effect(self):
        self.supervisor["unit_properties"].side_effect = [{"settled": False}, {"settled": True}]
        result = readiness.settle_observed(self.supervisor, "owned.service", "old", self.group)
        self.assertTrue(result["cgroup_empty"] and result["unit_settled"])
        self.supervisor["inspect_unit_identity"].assert_called_once()
        self.supervisor["systemctl"].assert_called_once_with("kill", "--signal=KILL", "--kill-whom=all", "owned.service")

    def test_deadline_never_turns_populated_cgroup_into_positive_settlement(self):
        self.group.empty.return_value = False
        with patch.object(readiness.time, "monotonic", side_effect=[10, 19, 19]), self.assertRaisesRegex(RuntimeError, "settlement remains unknown"):
            readiness.settle_observed(self.supervisor, "owned.service", "old", self.group)
        self.assertIsNone(self.supervisor["COMMAND_DEADLINE"])

    def test_late_positive_readback_refuses_and_restores_original_command_deadline(self):
        clock = [10]
        self.supervisor["COMMAND_DEADLINE"] = 17
        def read(_unit):
            self.assertEqual(self.supervisor["COMMAND_DEADLINE"], 17)
            clock[0] = 18
            return {"settled": True}
        self.supervisor["unit_properties"].side_effect = read
        with patch.object(readiness.time, "monotonic", side_effect=lambda: clock[0]), self.assertRaisesRegex(RuntimeError, "deadline expired"):
            readiness.settle_observed(self.supervisor, "owned.service", "old", self.group)
        self.assertEqual(self.supervisor["COMMAND_DEADLINE"], 17)
        self.supervisor["systemctl"].assert_not_called()

    def test_empty_cgroup_waits_for_later_unit_settlement_within_same_budget(self):
        self.supervisor["unit_properties"].side_effect = [{"settled": False}, {"settled": False}, {"settled": True}]
        with patch.object(readiness.time, "sleep"):
            result = readiness.settle_observed(self.supervisor, "owned.service", "old", self.group)
        self.assertTrue(result["cgroup_empty"] and result["unit_settled"])

    def test_owner_host_wrong_workflow_and_repeated_attempt_refuse_before_setup(self):
        environment = {
            "GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": "boburning/portcove",
            "RUNNER_ENVIRONMENT": "github-hosted", "GITHUB_EVENT_NAME": "workflow_dispatch",
            "GITHUB_RUN_ATTEMPT": "1", "GITHUB_RUN_ID": "12345", "GITHUB_SHA": "a" * 40,
            "GITHUB_WORKFLOW_REF": "boburning/portcove/.github/workflows/hosted-native-linux-readiness.yml@refs/heads/main",
        }
        with patch.object(readiness.platform, "system", return_value="Linux"), patch.object(readiness.platform, "machine", return_value="x86_64"):
            self.assertEqual(readiness.hosted_context(environment)["GITHUB_SHA"], "a" * 40)
            for change in ({"GITHUB_ACTIONS": "false"}, {"GITHUB_RUN_ATTEMPT": "2"},
                           {"GITHUB_EVENT_NAME": "pull_request"}, {"GITHUB_WORKFLOW_REF": "foreign/workflow"}):
                with self.subTest(change=change), self.assertRaises(RuntimeError):
                    readiness.hosted_context({**environment, **change})


if __name__ == "__main__":
    unittest.main()
