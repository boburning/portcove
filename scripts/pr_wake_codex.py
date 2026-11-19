"""Codex daemon readback for the local PR watcher."""

import itertools
import json
import os
import subprocess
import time
from pathlib import Path


def text_matches(items, message):
    return any(item.get("type") == "text" and item.get("text") == message for item in items)


class Daemon:
    def __enter__(self):
        from websockets.sync.client import unix_connect

        home = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))
        self.connection = unix_connect(
            str(home / "app-server-control/app-server-control.sock"),
            open_timeout=5,
            close_timeout=1,
            max_size=32 * 1024 * 1024,
        )
        self.ids = itertools.count(1)
        try:
            self.call(
                "initialize",
                clientInfo={"name": "portcove-pr-wake", "version": "1"},
                capabilities={"experimentalApi": True},
            )
            self.connection.send(json.dumps({"method": "initialized"}))
        except Exception:
            self.connection.close()
            raise
        return self

    def __exit__(self, *_):
        self.connection.close()

    def call(self, method, **params):
        identity = next(self.ids)
        self.connection.send(json.dumps({"method": method, "id": identity, "params": params}))
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            reply = json.loads(self.connection.recv(timeout=max(0, deadline - time.monotonic())))
            if reply.get("id") != identity:
                continue
            if "result" not in reply:
                raise RuntimeError(f"Codex daemon refused {method}")
            return reply["result"]
        raise TimeoutError(f"Codex daemon did not answer {method}")

    def pages(self, method, **params):
        cursors = set()
        cursor = None
        while True:
            page = self.call(method, **params, limit=50, cursor=cursor)
            yield from page["data"]
            cursor = page["nextCursor"]
            if cursor is None:
                return
            if cursor in cursors:
                raise RuntimeError(f"Codex daemon repeated a cursor for {method}")
            cursors.add(cursor)

    def thread(self, owner):
        thread = self.call("thread/read", threadId=owner)["thread"]
        if thread["id"] != owner:
            raise RuntimeError("Codex daemon returned a different thread")
        return thread

    def queued(self, owner, message):
        return [
            row["id"] for row in self.pages("thread/queue/list", threadId=owner) if text_matches(row["input"], message)
        ]

    def pickup(self, owner, message):
        # Check persisted user input, not a queue receipt or echoed assistant output.
        for entry in self.pages("thread/items/list", threadId=owner, sortDirection="desc"):
            item = entry["item"]
            if item["type"] == "userMessage" and text_matches(item["content"], message):
                return entry["turnId"]
        return None

    def turn_status(self, owner, turn_id):
        for turn in self.pages("thread/turns/list", threadId=owner, sortDirection="desc"):
            if turn["id"] == turn_id:
                return turn["status"]
        raise RuntimeError("Codex daemon cannot read the picked-up turn")

    def recover(self, owner, message, allow_send):
        queued = self.queued(owner, message)
        turn = self.pickup(owner, message)
        if turn:
            for queued_id in queued:
                self.call("thread/queue/delete", threadId=owner, queuedSubmissionId=queued_id)
            return turn
        if not allow_send:
            for queued_id in queued:
                self.call("thread/queue/delete", threadId=owner, queuedSubmissionId=queued_id)
            return None
        status = self.thread(owner)["status"]["type"]
        if queued:
            if status == "notLoaded":
                self.call("thread/resume", threadId=owner, excludeTurns=True)
            elif status == "idle":
                self.call("thread/queue/start", threadId=owner, queuedSubmissionId=queued[0])
            return None
        if status not in ("idle", "notLoaded"):
            return None
        # Bracket the transition from the queue into an active or committed turn.
        # A known queued copy uses the existing input, never another enqueue.
        if self.queued(owner, message) or self.pickup(owner, message):
            return None
        subprocess.run(
            ["codex", "queue", "--thread", owner, "--resume", "--message", message],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=20,
            check=False,
        )
        return None
