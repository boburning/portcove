"""Controlled-clock fixtures. No GitHub, hosted runner, or real Codex model."""

import argparse
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import pr_wake as wake
from pr_wake_codex import Daemon

HEAD = "a" * 40
OTHER_HEAD = "b" * 40
OWNERS = ("00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002")


class FakeDaemon(Daemon):
    def __init__(self):
        self.queues = {}
        self.turns = {}
        self.enqueues = []
        self.outages = False
        self.resume_works = True
        self.status = "inProgress"

    def __enter__(self):
        if self.outages:
            raise ConnectionError("daemon stopped")
        return self

    def __exit__(self, *_):
        pass

    def queued(self, owner, message):
        return ["queue-id"] if self.queues.get(owner) == message else []

    def pickup(self, owner, message):
        return self.turns.get((owner, message))

    def turn_status(self, owner, turn_id):
        assert turn_id in self.turns.values()
        return self.status

    def thread(self, owner):
        return {"id": owner, "status": {"type": "notLoaded"}}

    def call(self, method, **params):
        owner = params["threadId"]
        if method == "thread/resume":
            self.start_turn(owner)
        elif method == "thread/queue/delete":
            self.queues.pop(owner, None)
        else:
            raise AssertionError(method)

    def enqueue(self, args, **_):
        assert args[:3] == ["codex", "queue", "--thread"]
        assert args[4:6] == ["--resume", "--message"]
        owner, message = args[3], args[6]
        assert owner not in self.queues
        self.queues[owner] = message
        self.enqueues.append((owner, message))
        if self.resume_works:
            self.start_turn(owner)

    def start_turn(self, owner):
        message = self.queues.pop(owner)
        self.turns[owner, message] = f"turn-{len(self.turns) + 1}"


class WatchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name)
        self.daemon = FakeDaemon()
        self.addCleanup(patch.stopall)
        patch.object(wake, "Daemon", return_value=self.daemon).start()
        patch("pr_wake_codex.subprocess.run", self.daemon.enqueue).start()
        self.now = 1_000_000
        self.heads = {1: HEAD, 2: HEAD}
        self.conditions = {1: "pending", 2: "pending"}
        self.closed = set()
        self.samples = []
        self.add_watch(1, OWNERS[0])

    def add_watch(self, pr, owner):
        with wake.store(self.state) as db:
            wake.save(
                db,
                {
                    "id": str(pr),
                    "repo": wake.REPO,
                    "worktree": "/portcove",
                    "pr": pr,
                    "head": HEAD,
                    "owner": owner,
                    "run": 123,
                    "attempt": 1,
                    "deadline": self.now + 3600,
                    "status": "watching",
                    "seen": [],
                    "pending": None,
                    "pending_key": None,
                    "invalidated": False,
                    "delivered": None,
                    "accepted": None,
                },
            )
        wake.accept(self.state, pr, lambda _: None)

    def read_pull(self, pr):
        return {"state": "closed" if pr in self.closed else "open", "head": {"sha": self.heads[pr]}}

    def read_sample(self, row):
        pr = row["pr"]
        self.samples.append(pr)
        condition = self.conditions[pr]
        if condition == "pending" and self.now >= row["deadline"]:
            condition = "deadline"
        return {
            "operation": "pr-delivery.watch",
            "status": "succeeded" if condition == "green" else "planned",
            "evidence": {
                "watch_condition": condition,
                "contexts": [],
                "pull_request": pr,
                "head": HEAD,
                "run": 123,
                "attempt": 1,
                "workflow": {
                    "head_sha": HEAD,
                    "run_attempt": 2 if condition == "superseded" else 1,
                    "created_at": "2026-11-18T23:00:00Z",
                },
            },
        }

    def tick(self, pr=1, feedback=()):
        return wake.step(
            self.state,
            pr,
            lambda: self.now,
            lambda row, now: wake.observe(row, now, self.read_pull, self.read_sample, lambda *_: list(feedback)),
            read_pull=self.read_pull,
        )

    def events(self):
        with wake.store(self.state) as db:
            return [dict(r) for r in db.execute("SELECT * FROM events ORDER BY rowid")]

    def row(self, pr=1):
        with wake.store(self.state) as db:
            return wake.load(db, pr)

    def test_event_stream_attach_reconnect_and_suite_completion_are_read_hints(self):
        line = b"Changes made before this point are not reported; read the current state now."
        self.assertTrue(wake.event_hint(line, False))
        self.assertTrue(wake.event_hint(line, False))
        self.assertFalse(wake.event_hint(b"Event stream closed, reconnecting.", False))
        self.assertFalse(wake.event_hint(b": heartbeat", True))
        event = b'{"type":"com.github.pull_request.check_suite.status.changed.v1","data":{"conclusion":"success"}}'
        self.assertTrue(wake.event_hint(event, True))
        self.tick()
        self.assertEqual(self.samples, [1])
        self.assertEqual(self.events(), [])

    def test_thirty_minutes_pending_then_one_wake_despite_duplicates(self):
        for _ in range(10):
            self.tick()
            self.now += 180
        self.assertEqual(self.events(), [])
        self.assertEqual(self.daemon.turns, {})
        self.assertIsNone(self.row().get("job_started_at"))
        self.assertEqual(self.row()["queued_at"], "2026-11-18T23:00:00Z")
        self.conditions[1] = "green"
        for _ in range(4):
            self.tick()
        self.assertEqual(len(self.daemon.enqueues), 1)
        self.assertEqual(len(self.events()), 1)
        self.assertEqual(self.events()[0]["turn"], "turn-1")
        with patch.dict(os.environ, {"CODEX_THREAD_ID": OWNERS[0]}):
            args = argparse.Namespace(action="claim", event=self.events()[0]["id"])
            wake.event_command(self.state, args)
            with self.assertRaisesRegex(RuntimeError, "already claimed"):
                wake.event_command(self.state, args)
        self.closed.add(1)
        self.tick()
        self.assertIsNone(self.row())

    def test_outage_after_enqueue_restart_and_two_separate_owners(self):
        self.add_watch(2, OWNERS[1])
        self.conditions = {1: "checks-failed", 2: "green"}
        self.daemon.resume_works = False
        self.tick()
        self.assertEqual(len(self.events()), 1)
        self.assertIsNone(self.events()[0]["turn"])
        self.daemon.outages = True
        with self.assertRaises(ConnectionError):
            self.tick()
        with self.assertRaises(ConnectionError):
            self.tick(2)
        self.daemon.outages = False
        self.daemon.resume_works = True
        # Each tick reopens the durable store and has no in-memory dispatch state.
        for pr in (2, 1, 2, 1):
            self.tick(pr)
        self.assertEqual([owner for owner, _ in self.daemon.enqueues], list(OWNERS))
        self.assertEqual({e["turn"] for e in self.events()}, {"turn-1", "turn-2"})
        self.assertIn("PR #1", self.daemon.enqueues[0][1])
        self.assertIn("PR #2", self.daemon.enqueues[1][1])

    def test_previously_queued_green_cannot_qualify_superseded_head(self):
        self.conditions[1] = "green"
        self.daemon.resume_works = False
        self.tick()
        self.heads[1] = OTHER_HEAD
        self.daemon.resume_works = True
        self.tick()
        self.assertEqual(self.daemon.turns, {})
        self.assertEqual(len(self.samples), 1)
        self.tick()
        self.tick()
        messages = [message for _, message in self.daemon.turns]
        self.assertEqual(len(messages), 1)
        self.assertIn("reviewed head or workflow attempt changed", messages[0])

    def test_attempt_drift_and_missing_check_deadline(self):
        self.add_watch(2, OWNERS[1])
        self.conditions[1] = "superseded"
        self.tick()
        self.now = self.row(2)["deadline"] - 1
        self.tick(2)
        self.assertEqual(len(self.events()), 1)
        self.now += 1
        self.tick(2)
        self.tick(2)
        self.tick(2)
        messages = [e["message"] for e in self.events()]
        self.assertIn("/attempts/2", messages[0])
        self.assertIn("original deadline expired", messages[1])
        self.assertEqual(len(messages), 2)

    def test_pause_cancel_and_review(self):
        feedback = (("review/1", wake.pr_url(1) + "#pullrequestreview-1"),)
        self.daemon.resume_works = False
        self.tick(feedback=feedback)
        self.assertIn(OWNERS[0], self.daemon.queues)
        wake.control(self.state, argparse.Namespace(action="pause", pr=1))
        self.tick(feedback=feedback)
        self.assertNotIn(OWNERS[0], self.daemon.queues)
        wake.control(self.state, argparse.Namespace(action="resume", pr=1))
        self.daemon.resume_works = True
        self.tick(feedback=feedback)
        self.tick(feedback=feedback)
        self.tick(feedback=feedback)
        self.assertEqual(len(self.daemon.turns), 1)
        self.assertEqual(len(self.events()), 1)
        wake.control(self.state, argparse.Namespace(action="cancel", pr=1))
        self.tick()
        self.assertIsNone(self.row())

    def test_resume_does_not_restore_a_disappeared_review(self):
        feedback = (("review/1", wake.pr_url(1) + "#pullrequestreview-1"),)
        self.daemon.resume_works = False
        self.tick(feedback=feedback)
        wake.control(self.state, argparse.Namespace(action="pause", pr=1))
        self.tick(feedback=feedback)
        wake.control(self.state, argparse.Namespace(action="resume", pr=1))
        self.daemon.resume_works = True
        self.tick()
        self.tick()
        self.assertEqual(len(self.daemon.enqueues), 1)
        self.assertEqual(self.daemon.turns, {})
        self.assertIsNone(self.row()["pending"])

    def test_paused_watch_is_cleaned_up_on_close(self):
        wake.control(self.state, argparse.Namespace(action="pause", pr=1))
        self.closed.add(1)
        self.tick()
        self.assertIsNone(self.row())
        self.assertEqual(self.daemon.turns, {})

    def test_interrupted_turn_recovers_unclaimed_action(self):
        self.conditions[1] = "green"
        self.tick()
        self.daemon.status = "interrupted"
        self.tick()
        self.assertEqual(self.events()[0]["prior_turn"], "turn-1")
        self.daemon.status = "inProgress"
        self.tick()
        self.tick()
        self.assertEqual(len(self.events()), 1)
        self.assertEqual(self.events()[0]["turn"], "turn-2")
        with patch.dict(os.environ, {"CODEX_THREAD_ID": OWNERS[0]}):
            wake.event_command(self.state, argparse.Namespace(action="claim", event=self.events()[0]["id"]))
        self.daemon.status = "completed"
        self.tick()
        self.assertEqual(len(self.daemon.turns), 2)
        self.assertIsNone(self.row()["pending"])

    def test_same_owner_can_rebind_during_claimed_repair_turn(self):
        self.conditions[1] = "checks-failed"
        self.tick()
        self.tick()
        prior_event = self.events()[0]["id"]
        with patch.dict(os.environ, {"CODEX_THREAD_ID": OWNERS[0]}):
            wake.event_command(self.state, argparse.Namespace(action="claim", event=prior_event))
        replacement = {
            **self.row(),
            "id": "new-binding",
            "head": OTHER_HEAD,
            "attempt": 2,
            "pending": None,
            "pending_key": None,
            "accepted": None,
        }
        wake.register_watch(self.state, replacement)
        self.assertEqual(self.row()["status"], "replacing")
        wake.control(self.state, argparse.Namespace(action="pause", pr=1))
        self.tick()
        self.assertIsNone(self.row()["accepted"])
        self.tick()  # A hint can wake the old worker before the replacement's acceptance.
        self.assertEqual(len(self.events()), 1)
        wake.accept(self.state, 1, lambda _: None)
        self.assertEqual(self.row()["head"], OTHER_HEAD)
        self.assertIsNotNone(self.row()["accepted"])
        self.assertEqual(self.row()["status"], "paused")
        self.assertEqual(self.events()[0]["turn"], "turn-1")
        self.assertEqual(len(self.daemon.turns), 1)

    def test_interrupted_after_claim_retries_only_after_turn_stops(self):
        self.conditions[1] = "green"
        self.tick()
        self.tick()
        with patch.dict(os.environ, {"CODEX_THREAD_ID": OWNERS[0]}):
            wake.event_command(self.state, argparse.Namespace(action="claim", event=self.events()[0]["id"]))
        self.tick()
        self.assertEqual(len(self.daemon.turns), 1)
        self.daemon.status = "interrupted"
        self.tick()
        self.assertEqual(self.events()[0]["claimed"], 0)
        self.daemon.status = "inProgress"
        self.tick()
        self.tick()
        self.assertEqual(self.events()[0]["turn"], "turn-2")
        self.assertEqual(len(self.events()), 1)

    def test_pause_removes_queued_copy_while_github_is_unavailable(self):
        self.conditions[1] = "green"
        self.daemon.resume_works = False
        self.tick()
        wake.control(self.state, argparse.Namespace(action="pause", pr=1))
        with self.assertRaises(ConnectionError):
            wake.step(self.state, 1, read_pull=lambda _: self.unreachable())
        self.assertEqual(self.daemon.queues, {})

    @staticmethod
    def unreachable():
        raise ConnectionError("GitHub unavailable")

    def test_close_cleans_pending_enqueue_after_outage(self):
        self.conditions[1] = "green"
        self.daemon.resume_works = False
        self.tick()
        self.daemon.outages = True
        self.closed.add(1)
        with self.assertRaises(ConnectionError):
            self.tick()
        self.assertEqual(self.row()["status"], "closed")
        self.daemon.outages = False
        self.tick()
        self.assertIsNone(self.row())
        self.assertEqual(self.daemon.queues, {})
        self.assertEqual(self.daemon.turns, {})


if __name__ == "__main__":
    unittest.main()
