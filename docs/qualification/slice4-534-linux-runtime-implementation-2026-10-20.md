# Slice 4 non-elevated semantic runtime implementation

Owner: [#534](https://github.com/boburning/portcove/issues/534). This implements
the selected rootless Linux preparation route. It grants no authentication,
issuer credential, protected execution, signing or publication authority.

`runSemanticRuntime` now has a fixed `linux-rootless` path. It accepts the
existing branded frozen opportunity, materializes inert snapshots and trusted
reader code, launches only the reviewed Python supervisor through the existing
resource guard, and checks the directly captured outcome. It retains the same
private capture brand and existing CheckRun broker/consumer. Imported JSON or a
synthetic receipt cannot create a publishable capture. Changes-required/refused
reports remain retained and produce no accepted handoff. The Windows path is
historical preparation; this change requests no further VHD attempt.

The fixed supervisor requires an ordinary Linux user, owned native Linux storage,
root-owned hash-qualified system tools, an available systemd user manager and
actual cgroup-v2 controller enforcement. It uses private user/PID/network/mount/
IPC/UTS/cgroup namespaces, read-only system/runtime/input mounts, one writable
512 MiB tmpfs, 1 GiB memory, zero swap, 64 total tasks and a 20-minute deadline.
Profile, work, temporary and cache paths share that single writable boundary.
Further user namespaces and capabilities are disabled. Read-only proc and device
mounts cannot become alternative writable storage. No root service, `sudo`,
Windows elevation, image attachment or ACL change is used.

The child cannot see unrelated host files, the dedicated persistent auth cache,
capture directory or issuer credential. A fixed Unix-socket CONNECT broker permits
only `chatgpt.com:443` and `auth.openai.com:443`, with public-address resolution,
finite transport limits and positive shutdown. It supplies no API-key route.
Dedicated ChatGPT authentication is released only after observed namespace,
mount and cgroup checks. Refresh returns through a bounded owned descriptor and
is persisted only after capture and complete tree/network settlement. Validation
or refusal before atomic replacement preserves the previous cache. A failure
after replacement can leave durability ambiguous; it blocks handoff and requires
reconciliation of retained effects, with no automatic retry. Tokens are not receipts.

The parent checks the exact executable bytes before materialization, all frozen
inputs and trusted runtime identities after execution, and positive settlement
before handoff. Resource ownership is inherited through a narrow parent-only
allowlist; ambient GitHub/OpenAI credentials, proxies and Node options are not
forwarded. The child/service environment is separately cleared. The fixed
credential-free qualifier supports only `fixture` and `codex-fixture`, accepts
no auth path, and can never create producer provenance.

The existing safe reader now offers bounded UTF-8 pages and frozen net-diff
views. Git/SHA256 identities and original byte offsets remain visible. Binary
data is explicit; raw base64 remains available. Truncated views expose original
continuation offsets. Capture validation replays the real responses and credits
only delivered bytes, retaining the distinction between necessary observation
and independent semantic judgment.

## Verification and remaining environment evidence

Inert tests cover widened request/auth/command refusal, mount and resource limits,
allowed reader operations, exact held-cgroup identity, settlement failures,
namespace identity, capture/auth-descriptor limits and network destination
refusals. The Node broker tests exercise UTF-8 boundaries, binary/truncated
views, original net-delta identities, response replay, changed executable
materialization, resource context and strict settlement. These are implementation
tests, not actual model judgment, authentication or host qualification.

The pinned upstream [0.162.0 execution arguments](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/exec/src/cli.rs)
and [feature registry](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/features/src/lib.rs)
support the selected fixed argument/feature names. That source check does not
qualify the actual Linux executable, authentication or inference route.

The October 20 nonprivileged WSL readback found the ordinary Ubuntu user shell
available but neither the system nor user systemd bus available. The observed
error is `Failed to start the systemd user session for 'boburning'`; the user
manager read reports `No such file or directory`. No service start, WSL shutdown,
root action or repeated runtime attempt was performed. Original readback is
retained under the delivery checkout's `work/slice4/534-wsl-*` records. Earlier
rootless namespace/tmpfs feasibility retains its narrower historical scope.

A functioning user manager with delegated controllers must be restored/observed
before native boundary qualification. Then the exact pinned Linux Node/Codex and
system-tool hashes, inert boundary and credential-free startup, dedicated normal
reviewer sign-in, supported authentication/network behavior and real complete-
opportunity reports must be observed. The native tests must include meaningful
compatible and misclassified/incompatible opportunities, with their actual
outcomes. No synthetic acceptance substitutes for those reports. Any host repair
and credential provisioning belong in the eventual consolidated setup, after
independent engineering; this record asks for no operator command now.

D1/D2/D3 remain selected. Availability/headroom remain Unknown, with bounded-
attempt eligibility and no capacity reservation. #254 remains Done;
#315/#534/#246 acceptance is pending, Chameleon protected acceptance remains
unset, production remains held, and Slice 5 is excluded.
