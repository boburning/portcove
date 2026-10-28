"""Disposable fixture only. Never use this captured PTY for owner custody.

The fixed public test phrase is source data, not an operational secret. The
production CLI has no phrase argument, environment variable or pipe channel.
"""
import errno
import json
import os
import pty
import select
import signal
import sys
import termios
import time

mode, *command = sys.argv[1:]
phrase = b"public-disposable-catalog-fixture-phrase"
pid, terminal = pty.fork()
if pid == 0:
    os.execv(command[0], command)
before = termios.tcgetattr(terminal)
output = bytearray()
sent = 0
interrupted = False
deadline = time.monotonic() + 180
status = None
settled_checked = False
try:
    while time.monotonic() < deadline:
        if select.select([terminal], [], [], 0.1)[0]:
            try:
                data = os.read(terminal, 4096)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                data = b""
            output.extend(data)
            if len(output) > 65536:
                raise RuntimeError("bounded fixture terminal output exceeded")
        # age owns /dev/tty; wait for its complete non-echo prompt before input.
        prompts = output.count(b"Enter passphrase") + output.count(b"Confirm passphrase")
        if prompts > sent and not (termios.tcgetattr(terminal)[3] & termios.ECHO):
            if mode == "interrupt":
                os.kill(pid, signal.SIGTERM)
                interrupted = True
                sent = prompts
            else:
                os.write(terminal, (b"wrong-public-fixture" if mode == "wrong" else phrase) + b"\n")
                sent = prompts
        if b"FIXTURE_API_SETTLED" in output and not settled_checked:
            if termios.tcgetattr(terminal) != before:
                raise RuntimeError("terminal state not restored before live caller settlement")
            settled_checked = True
            os.write(terminal, b"fixture-done\n")
        child, status_value = os.waitpid(pid, os.WNOHANG)
        if child:
            status = status_value
            break
    if status is None:
        sys.stderr.write(output.decode("utf-8", "replace").replace(phrase.decode(), "[FIXTURE REDACTED]"))
        raise RuntimeError("finite fixture terminal deadline exceeded")
    after = termios.tcgetattr(terminal)
    if phrase in output or b"wrong-public-fixture" in output:
        raise RuntimeError("fixture passphrase was echoed")
    if before != after:
        raise RuntimeError("terminal state not restored after settled child")
    print(json.dumps({"exit_code": os.waitstatus_to_exitcode(status), "prompts": sent,
                      "interrupted": interrupted, "echo_absent": True,
                      "terminal_restored": True, "checked_before_caller_exit": settled_checked, "output": output.decode("utf-8", "replace")}))
finally:
    if status is None:
        os.killpg(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    os.close(terminal)
