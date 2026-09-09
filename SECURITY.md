# Security policy

The [application update trust design](docs/UPDATER-TRUST.md) separates authenticated
metadata, Tauri payload signatures, OS trust and catalog authority. Its tests use
temporary disposable keys; current protected production release procedures remain
effective and application updater behavior is not activated by the design.

Please report vulnerabilities through [GitHub's private vulnerability reporting form](https://github.com/boburning/portcove/security/advisories/new) rather than opening a public issue. Include the affected version, operating system, reproduction steps, expected impact, and any proof-of-concept files needed to reproduce the issue safely. If GitHub cannot show the form, contact a repository maintainer without disclosing the vulnerability publicly.

Portcove treats upstream release metadata, archive paths, filenames, and adopted directories as untrusted. Important security invariants include:

- no install without a SHA-256 digest obtained independently from the payload;
- no GitHub or GitLab release resolution, including an in-memory release-cache
  hit, when the hosting service reports the repository as archived;
- no hosted release provider for a catalog entry marked `Retired`; such an
  entry can resolve only an exact stable per-platform direct manifest with a
  nonzero size, HTTPS URL, version, and SHA-256 digest;
- no catalog admission for an entry marked `Superseded` or `Abandoned`;
- no archive path traversal, links, special files, platform path aliases, or unbounded extraction;
- no execution during download or extraction;
- no deletion of user-data directories during version removal;
- no modification of the original directory during adoption;
- no bundled or uploaded copyrighted game source data;
- no release-signing private keys in the repository.
- no GitHub tokens in command arguments, SQLite, caches, logs, structured output, release downloads, or launched-game environments;
- bearer authorization is limited to the configured GitHub API origin, including across redirects;
- device authorization requires a public client ID and stores a token only after GitHub validates it.

The host's archived flag and Portcove's `Retired` catalog status are separate
facts. Hosted providers revalidate GitHub or GitLab repository metadata before
returning either a fresh or five-minute in-memory release selection. A `304 Not
Modified` may reuse the last semantically valid conditional metadata body; a
temporary network failure remains a network failure and never falls back to the
release cache. Provider API redirects are rejected, so bearer authorization
cannot cross a redirect boundary. A manually reviewed `DirectManifest` does
not query a host release API: it names one checksum-pinned artifact for every
declared platform, and normal download, archive, executable, source, install,
and rollback protections still apply. A roadmap proposal alone never grants
catalog eligibility.

GitHub release SHA-256 authority has three ordered levels: a valid provider
asset digest, otherwise exact `<asset-name>.sha256` sidecars, otherwise recognized
`SHA256SUMS`, `SHA256SUMS.txt` and `checksums.txt` manifests. Lower levels are
intentionally not consulted, even when they might contradict the selected level;
an unreadable or empty exact sidecar never falls through to an aggregate. Within
the selected sidecar level, every well-formed value bound to the chosen filename
must agree, including repeated lines and duplicate sidecar assets. Equal values
are normalized to lowercase; conflicts fail with `verification` and the bounded
`checksum_ambiguity` reason, without echoing untrusted manifest contents.

Sidecar names are matched without ASCII case sensitivity. Manifest filenames
remain case-sensitive after the existing leading `*` and `./` normalization.
Only exact sidecars may supply a bare digest. Unrelated names and malformed hash
lines supply no authority. Selection permits at most eight sidecar assets before
any download (`checksum_source_limit` on excess), downloads sequentially with a
30-second timeout per response, and retains the existing credential-free client
and five-redirect ceiling. Each body is limited to 1 MiB, bounding total body
processing to 8 MiB; network, encoding and size failures never return a partially
collected digest. None of these values are derived from the downloaded payload.

Every production child process is created through the core-owned typed child-process policy. It starts from a reviewed operating-system/session allowlist, removes GitHub credentials plus credential-shaped token, secret, password, API-key, cloud-key, SSH-agent, and askpass variables, and then adds only the operation's checked Portcove/upstream variables. Native executables may receive literal caller arguments. Windows batch launchers receive only fixed, metacharacter-checked catalog arguments and reject caller-supplied arguments before process creation.

Launch supervision is parent-independent in the desktop. A detached native helper holds the per-port lock, persists the supervisor/child/exact-install identity, waits for game exit, and collects saves before clearing the session. The Tauri process only observes this state. A crashed helper leaves a fail-closed row that startup recovery resolves against the recorded process and install; it is never reinterpreted as a successful launch. CLI interrupts are forwarded to the child's process group while Portcove remains alive to collect saves.

Install and adoption payloads are built and verified privately before same-volume publication. Removal quarantines only paths already registered inside the managed versions tree before deleting metadata. Startup recovery advances only durable, unambiguous operation states; untracked final directories are reported for review and are never automatically deleted.

Cancellation is cooperative and core-owned. A durable request races atomically with closing the preparation phase; prepared or published operations continue through their existing recovery protocol. Activity locks protect live workers from another process's orphan recovery. Cancellation never kills a blocking mutation worker or interrupts restore, migration, library transfer, or supervised save collection, and a cancelled outcome is reported only after it is recorded in the activity ledger.

Release and private-toolchain archives share one preflight policy. Downloads enforce declared and global compressed-size bounds while streaming. Extraction writes nothing until entry types, normalized collision keys, path aliases, resource quotas, compression ratio, and destination free space pass. On Unix, extraction preserves only whether a regular file was intended to be executable, normalizing executable files and directories to `0755` and data files to `0644`; ownership and setuid, setgid, and sticky bits are never restored from an archive. Archive paths are deliberately ASCII-only until Portcove has a proven cross-platform Unicode normalization contract.

Bundled game runtimes follow that same policy and belong to an immutable game version, outside persistent user data. The manifest binds their artifact and origin; explicitly adopted trees never claim vendor archive provenance. Every immutable game/runtime file is checked before launching a runtime-bearing install, including Java archives and extensionless module data. Missing legacy runtime identity blocks launch before an upstream bootstrap downloader can run.

Display tags are not trust identities. Every new or re-adopted install has a content-addressed artifact identity, a byte-bound manifest identity, and one persisted catalog-selected executable. Exact relative executable hints select one reviewed path; legacy basename hints fail on multiple case-insensitive matches. Active, staged, retained, rollback, recovery, and launch paths rehash the immutable critical set before changing a pointer or creating a process, and reject newly introduced loader-sensitive files or symlinks beside the executable. Saves, exact generated metadata, and catalog-declared mutable configuration are excluded from that launch-time set. Legacy rows without these identities remain visible but fail closed until replaced or re-adopted.

Library import accepts an explicitly reviewed, trusted local backup into a new or empty library. Metadata, content inventories, paths, selected executables, and current persistence/critical-file contracts are verified before the restored library becomes openable. Backup metadata is not an independent publisher signature: only import backups whose origin you trust. Imports never open or migrate the input database, upload source files, merge into existing installed state, or copy credentials. Incomplete transfers remain gated and recoverable; old input and ambiguous copied data are retained.

Signed catalog delivery uses explicit Ed25519 public-key pins, strict signature verification, bounded payloads, expiration, and a monotonic replay floor. Unknown or revoked keys, tampered/expired/future-dated envelopes, old sequences, invalid catalogs, and changes to embedded source/execution/persistent-data contracts are rejected. A trusted publisher can change release resolution URLs and metadata; verify its public key independently before granting trust. Release SHA-256 verification remains mandatory. Private signing keys never enter the application or support bundles. Startup stays offline-capable through a verified cache and embedded fallback. These guarantees assume an intact local database and a reasonably accurate system clock; restoring an older complete database also restores its replay history. Explicit metadata import does not transfer trust configuration. See [the delivery contract](docs/SIGNED-CATALOG.md).
