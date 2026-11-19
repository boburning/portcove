"""Deliver actionable PR watcher results to their owning local Codex threads."""

import argparse
import asyncio
import fcntl
import json
import os
import re
import shlex
import sqlite3
import subprocess
import sys
import time
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

from pr_wake_codex import Daemon

REPO = "boburning/portcove"
ROOT = Path(__file__).resolve().parents[1]
POLL = 180
EVENT_TYPES = ",".join(
    f"com.github.pull_request.{event}.v1"
    for event in (
        "check_suite.status.changed",
        "head.changed",
        "review.submitted",
        "state.changed",
    )
)
CONDITIONS = {
    "checks-failed": "A required check failed",
    "workflow-failed": "The bound workflow failed",
    "superseded": "The reviewed head or workflow attempt changed",
    "deadline": "The original deadline expired with missing evidence",
    "green": "All required checks passed for the reviewed head and attempt",
    "review": "A new review or conversation comment needs inspection",
}


def utc(epoch):
    return datetime.fromtimestamp(epoch, UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_deadline(value):
    try:
        epoch = int(datetime.fromisoformat(value).timestamp())
        if utc(epoch) == value:
            return epoch
    except (ValueError, OverflowError):
        pass
    raise argparse.ArgumentTypeError("use UTC time in YYYY-MM-DDTHH:MM:SSZ format")


def positive(value):
    number = int(value)
    if number <= 0 or number >= 2**53:
        raise argparse.ArgumentTypeError("expected a positive, safe integer")
    return number


def root_for_state():
    default = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state")) / "portcove/pr-wake"
    state = Path(os.environ.get("PORTCOVE_PR_WAKE_STATE", default)).resolve()
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    if state.stat().st_uid != os.getuid() or state.stat().st_mode & 0o077:
        raise RuntimeError("PR wake state must be private to this account (mode 0700)")
    return state


@contextmanager
def lock(state, name, nonblocking=False):
    with (state / f"{name}.lock").open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX | (fcntl.LOCK_NB if nonblocking else 0))
        yield


@contextmanager
def store(state):
    db = sqlite3.connect(state / "watches.sqlite3", timeout=10)
    try:
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA synchronous=FULL")
        db.execute("""CREATE TABLE IF NOT EXISTS watches (
            pr INTEGER PRIMARY KEY, data TEXT NOT NULL
        )""")
        db.execute("""CREATE TABLE IF NOT EXISTS events (
            id TEXT PRIMARY KEY, pr INTEGER NOT NULL, owner TEXT NOT NULL, message TEXT NOT NULL,
            report TEXT NOT NULL, turn TEXT, prior_turn TEXT, claimed INTEGER NOT NULL DEFAULT 0
        )""")
        with db:
            yield db
    finally:
        db.close()


def load(db, pr):
    row = db.execute("SELECT data FROM watches WHERE pr=?", (pr,)).fetchone()
    return json.loads(row["data"]) if row else None


def save(db, watch):
    db.execute("INSERT OR REPLACE INTO watches VALUES (?,?)", (watch["pr"], json.dumps(watch)))


def command(args, cwd=ROOT, timeout=20, require_success=True):
    result = subprocess.run(
        args, cwd=cwd, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout, check=False
    )
    if require_success and result.returncode:
        raise RuntimeError(f"{args[0]} {args[1]} failed ({result.returncode})")
    return result.stdout


def gh(endpoint, paginate=False):
    args = ["gh", "api", endpoint]
    if not paginate:
        return json.loads(command(args))
    output = command([*args, "--paginate"]).strip()
    decoder = json.JSONDecoder()
    result = []
    while output:
        page, end = decoder.raw_decode(output)
        if not isinstance(page, list):
            raise RuntimeError("GitHub feedback page is incomplete")
        result.extend(page)
        output = output[end:].lstrip()
    return result


def pull(pr):
    facts = gh(f"repos/{REPO}/pulls/{pr}")
    if facts["number"] != pr or facts["state"] not in ("open", "closed"):
        raise RuntimeError("GitHub returned an incomplete or different PR")
    return facts


def relevant_feedback(watch, facts):
    pr = watch["pr"]
    owner = facts["user"]["login"].casefold()
    head = watch["head"]
    mention = re.compile(rf"(?<![\w@])@{re.escape(owner)}(?![\w-])", re.IGNORECASE)
    feedback = []
    for area, endpoint in (
        ("review", f"pulls/{pr}/reviews"),
        ("comment", f"issues/{pr}/comments"),
    ):
        for item in gh(f"repos/{REPO}/{endpoint}?per_page=100", paginate=True):
            updated = item.get("submitted_at") if area == "review" else item.get("updated_at")
            if not updated or updated < watch["registered"] or item["user"]["login"].casefold() == owner:
                continue
            body = item.get("body") or ""
            if area == "review":
                relevant = item.get("commit_id") == head and (
                    item["state"] in ("CHANGES_REQUESTED", "APPROVED")
                    or (item["state"] == "COMMENTED" and bool(body.strip()))
                )
            else:
                relevant = bool(mention.search(body)) and (
                    item["author_association"] in ("OWNER", "MEMBER", "COLLABORATOR")
                )
            if relevant:
                feedback.append((f"{area}/{item['id']}/{updated}", item["html_url"]))
    return sorted(feedback)


def pr_url(pr):
    return f"https://github.com/{REPO}/pull/{pr}"


def sample(watch):
    return json.loads(
        command(
            [
                "just",
                "pr-watch",
                "--pr",
                str(watch["pr"]),
                "--head",
                watch["head"],
                "--run",
                str(watch["run"]),
                "--attempt",
                str(watch["attempt"]),
                "--deadline",
                utc(watch["deadline"]),
                "--sample",
                "--json",
            ],
            timeout=75,
            require_success=False,
        )
    )


def observe(watch, now, read_pull=pull, read_sample=sample, read_feedback=relevant_feedback):
    pr = watch["pr"]
    facts = read_pull(pr)
    if facts["state"] == "closed":
        return "closed", None, None, None, POLL
    head = facts["head"]["sha"]
    if head != watch["head"]:
        return "superseded", f"head/{head}", pr_url(pr), {"observed_head": head}, POLL
    result = read_sample(watch)
    evidence = result["evidence"]
    current = evidence.get("watch", evidence)
    if result["operation"] != "pr-delivery.watch":
        raise RuntimeError("invalid watch operation")
    facts = read_pull(pr)
    if facts["state"] == "closed":
        return "closed", None, None, None, POLL
    if facts["head"]["sha"] != head:
        return "superseded", f"head/{facts['head']['sha']}", pr_url(pr), result, POLL
    condition = current.get("watch_condition")
    if current.get("pull_request") != pr or current.get("head") != head:
        raise RuntimeError("watch sample binding differs from the PR")
    if current.get("run") != watch["run"] or current.get("attempt") != watch["attempt"]:
        raise RuntimeError("watch sample binding differs from the workflow attempt")
    if result["status"] == "succeeded":
        condition = "green"
    if condition in ("checks-failed", "workflow-failed", "superseded", "deadline", "green"):
        workflow = current.get("workflow") or {}
        attempt = workflow.get("run_attempt", watch["attempt"])
        run_url = f"https://github.com/{REPO}/actions/runs/{watch['run']}/attempts/{attempt}"
        failure = next((c for c in current["contexts"] if c["outcome"] == "failure"), {})
        check_id = failure.get("check_run_id")
        if condition == "checks-failed" and isinstance(check_id, int):
            run_url = f"https://github.com/{REPO}/runs/{check_id}"
        key = "deadline" if condition == "deadline" else f"{condition}/{workflow.get('head_sha', head)}/{attempt}"
        if key not in watch["seen"]:
            return condition, key, run_url, result, POLL
    feedback = [(key, url) for key, url in read_feedback(watch, facts) if key not in watch["seen"]]
    if feedback:
        key, url = feedback[0]
        return "review", key, url, {"feedback": feedback}, POLL
    if condition is None and now >= watch["deadline"] and "deadline" not in watch["seen"]:
        return "deadline", "deadline", pr_url(pr), result, POLL
    return None, None, None, result, current.get("next_sample_ms", POLL * 1000) / 1000


def record_event(db, watch, condition, key, url, report, state):
    event = str(uuid.uuid4())
    loader = ROOT / "scripts/pr_wake.py"
    invocation = f"PORTCOVE_PR_WAKE_STATE={shlex.quote(str(state))} python3 {shlex.quote(str(loader))}"
    message = (
        f"Portcove PR #{watch['pr']} at {watch['head']}: {CONDITIONS[condition]}. {url}\n"
        f"Event {event}. Run `{invocation} claim {event}` before acting. "
        f"Replace `claim` with `report` to read the local evidence. "
        "Proceed only if claimed. Re-read the current PR and follow existing delivery authorization."
    )
    db.execute(
        "INSERT INTO events (id,pr,owner,message,report) VALUES (?,?,?,?,?)",
        (event, watch["pr"], watch["owner"], message, json.dumps(report)),
    )
    watch.pop("delivery_error", None)
    watch["pending"] = event
    watch["pending_key"] = key
    watch["pending_condition"] = condition
    watch["invalidated"] = False
    save(db, watch)


def reconcile(state, pr):
    with lock(state, pr), store(state) as db:
        watch = load(db, pr)
        if not watch or not watch["pending"]:
            return
        event = db.execute("SELECT * FROM events WHERE id=?", (watch["pending"],)).fetchone()
        active = watch["status"] == "watching" and not watch["invalidated"]
        with Daemon() as daemon:
            turn = daemon.recover(watch["owner"], event["message"], active)
            if turn and active and not event["claimed"]:
                status = daemon.turn_status(watch["owner"], turn)
                if status in ("failed", "interrupted", "completed"):
                    if not event["prior_turn"]:
                        db.execute(
                            "UPDATE events SET message=?, prior_turn=?, turn=NULL WHERE id=?",
                            (event["message"] + "\nRecovery after a turn ended before claim.", turn, event["id"]),
                        )
                        return
                    watch["delivery_error"] = "The retry turn ended without claiming this event"
                    save(db, watch)
        if turn:
            db.execute("UPDATE events SET turn=? WHERE id=?", (turn, event["id"]))
        if (turn and active and event["claimed"]) or watch["invalidated"] or watch["status"] in ("closed", "cancelled"):
            if watch["status"] in ("closed", "cancelled"):
                db.execute("DELETE FROM watches WHERE pr=?", (pr,))
            else:
                if active:
                    watch["seen"].append(watch["pending_key"])
                    if watch["pending_condition"] == "review":
                        watch["seen"].extend(
                            key for key, _ in json.loads(event["report"])["feedback"] if key != watch["pending_key"]
                        )
                    watch["delivered"] = event["id"]
                watch["pending"] = watch["pending_key"] = None
                save(db, watch)
        db.commit()


def step(state, pr, now=time.time, observe_now=observe, dispatch=reconcile, read_pull=pull):
    with store(state) as db:
        watch = load(db, pr)
    if not watch:
        return POLL
    if watch["status"] in ("paused", "cancelled", "closed"):
        if watch["status"] == "paused" and read_pull(pr)["state"] == "closed":
            with lock(state, pr), store(state) as db:
                current = load(db, pr)
                if current and current["id"] == watch["id"]:
                    if current["pending"]:
                        current["status"] = "closed"
                        save(db, current)
                    else:
                        db.execute("DELETE FROM watches WHERE pr=?", (pr,))
        if watch["pending"]:
            dispatch(state, pr)
            return 15
        return POLL
    try:
        condition, key, url, report, interval = observe_now(watch, now())
    except (KeyError, OSError, ValueError, subprocess.TimeoutExpired, RuntimeError) as error:
        if now() < watch["deadline"] or "deadline" in watch["seen"]:
            if watch["pending"]:
                return 15
            return POLL
        condition, key, url, report, interval = (
            "deadline",
            "deadline",
            pr_url(pr),
            {"collection_error": type(error).__name__},
            POLL,
        )
    with lock(state, pr), store(state) as db:
        current = load(db, pr)
        if not current or current["id"] != watch["id"] or current["status"] != "watching":
            return 1
        if report:
            evidence = report.get("evidence", {})
            details = evidence.get("watch", evidence)
            workflow = details.get("workflow") or {}
            changed_timing = False
            for name, value in (
                ("queued_at", workflow.get("created_at")),
                ("job_started_at", details.get("job_started_at")),
            ):
                if value and not current.get(name):
                    current[name] = value
                    changed_timing = True
            if changed_timing:
                save(db, current)
        if current["invalidated"] and not current["pending"]:
            current["invalidated"] = False
            save(db, current)
        if condition == "closed":
            if not current["pending"]:
                db.execute("DELETE FROM watches WHERE pr=?", (pr,))
            else:
                current["status"] = "closed"
                save(db, current)
        elif current["pending"]:
            if current["pending_key"] != key:
                current["invalidated"] = True
                current["delivered"] = None
                save(db, current)
        elif condition and key not in current["seen"]:
            if condition == "superseded":
                current["delivered"] = None
            record_event(db, current, condition, key, url, report, state)
        db.commit()
    dispatch(state, pr)
    with store(state) as db:
        current = load(db, pr)
    if current and current["pending"]:
        return POLL if current.get("delivery_error") else 15
    return 1 if current and current["invalidated"] else interval


async def listen(pr, wake):
    executable = await asyncio.create_subprocess_exec(
        "gh",
        "event",
        "listen",
        "--resource",
        pr_url(pr),
        "--event",
        EVENT_TYPES,
        "--follow",
        stdin=subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    async def read(stream, is_event):
        async for line in stream:
            if is_event:
                try:
                    name = json.loads(line)["type"]
                except (ValueError, KeyError, TypeError):
                    continue
                if name not in EVENT_TYPES.split(","):
                    continue
            elif b"read the current state now" not in line.lower():
                continue
            wake.set()

    try:
        await asyncio.gather(read(executable.stdout, True), read(executable.stderr, False))
        await executable.wait()
        wake.set()
    finally:
        if executable.returncode is None:
            executable.terminate()
            await executable.wait()


async def watch_pr(state, pr, streams, wake):
    listener = asyncio.create_task(listen(pr, wake)) if streams else None
    fast_poll_used = False
    try:
        while True:
            try:
                delay = await asyncio.to_thread(step, state, pr)
            except Exception as error:
                print(f"PR #{pr} worker will reconcile after {type(error).__name__}", file=sys.stderr)
                delay = 15
            with store(state) as db:
                watch = load(db, pr)
            if watch is None:
                return
            if delay < 3:
                delay = POLL if fast_poll_used else delay
                fast_poll_used = True
            if watch["status"] == "watching" and watch["deadline"] > time.time():
                delay = min(delay, watch["deadline"] - time.time())
            try:
                await asyncio.wait_for(wake.wait(), timeout=max(0.1, delay))
                wake.clear()
            except TimeoutError:
                pass
    finally:
        if listener:
            listener.cancel()
            await asyncio.gather(listener, return_exceptions=True)


def verify_owner(watch):
    with Daemon() as daemon:
        owner = watch["owner"]
        thread = daemon.thread(owner)
        if not Path(thread["cwd"]).resolve().is_relative_to(Path(watch["worktree"])):
            raise RuntimeError("Codex daemon thread cwd is outside the owning worktree")
        daemon.call("thread/queue/list", threadId=owner, limit=1)
        daemon.call("thread/items/list", threadId=owner, limit=1)
        daemon.call("thread/turns/list", threadId=owner, limit=1)


def accept(state, pr, verify=verify_owner):
    with lock(state, pr), store(state) as db:
        watch = load(db, pr)
        if not watch or watch["accepted"] or watch.get("accept_error"):
            return
        try:
            verify(watch)
            watch["accepted"] = utc(time.time())
        except Exception as error:
            watch["accept_error"] = (
                str(error)
                if isinstance(error, RuntimeError)
                else f"could not read this thread on the local Codex daemon ({type(error).__name__})"
            )
        save(db, watch)


async def serve(state):
    command(["just", "--version"])
    command(["gh", "auth", "status"])
    if "--resume" not in command(["codex", "queue", "--help"]):
        raise RuntimeError("this Codex build does not support queue --resume")
    try:
        command(["gh", "event", "listen", "--help"])
        streams = True
    except (OSError, RuntimeError, subprocess.TimeoutExpired):
        streams = False
    tasks = {}
    while True:
        with store(state) as db:
            watches = [json.loads(r["data"]) for r in db.execute("SELECT data FROM watches")]
        for watch in watches:
            pr = watch["pr"]
            if not watch["accepted"]:
                if not watch.get("accept_error"):
                    await asyncio.to_thread(accept, state, pr)
                continue
            revision = (watch["id"], watch["status"])
            if pr not in tasks or tasks[pr][0].done():
                wake = asyncio.Event()
                tasks[pr] = (asyncio.create_task(watch_pr(state, pr, streams, wake)), wake, revision)
            elif tasks[pr][2] != revision:
                task, wake, _ = tasks[pr]
                wake.set()
                tasks[pr] = (task, wake, revision)
        present = {watch["pr"] for watch in watches}
        for pr, (_, wake, _) in tasks.items():
            if pr not in present:
                wake.set()
        tasks = {pr: task for pr, task in tasks.items() if not task[0].done()}
        await asyncio.sleep(2)


def owning_thread():
    owner = os.environ.get("CODEX_THREAD_ID", "")
    if not re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", owner):
        raise RuntimeError("the owning Codex session must provide its CODEX_THREAD_ID UUID")
    return owner


def service_online(state):
    try:
        with lock(state, "service", nonblocking=True):
            return False
    except BlockingIOError:
        return True


def handoff(state, args):
    owner = owning_thread()
    if not re.fullmatch("[0-9a-f]{40}", args.head):
        raise RuntimeError("the reviewed head must be a full SHA")
    worktree = Path(command(["git", "rev-parse", "--show-toplevel"], cwd=Path.cwd()).strip()).resolve()
    origin = command(["git", "remote", "get-url", "origin"], cwd=worktree).strip()
    if origin.removesuffix(".git") not in (f"https://github.com/{REPO}", f"git@github.com:{REPO}"):
        raise RuntimeError(f"the worktree origin must name {REPO}")
    if command(["git", "rev-parse", "HEAD"], cwd=worktree).strip() != args.head:
        raise RuntimeError("the worktree HEAD differs from the reviewed head")
    watch = {
        "id": str(uuid.uuid4()),
        "pr": args.pr,
        "owner": owner,
        "repo": REPO,
        "worktree": str(worktree),
        "head": args.head,
        "run": args.run,
        "attempt": args.attempt,
        "deadline": args.deadline,
        "registered": utc(time.time()),
        "accepted": None,
        "status": "watching",
        "seen": [],
        "pending": None,
        "pending_key": None,
        "invalidated": False,
        "delivered": None,
    }
    with lock(state, args.pr), store(state) as db:
        previous = load(db, args.pr)
        if previous:
            if previous["owner"] != owner or previous["worktree"] != str(worktree):
                raise RuntimeError("PR already has another watch owner or worktree")
            binding = ("head", "run", "attempt")
            if all(previous[k] == watch[k] for k in binding):
                if previous["deadline"] != args.deadline:
                    raise RuntimeError("retain the original deadline for this binding")
                if previous["status"] != "watching":
                    raise RuntimeError("watch is paused or being cleaned up")
                watch = previous
                watch.pop("accept_error", None)
            elif previous["pending"] or previous["status"] != "watching":
                raise RuntimeError("resolve the existing pending event or pause before rebinding")
        save(db, watch)
        db.commit()
    for _ in range(75):
        with store(state) as db:
            persisted = load(db, args.pr)
        if persisted and persisted["id"] == watch["id"]:
            if persisted["accepted"] and service_online(state):
                print(json.dumps(persisted))
                return
            if persisted.get("accept_error"):
                raise RuntimeError(persisted["accept_error"])
        time.sleep(0.4)
    raise RuntimeError("handoff is recorded but the service did not acknowledge it; check service status")


def control(state, args):
    with lock(state, args.pr), store(state) as db:
        watch = load(db, args.pr)
        if not watch:
            raise RuntimeError("PR has no watch")
        if args.action == "status":
            print(json.dumps(watch))
            return
        if watch["status"] in ("closed", "cancelled"):
            raise RuntimeError("PR is being cleaned up")
        watch["status"] = {"pause": "paused", "resume": "watching", "cancel": "cancelled"}[args.action]
        if args.action == "cancel" and not watch["pending"]:
            db.execute("DELETE FROM watches WHERE pr=?", (args.pr,))
        else:
            save(db, watch)
        db.commit()


def event_command(state, args):
    with store(state) as db:
        event = db.execute("SELECT * FROM events WHERE id=?", (args.event,)).fetchone()
    if event is None:
        raise RuntimeError("unknown event")
    if args.action == "report":
        print(event["report"])
        return
    if args.action == "receipt":
        print(json.dumps({field: event[field] for field in ("id", "pr", "owner", "turn", "prior_turn", "claimed")}))
        return
    owner = owning_thread()
    with lock(state, event["pr"]), store(state) as db:
        watch = load(db, event["pr"])
        if (
            not watch
            or watch["owner"] != owner
            or watch["status"] != "watching"
            or (watch["delivered"] != args.event and (watch["pending"] != args.event or watch["invalidated"]))
        ):
            raise RuntimeError("event is no longer actionable for this thread")
        changed = db.execute("UPDATE events SET claimed=1 WHERE id=? AND claimed=0", (args.event,)).rowcount
        db.commit()
        if not changed:
            raise RuntimeError("event already claimed")
    print("claimed")


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    actions = cli.add_subparsers(dest="action", required=True)
    actions.add_parser("serve")
    register = actions.add_parser("handoff")
    register.add_argument("--pr", required=True, type=positive)
    register.add_argument("--head", required=True)
    register.add_argument("--run", required=True, type=positive)
    register.add_argument("--attempt", required=True, type=positive)
    register.add_argument("--deadline", required=True, type=parse_deadline)
    for name in ("status", "pause", "resume", "cancel"):
        actions.add_parser(name).add_argument("pr", type=positive)
    for name in ("claim", "report", "receipt"):
        actions.add_parser(name).add_argument("event")
    args = cli.parse_args()
    state = root_for_state()
    if args.action == "serve":
        with lock(state, "service", nonblocking=True):
            asyncio.run(serve(state))
    elif args.action == "handoff":
        handoff(state, args)
    elif args.action in ("claim", "report", "receipt"):
        event_command(state, args)
    else:
        control(state, args)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, ValueError, OSError, sqlite3.Error, subprocess.TimeoutExpired) as exc:
        sys.exit(f"pr-wake: {exc}")
