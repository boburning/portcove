# Linux native public network relay preparation

This prepares source for #534. No namespace, interface, capability, WSL host,
public network relay, installed package or protected credential operation was
performed. The ordinary updater still uses its maintained `.no_proxy()` clients,
public-address checks, HTTPS certificate validation and explicit redirect policy.
Nothing here qualifies a native report or grants egress from a candidate request.

The maintained public build inputs appoint exactly:

- `https://boburning.github.io/portcove/application/metadata/`
- `https://boburning.github.io/portcove/application/targets/`
- The ordinary immutable asset entry point `https://github.com/`.
- Its existing permitted redirect host `release-assets.githubusercontent.com`.

The independently trusted parent must authenticate those actual build inputs and
resolve their public IPv4 addresses under the original phase deadline. A policy
contains only schema, existing private session nonce, the two exact base URLs and
sorted one-to-eight public IPv4 addresses for each of the three hostnames. Extra
hosts, private/special addresses, IPv6-only resolution and caller-selected URLs
refuse. This is an IPv4-only preparation; broader networking is not inferred.

## Prepared namespace and private FD interface

The optional public-journey path is separate from the existing offline path. Its
fixed init imports the read-only helper before starting any child. It requires
PID1, a single nonroot host UID/GID mapping, a network namespace owned by exactly
its private user namespace, only `lo`, and precisely namespace `NET_ADMIN` plus
`NET_BIND_SERVICE` in all four capability masks. It assigns the appointed actual
public addresses to private loopback aliases and binds only their TCP443 sockets.
It creates no external interface, route, host firewall rule or permanent helper.

Before returning listeners, it clears ambient, effective, permitted and inheritable
capabilities, verifies all four masks are zero and `NoNewPrivs` is one, and makes
init nondumpable. The fixed host join must preserve these actual observations in
the candidate process snapshot, candidate `close_fds`, the existing sandbox and
positive full-tree cleanup. A setup failure must terminate init before children.
The maintained Bubblewrap v0.11.1 source supports ambient requested capabilities
but ignores some grant failures; therefore support remains **Unknown** until the
actual controlled host qualification verifies both acquisition and complete drop.
The preparation follows the [pinned Bubblewrap source](https://github.com/containers/bubblewrap/blob/v0.11.1/bubblewrap.c)
and the kernel's [owning-user-namespace inspection interface](https://man7.org/linux/man-pages/man2/NS_GET_USERNS.2const.html).

`hosts_file(policy)` supplies read-only public address mappings plus localhost;
the fixed join supplies `hosts: files` resolution. The ordinary client therefore
sees real public destinations and uses its original URL, SNI and certificate check.
It receives no proxy capability, alternate URL or substituted certificate.

`PublicNetworkRelay(policy, selector, 5, 6, deadline, listeners)` registers callbacks
on the existing init selector. The join dispatches callable `key.data(mask)` and
calls `tick()` each iteration; `close()` removes owned registrations and sockets.
FD5 carries parent-to-init responses and FD6 init-to-parent requests, exclusively private to init. The
parent pipes them to one fixed hash-qualified Python process in the same 64-task
unit: `python3 -I -S -B HELPER --outer POLICY POLICY_SHA REMAINING_MS`. The parent
retains the original deadline and process/tree cleanup; this is not a new budget.

The integrated join uses fixed `--outer-controlled` mode with a fourth private
stdio channel from the owned Node parent. Normal teardown requires one NULL
stop on that channel. A clean framing EOF may arrive before the final namespace
capture on a different pipe; it closes public sockets and waits at most two
seconds inside the original deadline for the matching stop. EOF, truncated
frames and normal process exit alone establish no successful journey.

The outer helper verifies canonical TLS ClientHello/SNI plus the exact appointed
public address before opening that address on TCP443. It forwards original bytes
without decrypting TLS. ECH, missing/duplicate SNI, unexpected protocols and origins
refuse. Each direction has one 16KiB credit per stream, at most eight simultaneous
streams, 64 total, a 1MiB pipe-output bound, 64KiB ClientHello bound, 100,000-byte
pre-parser frame bound and 262,144-frame lifetime limit. Aggregate traffic bounds
are 1GiB received and 16MiB sent; these are component ceilings, not claims of free
disk, available host capacity or production timing. Original phase, 15-second
opening and 30-second idle deadlines remain enforced.

## Evidence scope

Local Windows pure/model tests pass, with actual POSIX private-pipe/socket tests
explicitly skipped there. They exercise real standard-library TLS ClientHello
bytes, fragmentation, malformed/duplicate/ECH refusal, immutable policy hashing,
the application's address exclusions, and inert namespace/capability models.
The initial local run exposed Windows-only absent `os.getuid` mock attributes and
`O_NONBLOCK`; tests now create the inert attributes, while Linux uses its actual
nonblocking/no-follow flags. That failure is preserved here, not credited as host
execution. The controlled POSIX fixture uses socket pairs and local test endpoints;
its connector replacement cannot be selected by the fixed outer CLI.

Plan/session/init integration belongs to the native-worker owner and is still
pending at this component checkpoint. Actual rootless capability behavior, native
TLS/public download, installed AppImage behavior and public V0-to-V1 update/recovery
remain separate qualification obligations under the consolidated setup grant.
