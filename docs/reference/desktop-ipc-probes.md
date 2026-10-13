# Native IPC probe engineering

Read when changing the update/scan IPC interception harness.

The native update and progressive-scan journeys share owned IPC interception
custody through `desktop-owned-ipc-probe.mjs`. Its two fixed handles own payload
decoding, the no-forwarding boundary, fetch identity, Channel closure, pending
response settlement, and one retained terminal cleanup report. Callers own
scenario behavior, durable readback, screenshots, and their primary error.
The attempt owner sends an untrustworthy session through existing outer teardown.

Update deliberately returns an immediate controlled mutation failure and closes
its Channel at index zero. Scan deliberately emits two provisional events and
holds its response until cleanup. A failed Channel close does not stop response
settlement; lost fetch ownership never overwrites the foreign replacement.
Reports distinguish attempted actions from observed callback/invoke completion.
They extend these internal observation reports, not the verifier/evidence format.

Channel admission relies on the reviewed first-party action creating its token
after probe installation. This bounded window is specific to these two callers;
it does not establish general ownership of arbitrary fresh callbacks. Admission
excludes pre-existing, reused, and invocation callback/error IDs. Each admitted
Channel is bound to its original callback function before emission or closure.
Only the intercepted invocation's fresh response callbacks receive observers,
which forward the original callback and record completion after it returns.
Missing or replaced callbacks remain unowned; absence alone never proves cleanup.

The full frontend qualification lane run the existing context preflight, which also
checks these probes through pinned Tauri 2.11.6 runtime fixtures and the installed
API 2.11.1 `invoke` and `Channel`. Fallback and native forwarding are inert/spied;
this proves client lifecycle behavior, not backend discovery or native UI.
