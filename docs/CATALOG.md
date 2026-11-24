# Catalog policy

Read [Integration ownership](#integration-ownership) to find who manages a
port. If you need to edit an individual port record, read
[Adding or changing a port](#adding-or-changing-a-port). Use the
[definition contract](DEFINITION-DELIVERY.md#implemented-engine-capability-negotiation)
to learn how clients choose supported adapters. Apply each example and dated
test result only to the port and scope it covers.

## Implementation methods and shared dependencies

The optional `listing.implementation` format-1 envelope explains upstream work.
It projects into descriptive listings and managed presentation, separately from
`installation_method`, original-game/source-edition identity, target platforms,
release availability and qualification. It cannot grant an operation, transfer
save compatibility, select a package or replace an implementation.

`methods` contains at most eight distinct evidence-backed claims. The vocabulary
is `static-recompilation`, `matching-decompilation`, `non-matching-decompilation`,
`source-port`, `engine-reimplementation` and `other`; projects may combine methods.
Each claim includes `evidence_urls` (one to eight credential-free HTTPS links)
and an optional explanation `note`. Do not infer clean-room development from a
rewrite, or matching status from a source port. Unknown methods are unavailable
as explanations; they do not make allowed setup or launch unavailable.

`dependencies` contains at most sixteen distinct relationships. `kind` separates
`toolchain`, `runtime`, `library` and `source-preparation`; `project_url` identifies
the dependency independently of the game or implementation. Retain its `name`,
`confidence` (`confirmed`, `inferred` or `contradicted`), `evidence_urls`, relevant
`version_scope` and optional `note`. Confirmation needs attributable upstream
build/dependency documentation. A text mention may justify an inferred research
lead. Contradiction is displayed explicitly and never becomes a dependency grant.
Existing reviewed `upstream_lineage` remains the separate authority for forks,
successors and relocations; explicit original-game IDs still group alternatives.

The representative Majora’s Mask comparison describes 2Ship2Harkinian as a source
port using libultraship and ZAPDTR, and Zelda 64: Recompiled as static recompilation
using N64: Recompiled and RT64. Evidence is pinned to each inspected upstream source
revision. These descriptions do not revise either port’s supported source editions,
platforms, package identities or setup routes. Desktop shows them under **How this
project works** in details and comparison; **Implementation technique** is a
separate filter from installation method. No provider request is needed to read it.

ScummVM listings keep each game's own original-game ID and reviewed game data
edition. Each uses a `runtime` relationship to identify the shared ScummVM player.
The compatibility chart describes upstream support by engine and game ID.
The setup steps name the verified data archive and explain how to launch a saved
ScummVM target. ScummVM owns its profile and save locations, and the selected
package route determines who updates the runtime.
See [ScummVM's default save locations](https://docs.scummvm.org/en/latest/use_scummvm/save_load_games.html#location-of-saved-game-files)
and [direct launch with a saved target](https://docs.scummvm.org/en/latest/advanced_topics/command_line.html#starting-a-game).
The [shared player example](reference/scummvm.md) shows how to register two game
targets against the same upstream installation.

Descriptions require listing format 12. Formats 5 through 11 exported for older
strict readers omit only this inert field; ordinary requirements and restrictions
remain. Retained user-selected listings omit the field too, preserving their
established envelope versions and compatibility with earlier strict readers.
Core retains malformed/future optional envelopes without interpreting them;
Desktop ignores unsupported envelope versions, unknown kinds and unsafe links.
Authoring remains strict. Older documents may omit the field entirely.
An incoming signed directory below format 12 preserves an existing implementation
description only when the project URL and full original-game identity, including
source editions, match exactly. Other delivered fields still replace their prior
values. A format-12 omission clears the description; a changed project or game
scope does not inherit it. This compatibility rule grants no operational rights.
An accepted strict definition's explicit description takes precedence over a
bundled description. A bundled fallback is used only for the same project URL
and full original-game identity, so an accepted scope correction cannot inherit
another project's or edition's explanation.
Desktop consumes the effective Core listing when present, including a cleared or
unsupported description. It uses definition presentation only when no listing is
available; it cannot restore a description that Core has cleared.
Changing only this explanatory envelope does not invalidate a retained upstream
release observation: the observer declaration hash excludes it.

### Exact release withdrawal in status

Status reports curated distribution withdrawal only for the exact recommended
artifact or exact active installation. In machine output, the Install
assessment identifies the installed copy with `retained: true`. The reason
is `curated_distribution_withdrawn`. The badge and details use the catalog
maintainer when no further explanation is recorded. Both appear when both
releases are withdrawn. Status omits an actionable cached update offer only
when the cached metadata identifies one exact admitted artifact whose
distribution is withdrawn. The stored check remains available as historical
evidence, even after a different artifact becomes the recommendation.
Installed launch and rollback keep their existing checks. Local files and
saves are preserved.

## Package and launch declaration compatibility

Existing asset hints narrow supported package names. Reviewed release-stream
exclusions separately filter tags for their declared platforms. Exact managed
pins and package choices retain their own identity and authority checks.

The archive dispatch accepts TAR.XZ and 7z on the player-owned setup route
through the existing bounded extractors. Managed installation requires separate authority for the format. Existing managed TAR.XZ still requires
its retained platform declaration. Launch resolution derives the installed
source, per-game user data and cache paths from the trusted launch request.

The indexed-only `reviewed_launch_contract_v1` declares platform asset
rules, archive formats and typed launch values. The entry declares
`runtime.reviewed-package-and-launch-v1` in definition schema 4. A scoped
catalog projection holds the selected subject, and installation retains the
exact entry, projection and separately admitted acquisition grant. Legacy
catalog import and export refuse the declaration.

Asset `include` and `exclude` use literal case-insensitive filename terms.
`tag_pattern` matches one exact tag or a literal prefix ending in `*`.
The default and `markers` preserve GitHub's prerelease flag and recognized
tag markers. `flag` uses the flag alone. `never` excludes both detected kinds
of prerelease. Package declarations use `zip`, `tar.gz`, `tar.xz` or `7z`.
The exact suffix and container magic must agree before bounded extraction.

Launch values are literal strings or objects with a `path` of `user_data`,
`source`, `install_root` or `cache`. Each path occupies one argument or one
environment value. Source expansion needs the verified launch source.
Existing path, executable and environment policies still apply.
A reviewed launch contract's values follow strict rules by construction,
because the contract is catalog data that reaches players' machines and
starts a game process. A location comes only from the closed `path` set.
Core's `launch_paths::is_contract_launch_text` accepts a literal environment
value or text argument only when:

- It is 1 to 256 bytes drawn only from ASCII letters, digits and
  `.` `_` `=` `,` `+` `-` `:`. Everything else is refused, including `/`, `\`,
  `"`, `'`, `@`, `%`, `$`, backtick, `~`, `;`, whitespace, control characters
  and every non-ASCII character (fullwidth or look-alike dots, slashes and
  quotes, and superscript digits).
- It contains no `..` anywhere.
- Split into tokens at `=` and `,`, each token may start with one option
  sigil, `-`, `--` or `+`, whose remaining body does not start with `-` or `+`
  again. A token with a sigil contains no `:`. In a token without a sigil,
  every `:`-separated segment before the last has at least two characters and
  no `.`, which refuses drive forms (`C:x`, `--dir=C:x`, `-dC:x`) and
  alternate data streams (`a.txt:evil`) while keeping `profile:fast`; a token
  does not start with a case-insensitive `file:` scheme.
- No `:`-separated segment of a token body, nor the body after its first
  character for a single `-` or `+` sigil (an attached short option such as
  `-oNUL`), is a Windows device name (`CON`, `PRN`, `AUX`, `NUL`,
  `COM0`–`COM9`, `LPT0`–`LPT9`, case-insensitive, with or without an
  extension).
- No token names a refused runtime option (below).

For example `profile:fast`, `--width=1280`, `-windowed`, `+set` and
`r_mode=4` are accepted; `-d\\host\share\x.dll`, `-I/etc`, `-dC:x`,
`@/etc/args`, `-I..`, `-game..`, `a.txt:evil`, `COM¹`, `%2e%2e` and
`smb://x` are refused.

Legacy catalog fields (`launch_environment` values, `launch_arguments` and
`setup_arguments`) may carry relative paths in existing data, so they pass
the looser shared rule `launch_paths::is_contained_launch_text`:

- The text is ASCII and has no control character, no `"` or `'`, no `%`,
  `$` or backtick (refusing `%NAME%`, `$NAME`, `${NAME}`, `$(...)` and
  backtick expansion), and no `\\` or `//` anywhere (UNC, device, extended
  `\\?\` paths and `scheme://` locations).
- It is split into elements at `;`, `,`, `=` and ASCII whitespace. An element
  is refused when it starts with `@` (a response file), starts with an ASCII
  letter and `:` (`C:\x` or drive-relative `C:x`), has a drive form after any
  option sigil (`-C:x`, `--C:x` or the attached `-dC:x` and `--dC:x`), or
  starts with a case-insensitive `file:` scheme.
- Each element is split into segments at `:`, the path-list separator; a
  single `key:value` token such as `profile:fast` keeps two harmless segments.
  A segment before the last that has a `.` is refused (an alternate data
  stream such as `a.txt:evil`). A segment is refused when it starts with `/`,
  `\` or `~`, or when a
  component in either separator style is a parent reference (only dots and
  spaces with at least two dots, which Windows reads as `..`), ends in `..`,
  is a reserved device name (`CON`, `PRN`, `AUX`, `NUL`, `COM0`–`COM9`,
  `LPT0`–`LPT9`, including the superscript digits `¹` `²` `³`), or starts
  with `-` or `+` and is followed by a separator (`-I/etc`).

Catalog `launch_environment`, source and user-data variable names pass the
shared deny-list `process::is_loader_injection_variable`, compared
case-insensitively. It refuses every name under the runtime, loader, toolkit,
graphics and TLS prefixes `DOTNET_`, `COMPLUS_`, `COR_`, `CORECLR_`, `MONO_`,
`DOORSTOP_`, `PYTHON` (except the reviewed `PYTHONDONTWRITEBYTECODE`), `WINE`,
`QT`, `QML`, `GTK_`, `GTK2_`, `GTK3_`, `GDK_`, `GST_`, `GIO_`, `OCL_`,
`LIBVA_`, `VDPAU_`, `GBM_`, `EGL_`, `__GLX_`, `__EGL_`, `ELECTRON_`, `NODE_`,
`SSL_`, `OPENSSL_`, `MALLOC_`, `LD_`, `DYLD_`, `JAVA_`, `_JAVA_`, `JDK_`,
`PERL`, `RUBY`, `ENABLE_` and `DISABLE_` (Vulkan implicit layer toggles),
`VK_`, `LIBGL_`, `MESA_LOADER_`, `LUA`, `WEBVIEW2`, `TCL`, `TK_`, `BASH_`,
`GEM_`, `BUNDLE_`, `PIP_`, `NPM_`, `OPENCL`, `LIBDECOR_`, `IBM_`, `OPENJ9_`,
`ASAN_`, `UBSAN_`, `LSAN_`, `TSAN_`, `MSAN_`, `PROCESSOR_`, `OBS_`,
`MANGOHUD`, `XR_`, `VR_`, `CURL_`, `LADSPA_` and `LV2_`; the exact names
`PATH`, `SDL_DYNAMIC_API`, `__COMPAT_LAYER`, `CORE_LIBRARIES`, `GCONV_PATH`,
`LOCPATH`, `NLSPATH`, `TERMINFO`, `TERMINFO_DIRS`, `GLIBC_TUNABLES`,
`HOSTALIASES`, `RES_OPTIONS`, `TZDIR`, `CLASSPATH`, `CURL_CA_BUNDLE`,
`REQUESTS_CA_BUNDLE`, `_NT_SYMBOL_PATH`, `PSMODULEPATH`, `GSETTINGS_BACKEND`,
`SSLKEYLOGFILE`, `NO_PROXY`, `SYSTEMROOT`, `WINDIR`, `COMSPEC`, `TEMP`,
`TMP`, `APPDATA`, `LOCALAPPDATA`, `USERPROFILE`, `PROGRAMDATA`,
`PROGRAMFILES`, `HOMEDRIVE`, `HOMEPATH`, `PUBLIC` and `ALLUSERSPROFILE`; and
every proxy variable (`*_PROXY`). The deny-list is a second guard for legacy
data, not the contract rule.

A reviewed launch contract's environment names are title-specific by
construction. Its prefix is derived from the port identity, not chosen in the
data: the port ID's ASCII letters and digits, uppercased, in order, followed
by one `_` (`blacklabelhq-medievilrecomp` becomes
`BLACKLABELHQMEDIEVILRECOMP_`). A stem longer than 32 characters keeps its
first 24 characters followed by the first 8 uppercase hexadecimal digits of
the SHA-256 of the port ID, so long IDs that share a start stay distinct. A contract may omit `environment_prefix`, or
restate exactly that derivation; any other value is refused, and a restated
prefix must be used by a name. A contract environment name is accepted only
when it passes the shared name check above and either is the reviewed
harmless `PYTHONDONTWRITEBYTECODE` or starts with the derived prefix and
continues after it. When the derivation is shorter than three characters,
starts with a digit, or starts with or is the start of a loader-injection
prefix above or a non-title runtime, driver, platform or tool prefix (for
example `SDL`, `MESA_`, `DXVK_`, `STEAM`, `XDG_`, `TEMP`, `HOME` or
`PORTCOVE_`), the port has no derived prefix and its contract may set no
environment name except the harmless one. A test keeps the derivations of the
embedded catalog distinct.

The rules bound where text can point, not what a game does with it. A game
may itself treat one of its prefixed variables, or a literal argument, as a
file name; values cannot name a location outside the closed `path` set, but a
relative name inside the working directory remains expressible. Literal
arguments can also carry runtime-specific semantic flags. The strict class
already refuses the single-sigil and `:` forms such as `-agentlib:jdwp=…`,
`-agentpath:…`, `-javaagent:…`, `-Xrunjdwp:…`, `-XX:OnError=…` and
`-Xbootclasspath/a:…`. The class admits `--remote-debugging-port=…`,
`--inspect=…`, `--load-extension=…` and `--renderer-cmd-prefix=…`, so a
contract value is also refused when a token, after any `-`, `--` or `+`
sigil and before any `=`, names (case-insensitively)
`remote-debugging-port`, `remote-debugging-pipe`, `remote-debugging-address`,
`remote-allow-origins`, `inspect`, `inspect-brk`, `inspect-port`,
`inspect-wait`, `debug-port`, `load-extension`, `disable-extensions-except`,
`browser-subprocess-path`, `js-flags`, `require`, `import`, `loader`,
`experimental-loader`, `no-sandbox`, `disable-web-security`,
`register-pepper-plugins`, `r`, `m`, `env-file`, `inspect-brk-node`,
`openssl-config`, `disable-gpu-sandbox`, `no-zygote` or `single-process`, or
ends in `-cmd-prefix` or `-launcher`; a `-D` token is refused when its
property starts (case-insensitively) with `com.sun.management` or
`java.library.path`. This list does not bound every runtime's flags (for
example a short `-e`, an attached `-mmodule` or another `-Dproperty=value`),
and the bare tokens `-`, `--` and `=` stay accepted, so review of a contract's
literal arguments remains a publication-time responsibility. Legacy fields do
not use this option list.

A reviewed launch contract whose platform entry has only literal text
arguments keeps the previous decision about player-forwarded arguments, so
moving an existing static list into it changes only the representation. A
typed `path` value or any environment entry offers only the fixed launch.

Reviewed forge qualification models the API dialect, API root, web host and
exact asset hosts separately from the reviewed repository, release and artifact
identity. The alternate-forge route is currently exercised by qualification
fixtures. Naev's Codeberg listing and upstream-owned registration keep their
existing scope. An indexed `reviewed-forge` selector requires a named definition reader.
Managed acquisition also requires an exact, independently authenticated
[schema-5 publisher grant](DEFINITION-DELIVERY.md#qualification-for-separately-reviewed-forges).

## Descriptive compatibility advisories

The optional `listing.compatibility` envelope belongs to the existing
single per-port authored record. Use existing generated setup warnings and exact
recommendation observations first; no bulk backfill is required. This envelope
contains only remaining descriptive facts, never acquisition restrictions,
execution grants, commands, signature overrides or private paths.

Each of at most 64 records has a stable `id`, `feature`, `platform`, `route`,
`explanation`, public HTTPS `provenance`, Unix-seconds `observed_at`, and `evidence`
(`observed`, `upstream-reported` or `manual-requirement`). Optional `release`,
`artifact_sha256`, `edition` and descriptive `workaround` narrow applicability.
An artifact digest requires its actual release. The envelope is bounded to
64 KiB and requires listing format 7 or later. A directory also carrying GitLab
observations uses format 8. Authoring rejects malformed, future, unknown
and command-bearing content. Runtime interpretation makes invalid or future
optional content unavailable without changing operation eligibility.

Format 1 carries general advisories. Format 2 requires at least one launch
record with `launch_behavior.first_launch` and `launch_behavior.repeat_launch`.
Each stage uses `starts-game-directly`, `opens-project-launcher`,
`asks-for-game-files`, or `unknown`. Both stages describe the same platform,
route, release and package SHA-256. Use `upstream-setup` for a documented setup
route outside Portcove. Record any repeat-launch preconditions in the explanation.

Route-wide management facts need no invented artifact identity. Version-specific
failures retain their exact release/artifact/edition scope; a date or a missing
later observation never establishes recovery. Existing recommendation evidence
keeps its own exact-scope failure and correction semantics. The feature report
shows those records as historical until the recommendation owner has a matching
environment and identity; it does not produce another recommendation score.

A listing may carry `listed_at`, the UTC date (`YYYY-MM-DD`, a real calendar day, no
time or offset) on which it was first added to the directory. It is descriptive: it
orders a "Recently added" view and grants no support, availability, trust or
operation. A directory carrying any date requires listing format 9, and exports to
formats 5 through 8 omit it so an earlier strict reader never meets it. Authoring
stamps the current UTC day on a newly prepared listing and keeps an existing date.
`node scripts/backfill-listing-dates.mts` (add `--write`) fills the date from the
commit that first added each authored port file; it only edits listings without one
and inserts a single line. The date is excluded from the observer's listing
declaration hash, so adding or backfilling it does not invalidate retained upstream
observations. A listing without a date is valid and simply has no recency.

A listing may carry `funding_urls`: 1 to 12 distinct public HTTPS pages where the
upstream developers accept funding. Omit the field when there are none; an empty
list is refused. Desktop shows them under "Help fund this project" in the port's
Resources as ordinary external links and opens only those exact URLs. They are
descriptive and grant no support, availability, trust or operation; Portcove does
not fetch them at runtime. A directory carrying any link requires listing format 10,
exports to formats 5 through 9 and retained user-selected listings omit them, and the
observer's listing declaration hash ignores them. Delivering a format-10 directory
stops listing updates for format-9 readers; see
[descriptive directory delivery](DEFINITION-DELIVERY.md#descriptive-directory-delivery).

`node scripts/listing-funding.mts` reads each GitHub-hosted project's `FUNDING.yml`
in GitHub's lookup order (the repository's `.github/`, root and `docs/`, then the same
places in the owner's `.github` repository); the first file found decides. It keeps
`github`, `patreon`, `open_collective`, `ko_fi`, `liberapay`, `buy_me_a_coffee` and
HTTPS `custom` entries in that order (several entries for one platform keep their
order in the file), reports every entry it skips, and when there are
more than 12 keeps the first 12 and reports the rest. Only a readable project with no
`FUNDING.yml` in any location means "no links". A missing, renamed or unreadable
repository, or a file that is oversized, malformed (including YAML aliases) or has no
usable entry, leaves the listing unchanged; a renamed repository is reported with its
new name so `project_url` can be corrected. The script prints its plan; `--write`
adds links to listings without any, and only `--write --replace` replaces or removes
existing links, which may be hand-authored. `--replace` never clears links when the
upstream file exists but yields no usable link; remove them by hand if they are
obsolete. `--only <id>` limits it to named
listings. Review the diff like any other listing change and regenerate the catalog.
Other hosts may carry reviewed hand-authored links.

Legacy format-5/6 exports omit only inert compatibility advice and retain
acquisition restrictions. GitLab-bearing directories refuse exports below format
8; format 7 retains advice without accepting GitLab observation identities.
A retained user-selected listing carrying advice uses
envelope version 3 so earlier strict readers refuse unfamiliar content. Existing
GitLab listings in envelopes 1/2 remain readable; a combined GitLab/advice envelope
uses version 3 and projects to directory format 8. Managed definitions and retained
managed instructions keep their original owners.

## Integration ownership

The owner adopted this upstream-first boundary on October 22, 2026 in
[#1422](https://github.com/boburning/portcove/issues/1422). Catalog breadth and
management depth are separate. Ordinary integration selects an appropriate
official package, helps supply original game files through upstream conventions,
invokes supported upstream preparation when needed, and launches the result.
Upstream owns its engine, game-specific generation/extraction, compilation
implementation, rendering, audio, codecs, gameplay and bug fixes.

Each installation has one owner for runtime replacement:

| Offered route                  | Runtime replacement and updates    | Portcove's responsibility                                                                                                                                                                                                                                                                     |
| ------------------------------ | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Managed official package       | Portcove                           | Accepted artifact identity, safe installation, documented input/setup invocation and launch; player-data protection for explicitly owned paths. Offer update, rollback, backup and removal only where established.                                                                            |
| Supported upstream preparation | Explicitly selected for the output | Delegate the substantive work to upstream's CLI, builder, extractor or setup window. If upstream retains an updater/launcher, use non-owning registration unless a complete upstream switch qualifies a managed route; its mutable runtime cannot also be a Portcove-owned immutable version. |
| Existing installation          | Player or upstream launcher        | Explicit selected executable, working directory and bounded arguments; register, launch, and remove the registration while preserving external files. User selection establishes execution intent, not curated package authenticity.                                                          |
| No useful reasonable route     | Unoffered                          | Record the precise upstream dependency or product deferral and reconsideration condition on the canonical issue. Preserve research, patches and failures as evidence.                                                                                                                         |

A supported setup window is acceptable. Shared PSX preparation remains useful:
it invokes upstream generation/rebuild rather than implementing each engine.
Compilation is permitted; replacing a game's build implementation or repairing
its engine is an exceptional maintenance commitment, requiring an identified
consumer and a concrete reason. Mere technical feasibility does not require it.

Before extending behavior, remove unnecessary management promises. Unknown save
ownership may allow non-destructive launch while withholding replacement,
backup, rollback or deletion. Qualification follows the operations actually
offered. Fixtures, actual setup/launch and optional gameplay/device observations
remain separate; known relevant failures remain visible. A link, catalog
placeholder, research record or deferral is not a delivered integration.

An integration can finish when a released client offers an actionable operation
on an applicable platform and its required checks pass. An upstream-managed
registration can be the finished title scope. Record which operations Portcove
offers and who owns each one. Record the Portcove handoff at the boundary
actually observed. Showing a picker, importing an original and completing
setup each need evidence when the offered operation depends on that event.

Reuse a shared capability result when the title fits its tested contract.
Verify the title's package, platform, source and ownership facts and exercise
unique behavior or a known failure affecting the offered operation. A player's
matching original is required at the operation that consumes it. Runner custody
of originals, completed campaigns and natural successors are separate evidence
unless the specific operation depends on them. Previously failed checks keep
their outcomes when a narrower operation becomes available.

Ordinary fitting additions use reviewed definition facts and existing behavior.
Compatible upstream updates normally change artifact facts. Reuse a policy only
after checking the behavior it relies on; a checksum or filename alone is
insufficient. New capabilities represent genuinely new behavior and retain
strict refusal of unknown execution/ownership semantics. Current schema IDs and
retained installed contracts keep their historical meanings.

See [compatibility and retired creation](reference/upstream-first-compatibility.md)
for identified consumers and retirement conditions. Preserve installed runtimes,
originals, saves, settings, backups and recovery independently of whether the
builder that created them remains an active feature.

### Rights basis for upstream-hosted packages

The owner adopted this rights policy on November 13, 2026 in
[#1129](https://github.com/boburning/portcove/issues/1129). It decides which
route a port may offer when its package is published by its own upstream but
not every part of it carries an explicit licence grant, as is common for
recompilations and decompilations of commercial games. Each tier applies only
to what Portcove itself does; the player always supplies their own game. On
the same day the owner made tier 3 the default for upstream-hosted packages,
following the model of launchers such as Quiver: Portcove fetches what the
upstream itself publishes and holds a package only for concrete reasons.

| Tier | Route                                                                                                                                                                    | Rights basis needed                                                                                                                                                              |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Discovery listing: name, summary and the upstream project link, with no download or install route                                                                        | An attributable public project; no package rights decision                                                                                                                       |
| 2    | Existing installation: the player obtains the package from upstream; Portcove registers it, verifies declared facts where bound, launches it and preserves external data | The player's own copy; Portcove neither hosts nor fetches the package                                                                                                            |
| 3    | Managed acquisition from the official upstream release: Portcove downloads the publisher's own release asset on the player's request, verifies it and installs it        | The package must come from the upstream's own release location, verified against its accepted identity, and must not bundle original game data beyond the owner exceptions below |
| 4    | Re-hosting, mirroring or caching packages for redistribution                                                                                                             | Not offered                                                                                                                                                                      |

- **Recorded notes, not holds.** Recompiled, translated or inherited game
  program code without a grant, bundled fonts of any licence that are not extracted from the game, icons, launcher
  art such as box art and logos, unlicensed helper code, forks or launchers,
  third-party library binaries shipped without their licence notices, and an
  unlicensed own layer are recorded as known limitations in the
  listing's warning. Portcove never re-hosts them; the upstream that
  publishes them answers for their terms.
- **Explicit prohibitions stay held.** An upstream that forbids redistribution
  or third-party acquisition of its package keeps its hold whatever the code
  basis.
- **Bundled game data stays held.** A package that bundles original game data
  keeps its listing download hold (see [acquisition restrictions](#acquisition-restrictions)). That covers ROM, disc or BIOS contents,
  original executables, copied ROM or cartridge headers, textures, models,
  audio, music, video, text tables or images extracted or captured from the
  game, art derived from them that the game uses, and shader caches, shader
  packs or shader recipes recorded from the game. Decompilation metadata such
  as symbol names and offsets is code, not game data; contents the player's
  original generates on first run are not bundled. A package whose contents
  are unknown stays held until they are listed.
- **Owner exceptions to the game-data hold.** On November 15, 2026 the owner
  made two narrow kinds of bundled game material recorded notes instead of
  holds. First, launcher or menu art that only the upstream's own front end
  shows when it is captured or derived from the game, such as posters made
  from screenshots or menu art made from a community texture pack. Images,
  textures, fonts or audio extracted unmodified from the game stay held, and
  so does art the recompiled game itself uses. Second, game data that its
  rights holder released for free redistribution, such as a freeware release
  or an official demo, when the package bundles it unmodified. Shareware
  episodes are not decided by this exception. Neither exception lifts an
  explicit prohibition in the material's own licence or the upstream's terms.
  Each listing names the material in its warning, and the player still
  supplies any full game separately.
- **Confirmed false positives.** When a person confirms that a
  [release-content scan](UPSTREAM-OBSERVATIONS.md#release-content-scan)
  finding is not game data, such as a homebrew test ROM, a reviewed entry in
  `.github/release-content-accounting.json` is the counterpart to a hold. It
  dismisses that exact package (port, platform, SHA-256 and scan rules version)
  with its reason and the reviewed issue or pull request, and a new package or
  rules version is reviewed again.
- **Listing downloads.** For a listing without a managed integration, or a platform its managed
  integration does not cover, tier 3
  also covers the ordinary listing download from the upstream's own releases.
  Its accepted identity is that release location, checked against the
  provider's published digest when there is one. Later releases stay offered
  unless one bundles game data outside the owner exceptions or a verified
  rights-holder request arrives; either restores the listing's download hold.
  Every migrated listing hold applies to every platform and release of the
  port, so a port keeps its hold while one platform's route, such as an
  existing non-owning integration, still needs a separate decision. A
  narrower scope is a later reviewed data change with exact evidence. The owner
  confirmed this on November 13, 2026. Core enforces one fresh route per host:
  it refuses the listing download (`managed-route`) only where this library's
  own Install assessment for the host is allowed or waiting for the player's
  game files. A held definition, an acquisition hold, pending setup or an
  existing registration leaves Install unusable, so the download stays offered.
  `catalog inspect-targets` reports the same refusal per target for a fresh
  library. Descriptive listing platforms never refuse
  a host, so a newly published upstream package stays reachable before the
  listing names it; registration still requires a native program. A
  `user-prepared` integration offers no Install, so its download stays
  available for preparing the reviewed copy. Registering an existing
  installation remains available either way.
- **Availability.** Tier 3 never copies or retains a package for others. When
  the upstream release disappears, moves or is withdrawn, Portcove stops
  offering fresh acquisition through the existing release resolution and
  upstream observation; installed copies and player data stay as they are.
- **Requests from upstream or rights holders** follow the route below; a
  verified request to stop future acquisition withdraws tier 3 for that scope.
- **Release content scan.** A hosted scan every six hours lists each listing's newest
  hinted release package per platform and flags game-data signals for review;
  a person confirms a finding before setting the hold. See
  [release content scan](UPSTREAM-OBSERVATIONS.md#release-content-scan).
- **Existing holds** stay in force until each is re-reviewed against this
  policy; the re-review is recorded in its owning issue or a dated evidence
  record, and the policy itself lifts no hold.

### Acquisition restrictions

Both carriers express a restriction as the same typed decision, which Core's
`acquisition_restriction` module evaluates once for Desktop and the CLI
([#8538](https://github.com/boburning/portcove/issues/8538)). The listing
authors `listing.restrictions`; a managed integration authors
`integration.acquisition_restrictions`. Authoring refuses the legacy
`download_block_reason` and `managed_acquisition_hold` keys; the generator
derives them.

Each decision has a slug `id`, an `effect` (`hold` or `permit`), a nonempty set
of `operations` and an optional `scope`. A listing names only `download`: its
legacy string can express nothing else, so a `register-external` or `launch`
decision would vanish for older readers until they have a format gate. An
integration names `download`, `install`, `update`, `adopt`, `activate` or
`prepare`. Removal, rollback and backup are
never restricted. The scope lists exact `platforms`, `releases`, `artifacts`
(version, lowercase SHA-256 and optional file name), source `inputs` and
`components`; an empty dimension is unconstrained. A listing scopes releases
or artifacts only with a `release_url` or download asset hints. No Core path
resolves inputs or components yet, so a permit cannot name them and a hold on
them applies wherever its other dimensions match.

A hold requires a descriptive `reason` code and a bounded player
`explanation`; a permit carries neither. `reason`, `reconsider_when` and
`tracking_issue` describe the decision and are never evaluated. The reason
codes are `bundled-game-data`, `upstream-owned-route`,
`package-facts-unresolved`, `legacy-rights-review`, `no-useful-route`,
`upstream-prohibition`, `safety-evidence-mismatch`,
`third-party-component-terms`, `known-defective-artifact` and
`upstream-transition-unreviewed`. Core reads an older untyped listing string as
a whole-listing download hold with the reader-only code `legacy-unclassified`;
authoring refuses that code.

Evaluation rules:

- Within one carrier the most specific matching decision wins: artifacts, then
  releases, then inputs or components, then platforms, then the whole port. A
  hold wins a tie.
- A hold from either carrier wins; a permit cancels only holds in its own
  carrier. A permit never overrides a trust, integrity, definition-eligibility
  or curated-revocation failure.
- A permit must share an operation with a hold in its carrier and cannot repeat
  that hold's scope, so data cannot grant by itself.
- A hold whose scoped identity can never be proven, such as the release package
  of an adopted folder, fails closed with Core's own explanation.
- An offer, such as a status view or the download options, may defer an
  identity Core resolves later: a hold that a more specific permit could still
  cancel does not withhold the offer. The final check before bytes are used,
  namely the downloaded package, the install artifact gate, activation and
  adoption, defers nothing: there a hold matches an unresolved dimension and a
  permit matches only known values. A provider-reported digest decides an
  offer only; the downloaded bytes decide the download.

Port action assessments report a held action as not offered, with its reason
code in `restriction`; listing action assessments are unchanged because the
listing carries only download decisions. The download offer drops a held
sibling asset and names it in its limitations. When every asset of the selected
release is held, the offer still lists the releases so a permitted package in
another release stays reachable; it is refused with the explanation only when
no release or package could be permitted.

Listing format 15 carries `restrictions`. In a format-15 document the legacy
`download_block_reason` must equal the explanation of the first hold that
names `download`, at any scope. An older reader treats that string as a hold on
every download, and the listing carries no other operation, so a reader limited
to format 14 is never less restricted than a capable one. Exports below format 15 omit `restrictions` and
keep that string. Signed listing delivery stays at format 11; a delivered
listing that repeats the current string for the same project and game keeps
the typed restrictions, and any other delivered value replaces them.

The managed wire format is unchanged. The generator emits typed integration
data as the existing `managed_acquisition_hold` and refuses typed data that
struct cannot represent exactly; Core normalizes the hold back to typed
decisions when it loads. A typed definition field is not yet deliverable: it
needs a reader gate that older applications refuse, which waits for the named
definition features of [#8496](https://github.com/boburning/portcove/pull/8496).

The one-shot `scripts/migrate-acquisition-restrictions.mts` re-expressed every
existing hold at the scope and operations Core enforced: 152 listing rows as a
whole-listing download hold with the explanation carried verbatim, and 5
managed holds in the canonical form below. It narrowed, cleared and reworded
nothing. Each narrowing is a later data change under the rights-basis decision
authority.

`reconsider_when` is never evaluated by Core. Run
`node scripts/restriction-recheck.mts` for a read-only report of each hold's
authored conditions. It reads committed catalog source, an optional listing
observer report (`--observations`) and an optional evidence file (`--evidence`)
of reviewed content scans, grants and route changes. It reports each condition
as `satisfied`, `not-satisfied`, `unknown` or `manual`. A hold with any manual
condition is flagged `manual`, for the owner, whatever its other conditions
say. Every manual hold, and every hold whose machine-checkable result is
satisfied or unknown, is listed by name under its flag. A successor release
counts only when it was published after the newest scoped release. When more
than one release is observed and any lacks a publication time, newest-release
checks are `unknown`, and missing evidence is `unknown`, never `satisfied`. It uses no
network, decides nothing and clears no hold. The [November 22, 2026 restriction evidence](evidence/acquisition-restriction-evidence-2026-11-22.md)
records the upstream facts and a proposed scoped decision for every migrated
row.

### Upstream listing and distribution requests

Upstream maintainers and rights holders can open a
[Portcove issue](https://github.com/boburning/portcove/issues/new?template=bug-report.yml)
to request a listing correction, delisting, or a stop to future acquisition.
Give the upstream project and Portcove listing or port ID, your relationship to
the project, a public reference that establishes that relationship, and the
affected releases, assets or routes. State the requested action and any
published upstream disposition. Keep private material out of the public issue
and use the [private security route](../SECURITY.md) for vulnerabilities.

Catalog maintainers acknowledge the request and verify identity, affected scope
and applicable distribution terms. They record the disposition and communicate
the affected listing visibility, future acquisition and installed behavior on
the request. Use the existing [listing and withdrawal owner #233](https://github.com/boburning/portcove/issues/233),
[exact-byte acquisition owner #315](https://github.com/boburning/portcove/issues/315),
[installed preservation owner #1306](https://github.com/boburning/portcove/issues/1306)
and [player-facing withdrawal status owner #4882](https://github.com/boburning/portcove/issues/4882)
for their respective changes.

Temporary upstream unavailability and metadata expiry follow their existing
availability and freshness rules. An authenticated revocation or confirmed
distribution withdrawal follows the applicable trust and acquisition rules.
Delisting addresses visibility. Previously installed use and exact-byte
retention remain subject to the applicable permission, trust and preservation
rules. Preserve player data through the existing lifecycle contract.

## Port-driven capability selection

Port integration is the product outcome for every console family. Use this
sequence on the canonical port issue:

1. **Discover:** identify the direct upstream, game, release and applicable platform.
2. **Evaluate:** select the most useful reasonable installation, preparation and launch route.
3. **Reuse:** prefer existing Core/adapters, official packages, supported upstream tools and safe non-owning existing-installation registration.
4. **Identify gaps:** name the exact unsupported operation and why existing or upstream routes do not suffice.
5. **Prioritize:** weigh known ports unlocked and expected player usefulness, reusable breadth, upstream tooling, implementation/testing complexity, maintenance cost, and source/security/rights/preservation risks.
6. **Implement when justified:** extend the existing Core or adapter owner. Small per-port integration changes are appropriate when no shared abstraction is justified; preserve one durable lifecycle authority.
7. **Integrate:** apply the capability to all genuinely fitting selected consumers. One shared change may justify a coherent multi-port batch.
8. **Validate and deliver:** prove the operations actually offered, preserve installed compatibility and safety, and reconcile canonical issues, catalog evidence and the live Project.

Record the short prioritization rationale with the selected consumers and missing
operation on the existing owner. Use existing Project Priority, Horizon, Target
release and Release commitment fields; do not add a score, adapter registry or
parallel backlog. Many useful consumers can justify shared work ahead of isolated
integrations; one immature consumer with a costly adapter can justify deferral.
An adapter is independently valuable only when it serves a demonstrated
integration need. Do not build universal console frameworks for hypothetical ports.

[#135](https://github.com/boburning/portcove/issues/135),
[#136](https://github.com/boburning/portcove/issues/136),
[#137](https://github.com/boburning/portcove/issues/137) and
[#138](https://github.com/boburning/portcove/issues/138) retain canonical technical
ownership for demonstrated PS1, NES/SNES/Genesis, GameCube/Wii and Xbox 360 gaps.
They are demand-driven dependencies of selected ports, not a separate mandatory
implementation campaign. A port need not wait for a whole-family adapter;
consume the smallest proven component or a fitting existing route. Broader
manifest/build/configuration/container/lifecycle work uses the same owner when
real consumers justify it. Planned does not commit every speculative enhancement.

Ongoing port adoption, investigation and maintenance use
[#2510](https://github.com/boburning/portcove/issues/2510),
[#2926](https://github.com/boburning/portcove/issues/2926) and canonical port issues.
Use the [Project selection rules](PROJECT-GOVERNANCE.md#selecting-approved-work)
across the entire backlog. Demand-driven adapter work and port delivery proceed
independently of beta acceptance. Protected delivery retains its existing owners.

[#1422](https://github.com/boburning/portcove/issues/1422) preserves its historical
317 rows / 316 canonical identities, duplicate mapping, accepted routes and prior
deferrals. For an unavailable route, retain discoverability and record the exact
missing capability, rejected existing/upstream alternatives, source/rights/
ownership/safety restrictions, any still-usable operations and reconsideration
condition. Deferral is not delivery; listing is not Supported. Never delay or
downgrade a working route because another title in the family needs new machinery.
Later discoveries retain continuous intake; the existing daily investigation's
approved metadata/intake scope and scheduling remain unchanged.

## Managed native portable packages

The `native-portable` adapter offers the existing managed installation, update,
retained-version, backup and recovery lifecycle to fitting upstream archives.
For ordinary GitHub discovery, releases containing only explicit other-OS
players are outside that platform's stream. PortMaster packages target handheld
Linux firmware and count as another platform's players on every desktop
platform, so a PortMaster-only release never enters a desktop stream. Same-OS, unknown or mixed package
names still use the normal variant, processor and integrity refusals; source-only
releases never silently select an older runtime. Curated identities retain their
existing exact selection.
It does not need a game-specific adapter. Setup provider and runtime update owner
are independent: the game can ask for original files on first launch while
Portcove continues to replace its runtime. A launcher that replaces its own
runtime instead uses the non-owning existing-installation route, unless the
updater switch described below qualifies it.

Verify that the selected process stays alive through edition dispatch and
settings-triggered restarts, or uses a supported tracked handoff. A launcher that
starts a successor and exits can end Core's supervision while the game still
uses its files. Keep that upstream-owned route non-owning until its full lifetime
can be tracked; bypassing useful setup or settings is not a management fix.

An upstream player with its own updater can take a managed route only when
upstream provides a switch that removes every update path, meaning the startup
check, manual checks and installing a download, and the route passes that
switch through `launch_arguments` or `launch_environment`. Record dated source
evidence that the switch reaches each update entry point. A switch that only
skips the startup check, such as an offline flag that leaves a manual check or
an install button available, does not qualify; the route stays non-owning. The
evidence is bound to the reviewed release: the route follows later releases by
its asset hints and reviewed layout, which do not check the switch, so re-check
it whenever a new release is reviewed. If a release dropped the switch, Core's
immutable verification would hold the changed installation. The rule covers
upstream's own update paths, not mods the player installs, and starting the
managed program directly outside Portcove runs without the switch. That includes
a launch the operating system starts for the player, such as an invite link the
game registered; the guide tells players to close such a session before updating.
A check that only reports a newer release or opens its page, and never downloads,
stages or installs anything, is not an update path under this rule.
MediEvilRecomp's `--disable-updated`, which upstream provides for an external
manager, is the first such route
([MediEvilRecomp qualification](qualification/medievilrecomp-updater-switch-2026-11-15.md)).
OpenCE's `HALO_UPDATE_AUTO=false` and `HALO_SERVER_AUTO_UPDATE=off` environment
values close its game and dedicated-server updaters
([OpenCE qualification](qualification/opence-updater-switch-2026-11-16.md)).

The supported tracked handoff is a reviewed Windows opt-in. A definition that
declares `windows_tracked_handoff: true` must offer Windows with a native `.exe`
launch; batch launchers are refused. Without it, the original process is the
whole session on every platform. With it, Core starts the Windows game inside
its launch session's job object, and the session stays running after the
original exits while any job process whose program lies inside the
installation (the managed install or the registered external folder) still
runs. The session record names those programs; Desktop does not show them
yet, and `launch show --technical-details` does. Delivered definitions must
require [native capability 28](DEFINITION-DELIVERY.md), or 35 for Snap64. A successor the game
starts from its own process tree, such as a `_wexecv` restart from a menu action, is tracked. A browser, Steam client,
editor or other program outside the installation never holds the session, even
when the game started it. A child created with explicit job breakaway, or a
program started outside the tree through the shell, a service, a scheduled task
or an already running instance, is not tracked. A separate Portcove process holds a query handle for the session's job. If
the supervisor exits, the keeper waits for the same in-install processes and
recovers the session after they exit. A missing job or ambiguous spawning
record requires manual review. Qualify a route whose successor
escapes these rules as non-owning, or require the original process to stay
alive. On Linux and macOS an exec-based restart keeps the process ID, but a
launcher that spawns a successor and exits is untracked there, so such a route
stays non-owning on those platforms.

Yakumo's official Windows ZIP is the first reviewed opt-in. Its menu restarts
use `_wexecv` on its own executable, so the successor stays in the job and
inside the installation. Its shipped `portable.txt` keeps settings, saves and
the prepared game in the declared `data` folder. Prepared copies keep their
non-owning registration, which does not track successors.
[Yakumo qualification](qualification/yakumo-tracked-handoff-2026-11-12.md).

Snowboard Kids: Recompiled by cdlewis also opts in on Windows. After a failed
start, choosing the other region's ROM relaunches the same executable with
`CreateProcessW`, and its in-install crashpad handler exits with the game.
[Snowboard Kids qualification](qualification/snowboardkids-cdlewis-tracked-handoff-2026-11-15.md).

The Mercenaries 2 native beta opts in on Windows. Quitting to the main menu or
loading a save starts the same executable again with Rust's `Command::spawn`
and closes the original.
[Mercenaries 2 qualification](qualification/mercenaries2-tracked-handoff-2026-11-15.md).

After Burner Climax (darkuni Recomp) opts in on Windows. For the World release,
`after_burner_climax.exe` starts its sibling `after_burner_climax_world.exe` with
`CreateProcessW` and exits.
[After Burner Climax qualification](qualification/afterburner-climax-tracked-handoff-2026-11-16.md).

Shantae Recomp (vibecodekun) opts in on Windows. Return to Launcher starts the
same executable again with `CreateProcessW` from an exit hook, and its shader
preset check runs a hidden helper copy of the same program that the game stops
before it exits.
[Shantae qualification](qualification/shantae-recomp-tracked-handoff-2026-11-16.md).

Adding this route does not adopt an existing external registration. Players can
review a separate managed copy while keeping the current copy usable. Core can
switch a fitting fresh native-portable route after verified separate publication;
the external files stay untouched and external saves are not copied. Retain
owner-neutral listing instructions, including upstream profile locations, and
put managed preservation promises only in integration presentation. A shared
upstream profile may still be read on the next explicit Play. A saved Core data
store or richer preparation/account contract requires its own compatible
transition rather than guessing at migration or rewriting retained definitions.

When complete game and engine-only packages cannot be distinguished by stable
literal hints, an exact `direct-manifest` archive can use this same adapter.
The existing Direct contract requires one Stable version/URL/size/SHA-256 per
declared platform; it does not discover newer upstream versions. The native
route still rejects installers, raw executables, custom build/setup commands,
mutable runtimes and downstream source preparation. A pin does not inherit
another artifact's qualification. A later reviewed catalog pin remains a new
artifact/compatibility decision, and runtime rollback does not rewind external
profiles or certify their older-version compatibility.

Native template version 3 represents exact archive pins. Version 4 additionally
consumes `windows_runtime_path_policy: relative-file-max-path` for Windows-only
native archives. Core checks every authenticated immutable package member and
the selected executable/working directory at their final coordinates before
publication and before launch or retained-data synchronization. Recovery,
adoption, relocation and library import repeat the applicable destination check.
The conservative envelope counts Windows UTF-16 units, the terminating NUL and
the runtime's `.\` relative spelling within MAX_PATH; it imposes no ASCII-only
rule. A shorter executable alone does not establish fitting data-file paths.
Choose a shorter output folder when held. This is a supported coordinate
envelope, not a general Windows long-path fix or a claim about the exact upstream
failure threshold. External profiles and arbitrary future save filenames are
outside the immutable-package check. New and retained independent entries using
this policy require Native4; Direct-only Native3 retains its meaning.

Libultraship template version 2 consumes the same `relative-file-max-path`
policy for archives with Windows support, including multi-platform definitions.
The checks apply only on Windows and include every immutable package member:
2Ship's extractor reads asset XML files whose paths can exceed MAX_PATH even
when its executable path fits. Setup refuses those coordinates with the existing
shorter-output guidance before publishing the installation. Retained contracts
carry the same destination checks through launch, relocation and library import;
adding a current policy does not rewrite older retained contracts. Linux and
macOS behavior, source admission, persistence and upstream extraction ownership
remain unchanged. Independent definitions declaring this policy must require
`libultraship-portable` version 2; version 1 remains available for definitions
without it. A fitting path does not prove successful extraction or rendering.

Native5 additionally supports `windows_temp_directory` for Windows-only native
archives using `relative-file-max-path`. Its value is one safe ASCII basename,
at most 64 bytes, declared exactly once in `persistent_paths` and separate from
other data namespaces. The publisher archive must leave that directory absent.
Core creates or validates it during existing locked launch preparation and
rechecks its namespace, case and redirect safety immediately before spawning.
Read-only launch inspection never creates it.

Core derives relative `TEMP` and `TMP` values from that field. Review the
upstream working-directory behavior before using it: the process and any
launched player must preserve the reviewed directory. The relative basename
keeps temporary filenames relative even when the installation path has Unicode.
Temporary bytes belong to the existing entry data scope, including backup,
retained-version and removal preservation; no independent cleanup deletes them.
Field additions, removals or coordinate changes do not rewrite an installed
contract. Authored `TEMP`, `TMP` and reviewed host-session overrides remain
rejected. Renderer hints remain reviewed host-session configuration.

Without an active creating contract, fresh installation refuses an existing
canonical temporary namespace, including an empty directory or files preserved after removal. Those
bytes stay held for a reviewed transition; their presence cannot establish the
new runtime interpretation. Normal active Native5 maintenance retains the exact
field and existing data authority.

Fresh and retained indexed entries declaring the field require minimum Native5;
a range whose lower bound is Native4 cannot authorize the new behavior. Earlier
definitions omit the field and retain Native1–4 semantics. Complete retained
projection continues to refuse unknown or discarded fields in older readers.

Native6 supports verified original-file preparation through the existing
`source_profile` and `runtime_source_set` fields. This opt-in accepts complete
schema-2 FileSet variants with cryptographic member identities, one enforced game
source contract covering those variants, and Copy targets only. Original outputs
are immutable and reserve their first path component apart from mutable
profile/TEMP paths and filename patterns. Manual
setup markers, conversion, installers and per-title initialization do not establish
this completion. No production title is admitted by the generic capability.

The existing SourceOnly planner, authorization, private staging, receipt, manifest
and publisher own preparation. Fresh packages must leave every original output
and sidecar vacant, including case aliases. Core resolves the package executable
and derives its exact parent directory; a wrapper does not move the outer
installation manifest or preparation receipts. Copied files are hashed against
the admitted complete source set, and original inputs are checked again before
publication and registration. The source and complete typed source contract are
bound to the existing receipt. Launch never repairs or recopies sealed originals.

Reviewed preparation can copy a verified installation into a new private payload.
Unrecorded or altered immutable inputs refuse preparation. A prepared installation
cannot silently rebind to another original edition, source registration or member
mapping; maintenance and retained activation compare their creating contracts and
sealed source receipts. Unapproved populated adoption and persistence changes stay
held. Preserving removal retains declared profile data and leaves external
originals unchanged. Native1–5 definitions and older SourceOnly interpretations
retain their existing semantics. Fresh and retained indexed entries with native
source profiles require a Native6 lower bound. Native capability 37
also admits complete exact relative-file sets with SHA-256-bound Copy targets.
Each observed relative path must map to a unique runtime destination. Preparation
uses private staging beside the resolved player and retains the Native6 output
ownership and publication checks. The relative-file-set verifier determines
whether the original can be a ZIP or must be an installed folder.

Use an official ZIP, tar.gz or tgz with an independently expected SHA-256,
reviewed native package and executable hints, and a small declared persistence
contract. A Linux x86-64 GitHub package can instead declare `release.linux_tar_xz`
and a required Linux TAR.XZ asset hint. That route accepts only matching TAR.XZ
players and uses the same bounded reader as downloaded setup. Independent
definitions require NativePortable capability 8 for this declaration.

NativePortable capability 40 allows a reviewed flat Linux x86-64 TAR.XZ
runtime to declare its immutable sibling `linux_packaged_library`. Core
requires the native player and library in the archive before publication.
The retained managed launch verifies the installed library and binds the
loader to a private directory containing that verified library before starting the ELF
directly. Declared originals and the managed profile stay in their own
subdirectories. The Linux declaration leaves the Windows launch unchanged
and requires a separate review before replacing an existing AppImage.
Retained format 11 carries the loader rule through source-only preparation.
Embedded Windows installations retain the Windows package route using
the existing format.

NativePortable capability 41 admits the `daggerfall-unity-data` mod loader
binding. A definition that declares it must require capability 41 or later.
Older readers cannot interpret its reviewed artifacts, payload digests and
repository ID. [Native mod loader bindings](DEFINITION-DELIVERY.md#native-mod-loader-bindings)
owns the binding contract.

NativePortable capability 26 adds checked Mac TAR.XZ app bundles through
`release.tar_xz_platforms`. Each declared Mac route needs its own mandatory
GitHub archive hints, a single exact `.app/Contents/MacOS/` executable and a
reviewed package layout. Core accepts the bundle directly or in one outer
wrapper, refuses archive links, and checks the selected Mach-O architecture.
Launch and declared player data use the installed folder beside the app.
Windows and Linux routes keep their creating working-directory contracts.

Native portable capability 27 covers the stable OpenOMF Linux x86-64
AppImage through `openomf-linux-v1`. Core checks the provider asset and keeps
the AppImage intact under one stable executable name. The Linux launch checks
the temporary mount and the actual OpenOMF configuration and state writers
outside the managed library. It preserves the SDL preference fallback and
checks only the OpenOMF leaves under explicit XDG roots. Paths must fit
the player's fixed buffer, including the mount and generated filenames. Custom OpenOMF
overrides or alternate resource sets use a separate prepared copy.
The Windows route keeps its existing package and profile contract.

Native portable capability 10 supports official sibling packages on an
original-bound Native6 definition with `windows_temp_directory`. Every platform
keeps the same verified original-file mapping and private profile namespace.
Core reserves, creates and rechecks that namespace on the selected host.
Only Windows applies the relative-path policy and sets the child’s
`TEMP` and `TMP`. Sibling launches use the definition’s fixed arguments.
An x86-64 Linux sibling may select one complete standalone AppImage by its
exact asset basename and executable hint. It uses the existing AppImage
installation path and the same retained original and profile checks.

Native portable capability 11 covers the official universal OpenRCT2 Mac
bundle. The retained Mac executable is `OpenRCT2.app/Contents/MacOS/OpenRCT2`.
Its fixed launch keeps the full bundle and uses the real account’s home for
the external OpenRCT2 profile. Core requires an absolute account home and
checks the effective profile for runtime overlap and unsafe aliases. Player
data and original game files stay external. Existing Windows and Linux launches
keep their separate behavior.

Native portable capability 12 adds the direct Linux x86-64 AppImage for
recompiled players with the reviewed `recomp-appimage-v1` layout. Its matching
Windows executable and declared title data fallback retain their existing
contract. Core matches the title prefix, version and exact package suffix,
binds the provider artifact, and retains the complete AppImage under a stable
executable name. Linux launches with the package’s ordinary arguments and
the player’s external configuration and launcher state.

Before launch, Core checks effective configuration, state and temporary paths
against the managed library and registered output roots. Adjacent AppImage
`.home` and `.config` folders require a separate player-managed copy. Core
reserves the launcher’s predictable log fallback under sticky system `/tmp`
and preserves safe existing user-owned contents. The original ROM and the
Linux profile remain the player’s files.

Native portable capability 13 covers the official OpenMoHAA Linux x86-64
and universal Mac ZIPs. The three titles retain separate launcher and
original-data mappings. Core verifies the exact root launcher, engine and
companions, then enables execution for the selected launcher and its engine
before recording the installed package. The upstream launcher replaces its
own process with the engine. Existing Windows and external registrations keep
their respective runtime and data owners.

The Unix managed launch uses the archive root and checks the upstream-selected
profile before starting the launcher. Linux uses HOME, or the effective
XDG_DATA_HOME under a nonempty FLATPAK_ID. Mac uses inherited HOME. Relative
or overlapping profiles require a separate player-managed copy. Portcove
preserves the declared original-data directories and leaves the shared
external profile with the player.

Native portable capability 15 covers the official Ironwail Linux x86-64
TAR.GZ and vkQuake Linux x86-64 AppImage. The two titles retain their
Windows launch and data declarations. The fixed classic Quake launch uses
the player's managed `id1` data. On Linux, Ironwail uses the account-based
external game profile, with HOME as a fallback. Portcove checks this profile
outside the library and leaves it with the player.

Ironwail requires its `ironwail.pak` beside the engine. vkQuake keeps the
provider-bound AppImage intact and checks its mount directory and adjacent
portable profile locations before launch. vkQuake uses the managed working
folder for saves and settings. The fixed data path avoids the upstream
store picker, and `-userdir .` keeps the same directory when a compatible
build enables account-based user directories.

Native portable capability 16 covers the official CorsixTH and OpenLoco
Linux x86-64 AppImages and the OpenLoco Apple Silicon ZIP. The Linux routes
check the AppImage mount and adjacent portable profile locations. The
OpenLoco Mac route keeps the whole bundle and checks its account profile.
The guarded profiles stay outside the managed library. CorsixTH uses
its defined XDG_CONFIG_HOME or inherited HOME. OpenLoco uses a nonempty
XDG_CONFIG_HOME on Linux, with the account home as the ordinary fallback.
Managed CorsixTH gives its Windows and Linux player the neutral name
`PLAYER` for the upstream blank-name fallback. It leaves the name already
stored in the player's external profile to CorsixTH. This `PLAYER` value is a
separate title-bound launch behavior, not part of the external-profile policy:
an equivalent definition under another identity keeps the profile guard but not
the name. It cannot move to the definition's `launch_environment` because
external-profile policies forbid launch environment, so moving it to data needs
a catalog contract change.

The managed offer covers the normal external profiles. Custom save,
landscape, campaign and other locations stay with separately prepared
copies. Keep those locations outside the library. The managed runtime
inventory holds updates, switches and removal if unrecognized programs appear.
Windows creating contracts retain their previous rules.

Native portable capability 17 covers the generic JGR Patch Pack Linux
x86-64 TAR.XZ and the OpenGlad Apple silicon ZIP. JGR reuses archive file
link extraction and launches with its default XDG configuration and
data roots. The guard holds a portable configuration or native social
plugin in a searched directory. OpenGlad launches the packaged player
beside its assets and uses the default HOME/.openglad profile.
Use a separately prepared copy for OpenGlad's custom profile override or
a custom Unix library search path. Existing platform contracts keep their
creating definitions.

NativePortable capability 39 covers the official Endless Sky Windows x64 ZIP and
Linux x64 standalone AppImage. The release selectors accept the publisher’s
portable package names and retain the provider artifact identity. Launch uses
the normal SDL roaming profile on Windows or the Linux data directory from
`XDG_DATA_HOME` or `HOME/.local/share`. Core checks that player data stays
outside the library and registered output roots. The Linux AppImage also
requires an independent temporary mount location and a clean executable
directory without an adjacent portable profile. Portcove manages the runtime.
Players retain and back up their pilots, settings and plugins separately.
The universal Mac disk image remains an upstream package.

Surge the Rabbit uses the publisher’s Windows portable ZIP. The selected
32-bit player runs on the Windows x64 host route with the bundled game data.
Portcove sets `OPENSURGE_USER_PATH` to the existing per-title data directory.
On Windows, any native portable definition that declares this environment
refuses a non-ASCII data directory, because the player reads it through the
narrow CRT environment; the declared environment, not the title identity,
selects that check.
The normal launch uses the bundled game and its separate writable data directory.
Native portable definitions with a managed userdata environment use their
declared arguments, since an alternate game-folder argument can change the
runtime’s write destination. The engine can reopen a project in the same process.
Separately opened project folders retain their own files and backup ownership.

The `external_profile_policy` declaration requires NativePortable capability 9 or
the higher version specified for the selected layout.
A policy is bound to the authenticated definition that satisfies its structural
layout (adapter, permitted platforms, launch and data constraints, and the
exact upstream package and executable shape its validator requires), not to a
compiled list of port identities. Every delivered definition is already signed
individually: its delivery binds the exact definition bytes (`definition_sha256`)
and, for a managed GitHub subject, the numeric `repository_id`. The Dune Dynasty
and fheroes2 policies have no package-shape validator, so they keep their
reviewed identity and repository pins until the maintainers decide whether that
per-definition signature is a sufficient binding or add a package-shape
validator for them.
It checks the effective profile selected by the final managed game environment
before the player starts. The reviewed Dune Dynasty policy follows Allegro's
Windows roaming folder and Linux HOME-relative XDG selection. It refuses a
portable config in the managed runtime. The fheroes2 policy follows the
standalone player's Windows HOME/APPDATA, Linux XDG/HOME, or Intel Mac HOME
selection. Profile roots must resolve outside managed runtime locations. A
bounded metadata check holds profiles with nested symbolic links, reparse
points, or hard-linked files. Dune Dynasty paths must also fit the upstream
player’s fixed buffers.
Portcove leaves those profiles and original files under their existing owner.
The same check applies to the matching older managed Windows layout without
rewriting its creating manifest.
Use an independently prepared copy for portable or otherwise ambiguous profiles.
For example, the CorsixTH and SDL Sopwith records use the shared route
without game-specific Rust or React code. The minimum integration shape is:

```json
{
  "support_tier": "beta",
  "channels": ["stable"],
  "platforms": ["windows-x86-64"],
  "adapter": "native-portable",
  "release": {
    "repository": "owner/project",
    "asset_hints": { "windows-x86-64": ["windows", "x64", ".zip"] }
  },
  "executable_hints": { "windows-x86-64": ["Game.exe"] },
  "persistent_paths": ["saves", "settings.ini", "game-data"]
}
```

These are reviewed facts, not an invitation to copy those paths to every game.
Trace save and settings writes during the first setup session as well as after
restart. Choosing a game-data folder does not prove that the running process
also changed its save folder; preserve every actual managed write coordinate
before promising updates or backup. Keep a useful upstream-owned route when
that coordinate requires upstream repair or supported preparation.
For ordinary captures written beside the executable, reuse reviewed
`persistent_file_patterns` with literal filename prefixes and suffixes. These
files remain player data through collection, backup, replacement and rollback;
do not exempt them as disposable runtime output or widen ownership to unrelated
files. A save-directory argument alone does not prove that capture writers use it.

For manual preparation that must finish before Play, `native-portable` may
declare a `setup_marker` pointing to an upstream completion JSON record beneath
an already declared persistent directory. Establish that upstream removes the
record before starting and publishes it atomically after successful preparation.
Core reads one bounded, single-link regular JSON object relative to the retained
runtime working directory; it does not execute a helper or certify the original
edition, data format or game content from that record. The upstream runtime keeps
those checks. Missing, unreadable, malformed or oversized records keep Finish
setup available and block launch. Native template capability 2 is required.
A reviewed marker may be added under unchanged existing player-data coordinates
for a new runtime; it never rewrites an installed contract. Changing or removing
an existing marker needs a supported transition. First-Play file pickers remain
Play and need no artificial completion marker.

When an active installation exists, activation checks the destination's actual
retained data contract, including artifact reuse, interrupted install publication
and pending activation recovery. Native portable publication recovery collects
current player data and restores it before committing activation, just as the
normal staged route does; this adds no restore-receipt requirement to native ports.
Today's recommended definition cannot authorize an incompatible retained target.
A failed pre-commit check preserves the active version and all player data;
already committed recovery finishes with the authoritative committed version.
Reuse, normal staged activation and both recovery routes share the existing
`prepare_retained_install_data` preflight. Their callers retain distinct admission,
publication, journal and commit boundaries. Rollback retains its stricter
directional compatibility check.

Assess preparation separately on each platform. A Windows first-Play picker
does not establish a Linux picker or a manual completion record. Keep a useful
upstream setup/non-owning route for a platform whose preparation cannot be
represented by the existing contract; never fabricate a marker. Managed-platform
badges describe the definition's managed scope, so record separately supported
external handoffs and their presentation limits explicitly. Application wrappers
that seed data or set required environment values must retain their supported
entry point; selecting a private native binary is not an equivalent handoff.

For mutable release tags, keep the tag commit, current source head and any
publisher-declared package build commit separate. A checksummed build manifest
is a publisher source claim, not an independent reproducible-build attestation.
Use Core's channel classification rather than a provider's prerelease flag alone;
a tag such as `v0.3-dutch-preview-1` selects Preview even when that flag is unset.
Preparation feedback retains the raw observed tag and provider flag as advice; it
does not classify a stream or override the player's saved choice.

Every package hint must match for managed replacement; the shared native
suitability check still rejects known foreign processors, platforms, supporting
files and equally plausible variants. The existing channel and artifact-integrity
rules remain in force. A missing digest can allow an explicitly unverified
non-owning download, but cannot authenticate a managed installation.
Generic downloaded setup offers optional checked ZIP, tar.gz/tgz, tar.xz and
bounded 7z extraction into a new user-owned folder. The
[archive boundary](ARCHITECTURE.md#discovery-listings-and-user-owned-setup) owns
the supported codecs, framing and resource limits. Managed package selection
retains its separate reader-capability and per-title admission rules.

Review the actual linked or vendored components and their attributable grants,
including packaged fonts, and record what they are. A parent's license, a
published archive or resemblance to another project does not settle a separately
authored component's permission; under the
[rights basis](#rights-basis-for-upstream-hosted-packages) an unresolved
component grant is a recorded note, not an acquisition hold. Retain a named
acquisition condition at its exact operation scope. When fresh
self-service acquisition is held, the authored listing can set
a `download` hold in `listing.restrictions` with a bounded practical explanation
and reconsideration condition. Core refuses download options, preview and
mutation before contacting the provider, except for an asset a scoped permit
names, which is checked again on its downloaded bytes. This restriction grants no
permission to acquire, register or execute an existing copy and does not rewrite
its retained contract. Keep useful existing permitted-copy instructions and
upstream links. Remove a restriction only after reviewing the changed fact.
Preparation refuses replacement records that remove or change an existing
restriction; resolve its canonical condition in a reviewed Git-authored edit.
A restricted authored listing may retain a non-owning `user-prepared` integration
for reviewing an independently permitted copy. Managed integrations continue to
own acquisition eligibility through their strict definitions. Package observations,
release links, hints and artwork enrichment do not resolve either condition.

For an upstream-owned route, optional listing `download_asset_hints` maps a host
platform to one through eight bounded, case-insensitive literal filename fragments.
An authored `listing_inherit_asset_hints` array can reuse the same record's reviewed
GitHub selectors for named managed platforms, provided the public project and
release scope and selected channel agree. Keep literal overrides for distinct
upstream packages and additional descriptive platforms. An explicit empty
`download_asset_hints` map suppresses inheritance. This projection only supplies
descriptive selectors.
Optional `recommended_download_channel` selects `stable` or `beta` for the initial
download lookup, for example when the reviewed player is published as a preview.
A player's explicit saved channel or release takes precedence. For a genuinely
fresh `native-portable` installation, Core also uses this hint when the managed
definition declares that channel. Settings, retained or staged installs, external
registrations and pending downloaded setup keep their existing fallback and
choices. Destination/policy changes and accepted install intent preserve the
chosen channel durably; read-only discovery never creates settings. This hint
does not change an installed channel, version pin or update policy.
Core uses all fragments together to recommend the reviewed player package or
upstream installer. Prefer stable discriminators instead of a version string;
retain a choice when incompatible variants are equally plausible. Operational
release hints take precedence. `prepare-port` reports complete/partial selected
asset coverage and competing literal matches as `download_preparation` feedback.
This is advisory selection, compatible with descriptive listing format 1: it
grants no authenticity, invocation or managed operation. Core still binds current
release/asset IDs, destination and extraction in the download preview. A reviewed
player ZIP named `debug` needs an explicit whole-filename hint; generic project
or platform fragments do not override its exclusion. Symbols, source,
checksum files, foreign platforms and processor mismatches remain excluded from
recommendations. Explain the actual upstream setup and its update/data owner in
the authored guide; downloading an installer never runs it.

An extensionless native Linux executable can be recommended as a direct file
when the reviewed hint names the entire asset and its filename identifies Linux.
The existing processor checks still apply. Keep the author's setup instructions
for making the file executable and preparing original game files.

A ready native archive with reviewed disposable runtime writes may instead fit
the existing `staged-source-portable` adapter; it does not require a source
profile or build step. A ready archive may also receive one explicitly declared
verified raw-file `copy`, with its exact destination declared persistent. This
does not include extraction, generation, BIOS or helper preparation. Establish
its actual executable-relative working directory,
declare player data separately from disposable caches and diagnostics, and keep
new package defaults version-owned. MC2 is an example: local settings/custom
multiplayer data persist, while generated texture/geometry caches stay with each
version. This is not permission to exempt arbitrary data folders or executable
outputs. Review interrupted temporary writes and packaged script callers too.
External user-profile saves remain outside backup ownership. Use
`external-user-owned` saved-data presentation when normal saves are external,
and explain any separately managed local settings in the authored instructions.
The shared installation review surfaces that limit for every managed adapter;
external registration must retain its ownership-neutral guide.
Ready staged archives require capability version 23 for independent definition
delivery. Core stages their installation before restoring declared data and
activating. Data added before first Play participates in backup, update and
rollback. A retained runtime without proof of completed Core data restoration
uses conservative additive collection: canonical-only data survives and differing
copies require a deliberate resolution. Existing source/build integrations keep
their preparation and collection contracts.

A ready staged archive whose reviewed mod layout is
`mods/packages/<id>/<version>` may opt into
`mod_package_policy: "versioned-packages-v1"` with the exact `mods` persistent
root. This requires capability 24, a format-7 retained contract and runtime-local
data. Direct-write `user_data_environment` bindings are refused because they bypass
package restoration. Core reuses the existing complete-package coexistence
behavior: absent versions are staged
privately and published without overwriting, successor-only packages survive,
and same-ID/version content conflicts report both paths before activation or
explicit data restore. Package identity compares contents rather than publisher
timestamps; current root state keeps its replacement/deletion behavior. Preserve
the player's choices without rebasing them onto a new default. This policy does
not authenticate mod code, promise compatibility, or preserve generated executable
caches. An old contract merely declaring `mods` does not acquire these semantics;
changing the policy holds replacement until a supported transition exists.

Declared data copies preserve exact file modification times, including upstream
original-data integrity records that depend on them. New backups verify those
times separately from content; old byte-only snapshots retain their historical
limits. New ready archives retain a format-6 contract so older programs cannot
apply timestamp-losing behavior to them. See [definition compatibility](DEFINITION-DELIVERY.md#implemented-engine-capability-negotiation).

An explicitly hinted Win32 player can be recommended on a Windows x64 host;
[Windows supplies WOW64 for x86 applications](https://learn.microsoft.com/en-us/windows/win32/winprog64/running-32-bit-applications).
This does not establish game-specific dependencies, gameplay, or other processor
compatibility. Supply the accurate `original_game_title` where the listing name
also contains the engine/project name so bounded launch suggestions can identify
the game among unrelated converters; equally plausible targets still require a choice.
Portable preparation reports a missing original game title alongside package
feedback. Use the canonical game identity; a helper name is not a substitute.
For listing-only downloads, a unique native player whose basename exactly matches
the upstream project name can also be recommended. Raw packages, supporting
programs, incomplete searches and ambiguous matches still require manual setup
or a choice. Suggestions remain read-only; registration and Play stay explicit.

Persistent paths are relative to the executable's directory, or the install root
when `launch_from_install_root` is declared. Declare only compatible original
inputs, generated data, saves, settings and supported mods that should reach
replacement versions. Outside data remains upstream/player-owned and outside
Portcove backups. Describe setup and this limit in `presentation`; optional unknown
gameplay evidence does not hide the listing or prevent a separately safe operation.

Literal launch arguments and environment values also belong to that coordinate
contract. A native portable replacement refuses changes to either, even when the
declared data paths stay the same: changing `--data-dir` or a data-location
environment variable cannot silently redirect a retained installation. A supported
transition must establish compatibility before changing these execution facts.

To promote a reviewed listing to a managed native-portable route, run
`node scripts/promote-listing.mts --port ID --archive PLATFORM=PATH --executable
PLATFORM=NAME --preparation TEXT` with the official archive you verified. It records
Core's inspected layout and the listing's asset hints in a new `integration`, leaves
the listing only its unmanaged platforms, inserts the ID into the sorted legacy
additions fixture, flips the port's download test to the managed route, drops the
superseded listing-only player test, formats the edits and regenerates the catalog.
Pass the publisher digest with `--sha256 PLATFORM=HEX`; without it Core only checks
the local hash and the command says so. Kept paths (`--persistent`) require an
explicit `--saves` choice, and a listing without `original_game_title` needs
`--original-game-title`. `--repository`, `--channel`, `--env` and repeated
`--launch-arg` values (written in order) cover the other declarations. It refuses
a listing whose restrictions still hold `download`, or whose summary names a
structured fact such as the release channel, before writing anything. It needs a built CLI (`--cli` or `PORTCOVE_CLI`, default
`target/debug/portcove`), and each managed platform needs an archive that the host
can inspect, so a Windows host promotes only Windows. The guide, rights warnings,
provider digest, write locations and process lifetime remain the author's review.

Put the actual next game-setup step first in the authored manual guide: original
files the game will request, a required manual preparation, or an explicit statement
that the package is ready for Play. Avoid a redundant first step telling the player
to install. Put the managed step in the integration's guide when it belongs
in the managed installation review. The full guide is available in Files even
when Core needs no source profile. Listing guides also survive as saved-download
handoffs after a definition disappears. Spell out any external launch arguments
in the upstream guide and put managed retention, backup and replacement details
in the integration's
`presentation.manual_preparation`, which Desktop scopes to managed ownership.
An empty Core
input requirement describes Portcove's action; it does not assert that the upstream
game never needs original files.

Follow the selected fork's actual setup route. An Android APK belongs to Android's
package manager and upstream app; a desktop parent's archive, converter, save path
or native plugin is not its contract. Describe the app's own original-file picker
or on-device preparation, actual profile location/export controls and meaningful
update limits. A signing-key change that requires reinstall needs concrete data
preservation instructions before uninstall. Keep source/artifact version conflicts
explicitly unresolved rather than importing another build's inputs or save promises.

Reference catalogs such as [Quiver](https://github.com/tgeorgiadis/quiver-launcher)
can expose useful asset filters, preferred executables, required files and simpler
upstream alternatives. Join by the exact implementation and reviewed lineage, then
verify those hints against the selected upstream source and package. An empty
required-files list does not establish an empty persistence contract; a portable
marker can change storage behavior and needs its own upstream evidence. Keep
distinct games sharing a repository separate. A reference catalog's release,
checksum, scanner or verification label is not Portcove admission or qualification.

Native portable runtimes use complete immutable-file verification. Changed or
missing package files, links, and undeclared code (programs, scripts, libraries,
plugins, files with an executable signature, and any addition under an Electron
package's `resources` folder) block
launch, update, version switching, managed removal and backup with the current
files preserved. The player can back up and relocate them or retain an external
installation. Other undeclared regular files, such as settings a game writes
beside itself, are unknown player-side files ([#5359](https://github.com/boburning/portcove/issues/5359)).
They do not block those operations, and only a reviewed loader-read name
beside the executable, such as `dinput8.ini`, `ReShade.ini`, `dxvk.conf` or
`Game.exe.config`, blocks launch. Verification and the removal review list them,
backups keep a separate copy that restore does not put back, and removal backs
them up first. They are not declared player data and are not collected as such;
harmless ones are carried to the version that becomes active under the
[Tier 2 contract](ARCHITECTURE.md#unknown-player-side-files). Past the unknown-file caps only a backup or removal is held;
see the [architecture contract](ARCHITECTURE.md#unknown-player-side-files).
Updates extract into a new version, collect
declared data from the active version even before its first launch, restore it to
the staged version, revalidate, then activate through the existing journal.
Obsolete package files stay in retained versions, rather than surviving in the
new runtime. A changed retained data/working-coordinate contract refuses an
unsupported transition. Version-dependent generated data needing regeneration,
mutable engines, installers and custom preparation are outside this adapter;
use an existing supported integration or a non-owning handoff.

Update policies, explicit staging/application and version pins keep their existing
meaning; automatic application stays opt-in. Runtime rollback carries current
declared data and does not promise that older software can read newer saves.
Committed activation remains authoritative after a later failure; recovery must
not claim an automatic rollback. Existing managed and external installations are
never silently converted when a catalog entry gains this capability.

## Catalog author task routes

The machine-readable catalog owns port, platform, source, release and
qualification facts. Use these routes to describe a useful integration and its
limits before preparing a change; stable IDs remain the operational references.

| Task                                         | Start here                                                                                                                                                                       |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Define the required original game files      | [Original game-file requirements](#original-game-file-requirements), then the [shared source contract](ARCHITECTURE.md#original-game-files)                                      |
| Explain what happens to saves and settings   | [Saved-data behavior](#saved-data-behavior), then [Core persistence](ARCHITECTURE.md#saves-and-settings) and [backups](ARCHITECTURE.md#backups)                                  |
| Check releases and record maintenance limits | [Release checking](#release-checking), [continuous admission](#continuous-admission) and [channels, support and qualification](#channels-support-and-qualification)              |
| Prepare and review the definition            | [Adding or changing a port](#adding-or-changing-a-port), [cover preparation](#default-covers) and [protected publication](#admission-decisions-and-protected-publication-target) |

### Original game-file requirements

Give players clearly defined requirements for their original game files and any
required BIOS. Bind the labels, edition/representation facts and exact property
checked to the declared source profiles and contracts. Distinguish an exact
identity match from structural admission, an informational observation and a
validator that has not run. The [shared inspector](ARCHITECTURE.md#original-game-files)
owns these conclusions; a filename or descriptive label cannot supply them.
The [authoring procedure](#adding-or-changing-a-port) keeps presentation tied to
the same source authority.

An informational contract for a single game file can declare
`variant_list_recognition_only` with exact release and artifact bindings.
Setup review leaves compatibility open for these lists and continues to use the
ordinary input-admission checks. An installed build receives the informational
result only when its release and artifact match the declaration. The source
profile still owns the user's exact registered-file identity. Existing contracts
without this field retain their compatibility rules.

Players may add their own Logiqx DAT files, such as No-Intro or Redump, as a
host preference. If the import rejects the Logiqx format, Settings prompts
players to choose a complete Logiqx XML DAT file and keeps the exact parser
reason in technical details. Core compares the SHA-1 or SHA-256 and size it
already observed for the selected files with the DAT entries and reports the matching
entry name beside the catalog result, for example to say a rejected file is the
Europe dump. A DAT file must list a size to match. An entry is complete only
when every file that has a SHA-1 or SHA-256 and is not a cue or gdi descriptor
matches; CRC32- or MD5-only files cannot be compared and do not count. A disc
whose data track alone was checked stays partial, and the report says so. The match is informational: it never changes classification,
admission, registration or a contract result, and a catalog identity does not
depend on any DAT. Portcove saves a fingerprinted path, never a copy, makes no
network request, and ignores a DAT file that changed after it was added. A
parsed DAT file is kept in memory for later inspections while its path, size,
modification time and fingerprint are unchanged, so each one is read, hashed
and parsed once rather than on every inspection; an edit that keeps both size
and modification time is noticed only after one of them changes. The memory
belongs to the running Portcove process, holds at most one million listed files
in total, and skips any single DAT larger than that; adding the file again
forces a fresh read.

### Saved-data behavior

Explain how updates preserve saves and settings for the offered route. Declare
the managed persistent locations and distinguish them from disposable runtime
output and external player-owned files. Use the existing
[synchronization and version-switch contract](ARCHITECTURE.md#saves-and-settings)
and [backup ownership](ARCHITECTURE.md#backup-service-ownership); a non-owning
registration does not acquire those management rights. Record an unknown or
unsupported behavior at its actual scope rather than implying every file is
backed up or every older game version can read newer saves.

### Release checking

Record release checking, required game files, saved-data behavior and
implementation notes together for the offered route. Identify its release
provider, offered channels, exact artifact and checksum requirements, then use
the existing [release-selection and maintenance rules](#release-selection-and-maintenance).
Separate safe selection of an artifact from qualification of that artifact and
permission to install it. Keep pinned and user-managed limits explicit; a
successful metadata check does not establish gameplay or authorize publication.

## Managed PS1 package and player-data restoration

`psx-recomp-managed` keeps its owned-disc/BIOS preparation and runtime generation.
Official release discovery may replace changing direct manifests when the same
reviewed package, executable and preparation rules apply. Native archives do not
replace this richer integration. Platform commitments remain independently scoped.

Older upstream framework versions stage bundled mod packages into the same
`mods/packages/<id>/<version>` tree used for player imports. For a retained
contract declaring `mods`, Core preserves complete destination-only packages and
adds complete absent versions through private, same-filesystem staging and atomic
no-replace publication. An existing ID/version must have an identical complete
tree; differing, missing or additional members, case/type conflicts and links hold
the operation with exact paths. Preserve conflicting copies separately and resolve
the reported conflict before retrying. Core does not identify which package was
player-created, authenticate a modified mod, insert arbitrary unknown runtime
files, rebase upstream selections or promise mod/save compatibility. Ordinary
declared state retains its existing restore/deletion semantics. Runtime rollback
carries current data, including selected mod versions; it does not rewind saves.

Normal collection, including collection after Play or recovered sessions, checks
complete-package conflicts before copying other declared data. A differing copy
of the same package ID/version holds collection, backup or post-Play recovery with
both paths preserved; local edits need that deliberate review. Preserve the
reported copies separately and resolve the conflict before retrying. Current
runtime data remains intact; failed collection is not a completed backup or
recovery. Normal collection still mirrors deliberate package removals and ordinary
root-state changes. Only the retained `packages` layout has package semantics;
arbitrary historical `bundled` or `installed` folders are not reclassified.

For a reviewed split layout, declare the exact player paths
`mods/installed`, `mods/packages`, `mods/.staging`, `mods/state.toml`,
`mods/state.toml.tmp` and `mods/texture-packs`, where PSXRecomp `7192402` and
later create HD texture replacements and dumps. A managed build for such a
route that leaves any file in `mods/packages` is refused before anything is
installed, because those files would be collected as player data. The runtime build stages its own `mods/bundled` files
and any bundled README. Those files belong to the verified runtime version.
Core carries declared player paths through normal retained collection, restore
and rollback. Upstream owns any legacy package migration within those paths.
The existing whole-tree contract continues to apply to older definitions.
Explicit integrations use the same paths on every declared platform, including
Mac for Mortal Kombat 4
([record](qualification/mortal-kombat-4-psxrecomp-031868cc-2026-11-13.md)).

PS1 installs publish inactive and run player-data preflight before activation.
Older interrupted install journals use the same order; an already committed
active version remains authoritative. Explicit backup restoration also preflights
retained mod trees before publishing canonical data, including recovery replay.
Failed copies preserve original sources and pre-existing destination packages;
complete additions may already be present. Retrying recomputes from those copies.
Interrupted private staging is retained in the existing owned staging namespace;
this does not promise automatic reuse or cleanup of orphaned private copies.

Before first Play, a historical runtime without proof of completed Core data
restoration uses additive collection: canonical-only files stay, and differing
common files hold for preservation review. A successful full restore records
`.portcove-psx-data-restored.json` at the installation root, bound to the registered
install and manifest. This lets subsequent collection preserve deliberate saves,
settings and mod selections made before first Play. It is not a launch receipt or
game-file/edition validation. Missing or stale proof never authorizes destructive
collection; malformed or future proof holds rather than being overwritten. Only
the exact PS1 metadata path and its defined atomic-write temporary names are
excluded from package integrity checks. No undeclared `mods` path is adopted.

## Managed ReGaiden shared preferences

The reviewed v0.4.1 Windows package uses the constrained
`gbrecompiled-windows-v1` consent-bearing policy. An exact direct release or
reusable GitHub package rules bind acquisition through the configured provider;
`managed_shared_preferences_save_id` records the reviewed upstream
save basename independently of the executable name. New declarations require
staged-source capability 19 for direct manifests or 21 for GitHub discovery, and the
`regaiden-gbc` materialization that older engines cannot parse. Core retains
explicit review of the Windows account and both shared/local preference paths
in schema7 installation manifests. Local saves/settings are managed; the
account-wide file is never owned, backed up, restored or deleted. Scope cannot
travel through adoption, relocation or library transfer. See the
[exact contract and manual reinstall recovery](reference/managed-regaiden.md).
Historical prepared registrations retain their previous non-owning semantics;
this route neither migrates them nor establishes gameplay qualification.

## Managed RaceWave46 sign-in boundary

The reviewed official Windows v1.0.0 package uses the reusable
`version-local-retroachievements-v1` runtime-data policy requiring staged-source
capability 19 for direct manifests or 21 for GitHub discovery. Core binds the
provider's exact artifact facts to the retained rules. Ordinary `.runtime` saves and
settings are managed; RetroAchievements credentials stay inside each version.
They are never opened, hashed or copied. Whole-tree transfer and recovery refuse
known credential names before reading payloads and again before publication.
See [data ownership and manual recovery](reference/managed-racewave46.md).
This user-side acquisition route does not authorize redistribution or remove
upstream contribution-license caveats. Existing external registrations retain
their historical contract.

## Exact relative-file sources and managed TFE

`relative-file-set` is an explicit source representation and projected source
kind. Unlike historical basename-only file sets, each member declares a portable
relative path, exact size and SHA-256. Required members must cover the managed
runtime targets bijectively with matching hashes; directory and ZIP namespace,
size and caller-budget checks precede member admission. The normalized aggregate
uses its own versioned SHA-256 protocol, including single-member sets. Existing
basename file-set identities and aggregates are unchanged.

Member hashing and owned staging use bounded 128 KiB chunks for directory and ZIP
sources. Directory reads retain no-follow, single-link and before/after object
identity checks; cache revalidation uses the same streaming path. Cancellation
is checked between chunks. A hash or size mismatch refuses admission/publication,
and interrupted writes stay in the existing private staging/recovery boundary.
ZIP intake retains its 128 MiB member and 512 MiB declared aggregate limits.
An exact schema-2 identity above either ZIP limit accepts an installed directory
only, with at most 640 MiB per member and 2 GiB of declared members. Both shapes
retain the 256-member limit, portable relative paths and caller hash budgets.
A source identity cannot mix ZIP-compatible and large directory-only variants.
The larger directory limits accommodate the classic Doom 3 and Resurrection of
Evil PK4 sizes. An identity declaration alone does not qualify a port’s
installation, preparation or retained-data transition.

The reviewed Windows TFE v1.22.420 package selects the constrained
`tfe-dark-forces-portable-v1` initializer and requires staged-source capability
**19** for direct manifests or **21** for GitHub discovery. The retained definition supplies executable and package rules; an exact
direct release or the configured GitHub provider supplies changing artifact facts.
Its checked complete game-data layout, pilot/settings initialization and recovery
remain Core behavior. The exact old initializer retains its original meaning for
persisted consumers. Transport schema **75** originally added the relative source shape and managed initializer;
older consumers must refuse unsupported semantics. Full source inspection and
bounded quick filter observations are distinct: the latter returns `NotChecked`
for this shape. See [managed Dark Forces setup and recovery](reference/managed-tfe.md)
for player workflow, persistence boundaries and the removal recovery hold.

The closed `chocolate-family-portable-v1` initializer requires staged-source
capability **38**. It selects one official Windows Chocolate Doom, Heretic or
Hexen package and a checked whole IWAD. Core creates only a missing local extra
configuration, preserving existing compatible bytes. Autoload and music-pack
paths stay local. Save directories are derived from the actual IWAD's SHA-256,
so different original editions do not share slots. Actual IWAD bytes are checked
before preparation, data movement and spawning; a changed original or incomplete
dataset holds the operation. An explicit setup deployment retains its existing
whole-dataset replacement authority. The recipe does not initialize TFE files,
import host profiles, run a setup utility or accept catalog-supplied file contents.
Older consumers must refuse the unknown initializer/capability. See
[managed Chocolate profiles](reference/managed-chocolate.md) for ownership and
preservation boundaries.

## STFS package extraction

`stfs-directory` extracts a player's original Xbox 360 STFS package (an Xbox Live
Arcade download) into the runtime directory named by `runtime_source_filename`.
It is valid only on `staged-source-portable` ports whose destination has no
extension and is listed in `runtime_mutable_paths`, with at least one
`runtime_source_hashes` anchor such as `default.xex`. NocturneRecomp (#101) is the
first route.

The reader accepts `LIVE` and `PIRS` packages in the single-table (read-only) STFS
layout. Console-signed `CON` packages, two-table packages and SVOD volumes are
refused, each with its own reason. Core checks the package's SHA-1 hash tree:

- the header SHA-1 at `0x32C`, which covers `0x344` up to the first hash table;
- the top hash in the volume descriptor against the highest hash table;
- each level-1 (and level-2) table against its parent;
- each level-0 table, and each data block it reads, against its recorded SHA-1.

The licence entries and the signature lie outside the header hash, so two owners'
copies of one game can differ there while their verified content is identical. The
RSA signature is not checked. A file entry with the contiguous flag reads sequential
blocks; a recorded next pointer must then name the following block or be empty.

Which checks refuse a package depends on what proves its integrity:

| Check                                                                                                                                                                                                                                                                                | Enforced | Advisory                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------------------------------- |
| Container kind and layout (`CON`, two-table, SVOD), table and block counts, data base inside the file, block numbers in range, block and parent cycles, traversal, reserved and case-colliding names, at most 16,384 entries and depth 64, expanded bytes, free space before writing | Refuses  | Refuses                         |
| Header SHA-1, top hash, level-2/1/0 tables, data blocks, truncated hash tables                                                                                                                                                                                                       | Refuses  | Advisory                        |
| A contiguous file whose recorded chain disagrees                                                                                                                                                                                                                                     | Refuses  | Advisory; the chain is followed |
| 16 GiB package cap, descriptor length `0x24`, header at least `0x3AD` bytes, at most three hash levels, block count fitting in the file                                                                                                                                              | Refuses  | Advisory                        |

- **Enforced.** A content identity relies on the hash tree, and so does any port
  that declares `runtime_stfs_package`; inspection is enforced for every profile such
  a port binds, so the refusal happens at registration rather than at preparation.
- **Advisory.** Everywhere else, an `stfs-directory` port's source profile must carry
  an exact whole-package SHA-256 (`accepted_sha256`), which registration verified. The
  reader then accepts every package the earlier reader accepted: inspection lists
  findings in `integrity_advisories` and extraction logs them as a warning. This keeps
  a known package such as NocturneRecomp's working if Portcove's reading of the format
  ever disagrees with a real package. Extraction selects the policy from the binding
  alone, relying on that catalog rule.

A port may declare `runtime_stfs_package`, which requires staged-source capability
**32**:

| Field               | Meaning                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| `content_types`     | Accepted header content types as eight uppercase hex digits. Only `000D0000` (arcade title) is reviewed. |
| `title_ids`         | One to sixteen accepted header title IDs as eight uppercase hex digits.                                  |
| `max_package_bytes` | Explicit bound on the selected package, at most 16 GiB.                                                  |

Core compares the header with this binding before reuse or extraction, so another
game, a title update or downloadable content is refused first with
`stfs_package_mismatch`. A binding without `stfs-directory` is invalid.

### Package identity

The `source_profile` of an `stfs-directory` port identifies the package in one of
two ways, which may coexist as separate variants. When one package matches both, the
exact whole-package identity is the one admitted:

- **Whole package.** A `compound` representation with format `stfs-live` and an
  exact whole-file digest. NocturneRecomp uses this form, and it keeps working
  unchanged.
- **Content.** An `stfs-content` representation that lists `package_types`
  (`live`, `pirs`), `title_ids`, `content_types` (`000D0000`) and 1 to 16
  `members`, each a safe relative `path` with its extracted `sha256`. A package
  matches only when its complete hash tree verifies, its header values are listed
  and every member digest is equal. The port must declare `runtime_stfs_package`
  covering the same titles and content types.

A content identity projects no whole-file digest into the schema-1 compatibility
profile and never falls back to structural admission. Registration still records
the owner's exact file bytes, so a later change to that file is detected as before.
Launch-time reassessment does not reconstruct a content match from stored digests
and reports it as not evaluated. Folder search probes `PIRS` files only when a
selected profile declares a content identity. Title IDs, member digests and size
bounds must come from owner-provided or upstream-published evidence; never infer
them. No shipped port declares a binding or content identity yet. See the
[2026-11-13 record](qualification/stfs-importer-pirs-hash-chain-2026-11-13.md).

## Disc-image unpacking

`xdvdfs-directory` (Xbox and Xbox 360) and `iso9660-directory` (PlayStation 2 and
PSP: plain ISO, CSO, or CHD) unpack a player's original disc image into the runtime directory
named by `runtime_source_filename`, following the same staged-source pattern as
`stfs-directory`. They are valid only on `staged-source-portable` ports whose
destination has no extension and is declared either in `persistent_paths` (kept
across updates, the better fit for multi-gigabyte output) or in
`runtime_mutable_paths` (regenerated), with a
`source_profile` of kind `file` that carries exact whole-image SHA-1 or SHA-256
identities (for example Redump). Core reads the image read-only; it never modifies,
locks, trims or rebuilds it.

A port also declares `runtime_disc_image`:

| Field             | Meaning                                                                                                                                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format`          | `xdvdfs` or `iso9660`; must match the materialization.                                                                                                                       |
| `max_image_bytes` | Explicit bound on the selected image, at most 16 GiB. The 2 GiB bound of existing disc formats is unchanged.                                                                 |
| `product_codes`   | One to sixteen identifiers the disc must declare: the Xbox/Xbox 360 title ID (eight hex digits from `default.xex`/`default.xbe`), the PS2 boot serial, or the PSP `DISC_ID`. |

`runtime_source_hashes` is required: at least one anchor file (for example
`default.xex`, `default.xbe`, `SYSTEM.CNF` or `PSP_GAME/PARAM.SFO`) with its exact
SHA-256, each a safe relative path. Anchors, product codes and size limits must come
from owner-provided or upstream-published evidence; never infer or guess them. A
port that declares `runtime_disc_image` without a disc-image materialization is
invalid. Core compares the disc's identifier with `product_codes` before extracting,
so a wrong game or region is refused first.

Unpacking plans the whole file system before writing, refuses any entry it would
otherwise skip (extent past the image, oversized tables, too many entries or levels,
expanded bytes beyond the image, traversal, separator, control or non-ASCII names,
Windows reserved names, trailing dots or spaces, case-insensitive duplicates,
overlapping extents, multi-extent or interleaved ISO 9660 files, unreadable
system-use areas), checks free space with a margin, stages beside the destination,
verifies the anchors, then swaps transactionally and writes the marker. Failure or
cancellation leaves the previous runtime directory intact and removes staging. An
unchanged source with a valid marker and matching anchors is a no-op; any other
state re-extracts and never reuses output by size. A re-extract replaces the whole
destination folder, so anything the game wrote into it is lost. Destination drift
outside the declared anchors is not detected, so declare every file the runtime
cannot do without. Total directory-table bytes read while planning are bounded.

Compressed PlayStation 2 and PSP inputs are expanded to a private ISO beside the
destination, which is removed on every path and is never the registered source; the
unpack then reads that ISO. A `CISO` CSO (version 0 or 1, 2048 to 64 KiB blocks, stored
or raw-deflate) is recognised by its header rather than its extension and expanded by
Portcove itself; the header size, block size, version, index (monotonic, inside the
file) and every block's inflated size are checked, and a `ZISO` (LZ4) image is refused.
A CHD is expanded with the local `chdman`: a DVD-type CHD with `extractdvd`, and a
CD-type CHD (track metadata) by extracting the CD and converting its first data track
(`MODE1/2048`, `MODE1/2352` or `MODE2/2352` form 1) to a plain ISO. A CHD with both or
neither kind of metadata, a first track of another kind, or a sector that is not
exactly convertible is refused. The image bound, free space for the private ISO plus
the unpacked tree, cancellation and cleanup are the same as for a plain ISO. Neither
route applies to Xbox or Xbox 360 images.

ISO 9660 records may carry a system-use area. Well-formed CD-XA or Rock Ridge/SUSP
data and plain zero padding (as Sony PS2 mastering writes) are accepted but not
interpreted, so alternate names are ignored and symbolic links are not followed; any
other bytes are refused, so a corrupted record length can never hide the records
after it. The 16 GiB image bound applies to an explicitly added source; source
discovery and batch import still stop at 2 GiB.

An indexed definition that declares `runtime_disc_image` must require
`staged-source-portable` capability version 30, so older readers refuse it instead of
misreading it ([definition delivery](DEFINITION-DELIVERY.md)); a definition bundled
with the application ships with the build that understands it. `ace-combat-6-recomp`
is the first shipped declaration, and it uses an [optional game
source](#optional-game-source): a player can keep using `AC6.iso` beside the executable
or hand-extracted files in `assets` without choosing a disc image, and nothing is asked
of them; choosing the one reviewed image unpacks it into `assets` and replaces the
folder's contents. It remains Cataloged at its existing `beta` tier with no Supported
claim, accepts only the one reviewed image identity recorded in
[its dated evidence](qualification/ace-combat-6-owner-image-disc-reader-2026-11-11.md),
and keeps `assets` and its other declared persistent paths. An install recorded under
its earlier definition keeps that recorded definition, so it is not rewritten and gets
no prompt; a disc image the player chooses is used from the next runtime update.

A persistent disc-image destination is carried to the next version together with its
unpack marker (`assets.portcove-source.json`), and only for a port that declares a disc
image; every other port's persistent entries are unchanged. The marker is verified
exactly as before: an unchanged registered source whose marker matches and whose anchor
files re-verify is a no-op, so a runtime update neither unpacks again nor replaces
files already in the folder. A changed or removed source, a missing folder or a failed
anchor still unpacks again and replaces the folder transactionally, which discards
anything the player added to it by hand. `max_image_bytes` is a Portcove policy bound
chosen above the observed image size (9 GiB against 7,835,492,352 bytes), not an
evidence value.

### Optional game source

A disc-image port may declare `optional_game_source: true`. The source is then offered
but not required, so a player can use the manual routes (for example `AC6.iso` beside
the executable, or hand-extracted files in the runtime folder) without choosing a disc
image. It is valid only on a `staged-source-portable` port that declares a
`source_profile` and `runtime_disc_image`; any other port is refused. Its effects:

- An unregistered source never blocks. The install plan lists the requirement with
  `optional: true` (omitted when false, so every other plan is unchanged), and install
  review, update review and launch readiness ignore it: no `MissingSource` blocker, and
  the update action stays allowed.
- Nothing is unpacked or removed while no source is registered; the runtime and its
  persistent files stay exactly as they are.
- A registered source is unpacked as for a required source: it is verified, replaces the
  destination folder transactionally and discards what was added to it by hand.
- A registered source whose file has since gone (for example the image was deleted after
  unpacking) is treated as absent: Play is not blocked and the unpacked folder stays. Only
  "not found" counts as gone; a permission error or an unreachable location does not.
- A registered source that later changed or became unreadable does not hold Play either:
  Play launches with the files already unpacked, unpacks nothing and removes nothing, and
  the launch reports a `warning` message that the saved source changed or cannot be read.
  Registering the image again (or removing the registration) is what resumes unpacking.
- The Game files summary states, before a player chooses an image, that unpacking replaces the
  unpacked game folder and does not keep files added to it by hand.
  Cancellation is never treated as a source failure.
- Choosing a valid optional source is what makes Portcove unpack at the next launch, and
  that replaces the destination folder, which is the first time Portcove can replace a
  hand-extracted setup. Registering the source shows no separate confirmation of that, and
  install and update review (where `preservation_notices` appear) are not the moment it
  happens, so the definition's player copy must say plainly that unpacking replaces the
  folder.
- The install, setup and update paths follow the same rule: an optional source that was
  never registered, whose file has gone, or that changed or cannot be read, is simply not
  used; it neither fails setup nor
  holds the Install or Update action.
- Every other port is unchanged: a required source still blocks while unregistered or
  missing, and the requirement serializes as before.

An indexed definition that declares `optional_game_source` must require
`staged-source-portable` capability version 31 ([definition
delivery](DEFINITION-DELIVERY.md)); the flag is part of the installed compatibility
identity only when set.

## ROM patching

`rom-patch` produces the runtime file named by `runtime_source_filename` by applying an
exactly identified patch to an exactly identified original, for example a fan translation
that an upstream port requires. It is valid only on a `staged-source-portable` port whose
destination is declared in `persistent_paths` (as for `copy`), with a `source_profile` of
kind `file-set` that holds the original and the patch as two members. The player supplies
both files in one folder or ZIP; Portcove never downloads a patch through this route.

A port also declares `runtime_rom_patch`:

| Field                | Meaning                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `format`             | `ips`, `bps` or `ups`.                                                                    |
| `original_filenames` | The accepted filenames of the file-set member that holds the unmodified original.         |
| `original_sha256`    | The one original the patch applies to; it must be one of that member's `accepted_sha256`. |
| `patch_filenames`    | The accepted filenames of the member that holds the patch; no file is in both members.    |
| `patch_sha256`       | The one reviewed patch file; it must be one of that member's `accepted_sha256`.           |

`runtime_source_hashes` must be exactly `{runtime_source_filename: <patched SHA-256>}`: the
output's identity is pinned like any other single-file runtime source. All three identities
come from owner-provided or upstream-published evidence; never infer them. A port that
declares `runtime_rom_patch` without `rom-patch`, or `rom-patch` without a complete
declaration, is invalid.

Before every launch Core reads both members (each at most 64 MiB), checks each against its
pinned SHA-256 and refuses a mismatch as a source problem. File-set registration accepts
members up to 512 MiB, so a larger member can register but cannot be patched; pin only
inputs within the 64 MiB limit. An existing output whose marker
records the same inputs and whose bytes still match the pinned output is used as it is.
Otherwise Core applies the patch in memory and checks the result against the pinned output
before writing; only a match is written, to a private file beside the destination that then
atomically replaces it, and the marker is written last. A failure at any step leaves the
previous file, the original and the patch untouched. The appliers are strict: a truncated
record, an offset or copy range outside its buffer, an overlong number, bytes after the end
of the patch, or a declared size above 64 MiB refuses the patch. BPS and UPS checks also
compare the original, output and patch with the CRC32 values the patch records. UPS is
applied in the forward direction only; a patch that shrinks the file carries changes past
the new end, which are read and discarded as the reference decoder does, while a change
past both declared sizes refuses the patch. IPS output may grow past the original and
honours the optional truncation record; as in the format itself, offset `0x454F46` reads
as the end marker.

Identity is exact, so an original that carries a 512-byte copier header is a different file
and is refused at registration; the header-aware representation below applies only to
copied SNES runtime files, not to ROM patch inputs.

An indexed definition that declares `runtime_rom_patch` must require
`staged-source-portable` capability version 33 ([definition
delivery](DEFINITION-DELIVERY.md)); the declaration joins the installed compatibility
identity only when set. No shipped definition declares it yet; the first candidate
consumer is tracked on its port issue.

### SNES copier headers

Some SNES dumps start with a 512-byte copier header. A source representation of kind
`snes-copier-header-optional` identifies a raw SNES dump by its content: a file whose
length is 512 bytes more than a multiple of 1024 (and at most 64 MiB) is identified by the
bytes after those 512, and any other length is identified whole. Its identities use the
`snes-headerless-content` scope, and only this kind reads it, so matching for every other
profile is unchanged; a header inside a ZIP is not recognized. The header's bytes are never
interpreted, and exactly one header is ever skipped. Registration records that digest pair
for any raw file whose length shows a header, whatever its profile; other files' stored
facts are unchanged. A library holding such a record uses a digest scope that an older
Portcove version cannot read.

A port whose source profile uses this kind must use the `snes-headerless` materialization,
and that materialization requires it. It reads the registered original (following a
symlink as registration does), drops the header when the length shows one, checks the
result against the single pinned `runtime_source_hashes` identity in memory and only then
atomically writes the runtime file; the original is never changed. The registered source
record keeps the file's own SHA-256 and size. Indexed definitions using either need
staged-source capability 36 ([definition delivery](DEFINITION-DELIVERY.md)).

The managed DKC3, F-Zero, Super Bomberman, Super Mario World and A Link to the Past routes
use it; their pinned content and runtime identities are unchanged. Mega Man X2 and Super
Metroid stay exact: their reviewed predecessor-archive transitions bind the creating
`copy` materialization. DKC2 hands the original to its user-prepared runtime without a
materialization step and stays exact. An existing installation keeps the retained
contract it was installed under, so it accepts a headered dump only after it is next
installed or updated.

### Managed PS1 toolchain artifacts

The bundled defaults live in `crates/portcove-core/catalog/tool-artifacts.json`.
An admitted managed PS1 definition may propose one exact pack per
declared platform through projection schema 4 and the
`tools.psx-toolchain-v1` required feature. Each row fixes the publisher release,
ZIP size and SHA-256, Python, CMake and Ninja layout, and the Mac executable
member identities. Core refuses another repository, unexpected layout,
duplicate platform, missing platform, or a mismatched archive digest.

Acquisition, download resume, reopening and build require the exact bundled
tool pack. A proposal that differs from the independently pinned artifact
fails before acquisition or cache use, including after reopening. Legacy
definitions and existing preparations keep their cache coordinates and receipt
format. Player-selected chdman and DolphinTool paths use their existing trust
checks.

## Default covers

Ordinary single-record preparation uses [the authoring entry point](#adding-or-changing-a-port).
It enriches both listing-only records and integrations through the same cover
matching, decoder and fallback policy. Shared descriptive facts live once in the
authored record; the strict projection places the mapping in `presentation.artwork`.

For bulk cover preparation across both listing-only records and integrations, use
the same entry point with a selected workset:

```text
node scripts/prepare-port.mts --artwork-ids fragglet-sdl-sopwith,faxanadu-recomp --validator-cli TRUSTED_PORTCOVE_CLI --output-dir /path/to/cover-preparation
```

This mode reads the complete per-ID source catalog and accepts a logical workset
of unique known IDs, automatically continuing through bounded operations of at
most 400 identities. It collects no upstream repository/release facts. A
522-record directory needs one logical specification; accepted per-ID progress
resumes after interruption. Provider request, byte and time ceilings remain
unchanged. Optional `--identities` and `--credentials-file` work as in
single-record preparation. `--refresh-artwork ID,OTHER_ID` refreshes only IDs in
the selected workset; otherwise accepted mappings are reused. Project, issue,
record, release and route options cannot be mixed into an artwork-only batch.

The checkpoint retains per-ID proposals, full generated projections and precise
cover outcomes without editing accepted sources. A successful identical workset
reuses its receipt. A mixed result retains useful proposals and reports
`pending_port_ids`; review and accept the useful per-ID files, then retry only the
pending subset. Missing credentials or a failed match does not block other records.
Use a new checkpoint for a fresh scheduled refresh of unchanged mappings. Core
listing inspection runs when a validator is supplied; operational projection
changes require it. Neither mode changes local artwork choices or publishes data.

For a strict operational catalog proposal, use
`node scripts/generate-catalog.mts --prepare-proposal PROPOSAL.json --validator-cli TRUSTED_PORTCOVE_CLI --output-dir NEW_OUTPUT_DIRECTORY`.
Optional artwork facts/credentials/refresh flags are the same as below. This
mode snapshots the explicitly selected CLI and checks catalog declarations through
`catalog inspect-proposal`. Input and output use `--repository-authoring`, matching
the proposed operational projection in `prepare-port`. The accepted baseline uses
generic inspection for compatibility. Process receipts record the inspection mode
alongside the exact input bytes and validator identity. The command prepares existing artwork in
the same output. `proposal-evidence.json` adds exact input-byte/core receipts,
typed per-port declaration hashes and the complete accepted-to-proposed diff;
`artwork-evidence.json` retains its distinct cover reasons and provider costs.
The additive `proposal_changes` report matches ports and named source records by
stable ID. Each changed port includes its old/new display name and exact source,
execution, persistence and other changes; source identities/contracts/validators/
evidence are reported by collection and ID. Record insertion or removal does not
make unchanged siblings appear modified, including games sharing a repository.
Ordering changes are explicit. The same report accompanies `--compare-historical`.
These groups describe declared fields, not acceptance or inferred dependency
impact. The complete `differences` and Core receipts remain necessary: unkeyed
qualification facts and other catalog fields are outside this named-record report.
Full proposals also include `declaration_cases`: complete before/after ports,
shared source tables, unchanged port fields, accepted peers referencing the same
declared adapter, and the exact inspector receipts for each case. Shared source
records and adapter peers appear once. Per-case source references name identity
and contract IDs and qualification ordinals in that side's source table; follow
their declared validator/evidence IDs to reconstruct the complete scoped records.
No shared evidence or peer list is copied into every case. Cases include unchanged
port definitions when their declared source/evidence/qualification relationships
change. They are ordered by stable port ID; source-record order and exact scoped
qualification remain preserved. Unreferenced source changes stay in the complete
diff rather than being assigned to an unrelated port. These relationships are
not validation impact, capability fit or permission to reuse qualification.
Declared evidence is neither authenticated nor executed by proposal preparation;
an absent per-port inspector receipt remains null. Existing preparation/artwork
costs are linked separately. Engineering, application/harness changes,
interventions, maintenance execution, eliminated work and comparative savings
remain explicitly unmeasured. Preparation does not establish subsequent artifact
compatibility or delivery speedup.
All files remain unsigned proposals. No publisher grant, artifact authenticity,
actual source/operation/gameplay qualification or production delivery is inferred.
The `compatibility_fixture_review` report compares proposed source and port IDs
with the frozen schema-1 identities plus the independently reviewed lists in
`catalog-legacy-additions-fixture.json`. Missing or unreviewed IDs require a
manual fixture review; preparation can still describe an unreviewed candidate.
The generator never updates these expectations. Ordinary generation and `--check`
refuse an identity mismatch before replacing embedded bytes. This cheap check
does not establish full source-contract equality: Rust still compares complete
frozen legacy projections and retains its qualification and negative assertions.
Add independently reviewed additive IDs to this fixture once instead of updating
the expected count and three exclusion lists separately. Insert each ID in ascending
order; the generator and the Rust catalog tests refuse an unsorted list, so
concurrent additions usually merge instead of colliding at the end. Do not regenerate the
fixture from the catalog or derive expected identities from a proposal.
An unavailable validator or failed declaration check stops this proposal, retains
its process receipts and leaves the accepted catalog/libraries unchanged. A new
output directory is required; an interrupted or prior batch is never overwritten.
Full proposals capture the selected validator before declaration checks. Their
image decoder takes its own snapshot from that captured artifact only when fresh
image bytes need validation, then reuses it for the batch. A reuse-only batch
therefore retains one executable snapshot and creates no image-validation scratch
library. Decoder initialization failure is not retried within the batch; existing
artwork exception/fallback handling remains responsible for the result. Artwork-only
preparation keeps its eager selected-tool snapshot boundary.

Prepare a cover beside each new port definition. Search its public project name
and known aliases first; accept an exact port record only after checking the
underlying title and project identity. Keep the original-game identity separate.
Prefer a usable port cover, then the exact original game, then generated fallback.
Record ambiguous, coverless or unavailable candidates as finite exceptions.
Explicit local selections remain preferred; artwork never grants game support.

An original-game cover represents the identified game. It does not certify a
source pressing, package, language, or gameplay variant. A matching main-game
cover may represent a reissue, preview, or expanded collection when the same
original game and source platform have been established. Preserve the listing's
exact original-file requirements. An explicit reviewed regional selection keeps
its pinned localization. A different game, remake, or sequel is still a mismatch.

`presentation.artwork` contains the selected IGDB game/cover/image identities,
fixed CDN image digest and match kind. Maintainer preparation uses private Twitch
credentials; clients need no key and only fetch the bounded mapped image through
the existing shared resolver. Do not bundle images or treat display permission as
Steam export permission. All current and future covers use the shared full-image
presentation: preserve aspect ratio, show the complete cover, and use the card's
surface instead of a generated colored matte. Discover and Library cards draw
an offline controller illustration whenever a usable cover is missing or fails
to render.

A managed definition for two games can also declare `integration.presentation.companion_cover`
in its authored record. Verify the second game's IGDB identity and image digest
independently. Discover's Covers layout shows both full images when the primary
is the current catalog default and the companion loads. A missing companion
leaves the primary visible. The usual local cover choice takes precedence.

A multi-game project's authored `listing.collection_covers` holds up to four distinct
IGDB constituent-game mappings, independently reviewed and content-validated. It is
exclusive with individual `artwork`, `companion_cover` and authored regional-cover
selection. This display metadata keeps the project's identity and setup requirements.
Discover, Library and Details fit every complete image: pairs share the existing paired
layout and larger sets use a two-column grid. Explicit local Cover choices replace the
whole collection, including when that local image is unavailable. Partial network or
render failures leave the other images visible.

Initial selections normally contain two or four covers. A confirmed exact-image Gone
observation removes only its member everywhere in the proposal, including outside the
selected workset; one survivor remains valid and an empty collection is omitted.
Outages and changed bytes retain the reviewed pins with retry/review evidence. Ordinary
preparation reuses accepted members; explicit or due refresh rechecks every member's
bytes and preserves separate refresh clocks and per-title checkpoint identity. Changed
project identity or collection mappings require reviewed source facts before reuse.
Collection originals use the existing bounded IGDB cache and reference retention;
retained registrations keep their admitted descriptive mappings when a directory entry
is removed. Listing format 11 and retained-listing envelope 4 provide the strict-reader
fences. Older directory exports omit only the inert collection field. Collection images
carry the same display-only rights as individual IGDB covers and provide no Steam-export
bytes or runtime qualification.

The [2026-09-30 identity receipt](archive/2026-09-30-igdb-catalog-cover-identities.json)
records the catalog-wide preparation, accepted port and original identities, and
port-specific exceptions. It is dated evidence, not another scheduling tracker.
Preserve accepted mappings when adding entries; investigate only additions or
changed references. Ordinary schema-2 catalog proposals can prepare covers and
their evidence in the same batch using the existing generator:

```text
node scripts/generate-catalog.mts --prepare-artwork PROPOSAL.json --identities FACTS.json --credentials-file PRIVATE.json --validator-cli TRUSTED_PORTCOVE_CLI --output-dir NEW_OUTPUT_DIRECTORY
```

Maintainers can save an existing private credentials-file path once per user with
`node scripts/maintainer-config.mts set-igdb-credentials-file ABSOLUTE_PATH` and
inspect its redacted, no-network status with `node scripts/maintainer-config.mts check`.
The versioned `~/.portcove/maintainer.json` contains only the path and is shared
across worktrees outside Git. Explicit `--credentials-file` takes precedence.
Configuration and credentials are read only when provider authentication is
needed; accepted reuse and fallback do not require them. Credentials, tokens and
private paths stay out of proposal evidence and client bundles.

The optional facts document is keyed by stable port ID. Ordinary port matching
uses the definition's public name and exact project URL without a supplied IGDB
ID; a unique exact name/alias plus matching provider project website is required.
Its optional `port` and `underlying_game` records supply public `names` and
attributable HTTPS `evidence_url`, with an exact `project_url` for name-based port
matching. A reviewed original title may use its attributable upstream project URL
for a bounded exact-name lookup; known `platform_ids` and a specific `edition`
narrow that match when supplied. An independently established positive IGDB
`game_id` and exact `slug` may pin a known identity. These are proposal inputs,
not admission authority. Original-title lookup requires one exact eligible match
in the complete bounded result set; undeclared editions, ambiguity, sequels and
truncated results remain fallback. All supplied identity facts must agree before
image acquisition. A coverless port falls through to its identified original game.
Missing, ambiguous, mismatched or
unusable assets produce specific nonblocking cover exceptions and generated
fallback; a decoded image cannot establish semantic identity.

For a known regional cover, put `igdb_regional_cover` in the authored port record.
Pin the original IGDB game's `game_id`, `slug`, `name` and `platform_id`, then
the IGDB `localization_id` and `region_id` for the supported edition, and its
reviewed `cover_id` and `image_id`. Preparation verifies the localized cover's
relationship to that game and region. Refresh keeps the reviewed regional cover
when IGDB offers a different asset or the lookup is unavailable. A replacement
cover requires updating the pin and verifying the new image. If the pinned
image is confirmed Gone, the listing uses its fallback illustration. Only the verified image mapping goes into the
generated catalog and listing directory.

The assembled accepted records are the baseline. Artwork preparation also reads
accepted listing-only covers, so adding a managed integration can retain its
reviewed artwork. This artwork context has a separate evidence digest and does
not expand the accepted Core operational baseline. A changed source profile still
requires a matching explicit original-game identity to reuse that game's cover.
Unchanged port/source
identities reuse accepted mappings without provider requests; distinct ports may
reuse a uniquely accepted original-game mapping without merging their identities.
An ordinary executable release does not trigger artwork searches. For an assessed
reference change, `--refresh-artwork PORT_ID,OTHER_ID` explicitly refreshes those
batch entries. A failed refresh retains the matching permitted accepted mapping
for uncertain or transient failures, including HTTP404, authentication/network
errors and rate limits, without claiming live validation. HTTP410 from the fixed
IGDB image request identifies that exact image as Gone: preparation excludes it
from every reference in the output batch, regardless of record order, and records
its image identity/status. Existing exact-port/original selection can supply a
checked replacement; otherwise the generated/text fallback applies. Gone for a
different candidate image does not invalidate an accepted mapping. Unchanged
entries still make no provider requests. This bounded observation changes only
the unsigned proposal; accepted inputs, client choices/cache and protected
acceptance remain unchanged. It does not establish live provider removal or a
legal withdrawal.

The new output directory is required to be absent. It receives
`catalog-proposal.json` and `artwork-evidence.json`, including exact input/baseline
digests, artwork differences, per-cover reasons/checks/exceptions and request/byte
counts. No source catalog, client preference, signature or published feed changes.
Fresh image bytes pass the existing core decoder through the explicitly selected
trusted CLI and fresh task-owned scratch libraries. No new decoder or publisher
is introduced. Credentials stay maintainer-side; output carries fixed references
and digests, never credentials or image payloads. Scratch libraries retain local
validation material and are not a distributable image archive.

The provider route is sequential, has one lazy authentication attempt, no retries,
and bounds metadata/image requests, bytes and execution time. A valid `Retry-After`
on a captured metadata 429 or 503 postpones the next metadata request, preserving
the normal 300 ms floor. All three HTTP-date forms are interpreted in UTC,
including the zoneless asctime form, independently of the authoring host timezone.
Decimal seconds and HTTP dates retain the actual provider reset, including a
pause beyond the current 15-minute operation. Such a pause refuses further
requests without sleeping past the operation deadline. Metadata and image
429/503 responses preserve their separate retry clocks across bounded operations.
Waits and requests accept cancellation. Failed identities are not automatically
retried within the logical invocation, and uncertain failures retain eligible
accepted metadata. Fixed OAuth, metadata and image responses are consumed within
finite byte bounds or their unfinished bodies are cancelled when refused.
Cleanup does not drain rejected payloads or await an arbitrary cancellation
promise; reader locks and original failures are preserved. Retained references
are not fresh source-health evidence.
This command prepares the cover role only;
other roles, full backlog coverage, protected acceptance/publication and installed
or physical-platform evidence retain their own acceptance.

### Reference and exception maintenance

Use the existing catalog/onboarding maintenance checkpoint weekly. Run
`prepare-port.mts --artwork-ids @due --output-dir EXISTING_CHECKPOINT` to select
missing, invalid and then oldest observed references automatically against the
28-day refresh target. Unknown dates remain due. Explicit
`--artwork-ids ID,OTHER_ID --refresh-artwork ID,OTHER_ID` remains supported.
This is the existing operator cadence, not a new scheduler or player startup task.
Due refresh of a retained cover revalidates its approved IGDB game ID, slug
and cover role. An accepted mapping can be revalidated by exact ID and slug
even when the listing lacks an original title. This does not establish a new
artwork relationship or runtime eligibility. If the exact identity cannot be
confirmed, retain its allowed mapping. A different game or role needs separate reviewed preparation. Exact
confirmed Gone still removes the affected image references.
For a bounded retained-cover pass, add `--artwork-retained-limit COUNT` to
`@due`. This selects up to 400 due rows with an accepted cover or cover collection
and reports how many due rows were outside the current pass. An attempted row
goes behind rows with older attempts so unresolved identity holds do not starve
the rest of that workset. New and ambiguous cover identities keep their separate
review path. Ordinary executable updates do not refresh artwork.

A logical workset may exceed 400 IDs. The catalog generator's `--prepare-artwork`
runs a larger workset as consecutive operations of at most 400 IDs over the same
input, assembles the proposal per port and reconciles exact-image Gone observations
from every operation into all records. Ports outside an explicit workset keep their
unchanged input until that reconciliation, so each one a Gone image withdraws gets
its fallback record and invalidated ID. Game-media records from earlier operations
are relabelled when a later operation finds their selected image Gone. Those
operations share one provider budget; that path neither adapts admission nor
checkpoints progress. The prepare-port
driver admits operations of at most 400
selected IDs and adjusts subsequent admission using observed elapsed time,
requests and image bytes. Completed identities are atomically checkpointed after
each result under the existing preparation lock. Reinvoke the same full workset
after interruption or provider recovery: unchanged successful IDs are reused;
changed per-ID identity, relevant accepted-original mappings or validator bytes
invalidate the affected result. Ordinary preparation and explicit or due refresh
retain separate per-ID results so an ordinary run preserves the last live
refresh observation. Explicit and due refreshes reuse completed live observations
for up to 28 days. An older or unknown observation requires a new bounded read.
Earlier attempt receipts remain available. The exact old whole-batch reader
serves ordinary preparation in pre-#3766 checkpoints with no per-ID progress. It can retire when those checkpoints no longer need to resume.
A provider-blocked operation leaves its IDs pending while later unrelated or
offline work continues. A fully deferred operation is never blindly retried.
Provider Retry-After dates remain durable, and incomplete work never claims
successful full maintenance. Retained mappings after unavailable refresh remain
pending. Proposed records still require the existing review and delivery route.

The full input retains its bounded 10,000-record authoring contract. Each provider
operation retains 800 metadata queries, 400 image queries, 32 MiB metadata,
512 MiB images, 16 MiB per image, 15 minutes and 15 seconds per request.
Processing remains sequential with at least 300 ms between metadata starts,
one lazy authentication attempt per invocation and no failed-request retries.
A bounded 32 MiB metadata memo avoids repeated matching, image downloads and
decoding within the logical invocation. Memo reuse retains the earliest actual
observation clock; it cannot make old facts fresh. Per-ID checkpoint documents
are bounded to 8 MiB and contain metadata and digests, never image payloads.

Unknown or repeated IDs and changed artwork identities outside the selected
workset are refused. Results merge by stable ID. An exact-image Gone observation
removes every matching output reference, including unselected and checkpointed
records, without additional provider queries. Accepted source records, user
choices, source licensing and offline fallback stay authoritative. Only a
changed accepted image needs new semantic review and affected display validation.

Recheck the bounded missing-fact/resume exceptions at the same checkpoint; query
again when attributable facts, asset/provider state or a previous transient
failure changes. Preserve one current exception per stable port/role rather than
opening another owner queue. Absence of a current admitted definition stays with
its existing per-port/onboarding owner; it is not a successful artwork exception.

The [official IGDB documentation](https://api-docs.igdb.com/#rate-limits), checked
2026-10-18, permits four API requests per second and eight open requests.
Its [image guidance](https://api-docs.igdb.com/#images) says removed/replaced images
remain on its servers for 30 days. That is server behavior, not an observed expiry
or an image-retention license. The [caching FAQ](https://api-docs.igdb.com/#faq)
allows caching API data; it does not establish rights to bundle, mirror or export
a particular image. Keep maintainer authentication private and existing attribution.

Transient failure/404 preserves only eligible permitted known-good state and
reports uncertainty; an observed HTTP 410 or a concrete withdrawal/invalidation stops
that image's reuse in the proposal, preserving the exact reason and scope. Prepare
a validated replacement or generated fallback through the existing protected
catalog correction route. Retained bytes are not permission to continue a known
forbidden use. Client propagation needs its own accepted signed correction; an
unsigned maintenance report cannot revoke trust or mutate installed libraries.
Local imports/choices/corrections and unrelated game data remain independent of
remote cache eviction. Broader production correction remains with #1155/#246/#534.

Generate the embedded catalog with
`node scripts/generate-catalog.mts`, then run selected local checks and the opt-in
`just desktop-verify --scenario native-default-cover-display --require-clean`.
That scenario derives its cover inventory from the actual native catalog, checks
every mapped cover in both themes, and captures representative detail surfaces.
Live CDN evidence is separate from ordinary offline CI and signed publication.

For managed setup, `setup_output_paths` declares safe relative generated files
or directories. They cannot overlap game/setup executables, persistent data,
disposable runtime state, the materialized source, or one another. The completion
marker must belong to a declared output path. Older definitions may omit
the field and remain readable, but cannot acquire the explicit preparation-plan
capability without a reviewed output contract. These paths add no manifest
exclusion or permission to trust newly hashed files.
Output paths are relative to the install root; setup markers, persistent paths,
and disposable runtime paths are relative to the runtime working directory when a
nested runtime is declared. Managed preparation permits that nested working directory only for
the upstream-managed adapter and still checks every generated path against the
install and runtime ownership boundaries.

Generated setup trees use a separate portable-path check from downloaded
archives. It preserves Unicode names byte-for-byte, rejects traversal,
Windows-unrepresentable names, and collisions under NFD full Unicode case
folding with default-ignorable code points removed. It does not apply
compatibility normalization that could merge distinct names. Library transfer
and import use the same check so verified generated assets keep their names when
copied. The stricter ASCII archive-member policy remains in place for downloaded
packages.

The OpenGOAL family declares `data/iso_data`, `data/decompiler_out` and `data/out`,
following the [extractor](https://github.com/open-goal/jak-project/blob/ce97ce959b8c773097f593bf42f470555f6a6e2b/decompiler/extractor/main.cpp)
and its [decompilation output](https://github.com/open-goal/jak-project/blob/ce97ce959b8c773097f593bf42f470555f6a6e2b/decompiler/decompilation_process.cpp)
contract. The exact Windows Jak 1 extractor from OpenGOAL v0.3.9 also creates an
[empty compiler directory tree](https://github.com/open-goal/jak-project/blob/b6c8430c0b0a5cb139b939bcf0ffd25285b896c7/goalc/build_actor/jak1/build_actor.cpp#L641-L647)
at `out/jak1/obj`. After the extractor has settled, Portcove discards only that
fresh empty tree in private staging. Existing data and unexpected entries stay
subject to the normal output checks. Saves and `data/log` remain separately owned.
These declarations are implementation facts, not new artifact or platform qualification.

PaperBoat uses the same isolated preparation transaction through the
Libultraship adapter. Portcove normalizes the registered Paper Mario source to a
private big-endian `.z64`, runs only the checksum-qualified PaperBoat executable,
and admits `pm64.o2r` plus the optional Torch hash record as version-owned output.
The upstream setup window remains visible; after generation the user chooses its
close option rather than launching outside Portcove. `SHIP_HOME` points at the
private copy during setup and at canonical user data during supervised play.
Generated game data therefore rolls back with its release, while saves,
configuration and mods remain separately backed-up player data. Logs remain
disposable. This contract does not claim a ROM, gameplay, Steam Deck, macOS, or
unpublished-release qualification.

Open Nectar 0.8.5 creates a `shader_cache` directory beside its Windows runtime
on launch. The catalog treats that exact directory as disposable runtime output;
its `save` directory and `pikmin_settings.conf` remain Portcove-managed player
data. Preparation capacity checks reserve a full GameCube disc image for
materialization and a separate disc-sized allowance for generated setup output,
in addition to the copied installation; the registered compressed file size
alone cannot represent that peak. The [2026-09-24 Windows observation record](qualification/open-nectar-pikmin-windows-observations-2026-09-24.md)
describes setup, startup and persistence evidence and its limits. This runtime
observation does not establish gameplay qualification.

`crates/portcove-core/catalog/catalog.json` is the machine-readable authority
for actual ports, platforms, upstream sources, release channels, adapters,
source contracts, and qualification evidence. The catalog grows continuously
and independently of Portcove's product release stages. Durable prose must not
copy its current count or maintain a second title list.

## Continuous admission

A candidate is eligible when it has an attributable upstream or accepted
user-provided-runtime route and a useful operation Portcove can perform safely
on at least one declared platform. Record acquisition authority, exact artifact
identity where bytes are acquired, required game-source identity, and the
platform and operations actually offered. Each offered operation needs its own
bounded executable, setup, ownership, consent, persistence and recovery
contract. Unknown saves may coexist with non-destructive launch; they do not
authorize replacement, cleanup, backup, restore or deletion of unowned bytes.
Missing gameplay observations, active upstream maintenance, automatic updates,
complete save mapping, every platform, or a reusable family adapter are not
universal admission gates. Prefer an appropriate official package, supported
upstream preparation or useful non-owning existing installation before a
title-specific exception. An exception needs an identified consumer and bounded
maintenance reason; disproportionate downstream engine repair/build work can
instead justify a precise upstream dependency or product deferral. Any retained
glue uses the shared acquisition, transaction, persistence and lifecycle owners.
A bare upstream link or placeholder is not an integration.

Schema-2 GitHub proposals may carry `release.curated`, keyed by declared platform.
Each version-1 record binds repository/upstream, canonical original GitHub release
asset URL and host, release/tag/commit/asset identities, platform/route, safe
filename, nonzero size and canonical SHA-256. Acquisition, distribution,
independent-review and protected-acceptance evidence references carry bounded
HTTPS locations and exact declared digests. Distribution basis is explicit.
These are inert declarations: shape validation does not authenticate the
referenced evidence, publisher, build or distribution permission.

The existing Core proposal inspector includes each record's declaration hash
alongside its port hash without fetching or changing anything. Empty maps are
omitted from serialized definitions, preserving existing declaration identities.
Schema-1 and non-GitHub curated proposals are refused. Custom providers and
legacy managed GitHub grants refuse curated declarations. The explicit
[schema-4 capability](DEFINITION-DELIVERY.md#exact-definition-availability-policy)
requires independent policy admission, exact fresh upstream identity and the
shared byte verifier; library schema 36 retains immutable accepted identities
against silent repinning and authenticated scoped transition receipts. Exact
artifact revocation holds acquisition and critical installed use; distribution
withdrawal holds acquisition while permitting local use under existing guards.
Future-acceptance loss is a separate fact and does not revoke historical bytes.
Neither expiry nor omitted transitions erase a recorded hold. Record preparation
still grants no runtime authority.
[#315](https://github.com/boburning/portcove/issues/315) remains incomplete until
verified cache reuse, scoped holds, recovery and lawful canary qualification
establish the full offered route. No client-observed self-hash acceptance is
introduced by record preparation.

GitHub Stable selection excludes provider-declared prereleases, existing
hyphenated development markers, and case-insensitive numbered beta suffixes
such as `Version1.0.5beta12`, even when upstream leaves its prerelease flag unset.
Preview (`beta`) selection still requires the catalog to declare that channel; classification
does not grant compatibility or installation authority. No selectable stable
release produces an unavailable result, rather than falling through to a beta.

Managed `staged-source-portable` execution requires complete immutable install
verification, including nested package selectors previously recorded as
noncritical. Retained adapter identity selects this policy; changing the current
catalog cannot remove it. The existing mutable and generated-metadata rules
remain in force, while recorded immutable files cannot become exempt through
new mutable declarations. Inventory refuses redirected/unsafe filesystem objects
and is bounded to 100,000 entries and depth 64. These sequential observations
provide no filesystem snapshot or execution sandbox. External user-prepared
inspection remains its separate non-owning route.

API 80 / staged-source version 20 adds an explicit `trust: "user-selected"`
existing-installation route. The definition supplies identity and useful setup
instructions; the player selects a native executable, working directory and
bounded argument array. Core reviews those exact inputs, confirms execution
intent and retains them for supervised launch. It checks executable/path safety
and refuses script launchers and library-owned locations. It does not certify an
official package, require a catalog-pinned immutable tree, inspect unrelated
external contents or acquire ownership of them. Runtime replacement belongs to
the player or selected upstream launcher. Only launch and registration removal
are offered; external installation, save and settings files remain untouched by
removal. The launched program can make its normal writes; this is no sandbox. The
[ECWolf reference](reference/ecwolf.md) records an official-package example with
non-owning Windows/Linux/Intel Mac/Apple Silicon registration, separate Android
setup and external data locations.

Naev's external route selects the complete upstream Windows installation or Mac
app, with its native player and containing working folder. Windows portable
`datapath.lua`, Mac bundle resources and upstream profile migration keep their
existing behavior. Keep current and predecessor profiles recoverable before an
upgrade. Upstream/player own package replacement, saves, settings, plugins,
backups and removal; Portcove removes only its registration. Linux retains the
upstream AppImage guide until a complete native environment contract fits the
existing selector. Package/source inspection does not establish native loading,
graphics, gameplay or minimum-host qualification.

FreeOrion's external route tracks the selected graphical client. Its upstream
server and AI processes can finish shutdown after that client exits; optional
local multiplayer hosting can keep a separate server. Registration grants no
server ownership or whole-installation quiescence. Keep the complete upstream
installation, wait for actual writers before copying or changing external data,
and use upstream/package-manager updates and backups. The reviewed Ubuntu native
selection uses its real player and package data working folder, preserving the
wrapper's startup coordinates without selecting a script.

Supervision and launch results describe the selected native program; only a
definition with the reviewed Windows tracked handoff also waits for in-folder
successors in its process tree. An upstream launcher can hand off and close
while the game continues;
activity completion or registration removal neither stops that successor nor
establishes that external files are safe to replace or recover. Close the actual
game and its helpers before upstream maintenance. Managed packages retain the
full-lifetime requirement and its tracked-handoff boundary above.

This mode has empty archive/tree/executable-hint/mutable-path declarations and
cannot combine with source invocation, managed policy, bundled runtime, setup
or managed-build hooks. Historical source-catalog identities remain preserved
without an active source binding or a source-validation claim. New retained
records explicitly distinguish user intent from accepted-package certification
and make older readers refuse the new meaning. Unknown trust values are refused.

Catalog schema 1/2 supports hosted or exact direct-manifest package installation
through its existing adapters. The `user-prepared` release route is separate:
an official definition pins the package's exact archive identity and the
immutable extracted tree, executable, platform, and explicitly mutable game
output. Core only inspects and records a player-owned folder; it does not
acquire, extract, own, update, back up, relocate, or delete that folder.
Only catalog entries that declare and qualify this route offer it. [#1169](https://github.com/boburning/portcove/issues/1169)
owns the first real-port qualification and its remaining end-to-end evidence.
An optional `presentation.manual_preparation` gives the exact player-created
steps for a user-prepared runtime; the short port summary remains an outcome
description. Wave Race registrations made under the retired pilot keep their
requirement for an empty `portable.txt` beside the executable, in addition to
the extracted upstream ZIP files; its current catalog installs the same package
as a managed route ([record](qualification/wave-race-64-recomp-managed-acquisition-2026-11-13.md)).
Optional `presentation.manual_setup` supplies authored `steps` (one to eight
objects with nonempty `title` and `instruction`), up to eight essential `warnings`,
and an optional HTTPS `help_url` without credentials. Include `warnings: []`
when no warning is needed; omitting the required array does not produce a
Core-readable guide. Use preparation's Core inspector
or the required catalog checks to validate the complete projection. These
presentation facts are never executable recipes or evidence that a step was
completed. Current prepared routes supply them separately from the retained `manual_preparation`
compatibility and technical notes. Older definitions keep their prose fallback.
Clients keep warnings visible, show numbered steps, and disclose the longer notes
without parsing free-form prose or changing file/operation authority.
Write each player step around one action: what to download, which original files
are needed, what to select, and what happens next. Follow
[content design](CONTENT-DESIGN.md#start-with-the-players-task). Keep exact editions,
filenames, sidecars, commands, save locations and permission warnings. Put dated
inspection evidence in compatibility/technical notes where the schema offers
them. Missing edition or hash information is a limitation to explain, not an
instruction to inspect internal research fields. Review the complete guide in
context; a shared paragraph rewrite does not qualify every game's instructions.
A platform-specific prepared spec may opt into `library_user_data: true` for
`staged-source-portable`, with a safe `user_data_environment` name on the port.
After retained-package and original-source revalidation, Core creates only the
private `<library>/user/<port>` directory and binds its absolute path for launch.
Existing private contents are preserved; missing parents, links and non-directory
paths are refused. Omitted or false flags create no directory and bind no variable.
This declaration requires staged-source template contract version 2. It does not
migrate AppData, qualify an upstream package, or grant update/backup ownership.
Removing the external registration preserves both the external folder and private
user files. No current title is admitted by this generic engine component.

API 79 / staged-source template version 18 adds the opt-in prepared spec flag
`source_directory_environment: true`. It requires `staged-source-portable`, a
`relative-file-set` source profile, and a safe port `source_environment` name.
Core revalidates the retained runtime and original-source contract, requires a
real directory without redirected ancestors, then binds its absolute path through
that variable. An otherwise valid relative-file-set ZIP is incompatible for this
route; Core does not extract it. Authored fixed arguments remain available, while
caller-forwarded arguments are refused. This flag cannot combine with a positional
source extension, settings/shared-preferences selector, or the version-17 Windows
positional-file path policy. Omitted/false retains previous behavior.

The binding uses the relative-file-set verifier and its bounds. Exact declared
members are authenticated; additional scanned files are not thereby
authenticated as a complete original tree. This binding grants no runtime write
protection, source ownership, assembly, acquisition or update authority. A source
directory alone does not establish a safe title route. Opt-in registrations retain
the strict contract envelope so older readers refuse rather than ignore this
binding; indexed definitions must declare a minimum staged-source version of 18.
Private user data can reuse `library_user_data` after source verification. No
re:Blue definition, game-data hashes, executable, or operation acceptance is added
by the generic capability.

Mutable paths exempt player-owned output bytes from the immutable digest, not
from filesystem safety. Every regular mutable file must have exactly one
filesystem link during both sweeps of full prepared-runtime inspection, including
the inspection before launch. This applies even when no required selector is
declared; a hard-linked save or settings file could otherwise redirect a game
write into the original installation or other data. Independent mutable content
may still change without changing package identity. These observations do not
freeze player-owned paths after inspection or provide an execution sandbox.

A `staged-source-portable` prepared spec may declare up to 64
`required_mutable_files`, each an exact relative file path within its declared
`mutable_paths`. Portable path keys must be unique, including case aliases.
For example, The Force Engine's portable selector is a mutable `settings.ini`:
its presence selects the program directory instead of host Documents, while its
contents legitimately change. Core observes each required file as a regular,
non-redirected file with exactly one filesystem link before inspection, at the
final callback-free inspection boundary, and during registered-location readiness.
Missing files, directories, symlinks, reparse paths and hardlink aliases refuse
readiness or the affected review/launch operation. Contents are neither hashed
into immutable identity nor frozen between observations. These checks do not
provide an atomic tree snapshot or an execution sandbox.

This declaration requires staged-source template contract version 4; versions
1–3 and omitted/empty declarations retain their previous behavior. Independently
delivered entries must declare version 4, and complete typed projection prevents
an older reader from silently dropping the new constraint. The retained
registration contract continues to enforce it after a current definition changes.
Registration creates no selector, claims no external ownership and changes no
original files. Preparation instructions must explain how the player creates
the reviewed selector; removal of registration remains available if it is missing
and preserves all external files. This capability alone admits no TFE package,
source input, native operation or managed maintenance route.

Registrations using required mutable files retain the existing strict contract
envelope instead of a raw catalog document. Older external-runtime readers
refuse that envelope because they require a raw catalog's schema and port list;
they cannot silently drop the selector requirement after a client downgrade.

Staged-source version 5 adds the optional `settings_contract` value
`tfe-dark-forces-v1.22.420`. This is a narrow read-only contract for the pinned
Windows x64 TFE parser, requiring version `1.22.420`, a root executable/working
directory, no runtime subdirectory or launch arguments, no source argument or
private user-data binding, and required mutable `settings.ini`. `GameData` must
remain wholly immutable; all four GOB files must be regular, non-redirected
objects. The accepted tree authenticates their bytes and required companions.
The settings reader requires one effective `[Game] game="Dark Forces"` and one
`[Dark_Forces] sourcePath="GameData/"` assignment. It checks the existing opened
selector at each inspection boundary, without writing settings or granting
ownership. Other preferences remain mutable.

This reader follows the consequential rules in TFE commit
`cc25205cc94c36a396f6f50295772f6ec83069a2`: case-insensitive section/key/game names,
whitespace/comma/equals separators, comments even inside quotes, and empty-quote
tokens. It conservatively refuses malformed sections, duplicate effective
selectors, unmatched quotes, NUL bytes, files exceeding 1 MiB, raw lines of
4096 bytes or more, tokens of 1024 bytes or more, and decoded CVar values of 256
bytes or more. A string CVar's second space-delimited word must also contain at
least two bytes when present, avoiding the pinned reader's empty-tail write.
Forwarded launch arguments are refused using the retained declaration before a
launch session is created. These limits protect the reviewed line/token/CVar buffers;
they do not establish general upstream memory safety. Valid selected data prevents
Dark Forces source fallback while observed valid; TFE may still probe host paths
for other games. Sequential observations neither freeze player writes nor
provide a sandbox.

Independently delivered entries must require version 5. Retained registrations
reuse the strict installed-contract envelope: older v4 readers reject the
noncanonical projection when they cannot preserve this field. This refusal
does not extend to newly supplied plain legacy catalogs, whose older decoders
may discard unknown fields. Such catalogs are not a compatible delivery route
for this declaration. The component alone admits no TFE package or source and
claims no native operation, production-client delivery or managed maintenance.
Both ordinary and bounded readers decode the same retained contract. Registrations
without this opt-in keep their existing encoding; no library-wide schema migration
or external-file ownership is introduced.

Custom cartridge creation capabilities 6, 7, 9, 13 and 14 are retired.
The old N64 v3 CVLoD recipe is also read-only compatibility. New definitions
cannot offer these builders; retained installed contracts preserve their exact
historical runtime meanings. See
[retirement and consumers](reference/upstream-first-compatibility.md).

Staged-source version 8 adds optional prepared-runtime `shared_preferences`
with the single value `regaiden041-windows`. It is restricted to the exact
ReGaiden 0.4.1 Windows x64 archive and staged-source use-in-place route. It
accepts no arbitrary external path. Windows resolves the shared roaming file
`gbrecompiled/runtime/runtime_prefs.ini` without creating it. Review discloses
the resolved path, current account fingerprint and present/absent state;
registration requires explicit acknowledgment of that exact preview. CLI
requires `--acknowledge-shared-preferences` with `--expected-preview`, in
addition to ordinary consent; Desktop presents a separate native acceptance.
Generic confirmation or the legacy Core authorization method cannot opt in.

The retained binding preserves the accepted account and path. Preference
contents may change normally; safe directory ancestors and a regular
single-link file are rechecked before launch. Account/path changes require
fresh registration. Other copies can overwrite this shared file and discard
unknown entries. Portcove does not own, migrate, back up, restore or delete it.
This is an explicit shared write scope, without private isolation or a sandbox.
Forwarded launch arguments are refused for this exact prepared contract.

This closed contract supplies `--rom` before the separately validated raw
`.gbc` source. Its only catalog arguments are `--save-dir saves`; an existing
safe `saves` directory is required. The five game-owned mutable paths are
`config.ini`, `runtime_prefs.ini`, `imgui.ini`, `saves` and `snapshots`. Review also discloses
the local preference fallback. Existing files must be regular and single-link,
and existing ancestors must not redirect through reparse points. Inspection,
registration and removal create no preference or save data. Printable ASCII
Windows paths and a conservative MAX_PATH allowance for generated transaction
filenames preserve the selected runtime's narrow-path behavior. These are
sequential path observations, not filesystem isolation after launch.
Indexed entries using this exact shared-preferences contract require minimum
staged-source version 8. Earlier public versions remain available only for their
implemented contracts; retired creation versions 6 and 7 are absent from the
public inventory. Private retained readers preserve their identified historical
runtime contracts without admitting new builds. Older readers that cannot
interpret shared preferences refuse through the existing strict envelope. See
[capability negotiation](DEFINITION-DELIVERY.md#implemented-engine-capability-negotiation)
and the [compatibility record](reference/upstream-first-compatibility.md).

Existing managed cartridge runtimes retain their original executable, arguments,
source receipt, mutable paths, protected companions and environment restrictions.
Preserving those readers does not retain source generation, engine patches,
compiler/linker orchestration or SDK acquisition. New Yoshi, Dr. Mario NES,
EarthBound, Render96 and Gundam definitions offer bounded user-managed
registration. Gundam's own supported setup pack performs generation and builds.
CVLoD continues to select official upstream packages; a new release does not
inherit private repaired-runtime or prior shipping-package observations.
Historical preparation instructions and failure receipts remain linked in the
[compatibility record](reference/upstream-first-compatibility.md).

Staged-source version 17 extends the printable-ASCII/MAX_PATH policy to a
Windows-only user-prepared runtime with a positional original-file argument.
The complete retained definition must require capability 17; managed version 11
keeps its existing meaning. Registration and folder changes check the canonical
executable and actual working directory. Readiness and launch also check the
selected registered original or source override, because these runtimes receive
that external path directly. Launch repeats the checks before child creation and
refuses caller-supplied arguments. Shared-preferences variants are outside this
narrow combination. This adds no acquisition, modification, backup or removal
authority over the external runtime or original files, and implies no particular
port's admission or actual operation acceptance.

For ordinary hosted installations, Core checks a provider digest or verifies a
checksum sidecar. For an exact direct manifest, each platform needs an accepted
HTTPS URL, size, version and SHA-256. For a curated GitHub artifact, Core obtains
the expected identity from an independently admitted record under authenticated
publisher policy. It checks the selected upstream release and asset, then verifies
the acquired bytes against the accepted size and digest. A client-computed hash
alone cannot establish provenance. See the [acquisition decision](DEFINITION-DELIVERY.md#acquisition-decision)
and the [remaining shared rollout acceptance](https://github.com/boburning/portcove/issues/315).

Every declared platform must provide at least one executable hint. A hint is an
ASCII safe relative path under the declared runtime root; a basename remains a
legacy shorthand only when it identifies exactly one file. Ordered alternatives
do not make an ambiguous basename acceptable. Catalog validation rejects
missing platform entries, duplicate hints, traversal, cross-platform filename
aliases, and macOS bundle directories in place of the executable inside the
bundle.

### Release selection and maintenance

Core's exact release selector binds one port, platform and channel to a specific
tag or declared direct-manifest version, filename, size and SHA-256. GitHub
revalidates the numeric repository, release and asset IDs, published digest and
tag commit. GitLab revalidates the numeric project, release-link and registry
file IDs, registry digest and tag commit. The configured direct manifest can
resolve only its declared stable package.

Exact checks apply the catalog's package, platform and channel rules. They
revalidate provider metadata independently of the latest-release cache. A
missing or changed artifact returns a hold for that selection. Curated
integrations continue to require their separately admitted acquisition route.
A matching selector describes provider metadata. The installer still verifies
the downloaded bytes and applicable package layout before activation.
Review evaluates the port's typed acquisition restrictions for the observed
version and SHA-256 with the same final artifact gate that install and update
apply, so a held package is refused at review with the restriction's
explanation; a permitted package of the same port can still be pinned.

A saved pin that Core cannot decode, or that names a channel the port no longer
follows, becomes that port's `exact_release_hold`: other ports' status,
checks and export are unaffected, the held port's checks and installs refuse
instead of following the channel, and Follow clears it. Library metadata
carries such a pin's stored text unchanged in `held_exact_release` (schema 13),
so the destination keeps the same hold.

Release asset hints should identify a stable port, platform, architecture and
package shape when automatic release selection is offered. A controlled N/N+1
test supports an automatic-update claim; it is not a prerequisite for a useful
pinned-release integration. If the selector cannot safely follow an ordinary
compatible release, record that limit and the exact condition for enabling
updates. A deliberate `DirectManifest`, rolling tag, source/runtime identity or
exact qualification record must not be broadened to manufacture automatic
updates.

For a managed GitHub route, `release.github_other_stream_tag_prefixes` can
exclude a reviewed upstream stream on a specific supported platform. Use it
for independently published add-ons or other platform streams with documented
tag prefixes. Core excludes these tags even before asset collection. Releases
in the selected stream with incomplete package evidence still hold. Review the
existing tag history before adding a prefix and retain exact package verification.

#### Artifact roles and fact sources

Core gives every release asset it classifies a typed role, target operating
system, architecture and fact source (`crates/portcove-core/src/route_facts.rs`).
Only a `desktop-game-runtime` role may become a launch target. A consumer
checks a fact's `source` before treating its role as authorized.

Sources are consulted in this fixed precedence; the first with a definite role
wins:

1. `release-metadata`: machine-readable metadata the release publishes.
2. `exact-release-structured`: a reviewed observation of the exact archive
   bytes, such as a [generated package shape](#generated-reviewed-package-shapes).
   Its player candidates exclude toolchain, installer, server and
   development-tool programs beside the player. From shape version 2 it names
   the version and each player's path, header machine and SHA-256 (see
   [player candidates](#package-shape-player-candidates)); an archive with any
   version 1 entry keeps the version 1 path-only candidates.
3. `provider-cross-reference`: another provider's reviewed record.
4. `family-extractor`: a bounded, versioned extractor for one release family.
5. `stable-declaration`: a reviewed selector of the route matched the asset,
   such as every reviewed asset hint for the platform or a curated pin.
6. `filename-suggestion`: filename tokens, versioned by `rule_version`.

A filename suggestion never authorizes a runtime. Selection by generic
filename scoring, without a matching reviewed selector, records only a
filename suggestion and keeps today's selection. Two authorizing sources that
disagree about the role make the role unknown; when authorizing sources
disagree about the host, the host is unknown rather than a refusal.

What this release enforces:

- A package named only for another operating system is never selected for this
  host.
- A release whose players are all for other hosts (another desktop, Android,
  iOS or a console) is outside this platform's stream. A fresh install takes the
  older release this host can use; an installation of the newer release is held
  with `installed-release-newer-than-host-candidate`, never offered the older
  one as an update.
- Server, checksum, signature, symbol, source and license-compliance files keep
  their existing exclusion from package selection.

Reserved for later slices: refusing an asset whose authorized role is an
installer, builder, importer, compiler, development tool, original-game input,
mobile package, console output or documentation. The `wrong-role`,
`wrong-host` and `contradictory-role` holds only fire when an authorizing
source makes such a claim. In this slice, a reviewed package shape claims a
desktop runtime and a matching reviewed selector claims the route's host, so
none of the three triggers for current catalog entries. Prefer adding
release-owned or structured facts over adding filename tokens or
title-specific selectors.

An ordinary compatible upstream release must resolve and install with the same
application and unchanged definition. Author the reusable integration rules;
let the existing provider observe each release's version, asset ID, exact name,
URL, size and independent digest. Core retains those exact facts with the
installed artifact. A per-release JSON edit or automatic version-bump PR is not
compatible progression. Historical source links and qualification hashes remain
exact observations; their presence alone does not pin provider selection.
Managed preparation records observed release facts in its receipt and preserves
authored listing links, including a useful separate upstream launcher. It does
not add a current-tag listing URL to an otherwise reusable managed definition.

Preparation flags delimited dotted release tokens, including older versions absent
from the observed tag, for applicability review. This advisory is not a numeric
capability classifier; architecture, ABI and engine-generation fragments remain
valid selectors. Prefer stable discriminating fragments, including the actual package
variant. Preserve numeric ABI/engine-generation requirements where intentional.
Test unchanged rules through the production provider for N, N+1 and a fresh
installation after N+1, including competing variants, foreign architectures and
successor-specific integrity evidence. Ordinary observed release changes from a
continuing uploader (below) do not add a mandatory maintainer review or full
gameplay campaign. Changed setup,
executable/data coordinates, ownership or package handling can require a reviewed
rule change; existing transition and recovery guards still apply.

A reviewed download can retain a native GitHub package choice in its install
manifest. This applies when two authored hints cover the full filename around
the exact three-part numeric release tag, and GitHub supplied the stable
repository, release and asset identities. On the beta channel, this also
covers full tags ending in `-alpha`, `-beta` or `-rc`, with an optional dot
and number. Core recovers that choice from the verified acquisition and the
definition retained when the package was installed. The next package must
include its full tag. Additional edition or debug labels need their own
reviewed binding. Core remembers the channel, host
architecture, native mode, package anchors and any declared original-source
profile. The next release must offer one verified package with the same
anchors around its own version. A missing or competing match holds the
update. Ordinary package eligibility, uploader, digest and activation checks
still apply. An installation without the required retained evidence uses
ordinary selection. An explicitly selected different channel and exact curated, direct or rolling
pins use their existing release contracts.

When an upstream release still matches a managed route's selector but changes
reviewed setup, replacement or data behavior, contain it with the integration's
[acquisition restrictions](#acquisition-restrictions) instead of port-specific
Core code. Two canonical forms are deliverable as the generated
`managed_acquisition_hold`. A route-wide transition hold has an `acquisition`
hold on `download`, `install`, `update` and `adopt`, an `activation` hold on
`activate`, and one `reviewed-N` permit on `activate` per reviewed artifact.
It refuses fresh Install, Update, catalog download and managed adoption before
provider contact, and refuses activation and recovery of a staged or
interrupted package unless its version and SHA-256 match a reviewed permit.

An exclusion form scopes `excluded-acquisition` and `excluded-activation` holds
to exact artifacts and adds one `reviewed` permit on `install`, `update` and
`activate`. It identifies excluded packages by version and SHA-256. If the
selected platform's package matches an exclusion, Core looks for a reviewed
permit match on that platform and channel and includes the hold
explanation in the install plan. Release observations record `reviewed-artifact-excluded`
for the candidate and retain the selected fallback as its own result. The fallback
must match the reviewed digest using
GitHub asset metadata or the publisher's checksum sidecar. Other releases go through ordinary selection and trust
checks. An excluded package cannot be activated from staging or recovery.
Installed copies retain their existing Play, backup and removal checks. A player
can choose the reviewed fallback through Update when the installed artifact
differs from the selected fallback.

Review changes to the hold on the canonical port issue. A selected independent
definition may keep or add restriction: every embedded hold must remain with at
least its operations and scope, and every permit must already be reviewed in
the embedded definition. It cannot drop an exclusion or add a reviewed fallback. Embedded catalog changes reach players
with an application release. Independent delivery remains with #246.

An integration may also record `reviewed_package_layouts`, one bounded fingerprint
per platform, so a release that matches the selector but changes shape is held
without a maintainer edit. The fingerprint lists the lowercase top-level directory
names and the package-relative path of every program or script (`.exe`, `.appimage`,
`.bat`, `.cmd`, `.ps1`, `.sh`, `.msi`, `.jar`, `.vbs`, `.lnk`, or an executable mode bit
on non-Windows packages), so a moved or duplicated launcher is drift. Libraries such as
DLLs are not fingerprinted.
One wrapper directory beside nothing else, such as a versioned folder name, is
looked through. Core compares the extracted staging tree to the fingerprint after
extraction and before any activation. An unchanged layout proceeds as an ordinary
compatible release; plain data files, documentation and libraries may change. A
different layout is refused with a player-facing reason naming the new or missing
programs and folders, leaves the installed copy untouched, and uses the existing
unsupported-acquisition surface, not a new hold authority. Platforms without a
fingerprint keep today's behavior.

An integration can retain up to four predecessor layouts per platform under
`reviewed_predecessor_package_layouts_v1`. Each fingerprint applies to the exact
verified GitHub repository, release, asset, tag, channel, filename, size and
digest in the normal acquisition. The current full layout applies to other
eligible packages. Portcove compares one complete layout and keeps the existing
download rules, player release selection and retained install contracts.
Signed delivery requires native-portable capability 42. Archive inspection
reports an unassessed scope when matching predecessor bytes lack exact
provider attribution. The scheduled metadata handoff supplies context for the
existing exact predecessor, while a different provider assignment must be
established by the ordinary acquisition route.

An independently reviewed managed GitHub archive with only the selected root
executable and no fingerprinted directories can declare
`reviewed_flat_package_layout_v1` as the ordered list of reviewed platforms.
The existing executable hints supply the basename in the generated fingerprint.
Keep the actual package selectors, executable hints and all runtime, original
game and qualification facts explicit. Preparation proposes this form only
when a previously reviewed fingerprint reproduces the existing integration byte
for byte. Archives with extra programs, directories or package-layout options
keep their explicit fingerprints.

For an official Linux archive with a dedicated portable-data directory, omit
that directory from the reviewed layout. Core checks that the executable's
declared data directory is absent or empty before comparing the package layout.
An empty directory at the observed package root does not count as package drift.
This combination requires native-portable version 32.

For the official OpenMoHAA Unix ZIP routes, record the reviewed layout after
Core verifies and grants execute permission to the title launcher and engine.
The ordinary archive inspector reports publisher modes, so it cannot supply
this prepared layout directly. This combination requires native-portable
version 33.

macOS layouts may opt into `ignore_verified_macos_libraries` when an upstream
archive stores patch-versioned shared libraries with execute permission. The
classifier excludes a matching library filename only when bounded native header
inspection identifies it as a shared library. Executable-mode files with an
unknown or contradictory type still count, including license text packaged
with execute permission. Existing fingerprints continue to use their declared
rules. The matching authoring observation is `catalog inspect-package-layout
--ignore-verified-macos-libraries`.

Linux x86-64 layouts may opt into `classify_linux_programs_by_format` when an
upstream archive marks data, documentation or versioned shared libraries
executable. An executable-mode file then counts only when it starts with an ELF
or `#!` header, and a `.so` or `.so.N` file is excluded only when bounded header
inspection finds an x86-64 ELF shared object with a dynamic segment and no
program interpreter. A position-independent program, an ELF program named like
a library and any program or script name above still count. Windows libraries
remain outside the fingerprint, as on Windows. Two residuals follow from the
rule. An executable-mode text file without `#!` is excluded, although a
reviewed `.sh` launcher could still run it through the shell. A static
position-independent ELF program named `*.so` has no interpreter and is
excluded like a library. The gate has never fingerprinted file contents or
libraries, so these residuals do not weaken an earlier guarantee. The matching
authoring observation is `catalog inspect-package-layout
--classify-linux-programs-by-format`.

Independent definitions using this gate
require [NativePortable version 18](DEFINITION-DELIVERY.md) so readers that
would ignore the field cannot accept them. The macOS library filter requires
version 30 and the Linux program format classifier version 36. A selected
independent definition
may replace a fingerprint after review but cannot remove one. The fingerprint
applies to staging and grants no
qualification. Persistent-path anchors stay in the existing `persistent_paths`
data. Exact-name matching means a route whose executable name carries a version
needs a reviewed fingerprint update, which is the safe direction.

A matching digest proves the bytes are what was uploaded, not who uploaded
them. Ordinary GitHub selection therefore also checks uploader continuity, using
the asset `uploader` and `created_at` and the repository `owner` from the same
observation. After the asset is selected, and before any checksum request,
download or selection caching, the selected asset continues the project's
publishing identities when any of these holds:

- it was uploaded before 2026-11-14T00:00:00Z, so existing releases keep their
  behavior;
- its uploader is the repository owner account;
- its uploader is GitHub's Actions app account (`github-actions[bot]`, type
  `Bot`, ID 41898282); a workflow's repository token can only upload to the
  repository whose workflow ran;
- its uploader also uploaded an asset of an observed release of this project
  before that instant, which makes it an established uploader;
- its numeric account ID is listed in the integration's reviewed
  `release.accepted_uploaders`.

Accounts are matched by numeric ID, so a renamed login still matches and a
freed login taken by another account does not. GitHub's shared placeholder for
deleted accounts (`ghost`, ID 10137) never establishes, owns or is accepted for
a project; an upload it is credited with after the baseline is held with a
reason saying GitHub shows a deleted account as the uploader. The
baseline instant is fixed: an upload after it never makes its uploader
established, so a later release from the same new account stays held too.
Established status comes from assets still present in the observed listing,
within the provider's existing page bound. When a project has deleted every
release uploaded before the baseline, that evidence is gone, and a later upload
by an account other than the owner or the project's automation is held until a
maintainer accepts it.

A known uploader matching none of these, or an asset uploaded after the
baseline that GitHub reports with no uploader account (`uploader: null`), is
refused through the existing unsupported-acquisition surface. The player reason
says Portcove is holding back this version and why, and that nothing was
downloaded or changed; details name the release tag, asset and uploader. The
refusal covers every provider resolution, including fresh Install, Update,
update checks and recommendations. It is not cached and changes nothing on
disk; installed copies keep Play, backup, rollback and removal. Selection does
not fall back to an older continuous release: while the newest matching release
is held, a fresh Install of that route is refused too, and an installed copy
stays on its current version.

Coverage is judged for the whole response. When no asset in the observed
listing carries an `uploader` field, the response does not cover uploaders, so
continuity is UNKNOWN: Core claims none, logs a warning and keeps the earlier
behavior rather than treating missing optional evidence as a known mismatch.
GitHub's API always returns the field, so this applies to non-GitHub-shaped
responses. When other assets in the same listing carry the field but the
selected asset does not, the observation is inconsistent and the release is
held (`provider_uploader_not_observed`), even if that asset predates the
baseline; GitHub's real API does not produce this shape.

The guard's limits are deliberate and narrow. An Actions-app upload passes, and
anyone with write access can add, change or trigger the project's release
workflow, so the guard stops direct manual or token uploads by a new account,
not a release built by an altered or compromised workflow; binding releases to
reviewed workflow provenance is tracked in
[#5841](https://github.com/boburning/portcove/issues/5841). The configured repository
is resolved by its current owner/name path and its owner is read from the same
observation, so a transferred or re-registered repository namespace is not
detected by this guard; existing repository-identity checks apply where a route
binds a stable repository ID. Exact curated records, direct manifests,
preserved-location failover and player-chosen catalog downloads are not
automatic progression and keep their own identity checks. GitLab release links
and generic-package rows carry no per-file uploader, and a release author is not
the file uploader, so GitLab selection remains unevaluated.

The guard also applies when a build becomes active from stored facts rather than
a resolution made just then (#6209). A GitHub resolution records its decision
(the basis, the uploader's account ID and the asset's `created_at`) with the
resolved release, and the install manifest keeps it with the build, bound by the
manifest's registered hash. Before activating a staged build, rolling back to a
retained build or recovering an interrupted activation or publication, Core
applies that recorded decision again:

- a build installed before the baseline keeps its earlier behavior;
- a recorded decision stands, except that an accepted uploader must still be in
  the current catalog's `release.accepted_uploaders`, so narrowing the list also
  holds builds staged under it (`provider_uploader_not_continuous`);
- a manifest written by a version that records these facts but carries no
  decision (a curated record, or a build no GitHub resolution produced) needs
  none;
- a build installed after the baseline whose manifest predates recording may
  have been staged by a version without the guard. Its activation and its
  recovery are held (`provider_uploader_not_observed`) unless a resolution of the
  same artifact made just then supplies the decision, as Update does when it
  finds the build already staged. Restoring such a previous version is held,
  which the rollback assessment shows before the action is chosen.

Other providers and curated, direct, user-prepared and managed-build routes are
not upstream progression and are unaffected, as is the active build. A build
this version adopts from local files records the marker; an adopted tree with a
separately recorded runtime is also recognized. A manifest rewrite or prepared
derivative carries the original's recorded facts and install time and never
adds a marker the original lacked, so a derivative of a pre-baseline build stays
pre-baseline. Rolling back to a held build reports `review_required`.

Binding and launching an exact profile pin require the recorded uploader
decision and current activation policy. An already-bound pin shows a hold with
the reason and next action. The Default launch continues to follow the active
runtime. Ghostship legacy recovery checks the original retained artifact's
uploader continuity before publishing the derivative or recovered progress.
The derivative uses the original acquisition time, so a pre-baseline Ghostship
artifact remains eligible.

An interrupted activation held for uploader continuity leaves the build staged
and retires the activation request. A verified publication that cannot activate
for this reason is recovered as staged when no other staged build would be
displaced and no external registration would be replaced. Check for updates to
resolve an eligible build. Other held publications keep their journals and
payloads for review. A journal still awaiting recovery defers standing updates.

To accept a new uploader, review the account and the held release on the
canonical port issue, then add `{ "id": <numeric account ID>, "login": "<login>" }`
to the integration's `release.accepted_uploaders`. The field is valid only on
GitHub-provider routes, with unique positive IDs other than the deleted-account
placeholder. Accepted uploaders are not part of an installed copy's retained
execution identity. Because the catalog is embedded, acceptance reaches players
with the next application release. A selected independent definition may keep
or remove accepted uploaders but cannot add one.

<a id="generated-reviewed-package-shapes-shadow"></a>

### Generated reviewed package shapes

Core derives a package shape for each managed portable route (#5359). Its six
parts are sorted, bounded sets of lowercase package-relative paths. Core derives
them after package normalization and declared-executable grants, before adding
original game inputs or bundled runtimes:

- `programs`: the fingerprint's program and script classifier, unchanged;
- `top_directories`;
- `persistent_parent_children`: child folders under the parent of each
  declared persistent path, and under each persistent path the package ships as
  a folder (catches a `mods/packages` to `mods/preloaded` move or a new
  `saves/netplay` folder);
- `persistent_overlap`: shipped files at or under a declared persistent path,
  or matching a declared persistent file pattern (catches a shipped `input.ini`);
- `config_files`: shipped `.ini`, `.cfg`, `.toml`, `.json` and `.xml` files at
  any depth, so additions and removals both count;
- `missing_persistent_parents`: parents of declared persistent paths the
  package does not ship.

For a declared Linux portable data directory, a missing directory and an empty
directory beside the selected executable represent the same package shape. Core
checks the staged path before excluding it from the top-level directory set.
Aliases, links and any packaged contents still fail the portable data checks.
Existing recorded shapes stay intact, and future generated baselines for such a
route must use the updated derivation inputs.

Managed extraction never creates links: ZIP links are refused and an allowed
TAR.XZ file link is written as a copy of its in-archive target, so every
shipped file is a regular file the shape sees and links are not a blind spot.

Comparison is exact set equality per part. A part one side does not know is
reported as unknown, never as a pass: an explicit fingerprint knows only
programs and top-level directories, and an unresolved declared executable, or a
declared persistent path or pattern that cannot be located relative to the
package root, leaves the persistent parts unknown.

A known change against a reviewed baseline withholds the candidate before
publication. A local shape can supply that baseline when its reviewed or
inherited provenance is retained. Comparisons against an unreviewed local
shape remain visible as observations.
The native portable, staged-source, N64 recompilation, libultraship, PSX
recompilation and generated-cache templates advertise the capability. The
embedded catalog uses the installed template capability. Indexed definitions
use the version they negotiate, so a definition capped below the enforcement
capability still records the comparison without adding the refusal. Unknown
parts remain visible, and the other acquisition and layout checks still apply.
If an exact candidate has a retained refusal observation, an update check
recomputes its verdict with the current applicable baseline before saying the
release is waiting for review. A fresh installation can select the newest
applicable reviewed GitHub package when its latest exact candidate is
withheld. The fallback must match the current selector and a reviewed version
and digest. A reviewed setup shows that different package before approval.
Installed, staged, and non-owning routes keep their own update behavior.

The baseline is, in order: the generated table entry for the exact artifact,
else the route's newest generated entry; the explicit fingerprint; the shape
recorded by the active local installation (see the install manifest in
[ARCHITECTURE](ARCHITECTURE.md#install-transaction)). The generated table,
`crates/portcove-core/catalog/package-shapes.generated.json`, is embedded in
Core and never hand-written. `node scripts/package-shape-baselines.mts` derives
each entry from an artifact the catalog already marks as reviewed, a
source-contract `applicability` row with an `artifact_sha256` or a hold's
`reviewed_artifacts`, through `portcove catalog inspect-package-shape`, which
uses Core extraction and executes nothing. Authors change only the review facts
they already own; `--record` re-derives the entry. `--candidates` lists reviewed
artifacts that have no entry yet, and downloading them is a separate, explicit
refresh step. Each entry also records `derivation_inputs_sha256`, a digest of
the catalog facts the derivation reads for that route and platform: the
adapter, the platform's executable hints and runtime subdirectory, persistent
paths and file patterns, install-root persistence (`launch_from_install_root`,
`n64_runtime_at_executable_parent`), the external profile policy, managed
shared preferences, declared-executable grants, Mac TAR.XZ platforms and the
explicit fingerprint's macOS library filter. Core computes that digest, and
`inspect-package-shape` reports the one for the embedded catalog it derived
with; `--record` refuses a shape whose digest differs from `catalog.json`, so a
CLI built before a catalog edit cannot record a stale shape under current
inputs (rebuild the CLI, then record again). CI runs the offline `--check`:
canonical bytes, the entries digest, Core's `SHAPE_VERSION`, each entry's
`shape_version` and its player candidates, and that every entry still names a
managed portable route, one of its platforms, a reviewed catalog artifact with
the same version and unchanged derivation inputs. Core's table-currency test
checks the same digests and versions.

When a catalog edit makes the table stale, run
`node scripts/package-shape-baselines.mts --prune`; the failing `--check`
names it. It is offline and needs no review: it drops entries whose route,
platform or reviewed digest is gone or whose derivation inputs changed, adopts
the catalog's version label and review source for a still-reviewed digest, and
rewrites the canonical table and its digest. It never re-derives or edits a
shape, so a dropped route only loses its baseline (`unknown`) until
`--candidates` lists it for an explicit `--record` refresh. Nobody edits the
table by hand.

Entry order follows catalog review order, so the last entry per route and
platform is the newest reviewed shape. Changing the component rules (the
program classifier, the configuration extensions, a part or its anchoring)
bumps `SHAPE_VERSION` and raises `COMPONENT_RULES_VERSION` to it in the same
change; a versioned golden-shape Core test over a fixture fails on any such
change until the version and the golden are updated together. The N64 macOS archive inspection can additionally prove
flat install-root persistence absent when the whole payload consists of the
app bundle that contains the resolved executable. It records the previously
unknown persistence components through a distinct N64 macOS derivation-input
digest and preserves the existing coordinates and known values of other
components. Earlier records still compare their known parts. The golden
fixture is a Windows route, so the Unix
executable-bit and verified macOS library branches of the shared classifier
are not pinned by it; a change there still requires the version bump. After a
component-rules bump Core ignores table entries and recorded local shapes below
`COMPONENT_RULES_VERSION`, and `--prune` drops them until they are re-derived.

#### Package shape player candidates

Shape version 2 (#8569) adds `player_candidates` to each generated entry:
`path`, `machine` and `sha256` of the players the reviewed bytes contain. The
six components and their rules are unchanged from version 1, so
`COMPONENT_RULES_VERSION` stays 1. Every table entry records its own
`shape_version`; a version 1 entry has no players and remains a valid baseline
with version 1 semantics until `--record` re-derives it. Installation manifests
and withheld-release observations carry components only, so they are still
written at version 1 and earlier Portcove builds keep reading them; this build
reads records of either version. Release selection, install comparison and
drift verdicts do not read players.

A player is decided by declared facts and package structure, never by a list of
titles. The candidate is the route's declared launch target, resolved from its
`executable_hints` and runtime subdirectory exactly as the installer resolves
it. It must be one of the shape's reviewed programs, no segment of its path may
name an installer, setup, compiler or toolchain, importer, development tool or
server (the existing structured-claim rule), and its header must classify as a
native executable rather than a library, script or text. Bundled compilers such
as `overlay_toolchain/tcc/tcc.exe`, updaters, crash handlers, setup programs,
diagnostics collectors and dedicated servers are therefore never players; a
route whose declared target is not such an executable records no player.

`machine` comes from a bounded header reader, never from a filename:
`pe-<arch>` for PE (`x86`, `x86-64`, `arm64`, `arm`), `elf32-<arch>` or
`elf64-<arch>` for ELF (`elf32be-`/`elf64be-` when big-endian), `macho-<arch>`
for a single-architecture Mach-O and `macho-universal-<arch>+<arch>` for a
universal binary whose slices are all checked. Other machines keep their raw
number (`0x%04x`, Mach-O `0x%08x`). Each read is at most 4 KiB and a
classification makes a bounded number of reads; truncated, inconsistent or
hostile headers classify as no native image or an unestablished kind and never
fail the inspection. `sha256` is the digest of the whole player file. A
reviewed player of a Windows x86-64 route may be a 32-bit `pe-x86` program;
the machine records that fact and does not refuse the route.

Core compares the active definition's shape inputs with the embedded
definition that supplied the generated baseline. Changed inputs produce an
unknown verdict and preserve the observed shape, even for a reviewed artifact.
An unrelated definition edit leaves the comparison available.

Known limits of the shadow phase include runtime behavior, such as files a
release writes at first launch, which package inspection cannot observe. An
exact-name classifier counts a renamed program as one removal and one addition.
Routes without a generated baseline fall back to the explicit fingerprint, the
local installation or `unknown`. The 2026-11-14 bootstrap and its verdicts
for the six known-drift routes are in
[release-drift-shadow-2026-11-14](qualification/release-drift-shadow-2026-11-14.md).

The reusable managed TFE, GB shared-preferences and version-local credentials
policies support reviewed GitHub package rules as well as exact direct manifests.
Fresh dynamic acquisition requires an opaque in-process resolver binding to the
complete retained definition, platform, requested channel and exact release.
A serialized review cannot supply that proof: Core resolves again and refuses
changed facts before downloading. This binding is distinct from publisher-scope
authorization. Offline installed-version checks still use the verified manifest
and registered artifact, never today's latest release. Historical exact policy
variants and direct-manifest targets retain their original meanings.

Independent compatible definition delivery to installed clients remains with
[#534](https://github.com/boburning/portcove/issues/534) and
[#246](https://github.com/boburning/portcove/issues/246). It does not replace
dynamic release discovery or authorize production publication in an ordinary
catalog change.

Declare the offered route's maintenance policy on its existing canonical Port
issue during admission and subsequent disposition work, independently from its
operations and qualification. [#1422](https://github.com/boburning/portcove/issues/1422)
owns ongoing rollout and its historical evidence; completed [#254](https://github.com/boburning/portcove/issues/254)
provides repeatable proposal and evidence preparation, and
[#246](https://github.com/boburning/portcove/issues/246) owns protected compatible
delivery. These declarations are not new catalog schema fields or a second
planning registry.

Prefer `managed-compatible-release` when upstream releases are safely versioned
and observable and ordinary compatibility can be validated deterministically.
Every accepted release still retains immutable version, artifact and accepted
hash identity. A declaration describes the maintenance target; separately name
the observation, selection, executable, source, persistence and compatibility
checks actually implemented and any remaining facts or capability owner. It
does not prove a future package compatible, inherit gameplay evidence, authorize
publication, install an update, or override a player's keep-current choice.

Use `pinned-release` for a concrete upstream or safety limitation that prevents
compatible progression. Record the retained exact pin, the limitation and the
facts or checks needed to resume. An accepted immutable artifact, unfinished
research, missing optional gameplay or a gap on another platform alone is not a
pin justification. A direct manifest is a release representation, not a permanent
maintenance exception; a bounded observer and reviewed compatible candidates
may remain required work. Keep unknown facts explicit instead of inventing a
limitation.

Use `user-managed-update` for an offered non-owning user-prepared runtime route.
Its exact package and extracted-runtime checks remain required, but Portcove
does not update or replace that external runtime. Preserve the offered
registration/launch/removal boundary and all applicable holds; the declaration
grants no acquisition, backup, rollback or deletion right. Revisit the policy only
when an independently justified managed route or changed input warrants it.

A standalone Linux AppImage release may use a version-bearing asset filename.
When its port declares exactly one AppImage basename and no runtime subdirectory,
the installer gives the verified file that declared name before writing its
manifest. This does not apply to archives, setup executables, or ambiguous hint
lists. The original release filename, digest and size remain the artifact identity;
the installed executable path remains recorded per installation, so existing
installations and rollback retain their original paths. DKR-R retains its existing
declared runtime filename for compatibility; that filename is not a release-version
claim. Version displays and update selection use the recorded release identity.

Hosted GitHub and GitLab providers inspect repository metadata before every
resolution, including reuse of a five-minute in-memory release selection. A
host archive flag and Portcove's `Retired`, `Superseded` and `Abandoned` values
describe maintenance status; none alone proves unsafe bytes, revokes an exact
accepted release, or grants acquisition authority. A conditional `304 Not
Modified` reuses only the last semantically valid metadata body. If metadata
revalidation cannot reach the host, resolution fails with that network error
rather than silently using a cached selection. Known withdrawal, compromised
routes, changed accepted bytes, failed integrity and unsafe operations still
hold at their actual scope. Exact direct manifests retain their existing
per-platform HTTPS URL, nonzero size, version and SHA-256 requirements.

Hosted managed selection and listing download recommendations exclude packages
whose names label them as dedicated servers. GitLab checks both the release-link
label and the resolved registry filename. The server label supplies no evidence
about a separate game client's platform, architecture, or integrity.

GitLab generic-package links can use the same reusable project, channel and
native-archive selectors. Core joins the selected versioned URL to independently
published package names, versions, filenames, sizes and SHA-256 values. It reads
all relevant bounded registry pages before claiming a unique match. If upstream
has uploaded different files to the same package/version/filename, a bounded,
redirect-free HEAD of that exact official project URL must identify exactly one
registry row through its published checksum and optional size. Repeated identities,
missing or conflicting integrity, ambiguous uploads and incomplete pagination
refuse resolution without caching a result. The joined filename must satisfy the
actual native archive/platform/variant rules; a display label is insufficient.
The new route downloads the exact URL it validated, then applies ordinary Core
byte verification and staged lifecycle protections. A mutable URL changing after
resolution can fail integrity safely; five-minute cache reuse is not a fresh
HEAD observation. Existing explicit package-file and published-description
checksum routes retain their behavior. This adds no per-release definition edit
or new approval/publication authority.

The earlier archive-state veto was completed under
[issue #212](https://github.com/boburning/portcove/issues/212) and remains
historical evidence. This availability-first contract supersedes that veto;
it preserves the independent release, source, archive, executable,
installation, rollback and retained-version checks. Broader retired-project
governance remains [#233](https://github.com/boburning/portcove/issues/233).

Discovery creates one durable issue immediately for every independently
catalogable or independently prioritizable port, with the direct upstream URL,
title identity, a durable game/target key for non-catalog candidates, neutral
Inbox/Watchlist fields, and an explicit statement that research intake does not
grant support. The key identifies the independently prioritizable game or
target, not merely a shared upstream repository. Project drafts are only for
fleeting non-port ideas. Triage records platform, artifact-integrity, source,
persistence, adapter, blocker, and resume-condition evidence. A newly cataloged
port does not automatically become a global V1
blocker.

## Channels, support, and qualification

Keep upstream tag names in catalog evidence. Use the [game channel vocabulary and serialized values](CLI.md#release-channels) when authoring a record.

Stable, Preview, and Rolling are user-selected release channels, not qualification
claims. Preview is the human label for the unchanged `beta` machine value. An entry may offer Preview or Rolling, be platform-limited, lack qualification
evidence, or have documented blockers while the application continues toward V1,
provided the UI and documentation represent that state honestly.

Legacy `support_tier` values remain compatibility metadata, separate from release-channel choices. Neither a channel label nor a tier name supplies artifact/platform/operation testing evidence or removes a concrete compatibility limitation.

Source inspection ambiguity counts possible identity matches, not distinct game
editions: multiple file representations can match the same edition. Player
guidance must preserve that distinction and direct the player to check both the
required edition and file format before choosing originals again.

Schema 2 stores new source qualification in `source_catalog.qualification`.
Each record binds the port, platform, release artifact SHA-256, upstream ref,
source contract, exact variant and representation, check-contract version,
method, time, result, and reviewed evidence IDs. Structural checks, automated
lifecycle results, hands-on observations, and known failures remain separate.
The core derives an exact claim only when the whole requested scope matches;
adding an artifact, variant, representation, platform, or check version cannot
inherit an older result. Missing or not-run evidence remains distinct from a
bounded failure and does not change source admission. For a provider-resolved
release, a contract's reviewed release binding qualifies only that exact
release when the provider resolves it; `release_policy` widens source admission
but never qualification. `catalog inspect-targets` reports reviewed bindings
per target, never policy-admitted releases. Scoped records do not record the
route or operation they exercised; until a reviewed field does, the check
version is the only operation discriminator.

`automated_tested_platforms` and `manually_validated_platforms` are retained as
legacy historical coverage. They identify a port/platform intersection but do
not identify the artifact or source variant that was exercised. Migration keeps
those arrays visible and does not manufacture exact records from them. New
qualification belongs in the scoped collection. Never promote synthetic tests,
a clean process exit, or generated files into hands-on evidence. Qualify each
declared platform independently.

For scoped records, `hands_on` describes direct observation of the specific
claimed behavior with the real runtime and any input or device relevant to that
claim; it does not encode the operator's identity. An agent can operate and
record that session.
Synthetic game data can establish bounded host lifecycle behavior but does not
establish gameplay, a physical-controller path, or a platform not exercised.
Retain the historical `automated_tested_platforms` and
`manually_validated_platforms` field names and their existing recorded claims;
this clarification creates no new qualification record or platform support.

### Evidence by mechanism

A mechanism suite proves what an adapter does for any port that declares it,
using a synthetic fixture identity that production code and scripts never name
(`mechanism_fixtures::identities_are_test_only` enforces this). It drives the
real Core service entry points with inert packages from a local GitHub-shaped
origin. It replaces per-title repetition of lifecycle checks, not title
evidence: a port that fits a mechanism still needs the native and title
evidence in the last column before its qualification claims change.

| Mechanism                | Suite                                                                                                                                | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Still needs native or title evidence                                                                                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `upstream-managed-setup` | [`service/upstream_managed_setup_mechanism_tests.rs`](../crates/portcove-core/src/service/upstream_managed_setup_mechanism_tests.rs) | With this host's desktop package published, only it is downloaded, including when its name carries upstream's `setup` token; a checksum list, mobile or console file or another host's package is never selected, and an installer program or source archive is refused by its role; install refuses before download without a registered original, under a managed acquisition hold, on an undeclared platform or on a digest mismatch. A package without its declared setup program is refused at install before anything is published, keeping the active installation. Install and update never run setup; preparation runs the owned native setup probe into a private copy and publishes only with the declared marker and no writes outside declared outputs; Play never reruns setup. A changed or missing original, a setup failure, a missing marker or unowned writes keep the active installation. Interruption before the verified copy is journaled keeps the unprepared installation and retains the private work for reviewed cleanup; from that point recovery publishes the prepared copy, for a first install and for an update. Progress stays intact at every fault point. Update needs its own preparation and keeps the previous prepared copy. After preparing an update, rollback returns to the previous prepared version and again to the new one, with player data following the active version; the update's unprepared package stays tracked until removal. Removal leaves the original, its registration and collected progress. | The real upstream setup tool accepting real originals and producing a playable tree, per platform; gameplay; upstream launcher updates or settings outside the declared paths. The selection replay holds no recorded release facts for the cataloged ports. |
| `referenced-disc`        | [`service/referenced_disc_mechanism_tests.rs`](../crates/portcove-core/src/service/referenced_disc_mechanism_tests.rs)               | With this host's player package published, only it is downloaded; a mobile package or another host's player is never selected, and a builder or debug package is refused by its role; the same install refusals as above. Launch passes the registered original in place with the player data folder, and repeated preparation is stable. The original is never modified, moved, copied into the library or written next to; a changed or moved original is refused, not repaired. Update and rollback keep player data and the reference; interruption before the install is journaled keeps the previous version, and from that point recovery activates the new version with the previous kept for rollback. Removal, and removing the source registration, leave the original untouched.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | The real player accepting real disc images and formats per platform; gameplay; the player's own data-location behavior beyond the descriptor Portcove writes. The selection replay holds no recorded release facts for the cataloged port.                   |

The [selection-equivalence replay](../crates/portcove-core/src/release/tests/selection_equivalence.rs)
counts these adapters as covered only through the synthetic mechanism ports and
their own fixture, `mechanism-fixture-releases.json`.

Release selection applies one typed-role gate for every adapter (#8602): a
filename-suggested installer, builder, compiler, importer, development tool,
debug build, source archive, documentation, mobile, console or server artifact
never becomes the game package. The gate covers every provider that chooses a
package by filename: GitHub release assets, and GitLab release links and their
final registry filenames. Reviewed-forge and direct-manifest routes install an
exact reviewed artifact and choose nothing by filename. When nothing else for
this host remains, the refusal carries `route_hold: wrong-role` and nothing is
downloaded. The widenings are declared by adapter: an upstream-managed setup
route expects an extractable package named for its setup or installer, because
its mechanism runs upstream's setup from that package; uninstallers and runtime
redistributables stay refused. A PSX recompilation route expects its
owned-input preparation kit, which may be named for its source.

### Qualification evidence preparation

For the repeated managed setup sequence owned by #1742, the existing report tool
accepts `--preparation-case FILE` together with `--cli`, `--library` and a new
`--output` directory. This mode performs reviewed preparation; ordinary capture
remains read-only. A case contains `format_version: 1`, `evidence_kind` (`synthetic`
or `actual`), the verified `cli_sha256`, an exact `environment` object with Node's
`platform`, `arch` and `node` values, and `plan`: the unchanged `data` object from
that CLI's `preparation plan PORT` response. Review the plan and its offered setup
before running the case.

The one fixed sequence re-reads the plan, refuses changed inputs, verifies the
original managed install, runs `preparation run` with its exact expected plan,
verifies the prepared install, and captures the new Core plan/inventory. Core
performs setup supervision, source checks, generated-output ownership, publication
and recovery; the report adds no execution language or installer. Artifact,
runtime, retained-definition, actual source inspection, host/target, setup and
conversion-tool joins must match. Unknown legacy source identity stays unknown.
Setup acceptance never promotes a separate source validator or gameplay result.

The new output retains `preparation-case.json`, per-phase raw Core responses and
`sequence.json`, including failures, elapsed execution and the existing operation
inputs/inventories. It never overwrites a prior attempt or automatically replays a
failed operation. Read activity/recovery before a fresh reviewed attempt. External
registration has no managed preparation operation and cannot acquire management
scenarios through this tool. Launch, gameplay, audio, input and save/load remain
unassessed; update/rollback/backup/removal are outside this bounded sequence.
Compiled production-CLI synthetic cases reuse it for Jak 1 ISO and Jak 2 CHD,
including the conversion-tool contrast. Actual upstream/game observations remain
in their existing qualification receipts. Comparative effort and speed baselines
remain unknown; per-title commands are eliminated for this repeated sequence.

`node scripts/qualification-report.mts --cli <executable> --library <library> --output <new-directory>`
captures existing versioned core snapshots and a checklist for active managed
installs and non-owning external registrations. Format 1 retains managed fields
and adds `runtime_kind`, a distinct `registration_id`, and available platform,
runtime/executable paths and immutable-tree identity. External `artifact_sha256`
is the registration's accepted archive identity, not a new download observation;
its immutable-tree hash is a separate fact. External platform comes from its
registration. Managed records lack artifact-platform identity, which remains
unknown; the capture host's platform stays in the doctor response separately.

Missing optional version, hash, platform, path or readiness facts remain null
(unknown), rather than borrowing current catalog or host facts for a retained
external record. Missing required port/record IDs, duplicate identities within a
route, conflicting managed/external records or a changed record owner refuse the
capture before report publication. Existing capture directories are preserved.
`installed_ports` still counts managed installs; `registered_ports` counts
external registrations and `reported_ports` counts both.

To project actual Core offers into the existing scenario report, run
`node scripts/desktop-verify.mts --list-scenarios --json --qualification-evidence <capture/evidence.json>`.
The rows retain Core's allowed, held or waiting assessment, execution platform,
exact available artifact/record identity, intended scenario producer and missing
observations. A managed record's unknown installed platform stays unknown.
Scenario `operation_routes` describe test coverage; they do not decide which
operations Core offers.

Repeat `--current-preflight <preflight.json>` for each operation/observation scope and
`--acceptance-packet <completed.json>`
to inspect receipts against the requested frozen dependencies. The owning acceptance
verifier rechecks the completed packet and its retained artifacts. Scope lives in
the existing binding's `execution_qualification.initial_state.offered_operation`:
`port_id`, `operation`, `runtime_kind`, `record_id`, `availability`, `reason`,
`platform`, `package_sha256`, `producer` and `evidence_kind`; an external record
also binds `package_platform`. Runtime conditions must declare the same platform
and observation kind. Kinds are `browser-fixture`, `native-harness-contract` and
`real-installed-execution`. A receipt with missing scope or incompatible inputs
cannot fill a missing observation. Retained execution `captured_at` orders observations, independently of packet completion.
Missing observation times remain explicitly unordered. Current required gaps or failed
source reviews block completeness while historical observations remain visible.
Prerequisites remain descriptive metadata; required gaps and actual source-review
fields provide the defined disposition checks. Empty
or truncated inventories never imply complete native coverage. The latest compatible failure remains visible;
an adjacent green fixture or harness result cannot replace it. This read-only
projection grants no acceptance and inventories only the supplied receipts.

The capture keeps the selected CLI's original path so sibling tool discovery
retains its normal behavior. It records the initial SHA-256 and checks that the
path remains a regular file with those bytes before and after every command,
including failed commands and managed backup listings. Changed bytes, a missing
path or a nonregular replacement refuses publication. If a command also
fails, both errors are retained, with the command failure first. These checks
detect observed drift; they do not make execution atomic or immutable, or prove
that an adversarial change and restoration did not occur between observations.

Backup listings and the backup/restore checklist apply only to managed installs.
External rows do not establish save locations or Portcove ownership; their
`user_data_root` remains unknown. For both runtime routes, `source_profile` stays
unknown because the captured runtime record does not bind a source profile.
The additive `catalog_source_profile` records the current catalog declaration,
or null for an absent/unspecified entry; it is not evidence of the source used by
the retained runtime. Exact source facts, when available, stay in the captured
core source responses without an inferred runtime association. Gameplay,
audio, controller and save/load observations start null (unassessed), regardless
of readiness or historical qualification. Record exact operation, method, scope,
date and actual result separately. Neither capture nor synthetic CLI responses
grant runtime/gameplay qualification or modify catalog evidence.

Legacy Project `Port stage = Supported` means that at least one declared
platform is present in both historical arrays. That historical claim is limited
to the port/platform intersection and does not become an unconditional claim
about every current source representation or artifact. Catalog support tier, upstream
release channel, upstream status, catalog admission, source-contract coverage,
Project Status, and Port stage are independent. In particular, a stable support
tier, successful download, or catalog entry does not itself mean Supported.

On 2026-09-04, the repository owner reported completing the defined hands-on
Windows checks for every catalog port whose Windows automation was complete and
whose only remaining gate was manual qualification. Those entries therefore
pair their Windows automation evidence with Windows manual validation. Catalog
entries with source, release, upstream, or native-platform blockers remain
unqualified. This attestation does not imply qualification for any other
declared platform.

Yu-Gi-Oh! Forbidden Memories v0.6.1 has exact Windows structural and bounded
automated lifecycle records for its Track 01 contract, checksum-qualified
artifact, clean managed build, immutable verification, responsive native
launches, persistence, backup restore, removal, and clean reinstall. A separate
current-client exercise covers exact v0.5.7-to-v0.6.1 update, retained-version
rollback/reactivation, immutable verification, and bounded canonical
persistence and backup preservation. It does not establish native v0.5.7
launch, cross-version runtime collection or restore, hands-on gameplay,
controls, audio, in-game save/load, or non-Windows platforms. The exact scope
and interrupted-launch limitation are recorded in the
[cross-version qualification record](qualification/yu-gi-oh-forbidden-memories-recompiled-windows-cross-version-2026-09-15.md).
Revelations: Persona
v0.1.1 has exact Windows structural and bounded automated lifecycle records for
its owned-input artifact and Track 01 contract, including v0.1.0 installation,
v0.1.1 update, no-op, rollback/reactivation, fail-closed verification, repaired
native launches, persistence, and backup restore. A separate current-client
exercise covers managed removal, preservation of canonical configuration, a
genuinely clean v0.1.1 reinstall, regenerated runtime configuration,
byte-identical restoration, final immutable verification, and a healthy backup.
It does not claim Play/game-intro execution, hands-on gameplay, controls, audio,
in-game save/load, or non-Windows platforms. The exact scope is recorded in the
[clean-reinstall qualification record](qualification/revelations-persona-recompiled-windows-reinstall-2026-09-15.md).
For both ports, `input.ini` is persistent user configuration and
`psx_last_run_report.json` is reviewed disposable runtime output.

Dr. Mario 64 Recompiled Plus 1.0.0 preserves the existing
`dr-mario-64-recomp` catalog identity while replacing the inactive predecessor
repository with its traceable successor. Its exact Windows structural and
bounded automated lifecycle records cover the checksum-qualified USA Rev 0
source, release artifact, wrapper runtime directory, immutable verification,
three responsive D3D12 launches with normal close, no-op update, safe refusal
of rollback without a retained version, removal preservation, and clean
reinstall. Its persistent runtime ROM is SHA-256-bound on every reuse, so a
restored or edited destination is rematerialized from the admitted source
before launch. The port remains beta: the same current AMD host failed under
Auto and explicit Vulkan inside `amdxc64.dll`, and the evidence does not claim
hands-on gameplay, controls, audio, in-game save/load, backup restore,
cross-version update/rollback, or non-Windows behavior. The exact identities,
methods, and remaining boundaries are recorded in
[`docs/qualification/dr-mario-64-recompiled-windows-2026-09-15.md`](qualification/dr-mario-64-recompiled-windows-2026-09-15.md).

An N64 recompilation package whose wrapper folder differs by platform keeps the shared
`runtime_subdirectory` for the platforms that use it and lists the others in
`runtime_subdirectory_by_platform` (capability 6 of its adapter).

Native portable archives normally derive the working directory from the unique
exact declared player filename. Do not repeat an incidental dated wrapper in
`runtime_subdirectory` when the player’s parent is the reviewed runtime root.
The authenticated package and full immutable manifest still bind expected
contents; a missing or ambiguous player is refused. The installation retains
its exact selected relative player path and creating definition, so later
catalog observations do not reinterpret older working coordinates.
The existing transition guard recognizes the omission only for native runtimes
without owned data or source preparation, when an explicit root equals the
authenticated retained player’s parent. Reverse rollback needs the retained
target’s own coordinate. Changed roots or data ownership remain held.

Marathon’s three official Windows integrations use that existing rule. Their
full-scenario artifact pins remain separate: full-game and engine-only package
names overlap the current provider hints, and populated shared upstream profiles
have no qualified cross-version transition. Wrapper naming is no longer a pin
reason. [Two real package inspections and regression controls](qualification/marathon-derived-wrapper-2026-11-05.md)
record the narrower removal of release-specific layout edits. OpenPete’s exact
runtime/source/cards/states boundary remains independently explicit under #113;
this layout change supplies no OpenPete upgrade or state-compatibility evidence.

The optional `n64_windows_initial_d3d12` declaration seeds only
`{"api_option":"D3D12"}` in a fresh Windows N64 portable working directory.
Both `graphics.json` and `graphics.json.bak` must be declared persistent at that
runtime coordinate. Core initializes `graphics.json` only when both are absent, after
source preparation and persistent restoration, using synchronized no-replace
publication. Existing regular settings, malformed bytes and backup-only recovery
remain untouched; symlinks, nonregular files and unreadable metadata are refused.
Initialization is not a repair of an existing configuration or a qualification
claim for its selected renderer. Dr. Mario's catalog summary retains the specific
AMD RX 9070 XT / driver 32.0.31041.1004 Auto/Vulkan failure and D3D12 remedy.
Other Windows hardware and newly created settings require their own applicable
evidence. Retained installation contracts preserve their original declaration;
indexed definitions require the N64 version 2 capability for this behavior.

The optional `n64_runtime_at_executable_parent` contract keeps a reviewed ready
N64 runtime and its declared data beside the selected executable when an archive
wrapper changes between releases. It requires a managed portable archive,
`portable_marker`, an admitted source with persistent N64 big-endian materialization,
and no conflicting runtime root, external data environment or generated build.
Review the actual package and component grants before enabling acquisition.
Do not add this flag to an existing installation to migrate its data coordinates.

This opt-in uses the existing staged lifecycle and conservative data-restore
receipt. Declared data is collected before first Play, backup, replacement,
rollback and removal. Without a matching restore receipt, conflicting runtime and
canonical copies are preserved for explicit resolution. Full immutable verification
holds modified runtime files and undeclared programs; current data crosses only
compatible retained coordinates. Runtime rollback does not rewind saves.
N64 engine capability 4 and retained-contract format 8 fence these semantics from
older readers; omitted/false retains historical N64 coordinates and behavior.
The contract itself supplies no platform, native, original-file or gameplay
qualification, and does not grant ownership of external copies.

Duke Nukem: Zero Hour Recompiled 0.0.3 has exact Windows structural and
bounded automated lifecycle records for the checksum-qualified USA source and
GitLab artifact. They cover mismatch refusal, archive-member normalization,
dynamic release resolution, installation, 47-file immutable verification,
responsive native launcher starts and normal close, backup and fail-closed
restore authorization, reviewed restore, adoption, update, rollback, retained
release reuse, managed removal, clean reinstall, and byte-identical persistent
state restoration. The stable GitLab definition has no release-version field,
so a future ordinary compatible release can be discovered without editing the
definition; its new artifact does not inherit 0.0.3's qualification record.
The port remains beta and the evidence does not claim gameplay, controls,
audio, in-game save/load, non-Windows support, signing, or publication. Exact
identities, methods, and boundaries are recorded in the
[Windows qualification record](qualification/duke-nukem-zero-hour-windows-2026-09-16.md).

Ape Escape Recompiled v0.3.0 has exact Windows structural and bounded
automated lifecycle records for the normalized USA Rev 0 `SCUS-94423` source
and GitHub artifact. They cover valid-CHD mismatch refusal, dynamic release
resolution, installation, 287-file immutable verification after responsive
native launches, bounded dynamic freeze diagnostics, persistent-only backup
and guarded restore, adoption, update, rollback, retained release reuse,
managed removal, clean reinstall, and byte-identical persistent-state
restoration. Generated `disc/`, JIT `cache/`, overlay captures, heartbeat, run
report, and `psx_freeze_dump_psx-runtime_*.json` files remain disposable and
outside backups. The definition has no release-version field, and any future
artifact or source identity requires its own qualification. The port remains
beta; gameplay, dual-analog controls, audio, in-game save/load, Linux, signing,
and publication are unclaimed. Exact identities and boundaries are recorded in
the [Windows qualification record](qualification/ape-escape-recompiled-windows-2026-09-16.md).

Mega Man X5 Recompiled v0.1.0-alpha has exact Windows structural and bounded
automated lifecycle records for the normalized USA Original `SLUS-01334`
source and GitHub artifact. They cover valid-CHD mismatch refusal, dynamic
release resolution, installation, 287-file immutable verification after a
responsive native launch, bounded dynamic freeze diagnostics, persistent-only
backup and guarded restore, adoption, update, rollback, retained release reuse,
managed removal, clean reinstall, and byte-identical persistent-state
restoration. Generated `disc/`, JIT `cache/`, overlay captures, heartbeat, run
report, and `psx_freeze_dump_psx-runtime_*.json` files remain disposable and
outside backups. The definition has no release-version field, and any future
artifact or source identity requires its own qualification. The port remains
beta; gameplay, controls, audio, in-game save/load, Linux, signing, and
publication are unclaimed. Exact identities and boundaries are recorded in the
[Windows qualification record](qualification/mega-man-x5-recompiled-windows-2026-09-16.md).

## Adding or changing a port

Start with [the authoring steps](#author-a-port-record), choose a
[reusable route](#choose-a-reusable-authoring-route), then
[regenerate and check the projections](#regenerate-catalog-projections).
The [Doom 3 Classic record](../crates/portcove-core/catalog/ports/doom-3-classic-dhewm3.json)
shows a managed integration with verified original files.
On an integrated record, `integration.platforms` owns managed platform
eligibility. Use `listing.platforms` only for additional platforms where
independent upstream package evidence applies. Declare each platform once.
The discovery directory reports both sets. The managed definition and its
selected release retain their own platform checks.

Use an exact `integration.mod_provider_bindings` scope with an already reviewed
loader. Shipwright declares its GameBanana game ID and Zelda 64: Recompiled
declares its Thunderstore community. Ordinary projects, files and compatible
updates within those scopes use the existing provider selectors. Retained
package references can still replay their original compiled binding. When an
indexed provider selection expires or is withdrawn, new provider operations
wait for a current authenticated selection. Use the
[indexed definition binding contract](DEFINITION-DELIVERY.md#reviewed-mod-provider-bindings)
when delivering a binding through the signed feed.

#### Declare mod sources

Declare the mod websites and release feeds a port can use in
`integration.mod_sources`. Core reads only this data to decide which sources a
port offers; no port ID, game or repository name in code selects them. Adding,
correcting or removing a source is a catalog change. Each entry has:

- `id`: lowercase letters, digits and hyphens, unique in the port. Clients
  use it to open the source.
- `authority`: the most the source may do. `link_out` opens the source page in
  the player's browser. `browse` also reads a bounded, attributed provider
  listing. `inspect` also downloads one exact file privately and reviews it.
- `platforms`: a sorted, non-empty list of host platforms. Core offers a
  source on a platform the integration manages, or one the matching listing
  presents.
- `name` and `instructions`: the player-facing site or collection name and a
  setup guide for files from this source. Follow
  [content design](CONTENT-DESIGN.md). GitHub release sources omit both.
- `source`: one typed kind.

| Kind              | Fields                                                    | Highest authority | Rules                                                                                                                                                                                                                                                |
| ----------------- | --------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `external_portal` | `site`, `url`                                             | `link_out`        | `nexus_mods` uses `www.nexusmods.com`, `mod_io` uses `mod.io`, `mod_db` uses `www.moddb.com`. `community_site` takes any public HTTPS DNS host.                                                                                                      |
| `quaddicted`      | `engine` (`vk_quake` or `ironwail`)                       | `browse`          | The link is Quaddicted's database. Browsing needs a NativePortable GitHub release route on Windows or Linux.                                                                                                                                         |
| `mod_db_feed`     | `url`                                                     | `browse`          | `url` is `https://www.moddb.com/mods/<slug>/downloads` or `/games/<slug>/downloads`. Core derives the feed address from it. Browsing has the Quaddicted platform rule.                                                                               |
| `github_release`  | `repository`, `repository_id`, `asset_name`, `companions` | `inspect`         | The numeric repository ID must match GitHub. `asset_name` is the exact release asset. `inspect` needs a reviewed N64 Recomp loader with a native game and one `companions` layout per inspected platform. Other authority levels declare no layouts. |

No source kind can install, update or activate anything. Install authority
comes only from `mod_provider_bindings`, and Core's install helpers never read
`mod_sources`. Private inspection of a GitHub release also needs the exact
installed build's own retained loader. Compound activation stays behind
managed custody.

Every address in data is checked: HTTPS only, canonical spelling, no
credentials, port, query, fragment or dot segments, a public DNS host, and the
fixed host of its site. Core's provider readers fetch only fixed provider
endpoints or addresses it derives, and refuse redirects. The browser follows
its own redirects after a player opens a link-out page. A port may declare at
most eight sources and at most one source of each browsing kind.

[DEFINITION-DELIVERY](DEFINITION-DELIVERY.md#catalog-declared-mod-sources)
describes the reader feature that guards this field.

Run `node scripts/catalog-chip-gaps.mts` for read-only source system and supported
OS coverage. Add `--json` for per-port detail. An authored
`original_game_review` records deliberate multi-game, framework or unresolved
scope. The report counts these separately from missing edition facts. Update
ownership stays with upstream for listing-only records. A same-title match is a
research lead. Check the implementation's actual input edition against pinned
upstream evidence before adding a source system.

Run `node scripts/catalog-route-fit.mts` for a read-only route-fit summary of
every catalog identity. Add `--json` or `--output FILE` for the deterministic
per-identity report, `--observations FILE` to apply listing observer output
and `--check` to verify that every identity appears exactly once. Each record
names its adapter and provider family, whether an operational route exists, its
observation state, its typed restrictions and one disposition with a reason.
ScummVM is decided first, by the declared runtime engine rather than the name,
as `excluded-scummvm`. `enrolled` has an operational definition or generated
route enrollment. For listing-only records the candidate is the non-owning
user-selected registration route. `data-only` needs known desktop packages and
player facts for one of those platforms: an accepted package player
observation, a reviewed package shape or prepared-player `route_facts_v1`.
`needs-bytes-worker` has known desktop packages without player facts.
`unobserved` has unknown availability and no complete observation; it is
unknown, not absent. `missing-capability` names a host no release provider
adapter reads or packages without a supported desktop platform.
`upstream-condition` covers source-only or unavailable upstreams, a complete
observation without release packages, or restrictions that hold every
registration operation on every package platform. `needs-admission` is reserved
for data that declares a Portcove-owned route without an admitted reviewed
artifact; no listing-only field can declare one, so it stays at zero. Only an
observation with status `complete`, or a legacy one without a status, is
evidence. Restrictions use Core's offer-time precedence, with releases and
artifacts deferred, and name each held operation. A download hold does not
remove the registration route. The report grants no admission and changes no
catalog data.

#### Generated user-selected registration

Catalog generation adds the shared registration-only route to a listing-only
identity when its observed facts fit. This follows the owner decision on
[#1422](https://github.com/boburning/portcove/issues/1422#issuecomment-7083831868).
Portcove downloads and executes nothing on this route. The player keeps and
prepares their own copy, and the player and upstream own runtime replacement.
`scripts/catalog-generated-registration.mts` decides every identity from data
only. No title, id or hand-kept list appears in it.

Because no title-specific review happens, these rules are the review. An
identity fits when all of these hold, and the first one that fails is its
blocked reason:

1. It has no authored integration and no reviewed prepared-player
   `route_facts_v1` enrollment.
2. Its declared runtime engine is not the ScummVM project.
3. Its availability is not `source-only` or `unavailable`.
4. Its project or release URL names a GitHub repository.
5. One `listing-package-facts.generated.json` entry names it and that same
   repository, written by the current facts parser version, and records the
   listing's own words its release text was judged with (`listing_words`,
   [release text](#release-text-statements)); facts judged with another
   listing name's words are `repository-mismatch` until observed again.
6. The worker did not complete the entry as ineligible. The ineligible
   reasons are listed below.
7. That entry's observation is `complete` and its asset list is complete.
   Any other coverage is unknown, never eligible. The facts were confirmed at
   most 30 days (`maxFactsAgeDays`) before the table's `generated_at`
   (`stale-facts`). Any run of non-complete upstream attempts since then is at
   most 14 days (`lastGoodRetentionDays`) long (`observation-unavailable`).
   The worker's own inspection backlog (`pending-inspection`) is not an
   upstream attempt; only the facts age bounds it.
8. The offered release belongs to this identity's product
   ([release lines](#release-lines)). No other catalog identity names the
   same repository, unless the listing's release URL binds this identity to a
   release line no other identity is bound to (`shared-repository`). The
   repository's observed stable releases form one release line, or the
   listing binds one; the offered release is on that line; without a
   binding, that line is the main line or names the listed product; and no
   newer prerelease on the main line or another line naming the product
   follows it (`ambiguous-release-line`). The offered release is stable by
   Core's rule, its tag is not only channel words with a date, time or
   hash, and neither its title nor the first line of its body states a
   prerelease ([release text](#release-text-statements), `no-stable-release`).
9. No other package form of the release serves a platform the release also
   offers a readable archive for, unless it is that archive's own program
   (its provider SHA-256 equals a player those archives hold for that
   platform) or the listed product in another package form: its product
   words are the listing's product (its id, name or original title words
   joined), its product words and version equal those of every archive that
   could be offered for the platform, and each such archive's player there is
   named literally for that product
   ([other package forms](#other-package-forms)). Any other form, including
   one with no provider digest (UNKNOWN), means the release offers a
   different package than its archive where the rule would bind, such as the
   real game beside an archive holding only a build tool, so the whole
   identity is excluded (`other-package-form-beside-archive`). A form serving
   only platforms without an offered archive is ignored, and a source
   archive offers no platform. Other package forms are never downloaded.
10. For a supported desktop platform, an artifact has the role
    `desktop-game-runtime` from an `exact-release-structured` fact. That fact
    binds the archive's provider SHA-256 and holds player candidates with
    their own SHA-256. No other fact source is accepted. The artifact is not
    contradictory, its name carries no tool or system token and no
    [archive role word](#one-program-per-platform) such as `update` or
    `demo`, and it names no other system or architecture than the platform's. It holds a player
    candidate whose platform-true machine runs on the platform and whose name
    carries no tool token. It is no [source archive](#source-archives).
    Each player's own machine decides where it runs:
    another player in the same archive, such as a 32-bit helper or the other
    system of a combined Windows and Linux archive, neither helps nor blocks
    the platform. No archive Core refused has a name that allows the platform
    without vetoing itself (`core-refused`): a refused archive could hold the
    platform's game or a second one, so the platform is never decided around
    it.
11. On that platform the players are one program, and the archives holding
    them are one package (equal archive bytes), whatever their names say
    ([one program per platform](#one-program-per-platform)). No archive of
    the release that could be the game, on any platform, bundles a compiler,
    interpreter or build helper: that excludes the whole identity
    (`bundled-toolchain`). The one program is not named for a launcher,
    settings or setup step on any platform; that excludes the whole identity
    too (`launcher-entry`), and the gate refuses every runtime of such an
    identity, including platforms the fit would not enroll. No program of an
    archive that could be the game, on any platform, has a
    [program role word](#one-program-per-platform) in its file name or any
    folder of its path, nor a role word glued to the product's name
    (`role-program`). No archive or program name holds a character outside
    ASCII (`non-ascii-name`). These deny-lists are contradiction detectors
    and can only withhold. On top of them every name is parsed against a
    [closed vocabulary](#closed-vocabulary-names): every token of the archive
    offered on every platform is a product word, a version or a neutral word,
    and its product words joined are the listing's or repository's name
    (`archive-name-unaccounted`); the offered program is that name, in
    folders of accounted words (`program-name-unaccounted`). Anything
    unaccounted withholds; nothing enrolls by escaping a deny-list.
12. On that platform no restriction holds `register-external` or `launch`. A
    `download` hold does not block registration. This route never offers a
    download.
13. An authored listing guide leaves room for the generated selection step and
    ownership reference within the eight-entry guide bound. That bound is
    Core's catalog guide schema, which every client enforces; truncating
    the authored guide would drop title-specific steps, so the identity is
    withheld instead.

The route's platforms are every platform satisfying 9 to 12. The generated
record is exactly the hand-authored form: `external_registration_v1: true`, the
`user-prepared` provider and the `staged-source-portable` adapter. Generated
records then pass the same validation as authored ones. The listing keeps
only its other descriptive platforms.

##### Platform-true player machines

A header machine alone does not say which system a program is for: an arm64
Mach-O can be an iPhone app and an x86-64 ELF can be a FreeBSD or Android
program. Core's listing inspection therefore reads the system from the header
and names any other system in the machine (`ExecutableImage::platform_machine`
in `crates/portcove-core/src/package_shape/machine.rs`). Only an unqualified
`pe-x86-64`, `elf64-x86-64`, `macho-<arch>` or `macho-universal-…` runs on a
supported platform; every qualified name runs on none.

| Format | Desktop when                                                                                                                           | Other names                                                                                                                                                                  |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PE     | Windows GUI or console subsystem, without ARM64EC hybrid metadata                                                                      | `xbox`, `efi`, `arm64ec` (an x64 header whose load configuration names CHPE metadata: Windows on Arm), or `unknown` for any other or missing subsystem                       |
| ELF    | A glibc or musl `/lib…/ld-linux…`/`ld-musl-…` interpreter with a System V or GNU OSABI, or a static image branded GNU/Linux            | `android` (`/system/bin/linker*`), `freebsd`, `openbsd`, `netbsd`, `haiku`, `solaris` by OSABI or interpreter; `unknown` for a static System V image or disagreeing evidence |
| Mach-O | `LC_BUILD_VERSION` macOS or Mac Catalyst, or `LC_VERSION_MIN_MACOSX`, outside an iOS-shaped location; every universal slice must agree | `ios`, `tvos`, `watchos`, `visionos` (simulators count as their device), `other` (bridgeOS, DriverKit), `unknown`, and `unplatformed` for no platform load command           |

An iOS-shaped location is inside a `Payload/` directory at any depth (an
`.ipa` layout, also repacked inside another folder), or below an `.app` or
`.appex` bundle that is not a macOS bundle: the innermost bundle around a macOS
program is always followed by `Contents/MacOS/` and every outer one by
`Contents/`, while an iOS bundle holds its program and nested extensions
directly. A Mach-O image with no platform load command is macOS only outside
every iOS-shaped location, such as under `*.app/Contents/MacOS/` or as a bare
program; otherwise it stays `macho-unplatformed-…`. A macOS image in an iOS-shaped
location is `macho-unknown-…`. Core reads at most 64 KiB of Mach-O load
commands per slice; a platform command past that leaves the system unknown.
An ARM64EC image keeps an x64 header machine, so its load configuration
decides: a non-zero CHPE metadata pointer makes it `pe-arm64ec-x86-64`, a
Windows program for an Arm host that runs on no supported platform. Core reads
at most three more bounded headers for this (optional header, section table,
load configuration); anything malformed is not hybrid. The historical
unqualified `machine` that reviewed package shapes record keeps its meaning, so
managed routes are unchanged.

Players with only non-desktop machines block the identity as
`non-desktop-platform`; players with only `unknown` or `unplatformed` machines
block it as `unknown-platform`. Desktop players for another architecture or
system than any supported platform remain `wrong-host`.

##### One program per platform

A release archive can hold several titles, such as two games built from one
engine. After the tool veto, the kept players that run on a platform must be
one program: at most `maxDistinctPrograms` (1) distinct program names, across
every archive whose name allows the platform, and each archive's players under
one top-level directory. Anything else is `ambiguous-player`. Two program names
are the same program when they differ only in build-variant words: an
architecture or system word (`x86_64`, `x64`, `win64`, `linux`, `universal`),
`console`, `debug` or `exe`, and a bare `64`, `32` or `86` only when it stands
alone between separators. So `skyrun.x86_64.exe` and `skyrun.x86.exe` are one
program, `Game.exe`, `Game-64.exe` and `Game.console.exe` are one program, and
`skyrun.x86_64.exe` beside `skyrow.x86_64.exe` is two. A number glued to the
name is part of the name: `Lantern64.exe` can be a different game from
`Lantern.exe`, and nothing in the names proves otherwise, so `Lantern.exe` beside
`Lantern64.exe` (and likewise `Game.exe` beside `Game64.exe`) is
`ambiguous-player`. A reviewed `route_facts_v1` enrollment can still offer
such a release.

The bound is one because a second distinct name cannot be told apart from a
second title by name alone. That includes `Game.exe` beside `Launcher.exe`:
`launcher` is not a tool token, because a launcher is often the documented
entry point, so vetoing it could leave the wrong program as the only player.
Such a release is excluded as `ambiguous-player`. A reviewed `route_facts_v1`
enrollment can still offer it. The gate checks the same rule with its own code
and also requires an enrollment to name every player of its artifact that runs
on the platform.

A launcher alone is not the game either. When the one program of a platform
is named for a launcher, loader, settings or setup step (`launcher`,
`launch`, `start`, `loader`, `settings`, `config`, `cfg`, `configure`,
`setup`, `install` or `installer` as a whole word of its file name, split
like product names, so `GameLauncher.exe`, `Launch.exe`, `StartGame.exe`,
`GameCfg.exe` and `Game_Settings.exe` count and `Configurator.exe`,
`Restart.exe`, `Startup.exe` and `Settler.exe` do not), the whole identity
is withheld as `launcher-entry`. Such a program often builds or
prepares the game on first start without bundling a toolchain, and nothing
in the facts says it is the game's runtime entry. Reconsider an identity
withheld this way when listing data or release-bound metadata declares the
launcher as the game's runtime entry; a reviewed `route_facts_v1`
enrollment can still offer it. `setup` and `installer` programs are usually
already excluded by Core's tool veto; the launcher rule names them as a
second guard. The gate restates the rule with its own word splitter and
applies it to the whole identity: for each platform it takes the candidates
of its own one-program check, and when exactly one offerable archive (by
SHA-256) holds the platform's players, they are one program under one
top-level directory, no refused archive's name permits the platform, and that
program is launcher-named, it refuses every runtime of the identity. So an
enrollment forged for a clean Windows zip beside a Linux tarball whose only
program is a launcher is refused, as the fit rule withholds it.

A program named, or placed, for another role is not the game either. When a
program of any archive that could be the game (on any platform) holds
`debug`, `dedicated`, `headless`, `server`, `tools`, `editor`, `sdk`, `demo`,
`dbg`, `srv`, `ded`, `trial`, `shareware` or `test` as a whole word of its
file name or of any folder of its path (`Game-debug.exe`, `GameServer.exe`,
`server/Game.exe`, `tools/Game.exe`, `test/Game.exe`, `Game-trial.exe`,
`Game Demo/Game.exe`), the whole identity is withheld as `role-program`, even
beside the game's own program: a debug build is the same program by name,
but nothing says which one the player should register. Where no word
boundary shows (glued or in capitals), the program's literal name (the file
name lowercased, without `.exe`, letters and digits only) is compared with
the listing's, repository's and archive's names joined: one of them with a
role word before or after it (`gameserver.exe`, `GAMESERVER.EXE`,
`gamedebug.exe`, `servergame.exe`) or a trailing `d` (`gamed.exe`) is a role
program too. A word only containing the letters (`Serverless.exe`,
`Demos.exe`, `Testament.exe`, `Toolset/`, `Editorial/`) or a name plus another
word (`Gamer.exe`, `Gamedev.exe`) is not. A demo, trial or shareware build is
withheld: it is not the listed game. The gate restates the word list, the
splitter and the glued comparison and refuses every enrollment of such an
identity, and every runtime naming such a program.

A name with a character outside ASCII can imitate another name (a Cyrillic
`а` in `Gаme.exe`, the full-width `Ｇａｍｅ.exe`). When any archive of the
release or any of its programs has such a name, the whole identity is
withheld as `non-ascii-name`; the gate restates the rule.

###### Closed-vocabulary names

A deny-list of bad words loses to the next variation, so archive and program
names are parsed against a closed vocabulary instead: a name enrolls only
when every token is accounted for, and any unaccounted token withholds with
that token as evidence.

An archive name is tokenised (`archiveNameTokens`):

- the package form or another file extension (and an `.app` suffix) is
  removed;
- `x86_64`, `x86-64` and `64-bit` are one word;
- a run of digit groups joined by dots (`1.0.2`, `v2.1.0`) is a version,
  never a product word;
- the rest is split at separators into chunks:
  - A chunk that is a neutral word (`neutralArchiveWords`) is neutral. These
    are the platform and operating-system words `windows`, `win`, `win32`,
    `win64`, `linux`, `linux32`, `linux64`, `macos`, `mac`, `osx`, `darwin`;
    the architecture words `universal`, `universal2`, `x64`, `x86`, `x86_64`,
    `amd64`, `arm64`, `aarch64`, `i386`, `i686`, `64bit`, `32bit`; and the
    packaging words `portable`, `release` and `appimage`. `bin` is not one:
    `Game-bin-…` names one part of a split package.
  - A chunk of digits after `v` or `r` is a version. A `b` prefix is not
    one: `b2` usually says beta 2.
  - A chunk of digits only is an integer. It counts as a product word only
    where the matched name has that number at that position; otherwise it
    withholds (`number:<n>`). From four digits on (a date or build number) it
    may instead be a version.
  - Every other chunk is split into whole words (camel-case humps and
    letter/digit changes), each a neutral word or a product word, glued
    digits included.

The tokens follow an ordered grammar, `PRODUCT (VERSION | NEUTRAL)*`. The
product is the contiguous prefix of words and integers, and it must spell one
of the listing's id or name, or the repository name (`accountNames`,
`archiveNameAccount`). An integer is a product number only directly after the
product words. After the first version or neutral token, no product word may
appear, and an integer of one to three digits withholds, while one of four or
more digits is a date or build number read as a version. Anything else
withholds the whole identity as `archive-name-unaccounted`. The original game's title
(`original_game_title`) is not an accepted name: a remake's listing must not
enroll an archive named only for the original. So:

- for a listing named `Super Game`, `supergame-1.0-win64.zip`,
  `Super-Game-v1.0-windows-x64.zip` and `SuperGame-portable-x86_64.zip`
  enroll;
- for `Doom 2`, `doom2-1.0-win64.zip`, `doom-2-1.0-win64.zip` and
  `Doom-2-win64.zip` enroll, and for `2048`, `2048-win64.zip` does;
- these withhold, with the leftover token as evidence:
  - `SuperGame2-…` (`2`), `Super-Game-2-1.0-…` (`number:2`), `Super-Other-…`
    (`other`), `SuperGame-Trial-…` (`trial`), `SuperGame-beta-…` (`beta`),
    `SuperGame-rc1-…` (`rc`, `1`) and `SuperGame-Lite-…` (`lite`) for
    `Super Game`;
  - `Doom3-win64.zip` (`3`), `doom-2.1.0-…` (Doom at version 2.1.0,
    `missing:2`) and `Doom-1.0-win64.zip` (`missing:2`) for `Doom 2`;
  - `Doom-2-win64.zip` (`number:2`) for `Doom`;
  - `Game-1.0.2-win64.zip`, `Game-1.0-2-win64.zip`, `Game-v1-2-…`,
    `Game-2024-2-…` and `Game-win64-2.zip` for `Game 2` (its own
    `Game-2-1.0-win64.zip` enrolls), `Super-1.0-Game.zip` for `Super Game`,
    and `OPEN_1.2-3.win64.tar.xz` for `Open 3`;
  - `Game-b2-…` (`b2`), `Game-bin-…` (`bin`) and `Game-1-…` (`number:1`) for
    `Game`;
  - `Space-Invaders-…` (`invaders`) for `Space Game`, and `The-Other-…`
    (`other`) for `The Game`;
  - a platform-only name such as `win64.zip` (`no-product`).

An archive accepted only by the repository's name (not the listing's id or
name) is a common legitimate shape (a port's archive named after its own
repository). It enrolls, but `registration_queues.accepted_by_repository_name_only`
lists it for a person to check that group first. `numbered_products` lists
every enrollment that depended on a number counted as a product word,
`integer_as_version` every enrollment whose archive name was accounted for
by reading the first integer after the product words as a version when it
has exactly four digits or a leading zero, whatever its value
(`doom-2016-win64.zip` for `Doom`; `game-1942-…`, `Game-1000-…` and
`Game-0042-…` for `Game`; date-length runs of eight or more digits are not
listed), `unstated_status_words` every enrollment whose offered release's
title holds a status word (`beta`, `alpha`, `rc`, `preview`, `demo`,
`nightly`) as a whole word but states no status (`Beta release notes`), and
`tool_only_archives_beside` every enrollment whose release also holds an
archive with only tool-vetoed programs. These queues are reporting only and
never change what enrolls. The facts keep a release's title but not its
body, only the statement the body's first line makes, so a status word in
a first body line that states nothing is UNKNOWN to `unstated_status_words`.
Until November 24, 2026 the integer queue was `year_as_version` and listed
only 1970 to 2099.

A release may split the game across archives. When another archive of the
release holds no program, is no source archive, and has a name that allows
the offered platform (`Game-data-1.0.zip` or `Game-assets-1.0.zip` beside
`Game-1.0-win64.zip`), the offered archive alone may not be the whole game,
and the whole identity is withheld as `split-package`. A part named for
another platform (`Game-data-1.0-linux.tar.gz` beside a Windows zip) does not
split it. Loose data in another form follows the
[other package form](#other-package-forms) rule. The same-product relief
there applies only to recognised forms: the Windows, Linux and macOS
installer and package kinds, and the containers `.7z`, `.rar`, `.tar`,
`.tar.bz2`, `.tbz2` and `.tar.zst` (`reliefForm`). An unrecognised container
named for the product (`Game-1.0.pk3`) never gets relief and competes. A
`.wad` beside a desktop archive competes as a container too: withholding a
real console build is cheap.

A program enrolls only when its literal name (the file name lowercased,
without `.exe`, letters and digits only) equals the listing's, repository's
or accepted archive's product name joined. Only where the release ships no
other package form may architecture words follow it (`programArchitectureWords`:
`Game-x64.exe`, `game.x86_64`; a bare `64` or `32` is not one, since
`Game64` can be another title). Beside another form, the name stays strictly
literal. Every folder on its path must be made of product words, versions,
neutral words and the layout words `bin`, `game`, `app`, `contents`, `x64`
and `win64` (`programLayoutWords`, which accounts for a macOS bundle's
`Game.app/Contents/MacOS/`). Each folder segment follows the archive grammar:
a dotted run, `v<N>`, `r<N>` and four or more digits are versions; an
integer of one to three digits is accepted only directly after the segment's
words, and only where they and the number spell an accounted name (`Doom-2/`
for `Doom 2`; `Doom-2/`, `Doom 2/` and `Doom/2/` for `Doom`, and `Game-3/` for
`Game`, withhold); a number glued to letters counts only as a whole accounted
name (`Doom2/` for `Doom 2`, never for `Doom`); `b2/` is no version. Exactly one player may survive the platform selection:
two product-named programs on one platform (`Game/bin/Game.exe` beside
`Game/x64/Game.exe`, or `Game.exe` beside `Game-x64.exe`) are
`ambiguous-player`. Anything else withholds the whole identity as
`program-name-unaccounted`, with the leftover as evidence:
`supergameserver64`, `SUPERGAMELAUNCHER`, `SGSERVER`, `SGEDIT`,
`supergame-cli`, `Other.exe` in an archive named for the game, engine or
codename binaries, and `server/`, `tools/`, `editor/` or `data/` folders.

The neutral, architecture, layout and descriptor lists and the other
[measured name reliefs](#measured-name-reliefs) grow only from measured
evidence with a recorded example (`registration_queues.unaccounted_tokens`),
never speculatively. The deny-lists (role words, launcher words, archive role
words, names outside ASCII) stay as contradiction detectors layered on top:
they can never enroll. The gate restates the tokeniser, the lists and both
comparisons with its own code, for every runtime and for the identity-wide
candidate of each platform.

The cost of these name rules is stated, not hidden: they trade enrollment
count for certainty. They withhold real games in these shapes:

- a release that names only a platform (`win64.zip`, `linux.tar.gz`);
- a title that holds a role or launcher word as a word of its program or
  archive name (a title word `server`, `editor`, `demo` or `start`);
- an archive that uses a codename, an edition word or a platform word outside
  the neutral and descriptor lists (`Game-HD-…`, `Game-Deck-…`);
- a program that is an engine or codename binary, or carries a variant or
  bare-number suffix (`Game-64.exe`, `Game.console.exe`);
- a program with an architecture suffix beside an installer (`Game-x64.exe`
  beside `Game-1.0-Setup.exe`).

Such identities stay in their queue with the matched evidence
(`registration_queues.reason_evidence`, `unaccounted_tokens`) for a reviewed
`route_facts_v1` enrollment or an authored integration.

###### Measured name reliefs

Exact name equality turned out to demand what real project naming does not
provide. Of 131 identities an earlier run enrolled and a person verified as
correct (right archive, right program, stable release), 106 were withheld at
generator 22 by these name rules alone (`archive-name-unaccounted` 72,
`program-name-unaccounted` 22, `split-package` 8, others 4). The product
attribution of an archive comes from the catalog binding: the listing names
its own repository, a shared repository is withheld, and more than one
surviving archive is ambiguous. Names are there to detect contradictions.
Generators 23 and 24 therefore add closed, measured reliefs. A relief only accounts
for tokens: a deny-list word, an ambiguity, a split package, a wrong number or
any token still unaccounted withholds exactly as before, and the gate restates
each relief with its own code. Every enrollment records the reliefs it
needed (`registration_queues.enrollment_reliefs`), and
`registration_queues.relieved_enrollments` lists the relieved enrollments by
relief for a person to hand-check first.

- **Partial name** (`partial-name`). An accepted name is read in
  segments: runs of words joined only by a space, `-`, `_`, `.`, an
  apostrophe, `&`, `+`, `,` or glued (`&`, `+` and `,` link like `and`), so a
  colon, bracket, slash or dash starts a new segment. The first segment and
  colon subtitles are title segments; from the first em or en dash, slash,
  backslash, vertical bar or opening bracket on, every segment is an
  annotation (an author handle, a project, tool or platform name). The
  archive's product may omit whole segments, but never one that holds a
  sequel number (`sequel`): a number of one to three digits or a roman
  number, unless it is part of a dotted version (`0.1`), follows a linked
  platform word (`platformNumberWords`: "Xbox 360", "Nintendo 64", `N64`) or
  is glued inside an annotation token of two or more letters (`BT2`,
  `OpenKai2`, `oric212`); a single letter glued to it (`X4`) stays a sequel.
  Since generator 27, in a later title segment (a colon subtitle, not the
  first segment and not an annotation) a spelled number (`one` to `twenty`,
  `first` to `twentieth`, `spelledNumberWords`; never `zero`) and an integer
  of four or more digits are sequel numbers too: `Halo` never accounts for
  "Halo: Chapter Two" or "Halo: Second", `SeriousSam` for "Serious Sam: The
  Second Encounter", `Wipeout` for "Wipeout: 2048", `Battlefield` for
  "Battlefield: 1942", `Anno` for "Anno: 1602" or `TheOrder` for "The Order:
  1886". The cost is stated: on the catalog of November 24, 2026, 14 of 1,649
  listings hold such a subtitle (both Serious Sam encounters, four The Order:
  1886 listings, both The Two Towers listings, "Gakuou: The Royal Seven
  Stars", "N3: Ninety-Nine Nights", "Command & Conquer: … Dune 2000", "Rogue
  Trip: Vacation 2012 Recompiled", "Super Mario RPG: Legend of the Seven
  Stars" and "The Operative: No One Lives Forever"), and none of them can be
  accounted for by a partial name that omits it.
  Since generator 28 every number of a later title segment is a sequel
  number, but a linked platform's number ("Crackdown: Xbox 360"): a digit run
  inside a dotted run too (`KingdomHearts` never accounts for "Kingdom Hearts:
  2.8", `Halo` never for "Halo: 2.5", "Halo: Version 2.0" or "Halo: Chapter
  1.5"), every roman numeral in standard form of two or more letters, of any
  size, and a lone `V` or `X` (`Halo` never for "Halo: XXI", "Halo: XL" or
  "Halo: MMXX", `HaloWars` never for "Halo Wars: XXI"; a lone `I` stays a
  word), and the spelled tens beyond twenty, `hundred`, `thousand`, their
  ordinals and joined or hyphenated compounds (`thirty`, `twentyfirst`,
  `twenty-one`, `ninetynine`, `onehundred`; never `zero`). The first segment
  keeps the dotted-version reading (`Lantern 0.1`). The cost is stated: on the catalog
  of November 24, 2026, three of 1,649 listings read a new sequel number
  (`dx` in both "Link's Awakening DX" listings, `ninety` in "N3: Ninety-Nine
  Nights", which already held one), and of 5,920 archive names built from
  every listing's first title segment, whole title, repository name, id and
  initialisms, one changes outcome: `Zelda` no longer accounts for "Zelda:
  Link's Awakening DX HD".
  An annotation may also repeat a number the product carries ("Gears of War
  2 — Gears of War 2 port" for `GearsOfWar2`). So `Halo` never accounts for
  "Halo: 2", "Halo — 2" or "Halo, 2", `Doom` never for "Doom (2)" or "Doom:
  3", `Shenmue` never for "Shenmue: Chapter 2", `MegaMan` never for "Mega
  Man: X4" or "Mega Man (X4)", and `FinalFantasyVII` never for "Final
  Fantasy VII / VIII". Before the first word it keeps of a segment, the
  product may omit only articles (`the`, `a`, `an`) or a leading run that
  ends in a possessive ("Tony Hawk's", "Tom Clancy's", "Disney's"): `Contra`
  never accounts for "Super Contra", `Metroid` for "Super Metroid",
  `PacMan` for "Ms. Pac-Man", `MarioBros` for "Super Mario Bros.",
  `MortalKombat3` for "Ultimate Mortal Kombat 3", `CastleWolfenstein` for
  "Return to Castle Wolfenstein", `Auto` for "Grand Theft Auto: Vice City",
  `Mario` for "Paper Mario" or `Sonic` for "Sonic & Knuckles", while
  `provingground` accounts for "Tony Hawk's Proving Ground". Once it keeps a
  word of a segment it keeps every later
  word of that segment, except the segment's trailing port descriptors and
  measured edition suffixes (`editionSuffixWords`: `ce`, "Brogue CE"). So
  `Crackdown-v0.6.2-windows-x64.zip` accounts for "Crackdown (Crackdown
  Recompiled)", `crusader-no-remorse-…` for "Crusader: No Remorse / SDL port",
  `cybermage-…` for "CyberMage: Darklight Re-Awakening", `SealTeam-0.6.1-…`
  for "SEAL Team / SealTeam Source Port" and `shadowsoftheempire` for "Star
  Wars: Shadows of the Empire". A dropped tail never does: `MegaManX` for
  "Mega Man X4", `Mega-X` for "Mega Man X", `StarWars` for "Star Wars
  Battlefront" or "Star Wars Episode II", `PerfectDark` for "Perfect Dark
  Zero", `Batman` for "Batman Returns", `World` for "World of Goo", `Need`
  for "Need for Speed" and `Sonic` for "Sonic and the Black Knight" withhold.
  A port descriptor inside the title is a title word and is never omitted
  ("Static Shock" is never `Shock`, "Pal Game Party" never `Game-Party`). Every
  omitted name word, a trailing descriptor included, is recorded as
  `partial-name`. When a core word is omitted, a kept word of a title
  segment must be distinctive: not an article or connector, a generic or
  edition noun, a platform or console word, a descriptor, a neutral word, a
  number or a single letter (`nonDistinctiveWords`). So `game-1.0.zip` never
  accounts for "The Game", and an annotation alone never accounts for
  anything: an archive named only after the author, the project or the tool
  ("Gears of War 3 — squarehole360 Gears3 (GloriousEggroll)" for
  `GloriousEggroll-…`) withholds. Numbers are never optional: every number of the archive's
  product must be a whole number of the name where it stands; a kept number
  keeps its linked preceding word (`MegaMan2` never accounts for "Mega Man
  Legends 2"); a kept word keeps its linked preceding number; and a number of
  the name (digits or a roman number from `ii` to `xx`, `romanNumbers`)
  linked to a distinctive word is never omitted, even with its whole segment.
  "Doom" does not account for "Doom 2" or "Doom II", "Doom 2" does not
  account for "Doom", and `Silent` does not account for "Silent Hill 2". A
  number linked only to non-distinctive words may go: a year in brackets
  (`Lantern (1998)`), or the `360` of `crackdown-xbox360-recompiled`, linked
  only to `xbox`. Across names too: a product that drops a number another of
  the listing's accepted names ties to a kept word, and does not carry that
  number elsewhere, is unaccounted (a number glued inside an annotation
  token never is one, nor one an annotation repeats from the product), also when it spells the id or repository
  name exactly (`Doom-1.0-…` for a listing named "Doom 2" whose id is `doom`,
  `Sims1-…` for "The Sims 2"). `DOA3` for "Dead or Alive 3 (DOA3 Recomp)"
  carries its `3`. Since generator 29 a carried number compares by value: a
  digit run carries a roman number of two or more letters from
  `romanNumbers` of the same value, so `saboteur2-1.1-windows-x86_64.zip` in
  the repository `saboteur2` carries the `II` of "Saboteur II". A different
  value never does (`saboteur3-…` still drops it), nor does a digit run carry
  a lone `V` or `X`, which may be a letter's name ("Mega Man X"), or a word
  outside `romanNumbers`. Also since generator 29 an architecture word in the
  name's annotation (one of `programArchitectureWords`, its pieces in one
  chunk or joined by `-` or `_`: `x86-64`, `x86_64`, `x64`, `Win64`,
  `amd64`, `i386`, `64-bit`) names the build, so its numbers are no sequel
  numbers and never stop the annotation being omitted: the same archive
  enrolls for the listed name "Saboteur II: Avenging Angel (Saboteur II
  x86-64 recomp)". Only the annotation: in the title proper "Mario 64 (x86-64
  recomp)" still needs its `64`, and a bare annotation `64` or `x65` is still
  a number. A platform name split by camel case (`PlayStation 2`)
  makes its number mandatory: the cost is stated.
- **Initialism** (`initialism`). A product of three to six letters, or two
  to six with a number of the name among its initials, may be the
  initials of the first title segment's words from its first word on,
  covering more than half of that segment's words and at least two of them,
  with a distinctive word among them, and only where the partial name made
  of that segment's words, omitting the same later segments, is accepted
  (`laterSegmentsDroppable`): `nfs` never stands for "Need for Speed:
  Underground 2", `dbz` for "Dragon Ball Z: Budokai 3", `sw` for "Star Wars:
  Episode II", `mm` for "Mega Man: X4", `kh` for "Kingdom Hearts: Volume 2",
  `gow` for "Gears of War: 2" or `dw` for "Dynasty Warriors: Gundam 2". Since
  generator 26 a two-letter initialism without a number is none: `mm` for
  "Midtown Madness", `ki` for "Killer Instinct" and `sc` for "Super Contra"
  withhold (`mm2` for "Mega Man 2" and `ki2` for "Killer Instinct 2" do
  not). A word gives its first letter, a
  capitalised acronym its first letter or all of it (`otesa` for
  `OpenTESArena`), a number all its digits or roman letters (`wg3d` for
  "Wayne Gretzky's 3D Hockey"), a possessive `s` nothing (`thps` for "Tony
  Hawk's Pro Skater"). The run ends only at the end of its segment (before
  optional trailing words) or just after a chunk holding a number, never
  inside a glued chunk, and never while a number remains later in the
  segment: `dw2`, `doa3`, `wg3d` and `mhgu`, never `dw`, `doa`, `wg3`, `mhg`
  for "Monster Hunter Generations Ultimate" or `nfs` for "Need for Speed
  Underground 2". The same holds across the listing's names: a product that
  is, with descriptors around it, the initials of a run of any accepted
  name's first title segment that ends where no initialism may end (a
  truncated initialism, `truncatedInitialisms`) is unaccounted, also when it
  spells the id or repository name exactly. So `gow`, `gow-recomp` or
  `Native-gow` never stands for "Gears of War 2", 3 or 4, even in a
  repository named `gears-of-war-port` or `gow-recomp`, while `gow2` does;
  `nfs` never stands for "Need for Speed Underground" through a repository
  named `nfs-recomp`, `thps` never for "Tony Hawk's Pro Skater 2" through
  `thps-port`, and `SSX-Recomp` never for "SSX 3". Measured: `sst`,
  `rsc`, `ghr`, `gow`, `mhgu`, `dw2`, `wg3d`, `doa3`, `itc`, `thps`,
  `otesa`; `mm` and `ki` were measured too and are lost since generator 26
  (`ki` is still accounted where the repository name spells it, `ki-recomp`).
  An initialism that is a
  deny-list, neutral, descriptor, channel, variant, layout or package-form
  word, a roman number, or a short edition, medium or bonus word (`ds`, `sv`,
  `svr`, `cl`, `ed`, `me`, `dlc`, `ost`, `bgm`, `hd`, `sd`, `uhd`, `dx`, `cd`,
  `dvd`, `ex`, `se`, `ce`, `le`, `re`, `mp`, `sp`, `vr`, `xl`), is never one
  (`initialismVetoWords`), even where it really is the initials; `sc2` for
  "Super Contra 2" is one. `ewj` for "Earthworm Jim" is not recovered as an
  initialism: `earthworm` is one word in every accepted name, and the rules
  split no compound words; it is accounted only where the repository name
  spells it (`ewj-port`). Since generator 27 an initialism takes no initial
  from an author handle (`authorHandles`): initials come from title words and
  the repository's name, never from its owner. The first word of a listing
  id is a handle when it is no word or whole chunk of the name's title
  segments nor of the repository's name (`alexbeav` of
  `alexbeav-suikoden-ii-recomp`, `abilliontokens` of
  `abilliontokens-sims2-recomp`), and the first word of the repository's
  name is one when it is no title word and the owner starts with it (three
  or more letters: `owner/owner-game`); a name that starts with a handle has
  no initialism, so `asii` and `as2` withhold. The cost is stated: on the
  catalog of November 24, 2026, 508 listings have a handle, and 376
  initialisms of their ids or repository names are no longer accepted (most
  start with `a` for `alexbeav`; the id `diddy-kong-racing-golden-balloon` of
  "Golden Balloon" also loses `dkrgb`, its words being neither title nor
  repository words).
- **Port descriptor** (`descriptor`). A closed list of words that say how a
  port was made, not which game it is, may stand in the archive or program
  name without being in the accepted name, and may be absent where the
  accepted name has it as a trailing port descriptor ("… Recomp", "… PC
  Port"; recorded as `partial-name`), never where it is a title word.
  Descriptors are never the distinctive word. In an
  archive or folder name a descriptor is a whole token (`Portal-…` never holds
  `port`); in a program's glued name, descriptors only trail it
  (`narutothebrokenbondpc`), as measured. Each has its measured example:
  - `recomp`: `gow2-recomp-0.4.7-linux-x86_64.tar.gz` (repository
    `gears-of-war-2-pc-port`), repositories `doa3-recomp` and `ki-recomp`;
  - `recompiled`: `FZeroXRecompiled-v0.1.16-windows-x64.zip` (repository
    `f-zero-x-recomp`), `DarkRiftRecompiled-macOS-arm64.zip` (repository
    `DarkRiftRecomp`);
  - `recompilation` and `static`: "The Sims (Original Xbox Static
    Recompilation)" beside `Sims1-win64.zip`;
  - `decomp`: repository `crusader-no-remorse-decomp`; `decompiled`: listed
    with it by the owner, no separate archive measured;
  - `port`: repository `SealTeam-Source-Port`;
  - `pc`: `MechAssault2-PC-v0.1.0-win-x64.zip`, `Skate2-PC-v0.2.0.zip`,
    `Skate1-PC-v0.2.0.zip`;
  - `native`: two measured archive names;
  - `unofficial`: listed by the owner in the same family, no separate archive
    measured;
  - the region of the original the player supplies: `usa` and `ntsc`
    (measured), `pal` (same family);
  - `uni`: a macOS universal-build marker (two measured macOS archives), only
    directly beside `macos`, `mac`, `osx` or `darwin`.

  These are never descriptors and still withhold: `beta`, `alpha`, `rc`,
  `preview`, `nightly`, `dev`, `test`, `demo`, `trial`, `lite`, `deck`,
  `mods`, `extended`, `fixed`, `hd`, `remaster`, `remastered`, `classic` and
  every deny-list word. So `Game-PC-Demo-…` and `Game-Recompiled-Server-…`
  withhold.

- **Build identifier** (`build-id`). After the product, a token of 7 to 40
  hexadecimal characters with a letter and a digit (`e1625759`, the
  `0c97cca` of `0.79.0c97cca`) is read like a version; so is a dotted version
  with one glued patch letter (`SymphonyRecomp-v1.2.0p-…`) and a dotted
  version glued by `v` or `V` to a product word
  (`condemned2recompV0.6.1_windows.zip`). The cost is stated: a real word of
  seven or more hexadecimal letters with a digit (`decade2`) after the
  product reads as a build identifier. A dotted version glued to `a`, `b`,
  `r`, `rc`, `alpha`, `beta` or `pre`, with or without a number (`1.2.0b2`,
  `1.0rc1`, `1.0a`), is a prerelease marker and withholds. Only the measured
  `p` is a patch letter; any other letter glued to a version
  (`1.0d`, `1.0x`) stays unaccounted.
- **Program names** use the same reliefs where the release ships no other
  package form: the literal name, before any architecture words, may spell an
  accepted name or the accepted archive product under them
  (`shadowsoftheempire`, `ogrebattle64`, `provingground`, `rampage`,
  `brogue`, `crystaldefenders`, `dw2`, `wg3d`, `otesa`,
  `battlearenatoshindenrecompiled`, `macrossvfx2recompiled`,
  `narutothebrokenbondpc`). Beside another package form the name stays
  strictly literal, and role and launcher words veto as before.
- **Folders** (`folder`). A folder segment read by the archive grammar whose
  product is the accepted archive product or spells an accepted name under
  the reliefs, followed only by versions, build identifiers, neutral words,
  descriptors and dates or build numbers of four or more digits, is
  accounted: `Amped2-Recomp-v0.2.0-windows-x86_64/`,
  `SSX3-Recomp-v0.3.0-windows-x86_64/` and `Dora64-3-1.0.0-Windows-x64/`
  failed the per-word folder rule only because of their glued digits. A
  folder accepted only under a relief (a partial name or an initialism) is
  checked for uniqueness like a relieved program name (generator 27): `sm2/`
  holding `SpiderMan2.exe` in `SpiderMan2-1.0-win64.zip` withholds beside a
  "Space Marine 2" listing in another repository, as `gow/` would beside a
  second God of War listing. A folder that spells the accepted product is
  not compared.

A name is relieved when it is accepted only through a partial name or an
initialism: a product that spells one of the listing's accepted names whole,
adding or omitting only descriptors and edition suffixes (`DarkRiftRecompiled`
for the repository `DarkRiftRecomp`, `itc` for the repository `ITC-Recomp`),
or only adding a build identifier, is not relieved, and the fit prefers such
a spelling over a relieved one.

**Uniqueness** (`name-not-unique-in-catalog`, generator 26). A relieved
archive or program name is accepted only if no catalog listing in another
repository would accept the same product literal, by equality with one of
its accepted names or by the same reliefs (`catalogNameCollisions`; the gate
restates it from `generation.records` with its own index,
`gateCollisions`). A name that cannot tell two catalog games apart is a
contradiction, whatever the repository says: on the catalog of November 24,
2026, `gow` is accepted by God of War listings and by "Gears of War:
Judgment", `tloz` by twelve Zelda listings, `ts2` by "The Sims 2",
"TimeSplitters 2" (twice) and "Toy Story 2", `hst` by both Hot Shots Tennis
games, `dw2` by Digimon World 2 and Dynasty Warriors 2, and `thps` by two
ports of Tony Hawk's Pro Skater. The withhold lists the other listings as
evidence (`registration_queues.reason_evidence`), so a person can see whether
a more specific accepted name in the catalog would resolve it. A listing in
the same repository is the [shared-repository](#release-lines) rule's
concern and is not compared: two listings in one repository that are each
bound to a distinct release line by their `release_url` tag are attributed
by that authored binding, not by names (without such bindings the
shared-repository rule withholds them). The cost is stated: two ports of one game in
different repositories collide too (`thps`), and such an identity waits for
a person. Since generator 27 numbers compare by value (`numberTwinGroups`,
`gateTwinGroups`): each listing's names are compared as they are, then with
every number written as a roman numeral, then with every roman numeral
written as digits, one group at a time (since generator 28 for every value
from 1 to 3999, read by a general roman parser both ways, so `gow21`
collides with "God of War XXI"), so `gow2` collides with
"God of War II", `sf3` for "Syphon Filter 3" with "Shining Force III" (and
with a listing named "Street Fighter III"; the real "Street Fighter III: 3rd
Strike" accepts neither `sf3` nor `sfiii`, its subtitle holding the number
3), and `sfiii` with "Syphon Filter 3". The same holds for the cross-listing
check below (`Lantern2` for "Lantern 2: Echoes" names a "Lantern II"
listing). A lone `I` and `1` stand for each other only where the `I` (or
`1`) directly follows the product words of a title as the last word of that
segment (`ff1` meets "Final Fantasy I"); elsewhere neither is twinned
(generator 28). A product that spells its own listing's or repository's name
exactly, or modulo descriptors, is not relieved and is not compared:
`sfiii` for the repository `sfiii-native` of "Shining Force III" still
enrolls. Author handles give no initials in the index either (D3).

The index maps every word of every listing's id, name and GitHub repository
name (with their number twins), and the first letter of each, to its
listings; it is built once per listing array (O(W) for W words in the
catalog). A literal of length L is looked up in O(L × longest word) map reads
after each leading run of descriptors, and every listing found is checked
with the reliefs, in code-point order of their ids. The per-query cost is
honestly linear in the catalog: every listing whose name starts with the
literal's first letter is a candidate (on the catalog of November 24, 2026,
426 of its 3,298 ids and names start with the most common letter), and a
whole run costs the relieved candidates times the listings. Measured on that
catalog (1,649 listings): the index builds in 160 ms, and 2,623
relieved-shaped literals (every listing's initialisms and first title
segment) take 3.8 ms each in the fit and 14.3 ms each in the gate, 10 s and
37 s in all.

A relieved archive product that spells the complete accepted name (id, name
or GitHub repository name, modulo descriptors) of another catalog listing,
or the first title segment of the name of a listing in another repository
(real names carry `— X (author)` suffixes), is a contradiction, and the whole
identity is withheld as `archive-names-another-listing`:
`StarWars-1.0-win64.zip` in the repository of "Star Wars: Battlefront" names
the listing "Star Wars". So does a four-digit-or-longer number read as a
version that, with the product, spells another listing's name
(`Wipeout-2048-…` for "Wipeout" beside a listing "Wipeout 2048"); alone such
an archive stays in the `integer_as_version` queue. A partial name that is a
leading-word prefix of two or more listings' names (`Crackdown` beside
"Crackdown" and "Crackdown 2"), or an initialism whose run's words are
(`mm2` beside "Mega Man 2" and "Mega Man 2: Disc 3"), enrolls but is listed
in `registration_queues.franchise_only_partial` for a person to check first.
Since generator 27 so is every relieved archive, program or folder name that
drops a later title segment (a subtitle such as ": Peace Walker", ":
Symphony of the Night" or ": San Andreas"; an initialism drops every later
title segment), always, not only when two or more listings share the prefix:
dropped subtitles are always hand-checked. Enrollment is unchanged (the
hand-verified `cybermage` for "CyberMage: Darklight Re-Awakening" and
`rampage` for "Rampage: Total Destruction" still enroll). The queue maps each
listed identity to its findings, naming the dropped segment
(`windows-x86-64: rampage.exe drops "total destruction"`) or the shared
prefix (`… shares its words with two or more listings`). Since generator 29
a segment is listed only when every accepted spelling of the name omits it:
one that keeps the segment shows the name holds its words, so
`SimsBustinOut` for "The Sims: Bustin' Out — Original Xbox (The Sims:
Bustin' Out - Static Recompilation)" and `hardcorpsuprising` for "Hard
Corps: Uprising (Hard Corps: Uprising Recompiled)" are not listed, although
each could also be spelled with the annotation's copy of the subtitle; a name
that lacks the subtitle (`HardCorps`) still is. Only a spelling that keeps
the first title segment counts, so `lantern` still drops "The Lantern" from
"Lantern: The Lantern" although it can spell the subtitle alone. The same
holds for `subtitle_dropped_by_repository_name`, whose fallback (the
longest leading run of title segments the literal spells) compares numbers
by value too: `saboteur2` drops "Avenging Angel" from "Saboteur II:
Avenging Angel" as from "Saboteur 2: Avenging Angel".
Since generator 28 an offered archive or accepted program name that drops a
later title segment of the listing's name while equal to its repository or
id name (modulo descriptors), and so is not relieved, is listed in
`registration_queues.subtitle_dropped_by_repository_name` with the same
findings (`windows-x86-64: Doom2.exe drops "total destruction"` for "Doom 2:
Total Destruction" in the repository `doom2`): reporting only, enrollment is
unchanged.
`HalfLife` for "Half-Life: Blue Shift" is such a franchise-only partial name
(the colon makes "Blue Shift" a later segment without a number); beside a
"Half-Life: Opposing Force" listing in another repository it spells that
listing's first title segment and withholds, and beside any other listing in
another repository that accepts it it withholds by uniqueness. An archive that
spells its own listing's name exactly is not compared, and the check reads
archive names only: a relieved program name is not compared with other
listings.

The next real-data run reports the enrolled count, the count per relief
(`relieved_enrollments`), the fate of the 131 previously verified
identities, and every newly enrolled identity for hand-checking, relieved
ones first.

One program name is not one package, and equal programs are not one package
either. A release can carry the full game and a small update archive that
holds the same game program (the same player SHA-256), or the game and an
authoring-tool archive whose program has the same file name. Two archives are
the same package only when their own bytes are (equal archive SHA-256).

First, an archive whose own name holds a role word is never offered:
`update`, `updater`, `hotfix`, `delta`, `incremental`, `patch`, `symbols`,
`debug`, `dedicated`, `headless` or `demo` (`Game-Dedicated-1.0-win64.zip`,
`Game-Demo-1.0-win64.zip`, withheld with or without an installer of their
own). The archive name is split into words like product names are
(separators, camel-case humps and letter/digit changes, as
[release lines](#release-lines) split names), so a role word with a trailing
number or glued into a camel-case name is that role word
(`update-0.5.10.zip`, `Game-debug-win64.zip`, `Game-Windows-Update1.zip`,
`Game-patch01.zip`, `GameUpdate-linux.tar.gz`), while `Updated-Game.zip`,
`Deltaville-Fan.zip` and `Patchwork.zip` pass: a glued word that stays one
word is not a role word. Every occurrence vetoes, whatever the product's or
repository's own name: the archive name alone cannot tell a title word from a
role suffix, and each earlier own-name exemption let an update or delta
payload through (`Delta-Squadron-1.1-linux-delta.tar.gz` on a repository
named `delta`). The cost is stated: a game whose own title holds a role word
as a separate word of its archive name (`Delta-Lantern-win64.zip` for a
listing named "Delta Lantern", or `DeltaLantern-win64.zip`, which camel case
splits into `delta` and `lantern`) is withheld as `contradictory-role`.
Reconsider an identity withheld this way only when a listing-declared package
binding names this archive; the name rule itself does not change. A vetoed archive is reported as an
`asset-role-name` exclusion with the word as its token. Then, when more than one distinct archive whose
name allows the platform still holds players for it, the platform is
`ambiguous-artifact`, never chosen by order, size or name. There is no
exception for an archive that names the platform's system: a
`Game-v1.2-windows-exe-only.zip` beside an OS-neutral full `Game-v1.2.zip`
cannot be told apart from the full build by name, so choosing the explicit
one would enroll a partial build. So a `Game-v1.0.zip` beside a
`Game-v1.0.tar.gz` of the same game is ambiguous for every platform both
allow, and `Game-v1.0-windows.zip` beside a neutral `Game-v1.0.tar.gz` that
also holds the Windows program is ambiguous on Windows and offers the tarball
on Linux. A neutral Linux-only tarball beside `Game-windows.zip` holds no
Windows player, so each platform still has one archive. The one-program rule
still counts the players of every such archive. The gate checks each part
with its own code too.

An archive that bundles a compiler, interpreter or build helper builds or
prepares the game on the player's machine ("build on first start"), so a
person must look at it. Core's inspection returns the archive's listing as
names only: `names` (every distinct lowercase path component) and `leaves`
(every distinct lowercase file name). The helpers are `zig`, `clang`, `clang++`, `gcc`,
`g++`, `cc1`, `ld`, `lld`, `ld.lld`, `python`, `python3`, `pythonw`, `pip`,
`node`, `cmake`,
`ninja`, `make`, `msbuild`, `cl`, `link`, `hactool`, `extract-xiso`, `xdelta`
and `xdelta3`. `7z` and `7za` are ordinary extraction helpers and are not on
the list. A file leaf also names a helper when it is a versioned or renamed
compiler or interpreter: `python`, `python3`, `pythonw`, `clang`, `clang++`,
`gcc`, `g++`, `lld`, `ld.lld` or `zig` followed by digits and dotted digits
(optionally after `-`) or by `-` and letters, digits or `_`, with or without
`.exe` (`python3.11`, `clang-17`, `gcc-13`, `zig-x86_64`, `pythonw.exe`); such
a name never counts as a directory (`gcc-libs/`), and another extension never
matches (`python311.dll`). The worker records every listing entry naming a
helper as the artifact's `toolchain_names`: a file leaf as is
(`python.exe`), a directory component that is no file leaf with a trailing
`/` (`zig/`, `link/`). The short or common helper names `cl`, `ld`, `link`,
`make`, `node`, `python`, `python3`, `pythonw` and `pip` also name ordinary folders, so
they count only as a file leaf: `assets/link/`, `levels/ld/` or a
`lib/python3.11/` folder never match, while `Python/python.exe` does. The
other helpers count as a file or a directory (`tools/zig/`). Only a whole
name matches, so `python311.dll`, `scripts/` or `node_modules/` never do. The
helpers the recorded entries show are the artifact's `bundled_toolchain`; the
facts check refuses a summary the entries do not show. Any such archive that
could be the game withholds the whole identity as `bundled-toolchain`,
whatever the program is called and whichever platform the archive serves:
building on first start is a property of the project, not of one archive,
and a program name cannot prove the release does not build itself. "Could
be the game" means a runtime archive from exact bytes whose own name vetoes
nothing and permits a supported platform; a [source archive](#source-archives)
never counts. The route-fit report lists the helper names per identity
(`registration_queues.bundled_toolchains`). The gate re-derives the helpers
from the recorded `toolchain_names` with its own code, never from the
worker's summary, and refuses an enrollment of any platform of a release with
such an archive.

##### Release lines

A repository can publish more than one product: a game and its modding tool,
or two titles. Each release tag has a release line: its product words before
the version, lowercase, without release-channel markers. Derivation errs toward
one line for version and channel noise and toward different lines for
different product words:

- The version starts at a real version token: a whole word of digits,
  optionally after one `v`, `r` or `b` (`v1`, `r14388`, `2025`). A number
  followed by a letter is a product word (`game2x`, `game2`). A product word
  ending in a glued `v<digits>` is cut there (`game2v0.3` is `game2`).
- A `v`, `r` or `b` word directly followed, after a separator other than `.`,
  by another version token is a product word: `r2-v1.0` is line `r2` and
  `b2-v1.0` is line `b2`, while `v2.0-win`, `b5` and `r3` are the main line.
- A bare number of one or two digits directly after a product word, not
  before `.`, is part of the product: as the last kept word (`sm-1` and
  `sm-2`, `game-2` and `game-3` are different lines), or before another
  product word or a version (`lantern-64-v1` is `lantern-64`, `part-2-1.0` is
  `part-2`, `game-2-v1.0` and `game-2-v1.1` are both `game-2`). Before
  another bare number it is the version (`game-1-2-0` is `game`), and after a
  dropped word or at the start it is always the version (`hotfix-1`,
  `64-v1`). The repository's own name does not change this: on repository
  `sm`, `sm-1` and `sm-2` are two lines (`sm-1-v1.0` is still `sm-1`), so a
  listing for game 1 never enrolls game 2's release. The cost is plain: a
  repository that tags its major versions `<repository>-N` (`proj-3`,
  `proj-4` on `proj`) is `ambiguous-release-line` unless the listing binds
  its release (`release_url`).
- Release-channel words such as `release`, `nightly`, `beta`, `rc`, `build`
  or `rev` are dropped, alone or glued to a number (`rc2`, `beta5`,
  `build123`, `nightly20250101`, `release1.2`). `final` and `update` are not
  channel words: they can name a product.
- A commit hash (7 to 40 hex characters with at least one digit and one
  letter `a`–`f`) is version noise after the first word: `native-only-1a2b3c4`
  is line `native-only` and `dev-abc1234` is the main line, while
  `deadbeef-v1` (no digit) is line `deadbeef`. As the tag's first word a
  hex-looking word names the product: `facade1-v1.0`, `decade2-v1.0` and
  `cafe2024-v2` are lines of their own. A tag that is only a commit hash
  (`abc1234`, also with system or architecture words) is a channel build
  (below), so it is never stable and never counts as a release line. `v.`
  before digits is a version (`v.0.1.1`).
- `test`, `testing`, `tester`, `prealpha`, `canary`, `wip`, `experimental`,
  `fixed`, `fix`, `new` and `pr<digits>` are channel words when they stand
  next to a version, date or hash, or when the tag holds nothing else
  (`wip-v0.4`, `pr42`, `v1.0-fix`, `new`, `test`). Between product words they
  stay product words: `new-game-v1` is line `new-game`, `fix-it-v1` is
  `fix-it` and `test-orbit-v1.0` is `test-orbit`.
- Operating-system and architecture words are dropped as whole words
  (`windows`, `win`, `win32`, `win64`, `linux`, `linux64`, `macos`, `mac`,
  `osx`, `darwin`, `universal`, `x64`, `x86`, `x86_64`, `amd64`, `arm64`,
  `aarch64`, `i386`, `i686`, and a literal `x8664`), so builds of one
  product for several systems
  are one line: `windows-v1.0`, `win64-1.0` and `linux` are the main line.
  `x86_64` and `x86-64` are one word only when no letter or digit touches
  either end, in both copies of the rule; as one word they are a build
  target, never a number beside a conditional channel word, so
  `sm-x86-64-fixed-mac` is line `sm-fixed`. `nightly-x86-6412` holds `x86`
  and `6412`.

A line that spells the repository's own name is the main line. So `v1.0`,
`v2`, `2.0`, `v1.2.0p`, `2.0.0-beta`, `r14388`, `2025.01.01`, `20250101`,
`2025-01-01-nightly`, `release-1.2`, `build-123`, `rc2`, `latest`,
`nightly`, `continuous`, `1.0.0-windows-x64` and `<repository>-v3` are the
main line, while `level-editor-v1.0.0`, `game2-v1.1` and `lantern-64-v1` are
lines of their own. A tag that is not printable ASCII, or unknown, is a line
of its own.

Ambiguity excludes. A final short number cannot be told apart from a second
title by the tag alone, so a repository that tags major versions as `game-1`
and `game-2` has several lines and its unbound listing is
`ambiguous-release-line`. That is an honest exclusion: the listing's
`release_url` can bind the line, and a reviewed `route_facts_v1` enrollment
can offer it. The same holds for version-shaped product words: `v1-2` is
line `v1-2` and `v1-r1` is line `v1`, so a repository tagging that way beside
`v1.3` is excluded too.

A tag that consists only of rolling-channel words (`nightly`, `continuous`,
`latest`, `dev`, `build`, `snapshot`, `canary`, `preview`, `test`, `wip`,
`experimental` and similar) plus dates, times, hashes and system or
architecture words is a prerelease for the newest-stable choice even when the
provider does not flag it: `build_20261120_2250`, `nightly-2025-01-01`,
`continuous`, `latest` and `dev-abc1234`. A commit hash counts as a channel
word here, so a tag of only a hash (`abc1234`, `abc1234-win64`) is such a tag;
a hex-looking word without a digit (`deadbeef`) is no hash. A year alone is a
date, so `build-2025` is a channel build too: a repository tagging its
releases only `build-<year>` has no stable release (`no-stable-release`) until
it publishes a versioned tag or the listing is reviewed. Only real calendar and clock shapes
are dates: a year `19xx` or `20xx`, a month directly after a year and a day
directly after that month (`2025-01-01`), an eight-digit `yyyymmdd`
(optionally with `hhmm` or `hhmmss` glued after it), and an `hhmm` or
`hhmmss` word directly after a whole date. Any other number is a version, so
`build-42`, `build-12`, `build-1234`, `beta-01`, `release-2025-01-01`,
`build-123`, `nightly-1` and `2025.01.01` are not such tags. The worker
records the combined verdict, and the fit rule and the gate each restate the
tag rule (`channelOnlyTag`, `gateChannelOnlyTag`) for the offered release and
every observed release.

A channel-only release counts as never stable. For the newest-stable choice
and for the planned rule for repositories that publish only prereleases, a
repository whose releases are all channel-only (or flagged prereleases) has
never published a stable release (`no-stable-release`).

The worker records each observed release (within the observer's own bound of
the newest releases) with its tag, its prerelease verdict, publication time
and whether it carries a package file. Each check sees these releases:

- The line count (below) sees only the stable packaged releases, plus any
  release whose verdict Core did not give: a prerelease's tag noise never
  makes a second line.
- The product check sees the offered release's own line.
- The newer-prerelease check sees every prerelease (and unknown verdict)
  published after the offered release whose line differs from it.

The fit rule and, independently, the gate refuse an identity when:

- another catalog identity names the same repository through its release URL
  or project URL (any path below the repository counts), unless the listing's
  `release_url` names a tag on its repository
  (`…/releases/tag/<tag>`) whose line no other identity sharing the
  repository is bound to (`shared-repository`);
- the stable packaged releases fall into more than one line and the listing
  binds none, or the offered release is not on the bound line
  (`ambiguous-release-line`);
- the listing binds no line and the offered release's line is neither the
  main line nor names the listed product: joined, it is at least three
  letters and digits long and equals one whole word, or a contiguous run of
  whole words, of the repository name or the listing's id, name or original
  title. Words are split at separators, camel-case humps and letter/digit
  changes (`lantern64recomp` is `lantern`, `64`, `recomp`; `OpenLanternPS1` is
  `open`, `lantern`, `ps`, `1`), so part of a word never counts: `rec` does
  not name `lantern64recomp`. A window of only a tool's releases
  (`level-editor-v1.0.x`) is never taken for the game, while `part-v1.2` on a
  `part-decomp` repository is (`ambiguous-release-line`);
- a prerelease on the main line or on another line that names the product,
  or a release whose verdict Core did not give or whose tag is unknown, is
  newer than the offered stable release and on another line
  (`ambiguous-release-line`): the offered release may be another product's
  older release, such as a tool's stable release beside the game's newer
  betas. A newer prerelease on a line of other product words (a tool's beta
  beside the game) does not decide the game.

A listing bound to a line is read on that line only: the worker offers that
line's latest stable release. This uses the existing `release_url` field; no
per-title data is added. A repository that publishes a second product on the
main line itself (`v1.1-tools`) is not told apart by its tags; the shared
repository, tool-token, other-package-form and one-package rules still apply.

Repositories are compared by name. A listing that still names a repository's
old `owner/name` after upstream renamed it is not counted as sharing it with
an identity whose facts carry the canonical name. This residual is accepted:
the worker binds each entry to its listing's repository id
(`repository-identity-changed`), and the gate requires the recorded id, so a
renamed repository cannot enroll for a listing that names another one.

###### Release text statements

A release can call itself a prerelease in its own text while the provider
flag says stable. A release whose title, or the first line of its body,
states a prerelease is one for the newest-stable choice: the worker chooses
the newest release without such a statement, and the fit rule and the gate
treat it like a flagged prerelease everywhere (`no-stable-release` when it is
the offered release, the line count, and the newer-prerelease check).
Words may withhold, never pick an older release: when a newer release on the
offered line is stable by its provider flag and Core's tag rule
(`core_prerelease: false`) and is skipped only because its own words state a
prerelease, the older release is not offered. The identity is withheld as
`worded-prerelease-skipped` and listed in
`registration_queues.worded_prerelease_skipped` (`<tag>: <field> <token>`
per skipped release) for a person to hand-check: a newer release that is a
real prerelease confirms the withhold; one that is stable after all (a
measured false positive: Faxanadu's `v2.4.0` and `v2.5.0`, stable releases
titled as an experimental mod, would otherwise have offered `v2.3.3`) stays
withheld until its text, the rule or its provider flag changes, rather than
silently offering an older game. A newer release the provider flags as a
prerelease, or whose tag Core reads as one, is a prerelease by those
semantics, and the older stable release is offered as before. The
statements are `prerelease` (`prerelease`, or `pre` followed by `release`, so
`pre-release`), `release-candidate` (`release` followed by `candidate`, or a
standalone `rc`, also with digits: `RC1`, `1.0rc2`), `beta` and `alpha` (also
with digits), `early-access` (`early` followed by `access`), `unstable`,
`nightly`, `experimental`, `wip`, `preview`, `canary`, `demo`, `test-build`
(`test` followed by `build`), `debug-build` (`debug build`), `daily-build`
(`daily build`), `test-release` (`test release` or `testing release`),
`development-snapshot` (`development` followed by `snapshot`), `dev`,
`prototype` and `playtest` only with a number (glued, `dev2`, or directly
before one, `Playtest 2`), and `not-for-production` (`not for production`,
wherever it stands). A status word joined by a single hyphen or en dash to `test`,
`testing`, `tests`, `phase` or `stage` is one compound status that stands
where its last word stands: `Alpha-Testing 0.0.11` (measured: it stated
nothing before), `Beta-Test 3` and `Game 1.0 Beta-Test` state a status, while
`Alpha Testing 0.0.11` (no hyphen), `Alpha-Centauri 1.0` and `Out of
Beta-Testing 2` do not. A bracket between two words never joins them. Between a status word and its number, `release` is
skipped like a connector word (`Beta release 1.0`, `Nightly release
20261101`, `Beta release (1.0)`). A status word also stands when only connector words
(`build`, `version`, `ver`, `v`, `no`, `number`) and `release` follow it to
the end of the line: `Demo version`, `Beta build`, `Canary release`,
`Release candidate build` and `Super Game - Demo Version` state a status,
while `Beta release notes` and `Demolition release` do not.
Words are split at separators and letter/digit changes, never inside a word,
so `Arc`, `Alphabet`, `Betamax` and `Publicity` state nothing.

A status word states the release's status only where a status stands, never
anywhere in a sentence:

- what never states anything is removed first: image references
  (an image's alt text and file path), HTML tags, link targets (the link text stays),
  URLs, compare ranges (`v0.9-beta...v1.0`, as in GitHub's generated
  "Full Changelog" line: a run of two or three dots with a digit both before
  and after it, so `Beta...` and `Beta... finally` keep their status word) and
  image file names. Raw HTML is removed in CommonMark's grammar, whether or
  not GitHub renders the element (it strips what it does not render, and
  shows neither as text): comments, declarations (`<!DOCTYPE html>`),
  processing instructions, and any open or closing tag, so `<html>`,
  `<body>`, `<center>` and `<font color=red>` never become the judged line; a
  tag's whitespace may hold one line break (an `<img` whose attributes
  continue on the next line), and a `<script>` or `<style>` element is
  removed with its contents. A block element (`<br>`, `<p>`, `<div>`, list
  items, headings, table rows and the like) ends a line. Anything else in
  angle brackets is text, as GitHub shows it: `v1 <- Beta 2`,
  `Windows < 10 Beta 3` and `<Beta 3>` (an attribute cannot start with a
  digit) state _beta_. Every removal reads the text once, so a body of any
  length is read in time linear in its length;
- the word must be glued to digits (`rc2`, `1.0rc1`, `beta.2`), directly
  before a version (`Beta 3`, also past `build`, `version`, `ver`, `v`, `no`
  or `number`: `Pre-release build 7`), directly after one (`v1.0 Beta`), the
  line's last word (`Final Beta`, `Release candidate`), inside parentheses
  or brackets (`Game 1.0 (Beta)`, `Early access 0.3 (unstable)`), directly
  before an ellipsis (`..`, `...` or `…`: `Beta... finally`, `Beta… out now`),
  or directly after `public`, `open`, `closed`, `developer`, `technical` or `early`
  (`Public beta test`, `Open alpha`, `Developer preview`);
  `This is beta software for testing`, `Open the beta menu with F1` and `Now
  in early access for everyone` state nothing;
- a negation or past transition before it states nothing (`not`, `no`,
  `longer`, `since`, `after`, `from`, `post`, `past`, `former`,
  `formerly`, `previously`, `was`, `were`, `leaving`, `left`, `leaves`,
  `exits`, `exited`, `ended`, `ends`, `graduated`, `graduates`, `than`,
  `over`, `beyond`, and `out of`, skipping `a`, `an`, `the`, `last`,
  `latest`, `previous`, `final`, `first`, `public`, `open`, `closed`,
  `developer`, `technical` and `early`):
  `Out of beta`, `Out of early access`, `No longer a public beta`, `Changes
  since the last beta`;
- the product's own words name the product before the line's first number:
  the repository name's words and the listing's id, name and original title
  words (`listing_words`). `Alpha Centauri Port v1.0` for a listing titled
  `Alpha Centauri`, `Beta Squadron 1.2` and `RC Racing v3` state nothing,
  while the same word after a version states again: `Beta Squadron 1.3 Beta
  2` is a prerelease.

Only two places are judged: the release title, and the body's first line
that holds a letter or digit once what states nothing and leading Markdown
heading, quote, list and emphasis marks are removed, looked for in the whole
body (`bodyFirstLine` in `scripts/release-text.mts`, shared by the observer
and the rule), so a banner image or link-only line is skipped. That whole
line is judged, however long, and nothing is cut before it is found. Text the
observer did not keep (a source over its text budget, below) is recorded
`unobserved`: absence of a statement is never inferred from text that was not
read. A project-level remark further down ("pre-release quality"
in a long description) is never read. The facts record, per entry, the
listing words the text was judged with (`listing_words`), and per observed
release whether the text was observed (`text`: `observed` or
`unobserved`), the title when it is bounded printable text (`title`), the
statement found (`statement`: `{ field: "title" | "body-first-line",
token }`, or null), Core's verdict from the provider flag and tag alone
(`core_prerelease`) and the verdict the newest-stable choice used
(`prerelease`: Core's, or a statement). The body itself is never stored. The
facts check refuses a `prerelease` that is not exactly that, and a recorded
title whose statement, judged with the recorded listing words, is not the
recorded one. The fit rule and, independently, the gate re-derive the
listing words from the listing and refuse facts judged with other words,
re-derive the title's statement from the recorded title and read the body's
from the record. Reproduction compares the release list's current title and
body where the entry records the text as observed. Where the entry records a
release's text as `unobserved` but the provider now reports text that states
a prerelease (a stable-flagged release titled `v1.0 Beta`), reproduction
refuses the entry as `mismatch` so the worker observes it again: unobserved
text never keeps an enrollment through reconfirmation once the text is
known to state a prerelease. One table pins the
fit's and the gate's statement rules on the same rows, and generated
comparisons check that both read every line alike (hyphenated compounds
included) and decide every generated release window alike
(`release-text-unobserved`, `worded-prerelease-skipped`).

The observer feeds the rule. For a source whose consumers are all
descriptive listings, its configuration keeps release text
(`release_text: "listing-window"`), and its facts keep, for each of the
newest four published releases (`releaseTextWindow`, the listing
observation window), the release name and of the body only the line the rule
judges (`text: { title, line, line_complete }`), so keeping less never
changes a statement. A source's kept text is bounded by the checkpoint's
capacity: at most `releaseTextSourceBytes` of JSON per source (half the
32 MiB checkpoint for text, half of that for the projection's copy, divided
among the modeled 1,295 sources). Over it, every kept release of that source
records only a typed overflow (`overflow_bytes`, its size), the batch job's
accumulated read reports it in `gaps` with that size, and the text reads as
unobserved. Only the rows inside that window are read for text at
all, so untrusted text of older releases is never parsed, and only the first
release list page keeps text: the provider lists releases newest first, so the
window is on it, and the stored pages hold one window of text, not one per
page. A window release on a later page (behind more drafts than a page holds)
keeps no text and reads as unobserved. A change to that
text during an observation is a concurrent change like any other fact. A
source shared by a listing and a managed port keeps no text, so that
listing's releases stay `release-text-unobserved`. Managed sources keep no text and
their facts are unchanged. The listing projection carries the text beside
the observation (`listing_release_text`, bound to the observation's facts
digest), never inside `upstream_observation`, whose shape Core's signed
listing accepts. The observer's checkpoint retains it with the projection
(`last_complete_policies`), and the batch job's accumulated read
(`accumulatedObservations`) attaches it to the observation it names
(`withReleaseText`) in the worker's release shape (`name`, `body_line`,
`body_line_complete`); text of other facts, a malformed row, or a projection
retained before the observer kept text (until its source is next observed)
leaves those releases' text unobserved. A port with more than one completed
projection in one source is reported in the read's `gaps`, never chosen
between. The handoff does not carry the text.

Unobserved text is UNKNOWN optional evidence, never a statement either way,
and the fit never offers a release on it: an offered release whose text is
unobserved is withheld as `release-text-unobserved` (the gate restates it),
so the fit never enrolls a release whose text the reproduction would later
read as a prerelease. `registration_queues.release_text_unobserved` lists
every such identity, and `registration_queues.release_statements` lists
every observed release with a statement per identity. Measured: every
visible release of `youkaicountry-yknytt` is titled `vX beta` and none is
flagged; with its text unobserved the fit had enrolled tag `0.7.3`, and with
it observed the identity is `no-stable-release`.

##### Other package forms

A release can offer its program in a form the worker does not read beside
the archive it does read. The classifier inverts the default: a release asset
that is neither a readable archive nor on a closed list of non-program files
competes with the archive. Only a read archive, a shared library, a
non-desktop package and the closed non-program list are ever ignored; every
other or unknown form (`.txz`, `.tar.Z`, `.zipx`, `.sit`, `.wim`, `.squashfs`,
`.pck`, `.xyz`, …) is an unread container without being listed, so an
unlisted form withholds the identity instead of letting a single non-game
program enroll beside the real package. The honest cost: a release that
carries an unusual extra file is withheld into the
`other-package-form-beside-archive` queue, where the route-fit report lists
the competing asset names of each withheld identity
(`registration_queues.other_package_forms`, at most ten per identity), so the
closed list is extended deliberately, in a reviewed change.

The worker records every competing asset of the release with the provider's
name, size and SHA-256 (never its bytes) and the platforms its form can
serve. A container whose name verdict permits no supported platform (a
non-desktop or other-architecture name such as `Game-android.7z` or
`Game-win32.7z`) is recorded with an empty platform list; only a container
may have one, and it competes nowhere. The lowercased name is judged in this
order; the first match decides:

1. A read archive (`.zip`, `.tar.gz`, `.tgz`, `.tar.xz`, including
   `.app.zip`, `.app.tar.gz` and `.dSYM.zip`): read, never another form.
2. A shared library (`*.so`, `*.so.<digits…>`, `*.dll`, `*.dylib`): ignored,
   before the split-volume test, so `libgame.so.1.0.123` stays a library.
3. The closed non-program list below, and a name without a file extension
   holding `sha256sums`, `sha512sums` or `checksums` as a whole
   separator-delimited word (`Game-1.0-SHA256SUMS`, `checksums-linux`): ignored.
4. A volume of a split file: any name ending `.` and three or more digits
   (`.7z.001`, `.zip.001`, `.exe.001`, `.iso.001`, bare `Game.001`), and
   `.z01`, `.r00`, `.part1.rar`: a container.
5. A single-system form, in the table below. Before `.pkg` is read as macOS,
   a `.pkg` holding a non-desktop system word (`Game-ps4.pkg`, `ps5`, and
   the other listing-only system tokens) is that system's package: ignored
   as non-desktop. Before a name without an extension is read as a Linux
   program, one holding `osx`, `macos` or `darwin` as a whole word is a
   macOS program.
6. A non-desktop package (`.apk`, `.aab`, `.ipa`, `.vpk`, `.nro`, `.nsp`,
   `.3dsx`, `.cia`, `.wad`): its existing non-desktop treatment.
7. Everything else, any other or unknown extension: an unread container.

| Form                                                                                                                                                                                                | Serves                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `.exe`, `.msi`, `.msix`, `.appx`, `.msixbundle`, `.appxbundle`, `.appinstaller` (names an MSIX package by URI, possibly hosted elsewhere)                                                           | Windows                                                                                  |
| `.AppImage`, `.deb`, `.rpm`, `.flatpak`, `.snap`, `.run`, `.bin`, `.sh`, a name ending `.linux`, `.x86`, `.x86_64`, `.arm64` or `.aarch64`, or a file without an extension and without a macOS word | Linux                                                                                    |
| `.dmg`, a `.pkg` naming no non-desktop system, a file without an extension holding `osx`, `macos` or `darwin`                                                                                       | macOS                                                                                    |
| a split volume, or any other or unknown form (`.7z`, `.rar`, `.jar`, `.tar`, `.tar.bz2`, `.txz`, `.tbz`, `.tzst`, `.tlz`, `.taz`, `.tz`, `.Z`, `.zipx`, `.iso`, `.love`, …)                         | every platform its name permits; all when the name is neutral or Core cannot classify it |

A file without an extension has no final `.` followed by letters and digits
including a letter (`Game`, `Game-v1.0-linux`, `installer`). A name whose
apparent extension is only a version (`game-v1.0`, `Game.v1.2`,
`game.1.2.3`, `Game.v1`) is such a file, so a Linux program; a split volume
such as `Game.exe.001` is a container, never a bare binary.

The closed non-program list, in any letter case, is the only way an asset is
ignored:

- suffixes for checksums and signatures: `.sha1`, `.sha224`, `.sha256`,
  `.sha384`, `.sha512`, `.sha1sum`, `.sha256sum`, `.sha512sum`,
  `.sha256sums`, `.md5`, `.md5sum`, `.checksum`, `.checksums`, `.sig`,
  `.asc`, `.minisig`, `.pem`, `.gpg`, `.sigstore`, `.intoto.jsonl`;
- update metadata: `.blockmap`, `.zsync`, `.yml`, `.yaml`, `.json`, `.xml`,
  `.plist`;
- text and documents: `.txt`, `.md`, `.markdown`, `.rst`, `.pdf`, `.html`,
  `.htm`, `.rtf`, `.nfo`, `.log`, `.csv`;
- images and media used as release decoration: `.png`, `.jpg`, `.jpeg`,
  `.gif`, `.webp`, `.svg`, `.ico`, `.mp4`, `.webm`, `.mov`;
- debug symbols: `.pdb`, `.dbg`, `.debug`, `.sym` (a `.dSYM.zip` is a read
  archive with no players);
- patches and torrents: `.torrent`, `.patch`, `.diff`;
- audio, fonts and subtitles: `.mp3`, `.ogg`, `.flac`, `.wav`, `.opus`,
  `.ttf`, `.otf`, `.woff`, `.woff2`, `.srt`, `.vtt`;
- office documents and ebooks: `.docx`, `.odt`, `.epub`;
- signing and attestation: `.bundle` (including `.cosign.bundle`), `.p7s`,
  `.crt`, `.cer`, `.pub`, `.sbom`, `.spdx`;
- lockfiles, configuration, translations and metadata: `.lock`, `.toml`
  (so `Cargo.toml`), `.exe.config`, `.map`, `.ini`, `.cfg`, `.mo`, `.po`,
  `.css`, `.desktop`;
- the exact names `SHA256SUMS`, `SHA512SUMS`, `SHA1SUMS`, `MD5SUMS`,
  `B2SUMS`, `B3SUMS`, `SHASUMS`, `SHASUMS256`, `SHASUMS512`, `CHECKSUM`,
  `CHECKSUMS`, `hashes`, `signatures`, `sha256sum`, `sha512sum`, `sha1sum`,
  `md5sum`, `RELEASES`, `VERSION`, `manifest`, `LICENSE`, `LICENCE`,
  `COPYING`, `README`, `CHANGELOG`, `CHANGES`, `NOTICE`, `AUTHORS`,
  `CREDITS`, `NEWS`, `TODO`, `INSTALL`, `Makefile`, `Dockerfile`, `go.sum`
  and `go.mod`;
- SPDX-looking license names (`gpl-3.0`, `lgpl-2.1-or-later`, `agpl-3.0`,
  `apache-2.0`, `mpl-2.0`, `bsd-3-clause`);
- `LICENSE`, `LICENCE`, `COPYING`, `README`, `CHANGELOG`, `CHANGES`, `NOTICE`
  or `AUTHORS` followed only by `.lesser`, or by `-`, `_` or `.` and a
  license identifier (`mit`, `bsd`, `isc`, `zlib`, `apache`, `gpl`, `lgpl`,
  `agpl`, `mpl`, `epl`, `ofl`, `cc0`, `cc-by`, `cc-by-sa`, `unlicense`,
  `boost`, `bsl`, `third-party`, `thirdparty`, `3rd-party`, optionally with a
  version and `-only`, `-or-later` or `-clause`): `LICENSE-MIT`,
  `COPYING.LESSER`, `LICENSE-APACHE-2.0`, `NOTICE-THIRD-PARTY`.
  `README.markdown` and `LICENSE_THIRD_PARTY.txt` are ignored by their
  suffix. Anything else after the word is classified by the other rules, the
  safe direction: `Changes-Game-linux`, `Notice-Me-Senpai`,
  `Readme-Launcher`, `Authors-Cut`, `readme_first` and `installer` are bare
  Linux binaries, and `Install-Game.sh` and `INSTALL.sh` are `.sh` programs.

Nothing else that can carry or launch a program is on the list: `.js`,
`.py`, `.bat`, `.cmd`, `.ps1`, `.command`, `.aot`, `.nupkg`, `.7z`, `.lha`,
`.db`, `.dat`, `.delta` and `.diff.gz` keep competing as unread containers.
Game data packs for a host engine (`.pk4`, `.vbmod`, `.rtz`) compete too:
beside an archive whose only program is the engine, ignoring them would
enroll the engine as the game. A script or an ahead-of-time compiled image
can be, or launch, the program.

The identity is excluded as a whole (`other-package-form-beside-archive`)
when the release carries such an asset for a platform the release also
offers a readable archive for (one whose name permits that platform and that
is no [source archive](#source-archives)), the asset's digest is not among
the SHA-256s of the players those archives hold for that platform (an
unknown digest is not), and the asset is not the same product in another
package form. A single-file program equal to such a player is the same
package and enrolls. A form that serves only platforms without an offered
archive is ignored: a `.dmg` beside Windows and Linux archives leaves both
enrolled.

The same product in another package form is decided by attribution, never by
loosening the rule. Each asset name's product words and version are derived
the same way (`productIdentity`, restated by the gate as `gateProduct`): the
package form (and an `.app` bundle suffix) or another file extension is
removed; the rest is split at separators, with `x86_64`, `x86-64` and
`64-bit` kept as one word; a whole word that is a platform or architecture
word of the [release-line rule](#release-lines) (`linux`, `win64`, `x86_64`,
`amd64`, `universal2`, `64bit`, …), a release-channel word alone or with
digits (`release`, `beta`, `rc2`, `build`) or a package-form word (`setup`,
`install`, `installer`, `portable`) is dropped; a version token (digits,
optionally after `v`, `r` or `b`) is the version without that letter; every
other word is split into product words at camel-case humps and letter/digit
changes, dropping package-form parts (`GameSetup` is `game`). A form is the
same product when its product words are not empty and equal those of every
archive that could be offered for the platform (a runtime archive from exact
bytes whose name vetoes nothing and that holds a player for the platform),
its version is theirs (`sameVersion`), the product is the LISTING's
(`listingProductNames`: the product words joined equal the listing's id or
name words joined, never the original title, so `Game-1.0-Setup.exe` beside
`Game-1.0-win64.zip` for a listing titled "Different Title" still competes),
and each such archive's player for the platform is named literally for that
product (`programNamesProduct`): the program's file name lowercased, without
a trailing `.exe`, with every character that is not a letter or digit
removed, equals the product words joined. Nothing else is dropped: no
trailing digits, no variant word, no architecture word, so `Game-debug.exe`,
`Game2.exe`, `Game-2.exe`, `Game64.exe`, `Game-x64.exe`, `game.x86_64` and
`supergame2.exe` (for `Super-Game`) keep the form a competitor. A shared
word, a prefix or a containment in either direction never relieves. Versions are equal once trailing zero components are removed
(`1.0.0` is `1.0`); a Debian revision after the upstream version is
packaging, not the version (`game_1.0-1_amd64.deb` is `1.0`); an AppImage
that names no version is the same version as the archive (`Game.AppImage`
beside `Game-1.0-linux.tar.gz`); two unversioned names are the same version.
So `Game-1.0-linux.tar.gz` holding `Game` beside `Game-1.0.AppImage`,
`Game-1.0.deb`, `game_1.0-1_amd64.deb` or `Game-1.0.flatpak`,
`Game-1.0-win64.zip` holding `Game.exe` beside `Game-1.0-Setup.exe`, and
`Game-1.0-macos.zip` beside `Game-1.0.dmg` enroll. Another product
(`GameStudio-1.0-win64.zip` beside `Game-1.0-Setup.exe`), another version
(`Game-1.1-Setup.exe`, `Game-1.0.1.AppImage`), any other unversioned form
beside a versioned archive (`Game-Setup.exe`, `Game.7z`), an update or other
payload (`Game-1.0-update.7z`), empty product words on either side
(`Setup.exe`), a second offerable archive of other product words, or an
archive named for the game whose program is another one keep the form a
competitor: `GameCodegen.exe` or `GameRecomp.exe` in `Game-1.0-win64.zip`
beside `Game-1.0-Setup.exe` or `Install-Game-1.0.exe`, `game-gen` or
`gamegen` in `Game-1.0-linux.tar.gz` beside `Game-1.0.AppImage`,
`the-mapper.exe` in `The-Game-1.0-win64.zip`, and `Table.exe` in
`TableGame-1.0-win64.zip` beside their installers.

This attribution is a contradiction detector. It does not prove the archive
is the game: it only stops treating the same product in another package form
as a competitor, and every player-program rule still decides the archive.
Names nominate and contradict; they never supply missing product semantics.
The residual is stated plainly: an archive named for the game whose only
program is literally named the product but is in fact a tool enrolls beside
such a form exactly as it would with no competing form at all; the relief
only removes a contradiction, it adds no risk of its own.
The route-fit report lists every identity whose forms were attributed this
way (`registration_queues.same_product_forms`) as a review queue.

The rule's cost is now narrower. A project that ships a portable archive and
an installer, disk image or other package of other product words or another
version for the same platform is withheld until a person reviews it, in the
one grouped `other-package-form-beside-archive` queue. A neutral-named archive
permits every platform, so `game-1.0.zip` beside `Game.AppImage` (no version)
or a `.dmg` of another version withholds the whole identity. A reviewed
`route_facts_v1` enrollment can still offer such a release.

###### Source archives

A source or compliance archive is never the game package. Only an archive
whose listing shows no executable program (no player and no tool-vetoed
program) can be one: it is a source archive when Core's filename classifier
gives it the `source-archive` role, or its name holds `source`, `sources` or
`src` as a whole separator-delimited word (`Game-1.0-src.tar.gz`,
`Game-Source-1.0.zip`), or it is a third-party library source dump: at least
three quarters of its listing's distinct file names are source or build
files, and its product words share no word with the repository's name
(`somelib-1.3.zip` in a game's release). The source and build files are a
closed list of extensions (`.c`, `.h`, `.cc`, `.cpp`, `.cxx`, `.c++`, `.hpp`,
`.hh`, `.hxx`, `.inl`, `.ipp`, `.m`, `.mm`, `.rs`, `.go`, `.java`, `.kt`,
`.cs`, `.swift`, `.zig`, `.s`, `.asm`, `.py`, `.js`, `.ts`, `.cmake`, `.mk`,
`.am`, `.ac`) and names (`makefile`, `cmakelists.txt`, `configure`,
`meson.build`, `build.gradle`, `cargo.toml`). The worker records only the
counts (`listing_counts`: `leaves` and `source_leaves` of Core's `leaves`).
A source archive is never offered, never counts as one of a platform's
competing archives (`ambiguous-artifact`), never counts for the toolchain
rule, and offers no platform to another package form. A source-named archive
that holds programs is an ordinary candidate for every count: its programs
count for `ambiguous-player`, its bytes for `ambiguous-artifact`, its
toolchain for `bundled-toolchain`, and it offers its platforms to other
package forms, so `Game-1.0-win64.zip` holding `Game.exe` beside
`Game-1.0-win64-source.zip` holding `Other.exe` never enrolls by dropping
the second. It is still never offered itself, because its own name
contradicts it (`contradictory-role`). The route-fit report
lists them per identity (`registration_queues.source_archives`). The gate
restates the rule with its own code from the recorded names and counts.

Known residuals:

- Ignoring a form on a platform without an offered archive leaves one wrong
  enrollment possible. A game shipped only as a Windows installer beside a
  Linux-named tarball whose single program is neither the game nor
  tool-named enrolls that program on Linux; the mirror case (a Linux-only
  form beside a Windows-named zip) is the same. It needs four things
  together: a form only for platforms without an archive, an archive whose
  name restricts it to the other platforms, exactly one program in it, and
  that program not being the game while not tool-named. Every generic signal
  against it would also withhold the common "Windows `Setup.exe` plus a Linux
  tarball of the same game" release. So the route-fit report lists every
  enrollment whose recorded other packages include a form on a platform
  without an offered archive in `registration_queues`
  (`enrolled_beside_unoffered_forms`) as a review queue, and the facts batch
  summary prints that list.
- The facts record the name of every release asset that is neither a recorded
  artifact nor a refused archive (`asset_names`, within the observer's asset
  window), and the gate classifies each with its own classifier
  (`gateFormKind`): a form the gate sees that the worker did not record in
  `other_packages` competes with an unknown digest on every platform its kind
  serves (every platform for a container), so a worker classifier mistake
  that drops an asset refuses the batch instead of enrolling. Reproduction
  compares `asset_names` with the re-listed release. A recorded container's
  platforms still come from Core's name verdict as recorded, widened by the
  gate's own reading of the name, never narrowed. The classifier's tables are
  pinned by one shared fit-and-gate test table.

##### What the player sees

Upstream text reaches the guide only through a conservative name class. A name
must be printable ASCII letters, digits, spaces or `._-+()[]`. It has no
leading or trailing space and at most 120 characters. Format and bidi controls,
zero-width and look-alike characters never pass. The selection step names the
program only when the facts name exactly one player per platform, the same
name everywhere, and that name passes the class. It uses the archive's own
letter case, such as `Game.x86_64`, not Core's lowercase comparison key.
Otherwise it says "Select the game program in your prepared copy." It also
says that when the one program's name contains `launcher`, `settings` or
`config` anywhere: such a program never enrolls as a whole word
(`launcher-entry`, [one program per platform](#one-program-per-platform)),
and the guide never calls one the game as a second guard. The working
folder is the program's folder. The provenance reference names the repository,
the release tag and release file when they pass the class, and the date facts
were checked. It names at most three programs, then "and N more". Full paths,
machines and digests stay in the facts table and the enrollment table. Generic
copy states what stays unknown, such as which original game files upstream
needs. An authored listing guide stays first. The selection step, a warning
that no title-specific review happened and the ownership reference follow it.
The provenance reference and review step follow too when the bound leaves room.

##### Enrollment table and gate

`generated-registration.generated.json` records each enrollment's facts digest,
repository and repository id, release, artifacts and players, plus blocked
counts by reason. `blocked_exclusions` lists every name-based veto, grouped by
reason and token, most frequent first. Each group has the number of identities
and up to five examples with port id, vetoed name and outcome. The reasons are
`asset-tool-name`, `asset-system-token`, `asset-role-name`,
`asset-system-name`, `asset-architecture-name` and `player-tool-name`.
`ambiguous-player` groups the identities whose players are not one program,
with token `several-programs` or `several-directories` and the program names
as the example. `bundled-toolchain` groups archives by the helper they bundle. A group of real games
excluded by one token means the rule needs fixing, not a single game.
`facts_provenance` carries the facts table's provenance, or `null`. Generation is pure: when a fact stops holding, the next run
omits that route. The delta records the withdrawal reason. Withdrawal removes
the offer to register new copies. It never touches external files. Core's
existing [retained registration rules](ARCHITECTURE.md) keep a registered
copy's listing identity. Generated routes are bookkept by this table rather
than the curated `catalog-legacy-additions-fixture.json`.
`catalog-route-fit.mts` and `maintenance-program-view.mts` count them as
enrolled with no title-specific authority.

The owner reads exceptions as grouped queues. The table keeps only counts and
examples; `node scripts/catalog-route-fit.mts --json` adds
`registration_queues` with complete identity lists in port_id order, computed
from the committed catalog and facts, so any checkout reproduces them:
`reasons` (every blocked reason with its identities), `unread_forms` (every
release package form the worker does not read with the identities whose
release has it, also beside a supported archive), `exclusions` (every
name-based veto as `reason:token`), `refusals` (every refusal class of a
refused archive with the identities that have one), `shared_repositories`
and `enrolled_beside_unoffered_forms` (every enrolled identity whose release
also records another package form for a platform it offers no archive for:
a review queue, see [Other package forms](#other-package-forms)). The text summary prints
the counts. The identity-level reasons are distinct and machine-readable.
Upstream and release: `no-stable-release`, `no-release-archive` (no package
file at all), `unsupported-archive-format` (only desktop forms the worker does
not read, such as `.7z`, `.rar`, a bare `.exe`, `.msi`, `.dmg` or `.AppImage`;
the forms are in the detail and `unread_forms`), `non-desktop-platform`,
`no-digest`,
`repeated-inspection-failure`, `invalid-facts` and `upstream-unavailable`
(the listing's availability says so, or every archive of the offered release
answered 404 Not Found: upstream's own statement that the packages are gone,
re-evaluated when the release or its asset list changes; a single 404 among
reachable archives is that archive's `asset-not-found` refusal, and 5xx
responses, rate limits and timeouts stay transient `network` failures).
Product binding: `shared-repository` and `ambiguous-release-line`. Release
text: `release-text-unobserved` and `worded-prerelease-skipped` (see
[release text statements](#release-text-statements)). Reproduction:
`reproduction-refused` (the facts batch job's own reproduction refused the
identity's entry; see [reproduction refusals of one identity](#reproduction-refusals-of-one-identity)).
Fit: `no-player`, `tool-not-game` (only tool-named programs or a tool or
tool-role archive name), `contradictory-role` (also a source-named archive
holding the only programs), `non-desktop-platform`, `unknown-platform`,
`wrong-host`, `ambiguous-player`, `ambiguous-artifact`, `core-refused` (a
refused archive's name allows the platform) and `guide-bound`. Release
content, each for the whole identity: `other-package-form-beside-archive`,
`bundled-toolchain` (reconsider when the release ships an archive without the
toolchain, or a reviewed `route_facts_v1` enrollment covers the first-start
build), `launcher-entry` (reconsider when listing data or release-bound
metadata declares the launcher as the game's runtime entry), `role-program`
(a program or its folder named for a debug, server, tools, editor, SDK, demo,
trial or test role), `non-ascii-name` (an archive or program name outside
ASCII), `archive-names-another-listing` (a relieved archive product spells
another catalog listing's complete name), `name-not-unique-in-catalog` (a
relieved archive or program name that a listing in another repository would
accept too), `archive-name-unaccounted` (the
offered archive's name holds a token that is neither the listing's or
repository's name, a version, a neutral word nor a measured relief),
`split-package` (another archive without programs whose name allows
the platform may hold the rest of the game) and `program-name-unaccounted`
(the offered program is not that name,
or sits in a folder of unaccounted words). When no platform fits, the reason is the first of
`ambiguous-player`, `ambiguous-artifact`, `core-refused`, `wrong-host`,
`unknown-platform`, `non-desktop-platform`, `contradictory-role`,
`tool-not-game`, `no-authorizing-source` and `no-player` that any platform
gave. `bundled-toolchain` follows `core-refused` in that order.
`registration_queues` also holds `reason_evidence` (per reason among
`role-program`, `launcher-entry`, `non-ascii-name`,
`archive-names-another-listing`, `name-not-unique-in-catalog`,
`archive-name-unaccounted`, `program-name-unaccounted` and
`split-package`, per withheld
identity, the matched word with the program path, or the platform with the
archive name and program path), `accepted_by_repository_name_only` and
`numbered_products` (enrolled identities accepted only by the repository's
name, or by counting a number as a product word), `integer_as_version` and
`unstated_status_words` (the hand-check queues above),
`worded_prerelease_skipped` (per identity withheld as
`worded-prerelease-skipped`, the newer releases skipped by their words
alone), `enrollment_reliefs` and
`relieved_enrollments` (each enrolled identity's [name reliefs](#measured-name-reliefs),
and the relieved identities by relief), `franchise_only_partial` (per
enrolled identity, its findings: a partial name, or an initialism by its
run's words, shared as a prefix by two or more listings, and every relieved
archive, program or folder name that drops a later title segment, named),
`subtitle_dropped_by_repository_name` (per enrolled identity, each archive
or program name equal to the repository or id name that drops a later title
segment of the listing's name, named),
`unaccounted_tokens` (per closed-vocabulary
reason, each unaccounted token with the number of identities it withholds and
those identities, most frequent first: the evidence a person reads before a
token joins a neutral list), `bundled_toolchains` (each withheld
identity's helper names), `inspection_failures` (the
`repeated-inspection-failure` identities by typed cause),
`same_product_forms` (per identity, the other package forms attributed to
the listing's product: a review queue), `source_archives` (per identity, its
source archives), `release_statements` (per identity, every observed release
whose text states a prerelease, as `<tag>: <field> <token>`) and
`release_text_unobserved` (identities whose offered release text the
observer did not report).

The gate compares the generation with a baseline. The baseline is the
committed table at the merge base, never the working tree, so repeated runs and
hand edits cannot widen one change. On a pull request or merge group it is the
first parent of the checked-out merge commit, else the merge base with
`origin/$GITHUB_BASE_REF`. On a push or scheduled run it is the previous
commit. Locally it is the merge base with `origin/main`. A revision without the
table is an empty baseline. Outside a git repository the baseline is empty.
Inside one, an unresolvable baseline is an error, so CI's catalog jobs check
out two commits. The delta has no size bound: every enrollment that passes
the checks below may land in one change, and so may every withdrawal. What
holds a mass withdrawal a bug could cause is the facts batch job's
`withdrawal-held` stop ([stop and wait](#stop-and-wait)), not a count. The
gate re-checks every enrollment against its facts
entry with its own code, independent of the fit rule. It checks the facts
digest, complete eligible coverage, the bound repository id and release, the
age and retention bounds, the exact archive binding, the veto, tool and system tokens,
the name's operating system and architecture, that each player exists in the
facts with a machine that runs on the platform and was not excluded by the
tool veto, that every player of the artifact running there is named, and the
one-program rule, including each such artifact's players under one top-level
directory, for every non-contradictory desktop-runtime artifact whose name
permits the platform, as the generator checks. It also
restates, from the facts and the listings alone, the release-line and
shared-repository rules, the other-package-form rule for every platform the
release offers an archive for, whichever platforms the enrollment names
(naming each form's platforms itself, widened but never narrowed by the
recorded ones, and a container's or split volume's by its recorded name
verdict), that the archives whose names permit
the platform are one package, and that no refused archive is offered or
could hold the platform's game. It restates the #8569 cohort rules with its
own code too: the release text statements (the title's re-derived from the
recorded title), product-word attribution with its player check
(`gateProduct`), source archives, the identity-wide toolchain rule and the
launcher words. It restates the listing-level withholds from the authored
records the generation decided, before any generated route was added: no
authored integration or `route_facts_v1` enrollment (one runtime owner), not
the ScummVM engine, availability neither `source-only` nor `unavailable`, the
facts' repository equal (case-insensitive) to the one the listing's provider
identity names (`gateProviderRepository`, restating `listingProviderIdentity`
exactly: the release URL first, else the project URL; HTTPS on `github.com`
only, with no user, password, port, query or fragment; `/<owner>/<name>`, an
optional `.git`, an optional `/releases` subpath and an optional trailing
slash), and facts from the current parser version. Every fit
withholding reason has a gate restatement except two, each exempted with its
reason (`gateExemptions`): `route-held`, because Core evaluates the listing's
acquisition restrictions itself for every registration and launch, and
`guide-bound`, because Core's listing validation refuses a guide over eight
entries. A test enumerates every reason with several scenarios each, forces
every one past the fit, and requires the gate to refuse it. The facts
table's `generated_at` may not be earlier than the baseline facts table's,
because facts age is measured against that time. `--check` also requires the
committed table to equal the generator output, so a hand-edited table is
refused.

Raising `GENERATOR_VERSION` changes every enrollment, because each records the
version; it lands in the reviewed change that raises it, with no bound to
raise. Raise `GENERATOR_VERSION` when the fit rule or the generated route
changes, `FACTS_PARSER_VERSION` when the worker's output for the same
upstream changes, and `FACTS_TABLE_FORMAT` when the facts table's shape
changes. A parser or generator behavior change requires its version bump:
the bump is what marks the withdrawals it causes as `rule-version` and holds
them for a person ([stop and wait](#stop-and-wait)). #8569 raised the
generator version from 5 to 27, the facts parser version from 5 to 23 and
the facts table format from 4 to 17 (generator 23: the measured name
reliefs, `archive-names-another-listing` and the `enrollment_reliefs` and
`relieved_enrollments` queues; generator 24: title segments for partial names
and initialisms, title descriptors kept, only `p` as a patch letter, the
first-segment and number-suffix cross-listing checks and the
`franchise_only_partial` queue; generator 25: truncated initialisms across
the listing's names, so a repository name without the sequel number never
accounts for a numbered entry; generator 26: uniqueness of relieved names
(`name-not-unique-in-catalog`), initialisms only where the partial name of
the same words is accepted and of three letters unless numbered, no omitted
segment with a sequel number, only articles or a possessive run before kept
words, annotations alone never accounting for a name, and `&`, `+` and `,`
linking words; generator 27: spelled and four-digit numbers in a later
title segment as sequel numbers, every dropped title segment in the
`franchise_only_partial` queue, numbers compared by value in uniqueness and
the cross-listing check, no initial from an author handle, and relieved
folder names unique; generator 28: every digit run (dotted too), roman
numeral of any size and spelled number beyond twenty in a later title
segment as sequel numbers, numbers compared by value from 1 to 3999 with
`1` and a lone `I` only after a title's product words, and the
`subtitle_dropped_by_repository_name` queue; generator 29: a carried number
compared by value with a roman number of two or more letters, an
annotation's architecture word read as no sequel number, and a title
segment queued as dropped only when every accepted spelling that keeps the
first title segment omits it;
generator 22 and parser 23: the
ordered archive grammar, folder numbers by the same grammar, relief only for
recognised forms and the listing's own names, a `.wad` as a competing
container, `release` before a status word's number, and the
`year_as_version` and `tool_only_archives_beside` queues; generator 21 and
parser 22: dotted
digit runs as versions only, integers only at the name's own number,
no `b<N>` versions and no neutral `bin`, `split-package`, no original title
as an accepted name, exactly one player per platform, the
`accepted_by_repository_name_only` and `numbered_products` queues, and
status words standing before only connector words; generator 20, parser 21
and format 17:
closed-vocabulary archive and program names (`archive-name-unaccounted`,
`program-name-unaccounted`) replacing the shared-word relation, the
`unaccounted_tokens` queue, the gate's exact repository identity, and
`preview`, `canary`, `demo`, `debug-build`, `test-release`, `prototype`,
`playtest`, `daily-build` and `not-for-production` release text statements;
generator 19, parser 20 and format 16:
identifying words and joined names for archive relation,
`program-product-unrelated`, `non-ascii-name`, glued and abbreviated role
words, the gate's listing-level restatements and exemptions, the
`reason_evidence` queue, and `nightly`, `preview`, `experimental`,
`test-build`, `development-snapshot`, `wip` and `dev` release text
statements; generator 18, parser 19 and format 15:
product-form relief only for a program named literally for the product and
only for the listing's product, `role-program`, `archive-product-unrelated`,
`dedicated`, `headless` and `demo` archive role words, `launch`, `start`,
`install`, `cfg`, `configure` and `loader` launcher words, qualified,
`early-access` and `unstable` release text statements, and reproduction
refusing unobserved text that now states a prerelease; generator 17, parser 18 and format 14:
release text judged only where a status stands, with the listing's own
words recorded per entry (`listing_words`), an identity-wide launcher
refusal in the gate, product-form relief only for a program named exactly
for the product, Debian revisions, unversioned AppImages and trailing zero
version components, source-named archives holding programs counted as
ordinary candidates, and `.rtz`, `.vbmod`, `.pk4`, `.py` and `.aot` back
off the non-program list; generator 16, parser 17 and format 13:
release text statements in the title or first body line, an identity-wide
`bundled-toolchain`, `launcher-entry`, product-word attribution of the same
product in another package form, source archives with recorded listing
counts, system and checksum words before the bare-binary and `.pkg` forms,
`.rtz`, `.vbmod`, `.pk4`, `.py` and `.aot` on the non-program list,
containers serving no platform recorded with none, and an all-404 release
recorded as `upstream-unavailable`; generator 15: the own-name role-word
exemption is removed and every role word vetoes; generator 14 and parser 16:
a role word was exempt only inside a run of a product name's words and
camel-case archive names are split into words, `.appinstaller` is a Windows package form,
versioned or renamed compiler and interpreter file leaves are toolchain
helpers, and a hash-only tag is a channel build; generator 13, parser 15 and
format 12: no explicit-system exception for several archives, role words with digits
and without the product's own name words, `x86-64` as one word in both copies,
real date shapes in channel-only tags, first-word hex words as product words,
`test` as a conditional channel word, the wider non-program list, file-only
short toolchain helpers with recorded `toolchain_names`, and recorded
`asset_names` for the gate's own classifier; earlier: iOS shape at any depth, glued numbers in program names, the gate's directory
check, unreadable asset records, ARM64EC, release lines, shared
repositories, one package per platform, per-archive Core refusals,
per-platform archive counts, new tool tokens, the other-package-form rule
excluding the identity where another form competes with an offered archive,
split-file volumes, unread compressed and disk-image forms, the
non-program file list, the inverted default that makes every unlisted
form compete, archive role words, one package by archive bytes, bundled
toolchains, channel-only tags, stable-only release lines and typed
inspection failure causes; parser 13 removed the size and count
exclusions). It landed with an empty facts table and no enrollment. A
curated change that adds integrations to generated identities withdraws
their generated routes in that same change.

A portcove-core test re-runs Core's own rules on every fact of the committed
facts table, without network access. For each artifact it reclassifies the
recorded release file name and each program name, and it recomputes the role,
system, architecture and contradiction flags from each player's platform-true
machine. A macOS machine recorded for an iOS-shaped path is refused. It checks that each player path
is a player candidate by Core's path rule. Each machine must be one Core's
header reader can produce, and a `.exe` program must have a PE machine and
only a `.exe` may. The release tag must not be a prerelease by Core's rule. The
same test checks the worker's pinned sample output
(`scripts/fixtures/listing-package-facts-sample.json`), and forged variants of
it fail. A classifier or tool-token change therefore needs a refreshed facts
table in the same change.

The facts table may carry a table-level `provenance` object with
`workflow_run_id`, the 40-digit `source_commit`, the CLI binary's `cli_sha256`
and the run's `inputs_sha256`. A local run omits it. When present, its shape is
checked and it is carried into the enrollment table. The checks above cannot
tell real upstream bytes from facts someone wrote by hand, so pull-request CI
reproduces facts from the bytes
([reproducible facts](#reproducible-facts-and-the-path-allowlist)).

##### Facts worker

`scripts/listing-package-facts.mts derive` writes the facts from a listing
observer report. It reads only digest-bound archives of the latest stable
release. The latest stable release follows Core's reviewed prerelease rule: the
provider flag, or a tag such as `-alpha`, `-rc`, `-preview` or `-nightly`. It
verifies each archive's size and SHA-256, runs
`portcove --json catalog inspect-listing-artifact` ([CLI](CLI.md#listing-artifact-inspection))
and then deletes the bytes. From the archive's listing (Core's `names`) it
records only the bundled toolchain helpers. Core's temporary workspace is inside the worker's
own scratch directory, and a timed-out run is killed, so nothing leaks. Each
archive becomes an `exact-release-structured` fact with the player candidates
Core found outside any tool, installer or server location. A listing whose
`release_url` names a tag is read on that tag's [release line](#release-lines)
only. Each entry also records the observed releases and the release's
[other package forms](#other-package-forms) with the provider's size and
digest and the platforms each serves (never their bytes), for the
release-line and other-package-form rules.

A download that answers 404 Not Found refuses that archive permanently with
the refusal class `asset-not-found`; when every archive of the release does,
the entry is completed ineligible as `upstream-unavailable`. Other failed
downloads (5xx, rate limits, timeouts, interruptions) stay transient
`network` failures. From each archive's listing the worker also records the
counts of distinct file names and of source or build file names
(`listing_counts`, [source archives](#source-archives)), and from each
observed release the observer's release text verdict
([release text statements](#release-text-statements)).

The worker's candidates are the authored listing-only GitHub identities, read
before catalog generation adds generated routes (`workerRecords`). An identity
the generated route already offers is therefore still a candidate: its facts
are kept and refreshed, and its withdrawal is classified like any other
(`withdrawal-held`). Every generated enrollment must name such an authored identity, or the
run fails.

Core's filename classifier (`portcove --json catalog classify-listing-names`)
can only veto. When an archive's name suggests a role other than a desktop game
runtime, the archive is contradictory. Such roles include a server, installer,
builder, compiler, development tool, importer, mobile package, console output,
documentation, debug symbols or a source archive. A name suggesting an
operating system or architecture that none of the players' machines has is
contradictory too, and so is a listing-only `system_token`: a whole
separator-delimited word or two adjacent words joined naming a system with no
desktop route (`android`, `androidtv`, `ios`, `iphone`, `ipad`, `ipados`,
`tvos`, `watchos`, `visionos`, `freebsd`, `openbsd`, `netbsd`, `haiku`,
`switch`, `wii`, `wiiu`, `vita`, `psvita`, `ps3`, `ps4`, `ps5`, `psp`, `xbox`,
`3ds`, `nds`, `portmaster`). It never matches a camel-case part or substring,
so `HaikuQuest` and `Switchblade` are not vetoed. A filename never authorizes a
runtime. A release whose native archives are all vetoed does not enroll.

##### Listing-only tool veto

The shared classifier types only some tool names, and only as whole words.
Managed routes depend on it, so it stays unchanged. Core adds a listing-only
veto to the same command. It reports a `tool_token` for each release file name
and for each player program's file name. A token in the release file name
vetoes the whole archive. A token in a program's name excludes only that
player candidate, so another plausible player in the same archive still
counts. Excluded players stay in the facts as `excluded_players` with their
token. When several players remain, the guide names none. When exactly one
remains, it may name that one.

A token matches case-insensitively as a whole word between separators, as a
camel-case or letter/digit part (`GamePatcher`, `UnityCrashHandler64`), or as
two adjacent words joined (`Mod-Manager`, `Crash` `Handler`). The tokens and
why each is vetoed:

| Tokens                                                                    | Why                                                                               |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `patcher`, `randomizer`                                                   | Patch or randomize the player's own input; not the game.                          |
| `recompiler`, `decompiler`, `disassembler`, `n64recomp`                   | Recompilation and reverse-engineering tools, such as the N64Recomp tool itself.   |
| `setup`, `installer`, `uninstall`, `uninstaller`                          | Install or remove; registering them would start the wrong program.                |
| `updater`, `autoupdater`                                                  | Update programs beside the game.                                                  |
| `crashhandler`, `crashreporter`, `crashpad`, `crashsender`                | Crash handling helpers shipped beside engines.                                    |
| `builder`, `compiler`, `importer`, `extractor`, `unpacker`, `converter`   | Asset preparation and build tools.                                                |
| `editor`, `viewer`, `debugger`, `benchmark`, `configurator`, `modmanager` | Development, inspection and configuration tools.                                  |
| `sdk`, `devkit`, `tool`, `tools`, `toolkit`                               | Development kits and generic tools.                                               |
| `server`                                                                  | A server is not the player's program.                                             |
| `patch` (whole word only)                                                 | A patch archive; as a camel-case part it also starts titles such as `PatchQuest`. |
| `studio`, `authoring`, `workbench` (whole word only)                      | Authoring suites shipped beside the game; `StudioTown` and `LevelStudio` pass.    |
| `codegen`, `glue`, `toolchain` (whole word only)                          | Code generators and toolchains; `code-glue.exe` is vetoed, `codeglue.exe` is not. |

These words stay allowed, because they also name real game programs:
`recomp`, `recompiled` and `psxrecomp` (game ports are often named
`…Recomp` or `…Recompiled`), `launcher` (often the documented entry point)
and `demo` (a demo is still a game). A missed tool still needs a native
program outside every tool, installer or server location to enroll. A name
written as one lowercase word, such as `gamepatcher`, is not split and is not
vetoed. Such a program is still caught by its release when the release also
ships another package form for a platform it offers an archive for that is
not the archive's player (`other-package-form-beside-archive`). `engine` is not a tool word: engine
reimplementations are real game ports, also as a whole word in an archive
name.

Programs inside nested build trees (`target/release`, `build/`, toolchain
directories) are not treated as tools by path. A package can ship its only
game program there (a Cargo or CMake build directory), so such a rule could
hide a second real game or leave the wrong program as the only player; the
one-program rule keeps judging them.

The worker binds facts to the listing's repository and the observed numeric
repository id. A rename that keeps the id continues. A different id withdraws
the route as `repository-identity-changed` and keeps the bound id; a listing
that names another repository rebinds. A non-complete observation, such as a
rate limit, a missing repository or a partial listing, keeps the last-good
complete facts. After 14 days of consecutive non-complete attempts it
withdraws them as `observation-unavailable`. Only a complete observation that
no longer fits withdraws immediately, for example one with no stable release.

The worker never stalls on one identity. Every observed identity is evaluated
each run. An unchanged release is reconfirmed from the facts already held,
without reading bytes. These permanent cases complete as ineligible and are
re-evaluated only when the release or its asset list changes:

- `no-stable-release`, `no-release-archive` (no package file at all);
- `unsupported-archive-format`: no ZIP, TAR.GZ or TAR.XZ archive, but desktop
  package forms the worker does not read;
- `non-desktop-platform`: only mobile or console package forms (`.ipa`,
  `.apk`, `.aab`, `.vpk`, `.nro`, `.nsp`, `.3dsx`, `.cia`, `.wad`);
- `no-digest`: an archive without a provider SHA-256. This is a correctness
  rule, not a limit: without the provider's digest the bytes the worker reads
  cannot be bound to the release, and reproduction could not prove them;
- no identity-level Core refusal: a permanent refusal is scoped to its
  archive. The entry records the archive in `refused_archives` with a bounded
  class: Core's typed error code (`core-source-invalid`, `core-unsupported`,
  `core-verification` and so on, never Core's message text), or the worker's
  own `digest-mismatch`, `size-exceeded` or `not-digest-bound`. A refused
  archive is never offered; it blocks only the platforms its name allows, and
  `core-refused` becomes the identity's reason only when no platform fits. An
  unchanged refused archive is not read again;
- `repeated-inspection-failure`: a transient failure that recurred on every
  run for longer than the last-good retention bound (14 days, the same bound
  that keeps an unavailable upstream's facts). No attempt count settles it:
  a failure is retried every run until then. The entry records the last failure's typed `cause` (`network` for a download,
  `over-budget` for a timeout or deadline, `unreadable-archive` when Core read
  the bytes but returned nothing usable, `runner-time` for an identity over
  the per-identity budget CI can reproduce in (settled at its second
  consecutive occurrence, see [inspection order](#inspection-order-and-backlog)),
  `runner-disk` for a Core run that ran out of runner disk, or a refusal
  class such as `digest-mismatch` or `core-source-invalid`); every other
  reason records a null cause;
- `invalid-facts`: the identity's facts failed validation, such as a path with
  a control character, `:` or `\`, a release file or program name Core could
  not classify, a release record the worker cannot read, an asset record it
  cannot read in the offered release or a newer one, a newest release (highest
  id) without a parseable publication time, a newer release whose tag Core
  could not classify, or any other unexpected failure while evaluating it. An
  unreadable record is never dropped silently.

Every entry also records `unread_forms`: the sorted package forms of its
release that the worker does not read, also when a supported archive sits
beside them.

These count in the enrollment table's blocked reasons. Each identity is
evaluated and validated alone, so one bad identity never fails the run. The
worker never sends Core a name Core refuses: a tag or name over 1,024 bytes or
with malformed Unicode stays unclassified. An unclassified tag is never
skipped as a prerelease: when it is newer than every stable release, the
identity is `invalid-facts` for that release rather than silently falling back
to an older one. An unclassified release file or program name makes its identity
`invalid-facts` before any bytes are read. Requests are split at Core's own
request bounds (50,000 names and the CLI's 8 MiB input). If Core still refuses a request, it is
split until the refused name is isolated. Only a refused known-good probe,
meaning an unusable CLI, fails the whole run.

##### Inspection order and backlog

A run has no identity, byte, archive-size or archive-count bound: it reads
every identity that needs bytes, one archive at a time, verifying and then
deleting each archive's bytes before the next, so disk never accumulates.
The provider's own per-asset maximum (2 GiB for a GitHub release asset)
bounds an archive. Several archives for one platform are judged by the fit
rule (`ambiguous-artifact`), never by a count. Every derived entry lands in
the worker's table in the same run: the worker has no batch bound. The
scheduled job then lands at most one hour's reproduction share per batch and
carries the rest ([scheduled facts batch job](#scheduled-facts-batch-job)).

The only limits are the runner's time and disk and the REST quota. Each
identity's inspection has the time CI can reproduce it in
(`identityBudgetMinutes`): the CI reproduction shard deadline
(`reproductionDeadlineMinutes`, 85 minutes), less the quota wait CI must
expect, divided by the entries one CI shard holds. The worker computes it for
the entries one batch can land, the candidate count but at most
`reproductionBatchEntries` (250, one batch's `reproductionBatchRequests` at
one request per entry; see [reproduction quota](#reproduction-quota)), since a batch lands
no more and a change can name only authored listing-only identities. That
batch fits one entry per CI shard, so each identity has the whole 85 minutes
at about 400 or 1,100 candidates alike. The worker never settles what CI cannot reproduce: an identity over
its budget is a transient `runner-time` failure, retried in the next run,
and a second consecutive one settles it as `repeated-inspection-failure`
with the `runner-time` cause, so an identity that alone cannot finish is
never retried for ever. That ineligibility lasts until the entry changes: the
worker reconfirms it without retrying for as long as the offered release and
its asset list stay the same, and a new offered release or a changed asset
list makes the next run inspect it again (a facts parser version change
alone does not). The `repeated-inspection-failure` exception queue groups
these identities by cause and states that condition; a person may instead
review one for a curated route. A Core run that runs out of runner disk (about 14 GB on a
standard Linux runner, below Core's 16 GiB extraction ceiling plus the
archive) is a transient `runner-disk` failure, never a refusal of the
archive; it settles only after the 14-day retention bound. A run can also
be given a deadline (`--deadline`), the real time limit of the job it runs
in; it is checked before each identity, and every download and Core run is
cut at it. An identity the deadline cuts is left `pending-inspection`, not
failed, and its id goes to the worker state's `pending` list. An unsharded
next run inspects transient failures oldest first, then the rest in port_id
order, and the identities a deadline cut last, in their order. A sharded run
does not: its plan reads no bytes and returns `pending: []`, so each shard
orders a previously cut identity like any other (transient failures oldest
first, then port_id). There, a slow identity is bounded by its own budget
(`identityBudgetMinutes`) instead. An identity a deadline left pending in two
consecutive runs stops the job (`pending-repeated`, grouped by cause).
Without a deadline nothing is cut.

A sharded run splits the work across a job matrix
([scheduled facts batch job](#scheduled-facts-batch-job)):

1. Plan (`derive --plan true`): every observed identity is evaluated without
   reading bytes. Everything that needs no bytes settles; every identity
   that needs bytes is left pending and listed in `needs`.
2. Inspect: each shard runs the worker on the plan's table with the plan's
   clock (`--now`), restricted to its identities (`--only`), with its
   deadline. Shards are `identityShards`: one identity per shard, identity i
   in port_id order in shard i mod N, N the number of identities that need
   bytes but at most 256 (GitHub's matrix job limit).
3. Combine (`combine`): each shard's identities are taken from that shard
   and everything else from the plan, so a sharded run lands exactly what one
   unsharded run would (`combineShards`). Each identity's retry record also
   comes from its own shard only: every shard starts from the whole plan
   state, so another shard's copy is stale.

The worker state file (`--state`) holds the `pending` cursor and the retry
queue (format 3). An offered identity a deadline cut keeps its last-good
facts with an `attempt` of status `pending-inspection`. That is the worker's
own backlog, not an upstream attempt. It starts no `observation-unavailable`
clock, and the entry stays unchanged until the identity is inspected. Only
`stale-facts` (30 days after the facts were last confirmed) withdraws it.

Each run reports its `backlog` (`enrolled_pending`, `new_pending`,
`bytes_pending`: what deadlines cut), `needs`, `settled` (the identities it
settled into the table, newly complete or newly ineligible), `unobserved`
(candidates the observer report did not cover) and `no_progress`, which is
true when a deadline left work pending but the run settled nothing. A run
reconfirming the same verdict for the same release is not progress. Orders
in the facts and enrollment tables use Unicode code points, never the
running Node's locale data. `--check` validates the committed table. An
unattended run records provenance with `--workflow-run-id`,
`--source-commit` and `--inputs-sha256`; the worker adds the CLI binary's
SHA-256 itself.

Known coverage limits: a 32-bit Windows player (`pe-x86`) runs on no supported
platform, so a release with only 32-bit players stays `wrong-host`; a 32-bit
helper beside a 64-bit game no longer blocks it. A static Linux program with a
System V OSABI is `unknown-platform`, because nothing in its header names
Linux. A Linux tarball wrapped inside
another archive is not unpacked, so its players stay unknown.

##### Scheduled facts batch job

`.github/workflows/listing-facts-batch.yml` runs the worker unattended, with
its checks and decisions in `scripts/listing-facts-batch.mts`. It is built
disabled: the schedule does nothing and nothing is written until the owner
sets the repository variable `PORTCOVE_FACTS_BATCH_ENABLED` to `true`. A
manual dispatch defaults to a dry run, which may run while disabled: it
derives, generates and verifies the batch with read-only permissions, reports
it in the job summary and artifacts, and saves no worker state, branch, pull
request or issue. Its only credential beyond the built-in workflow token is a
short-lived token of the job's own GitHub App, minted by the two jobs that
write ([credentials](#credentials-the-app-token-and-the-built-in-token)); it
uses no paid runner and no external service other than GitHub and the
upstream release downloads the worker already reads. The dispatch input
bypasses nothing: without the variable it can only dry-run, and a dry run
never reaches the jobs that hold the App's key.

Each run, in one concurrency group (`listing-facts-batch`):

1. Any open issue titled `Listing facts batch stopped: …` stops the run.
2. An open batch pull request is evaluated instead of starting another. Only
   a pull request a GitHub App opened from a batch branch of this repository
   counts, so a fork, a person or another workflow's built-in token cannot
   hold or stop the job; before it merges, the `merge` job requires the
   author to be exactly its own App's bot login. When
   all five required checks (`catalog`, `dependency-review`, `frontend`,
   `rust`, `rust-quality`) passed on its exact head, the job composes it onto
   the current `main` tip as the squash will be, requires that composition to
   keep the allowlist and pass the gate and `generate-catalog.mts --check`
   against that tip, and merges through the guarded route
   (`scripts/pr-delivery.mts merge`, exact head, that target and tree checked
   from local objects with `--verify-local-composition`, since GitHub rebuilds
   its merge preview lazily, closure intent and merge message). The merge is
   bound with `--run`/`--attempt` to the head's newest successful
   `pull_request` CI run, so every required context must be a successful job
   of that run attempt; without such a run the batch still waits. The merged
   batch branch is then deleted (a failed deletion changes nothing else). A
   failed check stops the job. Missing or pending checks wait, and a batch
   that has waited more than 15 days (`batchWaitDays`) files `batch-waiting`.
3. Otherwise the job derives one batch from the tip of `main` over the whole
   candidate set: every listing observation the observer has accumulated
   ([observations](#accumulated-observations)) and the worker state restored
   from the Actions cache. `prepare` builds the CLI once, retains the run's inputs (the
   observations, the prior state and `inputs.json` with their digests) as the
   `listing-facts-batch-inputs-<run id>` artifact before the worker runs, and
   plans the run with `--workflow-run-id`, `--source-commit` and
   `--inputs-sha256`; `inspect` runs one matrix job per shard of the
   identities that need bytes ([inspection order](#inspection-order-and-backlog)),
   each with the hosted job's 6-hour limit less its other steps as its
   deadline; `combine` requires every shard to have finished, merges them,
   carries what one batch may not land (below), regenerates the catalog,
   commits locally and checks the paths, the gate, both
   [catalog capacity](#catalog-capacity) bounds and the batch once;
   `reproduce` re-reads every added or changed eligible entry of the batch;
   `decide` withholds each identity its reproduction refused on that
   identity's own facts (below), regenerates and re-checks the batch when it
   withheld one, and assesses the stop conditions. A batch
   it can propose is retained with its outputs record
   (`listing-facts-batch-outputs-<run id>`: the SHA-256 of the facts table and
   of the batch patch, and whether the run was a dry run). It refuses
   its own batch on a path outside the allowlist, a gate refusal, a capacity
   bound, a reproduction that gave no per-identity outcome, or any stop
   condition, and proposes
   nothing when the change is not material: no enrollment changed, no entry
   appeared, disappeared or changed other than by reconfirmation, and no
   offered entry was last confirmed more than 15 days before
   (`refreshAfterDays`). One batch's reproductions spend at most
   `reproductionBatchRequests` (250) REST requests, one per entry that needs
   reproduction, so the job's own reproduction and its pull-request CI
   together never wait for a quota reset ([quota](#reproduction-quota));
   further such entries are carried (`carryOver`): each keeps its previous
   entry, or stays absent when new, and is saved in the worker state's
   `carried` queue with the time it was first carried and the entry it
   derived. The next deriving run restores the queue, reuses each queued
   entry's inspection receipts (its artifacts per asset id and SHA-256, for
   the same repository id and facts parser version; never its refusals, since
   an ineligible verdict lands without reproduction), so an unchanged release
   is not downloaded again, and lands the longest-waiting
   entries first, then the rest in `port_id` order. An identity late in the
   alphabet is never starved by newer ones: every queued entry lands within
   its queue position divided by one batch's entries. A receipt grants
   nothing: a queued entry is reproduced from its bytes when its batch lands.
   Carried identities are reported as `carried` with `carried_ids` in the
   worker summary and counted in the pull request body, never as complete or
   settled. Entries that need no reproduction always land.
4. A ready batch is pushed as the one-commit branch
   `automation/listing-facts-batch-<run id>` and opened as a pull request by
   the job's App, after the deliver job checks, before it mints the token,
   that the applied patch and facts table are the ones the outputs record
   names. Its required checks start on their own. Only then is the worker
   state saved.
5. Stop conditions and the freshness alert are filed; a deriving run also
   publishes the exception queues.

###### Accumulated observations

The observer is a rotating, bounded batch: each run attempts a slice of the
catalog's sources (about 87 of 1,420 per run), and its
`catalog-upstream-observations-*` handoff holds only that slice. The job
therefore reads the observer's durable record instead, its checkpoint
snapshot (`upstream-observer-checkpoint-*`), through the same reader as the
maintenance inventory and the listing delivery (`readUpstreamObservations`:
the newest completed schedule or push `main` run of the last 24 hours that
retains one, each producer event in its own window). The job keeps no copy
of observer state. `scripts/listing-facts-observations.mts` projects every
source that has completed to the last complete listing observation of each
port it serves, so a source observed in any earlier observer run reaches the
worker. An observation is kept while the current listing still names the
repository the observer was asked to observe (a rename GitHub redirects
keeps it; the worker binds the repository id); a re-pointed listing is never
rebound. The binding is
the repository, not the listing's whole declaration (the listing delivery's
rule): the worker reads only the repository's releases and assets, and a
landed batch rewrites the generated parts of the declarations it enrolls, so
a declaration binding would hide each newly enrolled identity until the
observer next completed its source, and the next run would stop with
`observer-coverage-dropped`. When a source's latest attempt ended for a
reason that is not the observer's own progress (the checkpoint's stated
coverage: `failed`, `unavailable`, including a rate limit or transport
failure, or a `partial` such as a truncated page), its listing carries that
status, so the worker keeps the last-good facts within
`lastGoodRetentionDays` rather than reconfirming them. The observer's own
budget, cancellation and quota stops (`partialProgressRules`) and a
collection that changed under it (`concurrent-change`) keep the complete
observation. A listing whose source never completed stays unobserved. The
snapshot is read against the catalog at the observer run's source commit,
which the job fetches on demand into its shallow checkout (the repository is
public), and the snapshot's revision is recorded as the run's
`observer_run_id`. If no run of the last 24 hours retains a snapshot, the
run fails and the next scheduled run tries again.

On 2026-11-24 the newest handoff (observer run 45397908546) held 73 of the
1,146 listing-only identities; that run's checkpoint held completed
observations for 1,125 of them (1,095 complete, 20 the observer itself
recorded incomplete and 10 whose latest attempt failed upstream). The
earlier dry run 45213427510 read only the handoff of observer run
45202674950: 80 of 1,146.

###### State and cursor

A dry run never saves the worker state, so it cannot move the cursor real
runs follow. A refused batch saves none either, so the next run derives it
again. A ready batch's state goes to the deliver job as a one-day artifact
and is saved there only after its pull request opened, so a failed push or
pull request leaves the cursor where it was and the next run derives the same
identities again (a pushed branch whose pull request failed stays behind,
unused). A batch a person closes unmerged has already moved the cursor: its
new identities wait for the next pass, and changed releases are offered
again when the release changes or its facts are next reconfirmed. Its branch
is not deleted; delete it by hand.

###### Reproducible facts and the path allowlist

A batch may change only `listing-package-facts.generated.json`,
`generated-registration.generated.json`, `catalog.json` and `listings.json`:
the facts table and exactly the outputs `scripts/generate-catalog.mts`
rewrites from it. The allowlist is by name, so each of those paths must also
stay a regular, non-executable file on both sides (`git diff --raw` modes
`000000` or `100644`): a symlink, an executable bit or a gitlink at an
allowed name is a violation. It never changes `GENERATOR_VERSION`, a
script, a workflow or an authored listing, and `generate-catalog.mts --check`
still requires every output to equal what the facts produce.

Pull-request CI (`fast-catalog`, and `catalog-full` in qualification) runs
`listing-facts-batch.mts plan` and the change's checks once
(`verify --reproduce false`) for every pull request, whoever opened it. The
plan shards every eligible entry the change adds or changes against the
gate's baseline (`identityShards`), and the required
`listing-facts-reproduction` matrix runs one job per shard
(`verify --shard I`); the `catalog` check passes only when every shard
succeeded. Before any provider call or download, `plan` and `verify` refuse
the whole change when any planned entry's `port_id` is not an authored
listing-only GitHub identity, its `repository` is not the one its listing
names, or its `repository_id` differs from the id the baseline entry bound
that repository to (`reproductionScopeProblems`); `reproduceFacts` refuses
such an entry again with zero calls. The authored listings and release-line
bindings for that check come from the base revision, never from the change,
so a listing only the head adds is out of scope. A change that edits
reproducible facts entries together with any authored listing or catalog
source under `crates/portcove-core/catalog/` (anything there but the four
generated batch outputs) is refused whole before any call
(`authoredSourceProblem`): the authored change lands first, the facts later,
the same shape as checker separation, and a batch never touches an authored
file. So the entries an untrusted pull request can make CI read are bounded
by the authored catalog already on `main`, and none points at a repository
that catalog does not name. Each reproduction shard first stops when a newer
head superseded its pull request (`stop-if-superseded`), so repeated pushes
do not stack matrices. For each entry, CI lists the
repository's releases by numeric repository id once per shard (one page of
100, the observer's page size) and reads the offered release from that list:
one REST request per repository. It requires the list to name the listing's
own repository, the recorded tag, publication time, Core's stable verdict and
the asset-list digest, and re-applies the worker's `latestStable` and
`unreadableReleases` to require the release to be still the newest stable
one (an older release whose bytes reproduce does not enroll; an unclassified
newer tag or an unreadable newer release refuses as `not-latest-stable`). A
full page shows the 100 newest releases, so when it holds the line's newest
stable release nothing older can displace it; a full page without one, or
an offered release absent from the page, is refused. It requires the entry
to record exactly the release's archives and exactly its other asset names, re-downloads each digest-bound archive, re-runs
`inspect-listing-artifact` and Core's name classification, and requires a
byte-equal artifact fact. A refused archive must be refused again with the
same class under the same name verdict. The release's own observed-release
record (tag, time, stable verdict) and its other package forms (names,
sizes, digests and platforms, a container's from Core's name verdict) must
match the provider. The observed releases must equal the observer's window
of the release list (the newest four by publication time, each with at most
32 assets), so an entry that leaves out another line's release, or an
other-form asset, is refused; a release published after the run refuses
every entry of its repository until the next run. Any change to an eligible entry other than its
`observed_at` and the worker's `attempt` record is reproduced, including the
parser version, coverage, repository binding and unread forms. An archive
whose record is byte-identical to the baseline's (same asset id, SHA-256,
players, name verdicts or refusal), in an eligible baseline entry of the same
repository id and facts parser version, is not downloaded again: its bytes
were reproduced when it landed, so only its provider metadata (name, size,
digest) and Core's name verdict are re-checked (`reusedArchives`). A new
release on another line changes only `observed_releases` or
`other_packages`, so it re-reads no archive; a changed artifact, parser
version or recorded fact is reproduced in full. A reconfirmation re-reads
nothing, so whoever can merge can keep a reconfirmation's date moving; an
ineligible entry offers nothing.

Reproduction has no entry, byte or archive-size bound; it is sized from the
real runner constraints instead. A shard holds the fewest entries the
256-job matrix allows (one for up to 256 entries, so a table of 400 new
entries is two per shard). Each shard reads one archive at a time and
deletes it, so its disk holds one archive (at most the provider's 2 GiB) and
Core's extraction of it at a time, inside the hosted runner's free disk
(about 14 GB on a standard Linux runner). Its deadline is one shared
constant, `reproductionDeadlineMinutes` (85 minutes: the repository's
120-minute CI job cap less the shard's other steps), the default of `verify`
in pull-request CI and in the batch job alike, and the worker's per-identity
budget is derived from it, so the job never settles or proposes what CI
cannot reproduce. The deadline is checked before each entry and archive, and
every download, Core inspection, name classification and quota wait is cut
to the time left and not started past it, so an item that reaches it is an
`over-budget` refusal, never a step timeout. An unavailable asset, a changed
release or a reached deadline refuses the entry: it is never trusted, and
any refused entry fails its shard and the `catalog` check. A network
failure, a provider server error (5xx), a rate limit, a quota that does not
clear before the deadline or the runner's disk running out while Core
extracts an archive is the provider's or the runner's condition, never a
verdict on the facts: the entry is refused as `transient` (with
`over-budget`, the `transientReasons`), and pull-request CI reports such a
shard as transient, to be re-run, rather than refused.

A facts change may not record
`generated_at`, or any added or changed `observed_at`, ahead of the clock
(`clockProblems`): facts age is measured from those times, which all come
from earlier runs. A push to `main` was verified on its pull request and re-reads
nothing.

The pull-request check runs the pull request's own code. So `plan` and
`verify` refuse a change that edits the facts table together with any path
the check depends on (`checkerPaths`): the two workflows and their Rust
setup, `Cargo.lock`, the workspace `Cargo.toml` and every workspace member's
manifest (read from its `members` list), the CLI's `main.rs` and
`catalog.rs`, the relative
import closure of `listing-facts-batch.mts`, `listing-package-facts.mts`,
`catalog-generated-registration.mts`, `generate-catalog.mts` and
`validation-plan.mts`, and Core's `package_shape` module with its
submodules and every Core module they name directly. The two must be
separate changes, checker first. A facts table with no entry on either side
is not refused: it has nothing to verify, so a table-format change may
rewrite an empty table with its checker; once either side has an entry the
refusal holds. The enrollment table alone is not refused:
a rule change regenerates it in the same change, from facts that change
cannot edit. This catches accidents only. The list is derived from the
checked-out code, Core's deeper dependencies are not in it, and a deliberate
change that loosens the checker and edits the facts in one pull request,
or that removes this refusal, is held only by review.

A change claims to be a batch when its branch is a batch branch or it
changes the table's `provenance`. CI then also holds it to the path allowlist
and checks the provenance against the run it names: that run must be this
repository's batch workflow, started by the schedule or a dispatch, on `main`
at the recorded source commit, the pull request branch must be that run's
batch branch, and the run's retained `inputs.json` must have the recorded
digest and match the observations and state retained beside it. The
provenance is also bound to the run's outputs: the run's outputs record must
name that run, must not be a dry run, and must hold the SHA-256 of exactly
the facts table under check. The inputs and outputs artifacts are kept 30
days. CI reads the change's paths from the committed range, so files earlier
CI steps leave behind do not count. Both artifacts are read with CI's own
built-in token (`actions: read`, a same-repository run); no credential is
added. That read is not yet observed live: if GitHub refuses it on a batch
pull request, the check refuses the batch, never passes it.

###### Reproduction quota

The REST requests of reproduction use the built-in `GITHUB_TOKEN`, in the
batch job and in the batch pull request's CI alike, whose quota is 1,000
requests an hour per repository
(`githubTokenHourlyRequests`), shared by every workflow of the repository.
The job's App installation has its own quota, at least 5,000 requests an
hour ([GitHub documentation](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#primary-rate-limit-for-github-app-installations)),
which only `deliver` and `merge` spend: per batch one request to open the
pull request and one to merge it (the two `git push` calls are not REST
requests), 2 of 5,000. Reproduction cannot use that quota: a token minted in
a reproduction shard would put the App's key in a job that runs Core over
downloaded bytes, and GitHub does not pass a token between jobs. Pull-request
CI runs with its own built-in token whoever opened the pull request. So the
built-in quota is the real constraint, and reproduction plans only half of it
(`reproductionHourlyRequests`, 500 an hour): the other workflows spend the
same quota while reproduction runs (CI's other jobs, the upstream observer,
discovery, the batch job's own gate and issue calls and the merge's reads),
and their use is not measured here (UNKNOWN), so no smaller reserve is
justified. Moving the pull request and merge writes to the App frees two
built-in requests per batch, too few to change the share. Reproduction
makes at most one request per entry (one per repository per shard), and the
downloads are not REST requests.

Every GitHub call goes through one client (`githubRequest`) and ends at its
step's deadline: a `verify` shard's reproduction deadline, or for other
steps `--deadline-minutes`, the step's timeout less a minute to start and
report. It honours `retry-after` (at least a second, so `retry-after: 0`
never spins) and `x-ratelimit-remaining` with `x-ratelimit-reset`, and
follows GitHub's guidance for a refusal that states no wait (a secondary
rate limit, a server error, a network failure): wait at least a minute
(`githubFirstRetryMs`), then back off exponentially. The deadline is checked
before every attempt and wait; a wait past it fails with
`TransientGithubError` naming its cause (the quota's reset time, or the last
failure). A permission refusal is no rate limit and is not retried. A
response is read only up to `githubResponseBytes`: reading stops as soon as
the bound is passed.

The plan sets the matrix's `max-parallel` (`reproductionParallelism`): the
shards whose requests fit one hour's share, 500 divided by the entries per
shard. When a change plans more entries than the share, shards started once
it is spent must wait for the reset, up to an hour
(`quotaResetWaitMinutes`), inside their 85-minute deadline, so the expected
wait comes out of the per-identity budget (`expectedQuotaWaitMinutes`,
`identityBudgetMinutes`). The arithmetic:

- About 400 entries: 400 requests, within one hour's share. A shard holds two
  entries, 250 of the 256 shards run at once, nothing waits, and each entry
  has 85 / 2 = 42.5 minutes.
- About 1,100 entries in one change: 1,100 requests, past the share. A shard
  holds five entries, 100 shards run at once, the later shards wait for a
  reset, and each entry has (85 − 60) / 5 = 5 minutes. The batch job never
  proposes such a change: it lands at most 250 entries that need
  reproduction per batch (`reproductionBatchRequests`) and carries the
  rest, longest wait first, so about 1,100 entries land as batches of 250,
  250, 250, 250 and 100 in consecutive deriving runs, each with 85 minutes
  per entry and no quota wait. The worker's per-identity
  budget is computed for that batch size, so it never settles what CI cannot
  reproduce.

The batch job's own reproduction and the batch's pull-request CI each
reproduce every entry of the batch, and both can fall in the same hour, so
both count against one hour's share (`reproductionsPerBatch`, 2): a batch
lands at most 500 ÷ 2 = 250 entries that need reproduction, the two together
spend at most 500 requests, and the other half of the quota stays for the
other workflows. The carry-over is automatic and visible: the worker summary
reports `carried` with `carried_ids`, and the batch pull request counts them. In the batch job, a reproduction whose every
shard wrote its refusal file and refused only transiently
(`reproductionTransient`) proposes nothing, keeps the previous worker state
and files no stop; the next run retries. Its run history is kept, so a second
consecutive transient reproduction files `reproduction-transient` with the
latest causes.

###### Reproduction refusals of one identity

A reproduction shard records every refusal typed (`refusalRecord`). A refusal
of one identity's facts (`identityRefusal`: `release-unavailable`,
`release-changed`, `not-latest-stable`, `asset-unavailable`, `core-refused`
or `mismatch`) is a verdict on that identity, not on the job. A release list
read counts as `release-unavailable` only when the provider states it
(404, 410, 451, a 403 whose message says repository access is blocked,
malformed records or a response over its size bound); an archive inspection
counts only when it fails with the worker's typed inspection error and Core
gave a verdict on the archive. Any other failure (another permission refusal,
a missing or crashed Core CLI, Core output that is not JSON, a Core usage
refusal, a fault of the job's own code) is `job-fault`, which stops the job
like `out-of-scope`. A systemic fault can still look like a verdict on each
identity (a wrong URL template gives every identity a 404), so when more
than one identity was reproduced and every one is refused for the same
reason, `decide` withholds
nothing and stops as `reproduction-unsound`. A single refused identity
(alone in its batch, or among others that pass) cannot be told apart from a
systemic fault that touched only it; it is withheld, which is the safe
direction. For a verdict on one
identity the shard
passes, and `decide` withholds the identity (`withholdRefused`). Its entry
becomes ineligible `reproduction-refused` for the release it was refused
for, naming the refusal reason and a receipt (`refusalReceipt`: the digest of the
repository, release, assets fingerprint, observed release text verdicts and
the parser and generator versions), so a repeated refusal of the same
release is a reconfirmation rather than a new change; the provider's detail
is in the job summary and the run's `withheld.json`. The catalog is
regenerated and the paths, the gate, both capacity bounds and the batch's
checks run again on the batch as it now stands; the rest of the batch
proceeds. The identity is listed under `reproduction-refused` in the
exception queues for a person to hand-check. While the receipt's inputs are
unchanged the worker reconfirms it without downloading the release again;
when any of them changes (a new release or asset, a changed text verdict, a
rule version), the worker derives it again, so it lands without a person once
reproduction agrees. When a batch must carry entries
(`carryOver`), an entry refused before for the same release waits behind
every other, so a recurring refusal never holds another identity's slot. If
the batch without the withheld identities cannot be regenerated, or its
exception queues cannot be published, nothing is proposed and the run stops
as `withheld-batch-unchecked`, naming that step. Measured: `youkaicountry-yknytt`'s release
list now titles its releases as betas; that refusal used to stop the whole
job until a person acted, and it now withholds only that identity. A refusal
that would withdraw a route players already have is held instead
(`withdrawal-held`, cause `reproduction-refused`). Transient refusals keep
their own rule (no proposal, retried; `reproduction-transient` on two
consecutive runs). Pull-request CI, the merge authority, still refuses a
change with any refusal: a batch whose release changed between the job's
reproduction and its CI fails its required check (`required-check-failed`).

###### Stop and wait

Each condition files or reuses one issue titled
`Listing facts batch stopped: <condition>`, opened by the workflow token,
with the grouped reason and the run. A recurrence after it was closed reopens
and comments on the same issue; an open issue is not commented again. No
further run starts while any such issue is open; closing it is how a person
clears the stop. An unreadable issue list, or more than 1,000 open workflow
issues, fails the run rather than reading as "not stopped"; past 1,000 closed
workflow issues and pull requests, a recurrence may open a new issue instead
of reopening the old one. A `reproduction-unsound` issue names up to five
of the shards' recorded refusals and why, as inert code text (every one is in
the run's refusal records). The conditions are `gate-refused`, `catalog-capacity`
(the batch would exceed a released-reader bound; see
[catalog capacity](#catalog-capacity)), `reproduction-unsound` (the
reproduction gave no per-identity outcome: an entry outside the authored
candidate scope, `out-of-scope`, a change that also edits authored sources,
a shard that ended without its typed record, a `job-fault` refusal, every
reproduced identity, of more than one, refused for the same reason, or a batch whose separation, clock or canonical-output checks failed after an
identity was withheld), `withheld-batch-unchecked` (the batch without the withheld
identities could not be regenerated or its exception queues published),
`reproduction-transient` (a reproduction that ended only transiently on two
consecutive runs), `path-allowlist`, `required-check-failed` (or a job batch that is not a
well-formed one-commit pull request), `foreign-batch-author` (a batch-shaped
pull request another GitHub App opened; see
[credentials](#credentials-the-app-token-and-the-built-in-token)),
`batch-app-slug-unset` (a batch passed its checks while
`PORTCOVE_FACTS_BATCH_APP_SLUG` is unset), `batch-waiting` (an open batch whose
required checks have not all finished more than 15 days after it was opened,
most likely because its runs wait for approval: a reconfirmation proposed at
15 days must merge within the rest of the 30-day facts age),
`no-progress` (the run's deadlines left work pending and it settled nothing:
with no identity or byte bound, a whole shard could not finish one
identity), `backlog-growing` (shard deadlines left more identities pending
than in the previous run), `withdrawal-held` (see below),
`repository-identity-changed`, `rule-version-changed` (the facts parser,
generator or Core filename rule version changed since the previous run),
`observer-coverage-dropped` (an identity the previous run's observer covered
is a candidate this run's observer report does not cover at all),
`pending-repeated` (an identity a shard deadline left pending in this run and
the previous one, grouped by cause) and
`worker-error` (also any job, the `gate` job and every shard included, that
failed, timed out or was cancelled).

`withdrawal-held` replaces a numeric withdrawal cap. It protects players
from a bug that withdraws offered games, without a magic number: each route
the batch withdraws is classified from the facts on both sides
(`withdrawalCauses`). Only a definitive upstream statement proceeds: its
facts entry changed in something other than a reconfirmation through a new
release or an ineligible verdict from a complete observation (a repository id
that changed under the listed name included), or its listing is no longer a
candidate (an authored, reviewed change). It is held, and the whole batch
with it, when the entry was rewritten by another facts parser version
(`rule-version`); when upstream stayed incomplete past the 14-day retention
bound (`observation-unavailable`: an observer or provider outage reads the
same as a deleted repository, so an outage could otherwise withdraw
everything); when the worker could not read the bytes or Core could not
classify a name (`inspection-failure`: `repeated-inspection-failure`,
including the `runner-time` and `runner-disk` causes, or `invalid-facts`);
when the job's own reproduction refused the entry (`reproduction-refused`: a
reproduction fault would otherwise withdraw offered games); or
when the entry is unchanged but for a reconfirmation (`not-reobserved`: the
withdrawal comes from a rule change or from facts ageing out because the
observer did not observe them completely, which is how an observer coverage
drop shows). A parser or generator behavior change requires its version bump,
which is what marks the withdrawals it causes as `rule-version`. A person reviews the held routes and
clears the stop; a rule change that withdraws routes lands as a reviewed
pull request, never as an unattended batch. Any number of upstream-explained
withdrawals, additions or changes proceed. A stop condition found while deriving also withholds that run's
batch. An open batch pull request that still fails stops the job again after
its issue is closed; close that pull request too.

The freshness watchdog compares the committed facts' `generated_at` with the
real clock on every enabled run, also while a batch waits or a stop issue is
open. When the table is more than 15 days old (`freshnessAlertDays`: a quiet
catalog proposes its reconfirmation batch at 15 days, so older facts have
not landed one), including the empty table before the first batch lands, or
records a time ahead of the clock, the job files
`Listing facts batch: facts are falling behind the clock`. It does not stop
the job, whose next batch is the remedy. Every job and every step has a
finite timeout, and each job's timeout is at least the sum of its steps', so
a slow step fails inside the job and the stop assessment still runs. These
are harness budgets, not limits on what lands: the plan job 130 minutes (the
CLI build 30, the plan 30); each `inspect` shard the hosted job's 360-minute
limit, with the worker's deadline set to that limit less the shard's other
steps (330 minutes); each `reproduce` shard 125 minutes, the sum of its
steps, whose reproduction step (90) outlasts the shared
`reproductionDeadlineMinutes` (85); `combine` 80; `decide` 120; the deliver
job 45; `merge` 45; `gate` 20; `notify` 30.

When a stop issue cannot be filed (a spent quota, the step's deadline),
`notify` fails with that cause and keeps the unfiled issues in the Actions
cache (`listing-facts-batch-unfiled-v1-…`). The next run's `gate` restores
them and holds the run (`blocked`) until its `notify` files them first, so a
stop is never lost; an unreadable record holds as `worker-error`.

###### Exception queues

Every deriving run publishes `catalog-route-fit.mts --json` as the
`registration-queues-<run id>` artifact and a job summary with the count per
blocked reason, the most frequent unread package forms and the most frequent
name vetoes. That report stays computed from the committed catalog and facts.

###### Credentials: the App token and the built-in token

The owner decided on [#1422](https://github.com/boburning/portcove/issues/1422#issuecomment-7106469487)
to deliver and merge batches with a dedicated GitHub App rather than the
built-in token: events the built-in `GITHUB_TOKEN` causes create no workflow
run (its pull request's `pull_request` runs wait for a person to approve them,
and its merge starts no `push` run;
[GitHub documentation](https://docs.github.com/en/actions/concepts/security/github_token#when-github_token-triggers-workflow-runs)),
while an App's events start them like a person's. So a batch pull request is
an ordinary pull request: its required checks and the `pull_request_target`
`closing-inventory` check start on their own, and a merged batch starts
`main` CI and the catalog publication that follows a green `main` run. There
is one CI path, with no second trigger, personal token or recurring dispatch.

- Only `deliver` and `merge` declare the `facts-batch` environment, whose
  deployment-branch policy admits only `main`, and only they can read its
  variable `FACTS_BATCH_APP_ID` and secret `FACTS_BATCH_APP_PRIVATE_KEY`. In
  each, one step (`actions/create-github-app-token`, pinned by commit SHA)
  references the key and mints a token with only `contents: write` and
  `pull-requests: write`, after every check that needs no credential and
  immediately before the first step that uses it. The step sets no `owner` or
  `repositories` input, so the pinned action scopes the token to the current
  repository (`GITHUB_REPOSITORY`) on every trigger; an input taken from
  `github.event.repository` would be empty on `schedule` and widen the token
  to every repository of the installation. The action revokes the token when
  the job ends.
- Neither job ever executes batch or artifact content. `$GITHUB_WORKSPACE`
  stays the untouched `main` checkout, and every check runs its scripts:
  `deliver` applies the patch with `git am` in a separate worktree (Git
  without system or global configuration, hooks, attribute files or
  fsmonitor, so no filter, diff or merge driver runs) and checks the commit
  as Git objects with main's `paths` and `outputs-check --revision`, then
  pushes that commit by id and opens the pull request with main's script.
  `merge` composes the batch onto the current `main` tip with
  `git merge-tree` (objects only), checks both diffs with main's `paths`,
  and runs `generate-catalog.mts --check` in a checkout of the `main` tip
  that received only the allowlisted data files of the composition, proven
  equal to it; the guarded merge reads a head worktree that writes no file.
  `deliver` downloads only data (the patch, its outputs record, the delta,
  the worker report and the worker state); `merge` downloads nothing.
- `deliver` pushes the batch branch with it and opens the pull request;
  `merge` merges through the guarded route and deletes the branch. Each push
  gets the token as an HTTP header through that one `git` command's
  environment, never through the git configuration, the remote URL or a
  persisted checkout credential. The token reaches only the steps that write,
  through `env:`; it is never echoed, cached or uploaded.
- In `merge`, the built-in token reads the evidence (check runs, the CI
  workflow run and its jobs, statuses, the closing inventory) and the App
  token is used for the merge mutation alone (`scripts/pr-delivery.mts`,
  `PORTCOVE_MERGE_TOKEN`), since the App has no Checks, Actions or Issues
  permission. The merge stays bound with `--run`/`--attempt` to the head's
  CI run and goes through the `Protect main` ruleset (five required contexts,
  zero approving reviews); the App is on no bypass list.
- `gate` and `notify` keep the built-in token (`notify` files the stop
  issues; the App has no Issues permission). `prepare`, `inspect`, `combine`,
  `reproduce` and `decide` run Core over downloaded bytes and never see the
  key, the App id or a write token; they declare no environment.
- The path allowlist is the control on what a batch may change. The App has
  no Workflows permission, so GitHub would also refuse a batch push touching
  `.github/workflows`: defense in depth, never relied on.

A dry run never reaches `deliver` or `merge` (both require the variable and
no dry run), so it works with the environment unset or the App unavailable.

- The owner sets the required, non-secret repository variable
  `PORTCOVE_FACTS_BATCH_APP_SLUG` to the App's slug before enabling the job;
  the job never sets it. With it, the keyless `gate` makes another App's
  batch-shaped pull request the named `foreign-batch-author` stop, so the
  key-holding `merge` job never processes that pull request's data. Without
  it (or malformed), `gate` never reports a batch green: a batch whose checks
  pass is the named `batch-app-slug-unset` stop and is not merged. `merge`
  still binds the author to the minted App's `app-slug` before any write and
  raises `foreign-batch-author` on a mismatch.

What the repository cannot show: the App's actual permission set,
installation scope and absence from every bypass list (UNKNOWN). A
successful mint does not confirm them: the action requests only the listed
permissions and the current repository, and a broader App or installation
grants them just the same. The owner verifies once in the App's settings
that its permissions are exactly Contents and Pull requests (read and write)
plus Metadata (read), that it is installed on this repository only and that
it is on no ruleset bypass list, and records that on
[#1422](https://github.com/boburning/portcove/issues/1422). The first live
batch then records these observations:

- the mint step's log names exactly this repository ("Creating token for
  this repository"), never "all repositories owned by";
- the pull request's author is the App's bot, and its CI starts without
  anyone approving it;
- no unexpected `push` workflow runs on the batch branch: every workflow's
  `push` trigger names `main` or `v*` tags only, none matches
  `automation/**`;
- the merge succeeds only with the five required checks green, and the
  `Protect main` ruleset's additional approval for unattributed changes does
  not refuse it (expected inert with zero required approvals; see
  [Repository settings](REPOSITORY-SETTINGS.md)). The batch commit is
  authored and committed as `github-actions[bot]` (the patch's author is
  fixed by `combine` and bound by the outputs record, and the App's bot
  identity is known only after the mint), while the App pushes it;
- `main` CI and the catalog publication start on the merge commit;
- the branch deletion succeeds, and the post-job step revokes each token.

A push to a path outside the allowlist is refused by the job itself, before
GitHub sees it.

The residual trust, plainly: the App's key, or any step that runs in
`deliver` or `merge`, is equivalent to unattended write to `main` for
anything that is not a workflow file, subject only to the five required
checks, because the ruleset requires no approving review and a merged batch
is then signed and published automatically. The `facts-batch` environment
admits only `main`, so anything merged to `main` could use the key.

Two further residual risks:

- `main` may advance between the job's last check of the composition and
  the merge request. The merge API takes the head SHA but no base-SHA
  precondition, and the `Protect main` ruleset's status-check policy is not
  strict, so GitHub merges onto whatever `main` is then. The `main` CI run on
  the merge commit is the backstop.
- `contents: write` is broader than the job's use of it. Beyond pushing the
  batch branch, the token could create other branches, releases and tags.
  The `Protect release tags` ruleset restricts update and deletion of `v*`
  tags but not their creation (see
  [Repository settings](REPOSITORY-SETTINGS.md)), and a `v*` tag push starts
  `.github/workflows/app-release.yml`.

###### Migration and steady state

There is no drip-feed. The first enabled run is one migration: it plans
every listing-only GitHub identity, reads every identity that needs bytes
across the inspect matrix, and opens one pull request that enrolls every
identity that passes the correctness rules. That pull request's CI
reproduces every new entry across the reproduction matrix, so a table of
several hundred new entries is verified in one pull request. Steady state
afterwards is the same unbounded job: each run proposes one batch with every
change that fits, whatever its size.

What protects players is not a count: it is the correctness rules (the fit
rule and the gate, each with its own code), the reproduction of every added
or changed entry from its exact bytes, and the stop conditions, including
`withdrawal-held`. The schedule runs every 6 hours: that decides how soon a
new release is seen, never how much lands. A run derives only while no batch
is open, so each landed batch costs two runs (the one that derives it and
the one that merges it) plus its pull request's CI. A quiet catalog proposes
a reconfirmation batch once an offered entry was last confirmed 15 days
earlier (`refreshAfterDays`, half the facts age), which leaves the other half
of the 30-day facts age for its checks and merge.

###### Catalog capacity

Two bounds limit how many generated routes the batch can carry. Neither is
a cap of this job, and each is guarded at Core's supported share
(`CATALOG_SUPPORTED_CAPACITY_PERCENT`, 85%):

- `MAX_CATALOG_BYTES` (16 MiB, ceiling 14,260,633 bytes), a bound of
  released readers. The binding measure is the JSON-escaped retained
  installed contract (Core's `catalog_growth_stays_within_supported_capacity`):
  4,529,946 bytes on November 23, 2026, so about 9,730,000 bytes of headroom,
  or about 1,100 more routes at about 8.7 KB of escaped contract per
  generated route.
- `MAX_LISTING_DIRECTORY_TEXT_BYTES` (64 MiB, ceiling 57,042,534 bytes) for
  the canonical listing directory `listings.json`: Core's text bound, which
  every tool that reads the canonical text follows (Core's inspection, the
  listing publisher's canonical read and this job, through
  `listingDirectoryTextMaximum`, which a test pins to Core). The directory
  measured 6,449,993 bytes on November 24, 2026. Until then the job also
  stopped at the publisher's former 8 MiB canonical read (ceiling 7,130,316
  bytes, 680,323 bytes of headroom); that read now follows Core's bound.

Before it opens a pull request the job checks the regenerated batch against
both ceilings (`capacity`): the generated, compact and signed-envelope
catalog measures, the escaped retained contract (estimated as the escaped
`catalog.json` text plus `retainedContractReserveBytes`, 16 KiB, about four
times the contract's 3,477 bytes of other fields) and the listing directory
text, together with every listing delivery row of `catalog-capacity --check`
(`listingDirectoryMeasures`, with the committed withdrawals: the compact
carrier's decoded, wire and record bytes, the listing and withdrawal counts
and the element budget released readers enforce, each with its own margin,
see [reader generations](SIGNED-CATALOG.md#reader-generations); the frozen
legacy target row is informational and never stops a batch). On November 24,
2026 the compact carrier's wire bytes bind first among them (modeled
3,859,933 of a 6,411,179-byte ceiling, about 36 days of measured growth).
A batch past any ceiling is not proposed,
since its required check would fail; the run files the reused stop issue
`catalog-capacity` with the exact figures. Raising
a released-reader bound needs a compatibility analysis of released readers and
is a separate change.

###### Numeric constants

Every number that remains in the worker, the generator, the gate and the job
is a correctness rule or comes from a real constraint:

| Constant                                                                                 | Value                                                        | Constraint                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxFactsAgeDays`                                                                        | 30 days                                                      | Correctness: how long observed release facts are trusted without a fresh complete observation. The gate restates it as `gateFactsAgeDays`, tested equal.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `lastGoodRetentionDays`                                                                  | 14 days                                                      | Correctness: how long an upstream fault, or a transient inspection failure, is treated as temporary. The gate restates it as `gateRetentionDays`, tested equal.                                                                                                                                                                                                                                                                                                                                                                                                        |
| `maxDistinctPrograms`                                                                    | 1                                                            | Correctness: a second program name cannot be told apart from a second title.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `listingReleaseLimit`, `listingPackageLimit` (facts schema bounds)                       | 4 releases, 32 assets                                        | The observer's own window; an entry cannot record more than the observer saw.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `releaseTextWindow`, `releaseTextSourceBytes`                                            | 4 releases, 6,477 bytes per source (32 MiB ÷ 2 ÷ 2 ÷ 1,295)  | Bounded unit derived from the checkpoint's capacity: the listing observation window's releases keep their title and judged first line (the whole body is read to find it); a source whose kept text exceeds its share records a typed overflow with its size, reported in the accumulated read's gaps, and reads as unobserved text: withheld (`release-text-unobserved`), never read as stating nothing.                                                                                                                                                              |
| `coreInspectedFileBound` (players per archive)                                           | 16,384                                                       | Core's inspected file bound (`MAXIMUM_SHAPE_PATHS`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `maximumNameBytes`, `chunkNames`, `chunkBytes`                                           | 1,024 bytes, 50,000 names, 8 MiB − 1,024 bytes               | Core's classification request bounds, and the CLI's 8 MiB input bound less room for the request's own JSON framing.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `guideBound` (`guide-bound`)                                                             | 8 entries                                                    | Core's catalog guide schema (`catalog.rs`, `listings.rs`): steps plus references, and warnings, at most eight each. A longer guide is refused by every client, and truncating the authored guide would drop title-specific instructions, so the identity is withheld instead.                                                                                                                                                                                                                                                                                          |
| `displayableName`                                                                        | 120 characters, 3 programs                                   | Player copy: a longer name, or more programs, falls back to generic wording; it withholds nothing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `matrixJobLimit`                                                                         | 256                                                          | GitHub Actions' maximum jobs per matrix.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `reproductionDeadlineMinutes`                                                            | 85 of 120 minutes                                            | The repository's 120-minute CI job cap (`ci-workflow.test.mts`), less the reproduction shard's other steps. One constant for pull-request CI and the batch job's own reproduction.                                                                                                                                                                                                                                                                                                                                                                                     |
| `identityBudgetMinutes`                                                                  | (85 − expected quota wait) / ceil(entries / 256) minutes     | The CI deadline, less the quota reset CI must expect past one hour's reproduction share (`expectedQuotaWaitMinutes`), shared by the entries one CI shard holds. The worker passes the entries one batch can land (at most 500): 85 up to 256, 42.5 from 257 on. A hand-made change of about 1,100 entries gets (85 − 60) / 5 = 5.                                                                                                                                                                                                                                      |
| Inspect shard deadline                                                                   | 330 of 360 minutes                                           | The hosted job's 6-hour limit, less the shard's other steps.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Runner disk                                                                              | about 14 GB free                                             | A standard public Linux runner; Core's 16 GiB extraction ceiling plus the archive can exceed it, so running out is a transient `runner-disk` failure, never a refusal.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `githubTokenHourlyRequests`, `reproductionHourlyRequests`                                | 1,000 and 500 requests an hour                               | The built-in `GITHUB_TOKEN`'s REST quota per repository, shared by all its workflows and used by every reproduction (the batch job's and its pull request's CI); reproduction plans half and leaves half for the other workflows, whose use is not measured (UNKNOWN). Reproduction spends at most one request per entry.                                                                                                                                                                                                                                              |
| App installation quota                                                                   | at least 5,000 requests an hour                              | The job's GitHub App, used only by `deliver` and `merge`: 2 REST requests per batch (open the pull request, merge it), so 2 of 5,000. It never serves reproduction, which would need the App's key in a job that runs Core over downloaded bytes, so it does not change the reproduction share.                                                                                                                                                                                                                                                                        |
| `reproductionParallelism`                                                                | 500 / entries per shard                                      | The shards whose requests fit one hour's reproduction share: 250 at about 400 entries, 100 for a hand-made change of about 1,100.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `reproductionsPerBatch`, `reproductionBatchRequests`, `quotaResetWaitMinutes`            | 2 reproductions, 250 requests, 60 minutes                    | The batch job and the batch pull request's CI each reproduce every entry on the built-in token, possibly in one hour, so both count against one hour's share: a batch's reproductions spend at most 500 ÷ 2 = 250 requests, one per entry that needs reproduction (`reproductionBatchEntries`), and the rest is carried (reported as `carried`), longest wait first, with its inspection receipts in the worker state, so neither waits; the App's own quota does not add to this share. GitHub resets the primary quota hourly, so a spent quota waits up to an hour. |
| `githubFirstRetryMs`, `--deadline-minutes`                                               | 1 minute, then doubling; the step's timeout less 1 minute    | GitHub's retry guidance for a refusal that states no wait; every call ends at its step's deadline with a clear transient cause.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `githubResponseBytes`, `githubRequestMs`                                                 | 8 MiB, 30 seconds                                            | A page of 100 releases with their assets stays far below 8 MiB; 30 seconds is one request's harness budget.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Open pull request listing                                                                | 10 pages of 100                                              | The REST page size; past 1,000 open pull requests the batch state is unknown and the run fails closed, like the stop-issue reads.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Observer checkpoint lookup                                                               | 24 newest completed runs per producer event, within 24 hours | The shared reader (`readUpstreamObservations`, DM-20): schedule and push windows are listed separately, and the newest run retaining a checkpoint snapshot is read; none fails the run, retried by the next schedule.                                                                                                                                                                                                                                                                                                                                                  |
| `MAX_CATALOG_BYTES`, `MAX_LISTING_DIRECTORY_TEXT_BYTES` (`retainedContractReserveBytes`) | 16 MiB and 64 MiB, each at 85% (16 KiB reserve)              | The released readers' catalog bound and Core's listing directory text bound: see [catalog capacity](#catalog-capacity). The job checks both before it opens a pull request.                                                                                                                                                                                                                                                                                                                                                                                            |
| Provider asset size                                                                      | 2 GiB                                                        | GitHub's per-release-asset maximum; no worker bound of its own.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `releaseListPage`                                                                        | 100                                                          | The REST API's largest page, the observer's page size. A full page without the line's newest stable release (or without the offered release) is refused at reproduction; a full page holding it is not, since nothing on a later page is newer.                                                                                                                                                                                                                                                                                                                        |
| `refreshAfterDays`, `freshnessAlertDays`                                                 | 15 days                                                      | Half the facts age, leaving the other half for a reconfirmation batch's checks and merge.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `batchWaitDays`                                                                          | 15 days                                                      | The facts age less the refresh point: a waiting reconfirmation past it would let offered routes age out.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `clockSkewMs`                                                                            | 0                                                            | Every recorded time comes from an earlier run on synchronized hosted runners.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Artifact retention                                                                       | 30 days                                                      | The facts age: provenance stays readable for as long as its facts are trusted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Retained-artifact ZIP bounds                                                             | 64 MiB compressed, 128 MiB expanded                          | A decompression-bomb guard on artifacts CI reads; exceeding it refuses the batch for a person, never one game.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Stop-issue reads                                                                         | 1,000 issues                                                 | Fail-closed read of the job's own issues; more refuses the run rather than reading as "not stopped".                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

The 64 added / 32 withdrawn / 64 changed delta bounds, the 64-entry / 4 GiB /
512 MiB / 30-minute reproduction budget, the 24-identity / 2 GiB run budget,
the 10-minute per-download and per-Core-run cap, the 512 MiB archive bound,
the six-per-platform and sixteen-per-release archive counts, three-failure
retry count, the 16-route withdrawal stop, the quarter coverage share, the
three-run and four-run stop counts, the 21-day alert, the 3-day wait, the
10-minute clock skew, the 4,096-file and 64 MiB handoff bounds, the
ten-name report cap and the 256-character cut of a release body's first line
are removed.

###### Switching it on

The job stays disabled until the real cohort, independent review, exact
gates and an activation decision are in place. Switching it on starts the
migration: the first run proposes one pull request with every identity
that fits, possibly hundreds. The path scope: the recorded direction on
[#1422](https://github.com/boburning/portcove/issues/1422#issuecomment-7090719917)
names only the facts and enrollment tables, while a batch that enrolls also
rewrites `catalog.json` and `listings.json`, because catalog generation
writes each generated route into the operational catalog and keeps only the
listing's other platforms in the discovery directory. Those two paths are
never authored by the batch: CI requires each of them, and the enrollment
table, to be the byte-for-byte output of `generate-catalog.mts` from the
facts table and the unchanged sources (`derivedBatchPaths`). Without them a
batch could not offer a route. A hand-written pull request changing both the
facts checker and the facts table is held only by review (the separation
refusal above catches accidents); whether the checker paths should need a
review stays an owner decision.

The App and its `facts-batch` environment already exist
([credentials](#credentials-the-app-token-and-the-built-in-token)); no
Actions setting that lets the built-in token create pull requests is needed.
The owner or lead then:

1. Dispatches the workflow once with the default dry run and reviews its
   summary and artifacts: the dry run derives the same migration batch and
   reports its size, its exception queues and its stop conditions. It needs
   neither the environment nor the App.
2. Exercises a throwaway pull request of a few facts entries, to see CI's
   reproduction shards and their aggregate run on real entries before the
   migration's matrix of up to 256 jobs.
3. Sets the required repository variable `PORTCOVE_FACTS_BATCH_APP_SLUG` to
   the job's App's slug; without it no batch is ever merged
   (`batch-app-slug-unset`).
4. Sets the repository variable `PORTCOVE_FACTS_BATCH_ENABLED` to `true`
   (unset or any other value is off).

The first live batch then records the observations that confirm the App's
scope (above): the token mint succeeds for Contents and Pull requests only,
the pull request shows the App as author and its CI starts unattended, the
guarded merge succeeds on green exact-head checks, and `main` CI starts on
the merged commit and publishes the catalog. No person approves, closes or
reopens a batch pull request.

Nothing else changes: no ruleset, required check or signing setting. To
switch it off, delete the variable or set it to anything else.

Use `integration.presentation.manual_setup` when Portcove-managed setup needs
different steps or warnings from the upstream package in `listing.manual_setup`.
The managed definition uses its own guide when present and otherwise inherits
the listing guide. The discovery directory keeps the upstream guide.

For a warning specific to one managed package, author
`managed_setup_platform_warnings` in the port record by exact managed platform.
Catalog generation emits Desktop review copy from the authored integration guide
or the explicit managed preparation in `route_facts_v1`. The managed install and
managed-copy reviews use a matching managed step and the warnings in the selected
definition. Explicit platform warnings can also supply the managed review for an
older definition. Otherwise, legacy inherited guidance gets the standard package
and ownership summary, with its existing warnings visible. The full guide remains
available in the game instructions. Keep upstream package warnings in the listing.

Managed PS1 generation and rebuild use the owned pinned toolchain, whose critical
file identities are rechecked before each builder process. Both prohibit the kit's
toolchain download fallback. Builder PATH contains only the owned toolchain and
bundled Python directories; profile, cache and temporary paths are private to the
preparation workspace. Missing or changed declared tools refuse before the builder
starts. Kits must support the generation no-download argument; incompatible CLI
contracts refuse rather than retrying with weaker arguments. This is builder
acquisition/environment policy, not title-native qualification or a general OS
sandbox. Retained workspaces and existing cancellation/closure guards still apply.

Managed PS1 ports pass their reviewed runtime configuration with `--game` and
an explicit `--memcard-dir` inside the managed runtime's `saves` directory.
This applies both to referenced discs and to materialized raw disc sets. It
keeps upstream defaults from moving player data into a Documents directory
outside Portcove's backup, update and rollback ownership. For example,
[Yu-Gi-Oh! v0.5.7's runtime](https://github.com/Unchiga/psxrecomp/blob/f003d3b9d76e8e54cb1e94957162c4e7de467f45/runtime/src/main.cpp)
honors this explicit directory for memory cards, settings and mod data.
Windows launch arguments use ordinary path spelling only when resolving the
existing ancestors proves it identifies the same location as the extended path.
Yu-Gi-Oh! additionally declares `PSX_PORTABLE=1`, because its launcher caches
use a separate upstream data-directory resolver. Its source and BIOS selection
files (`disc.cfg`, `bios.cfg`) are persistent preferences; the checked-disc
cache (`disc_verified.cfg`) and exact
[`diagnostics/psx_freeze_heartbeat.json`](https://github.com/Unchiga/psxrecomp/blob/f003d3b9d76e8e54cb1e94957162c4e7de467f45/runtime/src/freeze_heartbeat.c)
are reproducible runtime outputs. Other files in `diagnostics` remain verified.
New named persistent-path declarations also permit newly created preference
files in existing installations. Verification still checks every file recorded
as immutable in the original manifest; a later declaration cannot hide changes
to those bytes or rewrite that recorded identity during library import.
For an installed version with a retained definition, runtime verification may
recognize new exact persistent and runtime-mutable paths only when the current
port definition otherwise matches that retained definition and keeps all old
mutable paths. Recorded immutable members and executable companions cannot gain
mutability. This verification allowance does not prove that player data was
restored under a wider scope. Receipt-governed installations refuse collection or
restoration when historical scope evidence is absent or interpreted persistence
paths/patterns differ from their retained scope; the same persistence-authority
preflight covers inactive versions in read-only Restore review and again before
canonical publication. Actual restore also checks mod conflicts at its existing
mutation boundary. A managed PS1 installation is the one exception: when a
newer definition only adds `mods/texture-packs`, which PSXRecomp `7192402`
creates on every start, the installation keeps its retained definition. Files
there stay in that copy unmanaged, exactly as before the folder was declared:
verification reports them, and they are not collected, carried to another
version or backed up. Installations created
under the wider definition retain it and synchronize the folder.
The original receipt, manifest and diagnostic-mutability
behavior remain unchanged. Other existing integration interpretations, including
the separately qualified Shipwright exception, retain their own boundaries.

A ready staged archive may move forward to a fresh, strictly larger persistence
contract only when the old authenticated contract and its current data
interpretation agree, all source/launch coordinates and patterns remain compatible,
and every added path is absent from the active runtime, canonical data and actual
destination. Missing immutable package files do not make their names adoptable;
links, case aliases, overlapping paths and uncertain inspection refuse. Recheck
under the port lock after preparation, synchronization and before activation or
pending recovery. The new installation retains its full new scope; old copies keep
their original scope. Ordinary contract shrinking, populated additions and
unproven scope expansion remain refused. Runtime rollback still carries current
data and does not rewind saves.

The historical Sonic 3K v0.5.3 (#154), Sonic 1 v0.6.0 (#152) and Mega Man X2
v0.1.4 (#165) reader transitions to newer routes have an additional
compatibility hold: common declared player data must also be absent in the retained
runtime, canonical data and actual target. Only separately verified regular original
bytes are exempt; an empty set of added sidecars proves no save compatibility.
A fresh newer route cannot initialize unknown canonical player data through collection,
restore, backup restoration, activation or recovery. The exact legacy reader keeps
its creating contract. An established target's exact retained contract and matching
installation/manifest data-restore receipt preserve its administrative restore
behavior; that receipt does not establish state ABI or authorize legacy adoption.
A separate empty library remains the fresh creation case. Other ports retain the
generic common-data preservation rule above. New indexed fresh definitions for
these newer routes must declare staged-source capability version 25, so readers
without this behavior refuse them. Retained entries keep their creating reader
requirements; current runtime checks remain independent of that envelope.

Explicit rollback between two authenticated retained ready-archive copies may use
that same empty-path proof in either direction when one persistence scope strictly
contains the other. Both copies keep their original manifests and receipt scope; ordinary restore
completion keeps its existing proof-recording behavior. No current catalog
reinterpretation grants the older copy a wider scope. Every
changed path must be absent from both runtime roots and canonical data, with the
same compatible coordinates, patterns, immutable-member and companion checks.
Status and execution share the guard; execution repeats it after collecting
current data and before restoring the target or changing the active pointer.
This permits returning from an empty expansion and back to its retained larger
version. If either runtime later creates a changed path, or a path is populated,
aliased, linked or otherwise uncertain, the switch stays held with the files and
active copy preserved. Populated scope migration is not supplied by this exception.

A ready runtime-local GitHub archive may explicitly declare
`archive_data_compatibility_v1` with a stable `contract_id`, disjoint bounded
`shared_paths`, and `build_specific_progress_paths`. These are reviewed data
semantics, not inferred from filenames or an unchanged original ROM. Shared
conventional paths remain in canonical user data. Other persistent objects are
stored under `.portcove-archive-data-v1/<policy-sha256>/<producing-archive-sha256>`
and restored only to that archive under its retained contract. Mixed directories
can keep conventional SRAM shared while isolating host snapshots and unknown
sidecars. Changing the policy, source identity or persistence coordinates holds
replacement; historical installed definitions do not acquire the new policy.

One change is a reviewed successor rather than a migration: appending the same
run of new conventional files to the end of both `persistent_paths` and
`shared_paths`, in the same order, with every other hashed coordinate unchanged
(port, `contract_id`, progress paths, source profile and original identity,
and every existing path in order). Core derives the predecessor from the
contract itself by removing that trailing run; no catalog record names it. At
most 63 files can be appended across a lineage, because one of at most 64 shared
paths must remain. Each appended path must be a file name with an extension,
must not be an executable companion name (`.dll`, `.so`, `.dylib`, `.bat`,
`.cmd`, `.ps1`, `.sh`, or `.exe` on Windows) on any declared platform, cannot be
the verified original, and must not equal, contain or sit inside an existing
persistent, shared or progress path. Removed, renamed, reordered, inserted or
re-scoped paths, directories, an appended path that is not shared, and any other
policy change remain refused migrations. Indexed definitions that append to a
policy require staged-source capability 34, so an older reader refuses the
entry instead of holding existing installations.

Archive data stays under the namespace its first policy established, so a
successor reads the predecessor's `<policy-sha256>` directory and older readers
keep their coordinates; a fresh successor library creates its own namespace,
which the predecessor does not read. Update, activation and reuse of a copy
beside an existing predecessor accept the successor after two read-only checks
against the active predecessor copy: its recorded package members and
executable companions must not cover an appended path, and any appended file
present both in its runtime and in canonical data must have identical bytes.
Differing copies hold the update with the `appended_settings_diverged`
failure, whose summary names the file and the installed and saved copies'
exact paths so the player can delete the one they do not want.
After the successor copy's ordinary data restore, an appended file the
predecessor runtime already wrote and canonical data lacks is copied into the
successor copy only. Canonical data gains it through that copy's later
collection, so an activation that fails afterwards leaves no canonical change,
and a retry keeps an identical earlier copy (different bytes hold). A non-file
object at an appended path, or a file larger than 16 MiB there, holds with the
`appended_settings_path_blocked` failure, which names the location. A successor package that itself ships a file
at an appended path holds the same way when the predecessor runtime also has
that file with different bytes. Rollback to a retained predecessor copy is
accepted: the predecessor maps only its own paths, and the successor's files
stay canonical and in the successor copy. Before the pointer moves, Core
records `.portcove-archive-data-baseline.json` in the predecessor copy with the
digests of its own files at the appended paths. A later forward switch treats
files still matching that baseline as stale: canonical data wins without a hold
and nothing is adopted. Only a file the predecessor changed after rollback can
hold.

Backups framed with a predecessor policy restore under any successor in its
lineage. A backup's framing is its namespace coordinate, and a successor keeps
the predecessor's namespace, so backups taken while the successor is active
carry the predecessor framing too. An appended file absent from such a restored
snapshot is therefore treated as outside its coverage: restore synchronization
leaves that file in place in every installed copy whose contract declares it,
instead of deleting it, and canonical data gains it again when the active
successor copy is next collected. Appended files the snapshot does contain are
restored normally. Before a
successor owns them, files at appended paths are unknown runtime files of the
predecessor copy: verification reports them and backups include them in their
unknown-file area, but collection and restore do not move them. A historical
`archive_data_transition_v1` predecessor first enters the lineage member whose
scope matches its creating contract, then follows the same successor rule.
Persistent file patterns are not available on partitioned routes, so only
exact files can be appended.

Common installation notices explain preservation, retained Versions and rollback.
When build-specific progress exists, automatic maintenance stages the candidate
for the player's activation decision without changing their update preference.
Backups retain producing archive identity independently of the partitioned data
policy. No-runtime backup/restore preserves opaque data without granting future
runtime or source authority. This route requires staged-source capability 27;
see [definition delivery](DEFINITION-DELIVERY.md) for reader fencing and reusable
source applicability.

For a reviewed historical predecessor, `archive_data_transition_v1` declares
its exact archive and creating-contract digest once. The existing explicit update
review offers the data transition with a distinct eligible successor and reports
extra temporary library capacity. It preserves the working predecessor and binds
its build-specific objects to their producing archive. Every retained copy must
match the reviewed predecessor; an unexpected older contract or changed data is
a specific hold, not an inferred compatibility grant. This optional transition
requires staged-source capability 28. Its separate data-only admission retains the
original source/execution authority and fences older readers; ordinary subsequent
releases use the stable policy without new predecessor records.

If fresh acquisition publishes a staged copy before its final data-compatibility
check refuses, the error includes `staged_install_id`: that copy and its files stay
registered, the active copy stays active, and activation and stage-only retries
repeat the actual-destination check. This is an ordinary retained staged copy,
not a new durable held-status type. Whole-library export/import continue using
historical retained authority, with no current-catalog-only ownership grant.

Managed PS1 launches regenerate `.portcove-psx-runtime.toml` from the verified
`game.toml` template and current verified disc paths for both source modes.
Core rewrites the `[game]` disc field from the verified sources. PSXRecomp
`7192402` kits declare both `disc` (disc 1) and the `discs` roster, which the
framework reads first; both are rewritten, `discs` with every verified disc and
`disc` with the first. A repeated key, or a field outside `[game]`, is refused.
Upstream launcher writes therefore affect a disposable copy; the template and
source identities remain checked. An edited generated copy is replaced before
it can become the next launch's source authority. This also accommodates
[Persona v0.1.1's controller-preference write](https://github.com/mstan/psxrecomp/blob/c0139b4538723ef1d297257f101db2958b8b39f3/runtime/src/main.cpp).
Persona declares its exact `keybinds.ini`, `disc.cfg` and `bios.cfg` preferences
as persistent, and `psx_freeze_heartbeat.json` as a disposable runtime output.
Its older runtime keeps those launcher files beside the executable without a
portable-mode environment override. Installations whose old manifests already
recorded keyboard preferences as immutable need a clean reinstall before those
bytes can be edited; an already modified immutable template also requires a
clean reinstall. Current declarations never authorize silently accepting those
changes to an existing manifest.

Use `runtime_mutable_file_patterns` only for reviewed disposable files whose
names vary inside the catalog-owned runtime working directory. Each rule has a
literal nonempty `prefix` and `suffix`; it is anchored to one filename, requires
at least one character between them, and never recurses or behaves as a general
glob. Matching files are omitted from immutable verification but are not
enumerated, backed up or restored. By contrast, `persistent_file_patterns` uses
the same bounded syntax for player-owned files that must participate in those
persistence operations. A current reader may opt a persistent pattern into
matching its concatenated prefix and suffix with `allow_empty_middle: true`.
It still matches regular files only and retains executable and critical-file
refusals. Indexed definition admission rejects the option until its semantics
can be negotiated with readers. Format-1 signed catalogs reject the option in
the payload and inherit it only for matching compiled patterns.
`runtime_mutable_paths` remains the exact-path form for
disposable runtime output. Catalog validation rejects overlapping or
duplicate rules and conflicts with executable, source, metadata, exact-runtime
or persistent declarations. This contract cannot claim files in roaming AppData
or another external user-profile directory; such state needs an upstream
redirect or a separately reviewed ownership capability.

`windows_runtime_path_policy: "printable-ascii-max-path"` declares a verified
upstream limitation for a Windows-only managed staged-source runtime, or a native
archive with Windows support and no original-source preparation or setup helpers. Core rejects
known unsuitable output roots before acquisition, and checks the selected executable
and its probe filename budget during readiness and again before preparation. The
requirement is retained with the installation and survives an output-folder move;
it grants no relocation or adoption permission. Source files may remain in their
original Unicode locations when the adapter passes a checked relative runtime copy.
This policy currently excludes external runtimes, setup executables and managed
build recipes. Native archives also check every authenticated package member at
its final destination; other declared platforms retain their existing behavior.
Independent definition entries must require staged-source template version11 or
native-portable version7, respectively. Absent policy retains the prior route contract; this is not a blanket
ASCII restriction or a claim that every other runtime supports Unicode paths.
Existing installations use their creating definition: a new catalog declaration
does not retrofit this guard into retained manifests. Review an existing supported
move/adoption route separately; never rewrite the historical definition to claim
that an old installation is protected.

Ghostship 3.0.0 writes its disposable extraction cache to `torch.hash.yml` and
rotates `logs/Ghostship.log` through `logs/Ghostship.10.log`. The catalog declares
those exact runtime outputs through the existing nonpersistent runtime-path
contract, now available to the libultraship portable adapter. Source, executable,
Portcove metadata and persistent-path overlap checks still apply. Other files in
`logs` remain subject to immutable
verification. Generated `sm64.o2r`, configuration, saves, screenshots and mods keep
their existing persistent ownership. This declaration does not grant gameplay
or platform qualification. The paths come from the tagged
[Ghostship engine](https://github.com/HarbourMasters/Ghostship/blob/deb091c29caff57dd986398087b058f16b11911e/src/port/Engine.cpp),
its pinned [logger](https://github.com/Kenix3/libultraship/blob/6b861a64d29d9fe95d100be228eb6d190231cc0d/src/ship/log/Logger.cpp),
and [Torch cache writer](https://github.com/HarbourMasters/Torch/blob/106621f0f0f9731b8739bec95227c2c5887492df/src/Companion.cpp).

2Ship2Harkinian 5.0.1 writes `imgui.ini` and `logs/2 Ship 2 Harkinian.log`
beside its Windows executable during a native session. The former is a player
preference; the latter is disposable diagnostic output. The pinned engine's
[rotating logger](https://github.com/Kenix3/libultraship/blob/7cb10226e7875ec48ceec2f841d00afd84eef964/src/ship/Context.cpp)
can also write ten numbered versions of that log. The optional
[time-splits save action](https://github.com/2ship2harkinian/2ship2harkinian/blob/8a24047fbce8915993804e7819f4df4fa591551f/mm/2s2h/Enhancements/Trackers/TimeSplits/TimeSplitsActions.cpp)
writes `2S2HTimeSplitData.json` in the same directory. The catalog owns the two
configuration files as persistent and the eleven exact log names as disposable
runtime output, matching the selected upstream
[generated-file exclusions](https://github.com/2ship2harkinian/2ship2harkinian/blob/8a24047fbce8915993804e7819f4df4fa591551f/.gitignore).
This qualifies new installs against those bounded files while retaining
immutable checks for recorded files, other log files and launch-sensitive
companions.
An installation created under the earlier catalog retains its original
definition and can still fail pre-launch integrity after these files appear;
the new catalog does not silently rewrite its admitted manifest. Preserve that
install and its data until a reviewed recovery or clean reinstall is completed.

### Author a port record

The procedure below describes the current repository workflow. The completed
[#245](https://github.com/boburning/portcove/issues/245) design is a foundation;
future protected publication remains owned by
[#246](https://github.com/boburning/portcove/issues/246). This contract does not
activate a publisher.

1. Capture or update the roadmap item and direct upstream evidence.
2. Search the per-ID authored records and Core adapters before adding behavior.
3. Prepare the listing and optional existing integration with the command below.
   Add the smallest safe shared capability only when the offered route needs it.
4. Run catalog and source/profile validation, release-resolution checks where
   acquisition is offered, and the lifecycle and platform checks for operations
   actually promised.
5. Record only the qualification evidence that actually passed.
6. Link the pull request to its issue and update Project status.

Catalog changes must preserve source identity, checksums, bounded archive
extraction, symlink refusal, persistent-data ownership, per-port locking,
atomic activation, rollback, credential boundaries, and executable trust. See
[ARCHITECTURE.md](ARCHITECTURE.md) and [PROJECT-GOVERNANCE.md](PROJECT-GOVERNANCE.md).

Managed ZIP and TAR extraction never creates a link. A symlink entry is written as a
regular copy of its target only when its relative target resolves, inside the same
archive and through at most eight links, to a regular file; absolute, escaping,
missing, directory, cyclic, overlong-chain and malformed targets refuse before any
write, and the copied bytes count toward the same size and compression-ratio limits.
A definition whose package relies on this declares `release.archive_file_links`,
which older readers refuse through [native capability 14](DEFINITION-DELIVERY.md). N64 recomp definitions with macOS app-bundle packages declare it and require [N64 capability 5](DEFINITION-DELIVERY.md). This covers the dylib version aliases
in macOS app bundles. A package whose whole payload is one ZIP or TAR.GZ file is unwrapped one
level through the same extractor on macOS and Linux routes that declare an executable. The exact upstream asset keeps its own identity,
and any other payload shape is unchanged. These are extraction facts, not native
Mac execution evidence.

A native package whose official archive stores its declared program without an
executable bit declares `release.grant_declared_executable`. After extraction on a
macOS or Linux route Core resolves the declared executable and sets execute permission
only when the file verifies as a binary for the platform: ELF64 little-endian
executable or shared-object for x86-64 on Linux, or a 64-bit Mach-O (or a universal
image of at most two slices with a matching one) for the Mac architecture. The check reads headers only, so a non-program shared object
of the right architecture also qualifies. An unmarked script, another
architecture, a link or a non-regular file refuses, a program the publisher already
marked executable is left unchanged, and Windows grants nothing. Older readers refuse
the declaration through [native capability 22](DEFINITION-DELIVERY.md) (libultraship 4 and generated-cache 2 for those adapters); other adapters
reject it. The check proves what kind of file is being trusted, not that it runs.

The embedded catalog uses schema 2. It contains reusable identities, logical
variants, tagged physical representations, explicitly scoped conjunctive digest
records, per-port game and BIOS contracts, validators, exact qualification facts,
and immutable evidence
references. Maintainers edit one record in
`crates/portcove-core/catalog/ports/<stable-id>.json`. Its format-1 `listing` owns
the stable ID, name, summary, public project URL and optional original title,
issue reference, release/setup links, setup guidance and artwork. An optional
`integration` owns the existing strict operational fields. Common identity and
presentation facts must not be repeated in that object. Integrated platform
facts remain in `integration`; the listing projection derives them. A listing
without an integration carries no managed operation or qualification claim.
Shared source identities, contracts, validators, evidence and qualification stay
in `catalog-shared.json`, preserving their existing order and scope.

General versions/update navigation derives the stable GitHub or GitLab releases
page from the existing upstream URL. A selected package's notes use that
candidate's exact observed release URL; no selected package means no claim of
selected-release notes. `setup_url`, manual setup help and historical qualification
links retain their deliberate version pins. Other providers fall back to a
clearly labeled project page rather than treating a historical release as current.
Do not edit release-specific evidence merely to refresh general navigation.
Core permits native browser handoff to the one canonical GitHub or GitLab release
index derived from an accepted project or release repository identity, including
retained and pending listing projections. Comparison is exact: extra queries,
fragments, download paths and foreign repositories need their own reviewed URL.
This navigation rule grants no package acquisition, registration or launch action.
Desktop hands off selected download notes after Core resolves the same release
and asset IDs and confirms the displayed release URL. Resuming a saved setup
uses the matching download record for its release notes and retained setup
links, even when the current directory describes a different package. Those
retained links require the saved setup identity.
Completing a user-selected setup or replacement carries the matching download's
release and asset IDs, filename and observed checksum into the registration.
Desktop and CLI show its release and filename as the last recorded setup
download. A later launch-details edit keeps that history. Launch and update
ownership continue to follow the selected external program and its registration.

### Choose a reusable authoring route

Optional authoring-only `route_facts_v1` supplies a bounded Windows prepared
player basename, executable-parent working folder, literal argument vector and
actual external data locations. For a NativePortable GitHub integration, managed
facts can supply one preparation action and exceptional warnings. The executable
must match the operational declaration. Specify either no Core source binding,
or a source profile with a nonempty `runtime_source_set` and explicit
`integration.presentation.manual_setup`. [Doom 3 Classic](../crates/portcove-core/catalog/ports/doom-3-classic-dhewm3.json)
shows the verified-originals form. Describe the upstream originals and how the
player supplies them in either form. Common
registration/ownership/removal, declared managed preservation and rollback
explanations come from `scripts/catalog-route-facts.mts`. Bespoke guide actions,
source/edition requirements and immediate warnings remain explicit. A staged-source
archive can use prepared-player facts for its independent external route. Its
managed presentation and source/data contract remain explicitly authored. No guide
paragraph or descriptive fact authorizes execution or data ownership.
Literal arguments preserve empty values, whitespace, repeated flags and order.
They use Core's existing limit of 64 arguments and 32 KiB total UTF-8, with NUL
refused. The fully escaped selector must also fit the existing concrete guide's
4096-byte instruction bound; oversized vectors receive an authoring diagnostic
before generation. Descriptive data-location labels keep separate validation.

Generation expands those facts into the existing concrete versioned guides for
Desktop, CLI and other consumers. Historical concrete guides remain exact; a new
common explanation cannot reinterpret a retained installation. The same ordinary
generation writes `route-enrollment.generated.json` and checked per-title Rust
test includes for the existing lifecycle harnesses. Generated entrypoints keep
each title independently bounded in nextest and call the same shared assertions.
Independent inventory checks refuse missing or duplicate entrypoints. They
execute every declared representative once and emit distinct
per-title outcomes, checking independently reviewed expected launch vectors or
accepted member observations. An ordinary fitting title needs no production Rust
or per-title test wrapper. Independent observations and custom behavioral tests
remain necessary where their scope differs from the shared route.
For a managed-native case, record the independently observed executable and
immutable members in the shared native lifecycle corpus. Set `runtime_folder`
to the archive folder prefix with a trailing slash, or to an empty string for a
root-level executable. The fixture inventory and archive builder reject a
nonempty prefix without its trailing slash. List immutable member paths relative to that prefix.
Enroll the stable ID, prepared executable and literal arguments, managed role and managed
literal arguments in the independent expectations. Each route has its own
argument vector, including an explicit empty vector when applicable. Review
those facts against the package and upstream
launch instructions before generating the entrypoints. The managed declaration
generates both the managed lifecycle and the independent prepared-copy test.
[Native lifecycle corpus](../crates/portcove-core/src/testdata/native-engine-adoption-2026-11-02.json),
[independent enrollment](../crates/portcove-core/src/testdata/route-enrollment-expectations.json).

Fixture-only enrollment edits select both route inventories and every generated
managed and prepared lifecycle case. The independent Windows archive inventory
selects its shared release-selection case. A change limited to the native
lifecycle corpus selects the retained native release-selection cases, retained
and generated managed lifecycle cases, and managed enrollment inventory.
Operational changes to authored title records still select the full Core
inventory. A diff limited to regular per-title files can use the layout
conversion check when every record moves to or from a maintained PSX or GBA
authoring projection and preserves the exact expanded definition and other
authored facts. The planner binds the proof to checkout bytes. Catalog
generation, catalog contract tests and the embedded Core invariant still run.
Mixed changes, raw Rust fixture inputs, and unproven conversions retain the
normal affected-test selection.

Optional authoring-only `gba_staged_archive_v1` expands the reviewed Windows
staged GitHub archive layout used by the upstream GBA picker. Record the
four-character game code used by the packaged diagnostics and whether the
runtime uses versioned mod packages. The projection supplies the shared
local paths, diagnostic names and mod policy. Keep the repository, channel,
asset and executable hints, original-file and BIOS requirements, and external
save locations explicit. Use a full integration for a different layout, such
as a player that writes variant-specific configuration or stores credentials.
Settings qualification also requires the explicit integration form.
The projection refuses duplicate path and mod policy fields. Core receives
and validates the same concrete contract as before.

`prepare-port.mts` proposes this family form when the reviewed diagnostic code
is unique and the expanded integration matches the explicit bytes.

Reuse the shared staging, declared-data preservation and rollback evidence
when the official Windows archive uses the reviewed picker, stays within its
tracked process lifetime and has the same writer and update ownership.
Independently check each title's package selection, executable, original
edition and effective write paths. Review changed lifetime, writer layout,
credentials or update ownership against the affected lifecycle operation.
The Ruby and Sapphire example shows when explicit variant and fallback paths
can use the same staged behavior. [Shared lifecycle evidence](qualification/gba-versioned-mod-preservation-2026-10-25.md),
[explicit-layout example](qualification/gba-ruby-sapphire-managed-2026-11-06.md).

Optional authoring-only `n64_recomp_persistence_v1` expands the reviewed
root-level N64Recomp persistence layout for managed GitHub packages. Use `true`
for the shared mod, save and settings paths with the declared
`runtime_source_filename`. A record whose player also writes a `config`
directory declares `config-directory`, which adds `config` after `saves`; one
whose player writes technical settings declares `technical-settings`, which
adds `technical.json` and `technical.json.bak` before the original file. The
variant is the record's declaration, not its identity. Keep the source profile,
ROM filename, repository, asset selectors and executable hints in the
integration. A nested layout, different provider, optional settings
declaration or different writer set uses an explicit integration, and the
refusal names the missing precondition. URL preparation proposes the variant
whose expanded integration reproduces the reviewed explicit bytes.

#### Retired single-upstream shorthands

Shorthands must expand by declared fields, never by a repository or identity
literal, so a new title that fits a mechanism needs data only. Eleven earlier
shorthands carried the facts of exactly one upstream: Aleph One pinned Windows,
Chocolate and Crispy Doom Windows persistence, Gen2Recomped persistence, the
BStone/DevilutionX managed profile, OpenGOAL setup, OpenMoHAA, OpenX, Raze,
ReflectionHLE and RSDKv4. Their records now author those integration fields
explicitly, with byte-identical generated output. `checkedAuthoredPort` refuses
the retired `*_v1` fields so a stale declaration cannot silently drop the
fields it used to supply. A GitHub-hosted Direct pin must be a canonical
`<project_url>/releases/download/<tag>/<file>` URL of the record's own project,
with no query or fragment.

The optional authoring-only `psx_managed_windows_v1` supplies the shared
launch and data layout for the reviewed Windows GitHub PSXRecomp kit and its
matching Linux x64 sibling when independently enrolled. Use the
[Tony Hawk’s Pro Skater 3 record](../crates/portcove-core/catalog/ports/alexbeav-tony-hawk-s-pro-skater-3-recomp.json)
as the example. Keep the release selector, generated executable basename,
original-disc profile and source contract explicit. Set the value to
`true` for a required retail SCPH-1001, SCPH-5552 or SCPH-5500 (Japan) BIOS
with its own profile and contract; the kit's `game.toml` names the BIOS
configuration it builds with.
When that configuration names one of these images and the route registers
another retail profile, Core refuses the build before anything is installed,
because older frameworks stage whichever image they are given.
[SCPH-5500 record](qualification/psxrecomp-7192402-scph5500-2026-11-13.md).
Use `"bundled-openbios"` when the reviewed kit supplies and supports OpenBIOS.
This projects the literal `--bios bios/openbios.bin` argument and rejects a
retail BIOS profile. Use `"split-mods"` for the reviewed dual-platform kits
with explicit retail SCPH-1001, SCPH-5552 or SCPH-5500 BIOS. Their player-owned mod paths
are `mods/installed`, `mods/packages`, `mods/.staging`, `mods/state.toml`,
`mods/state.toml.tmp` and `mods/texture-packs`. Each verified runtime version keeps `mods/bundled` and
its other build-provided files. The existing whole-`mods` forms keep their
original persistence scope. The split-mods form requires explicit selectors
with the same title prefix and the platform-specific `-windows-x64.zip` and
`-linux-x64.zip` suffixes. Use `"split-mods-no-crash-log"` for reviewed
single-disc kits with SCPH-1001 BIOS whose writer omits `psx_crash.txt`; the
release repository must be the listing project. Their remaining split-mods
fields are the same. The MediEvil and Mortal Kombat 4 routes, whose writers
also keep `diagnostics-location.txt`, author their complete integrations
explicitly.
`"split-mods-openbios"` combines those split mod
paths and selectors with the bundled OpenBIOS argument and refuses a retail
BIOS profile, for reviewed dual-platform kits that ship and support OpenBIOS.
Use `"split-mods-overlay-directory"` for the reviewed single-disc retail kits
whose writer contract keeps the `overlay-captures` directory without a separate
`settings.toml.bad` path, the root-level overlay JSON, sidecar and addendum paths,
or the overlay temporary-file pattern. The dual-platform selector, BIOS and
split mod rules still apply. For the reviewed retail multidisc split-mods kits,
keep `runtime-discs`, `psx-settings-selected` and `psx-raw-set` explicit in the
integration.

Use `"technically-computers"` for GitHub kits with the TechnicallyComputers
layout: Windows x64, Intel macOS and Apple silicon macOS platforms in that
order with the `windows-x64`, `macos-x64` and `macos-arm64` selectors. This
variant supplies only the `build-portcove` runtime root and eight persistent
paths. Each record retains its repository, asset selectors, executable hints,
original disc profile, guide and qualification. A different writer layout uses
explicit fields. Kits that declare their `build-portcove` runtime root and
`runtime_mutable_paths` use `"technically-computers-input-files"` for the same
eight persistent paths plus `input.ini` and `keybinds.ini`. A raw disc set also
declares its `runtime-discs` source, `psx-raw-set` materialization and launch
arguments. No variant depends on the kit's repository or identity; a refusal
names the missing precondition.

A Linux sibling uses the same generated player basename without `.exe`, its
own asset selector and artifact-bound source applicability.
Preserve any separate upstream setup guide. The projection
writes the `build-portcove` working coordinates, `--no-launcher`, overlay
environment, owned save/settings/mod paths, and disposable diagnostic paths.
It refuses duplicate fields. A different writer layout or setup contract
needs the explicit form and applicable qualification.

`prepare-port.mts` proposes the compact PSX form automatically when its
expanded integration matches the explicit declaration byte for byte. A
different layout, selector or setting stays explicit.

The stock Diablo Windows v0.1.6 kit enumerates bundled mod manifests using
legacy Windows paths. Core checks the longest bundled manifest at the proposed
installation or relocation destination and again before launch. The rule follows
the reviewed archive digest into retained installations. The same stock player
reached the game on a shorter managed path. [Windows path receipt](https://github.com/boburning/portcove/issues/435#issuecomment-6899919050)

Core's managed PS1 builder runs with `--no-toolchain-download` and with
`HTTPS_PROXY` and `HTTP_PROXY` set to a closed local address. PSXRecomp
`7192402` stages an overlay toolchain on every rebuild by downloading Python
(and building tcc on Linux) whatever that flag says. Core admits no executable
it has not verified, so those requests are refused, the kit logs the failure
and finishes the build, and the player interprets overlays. A build that still
leaves any file in `overlay_toolchain` or `.cache/overlay-toolchain` fails
before anything is installed or changed.
[Framework review](qualification/psxrecomp-7192402-builder-downloads-2026-11-13.md).

Some PSXRecomp kits declare the pinned libwebp source archive without
including it. For the reviewed pin, Portcove downloads and verifies that
archive during managed preparation and puts it in the kit's declared
`third_party` folder before starting the builder. The existing builder network
restrictions still apply. Kits that already include the archive keep their
existing file and verification path.
On Windows the admitted managed builder retains up to 2,048 exact process
lifetimes. The supervisor waits on those exact handles and reconciles the
complete job process count before it publishes or cleans up staging.
PSXRecomp `d5cae379` differs from `7192402` only in GPU rendering fixes and
test-only build files, so the same builder rules apply to kits that pin it.
[d5cae379 requalification](qualification/psxrecomp-d5cae379-requalification-2026-11-13.md).

A managed PS1 `psx-raw-set` source profile gives every disc exactly one
positive track count; a disc that may have one or two tracks (`[1, 2]`) is
refused. Like a single disc, each disc binds only its data-track SHA-1 and that
exact count. Audio tracks are not hash-bound: the CHD storage identity is
checked before and after extraction, and the installation manifest covers
every file of the materialized set. Installation re-checks each extracted cue's
TRACK count against its disc's count, keeps the data track as `disc-NN.bin`
(the file the launch roster pairs with `disc-NN.cue`), names every other track
`disc-NN-tTT.bin` and rewrites each FILE line in order, keeping INDEX, PREGAP
and POSTGAP lines. A sheet whose FILE and TRACK entries do not pair one to one,
or that names an unsafe or missing file, refuses before anything is activated.
An indexed entry whose set has a disc with more than one track requires
managed PS1 capability version 4.
[Multi-track record](qualification/psx-multi-track-disc-sets-2026-11-13.md).

A `psx-raw-set` integration may declare `launch_disc_choice:
"psx-settings-selected"` after source review shows that its runtime reads the
1-based `[disc] selected` entry of the `settings.toml` beside the player and
derives both the mounted disc and the save-state disc scope from it, as the
PSXRecomp runtime documents for external launchers. The declaration needs the
managed PS1 adapter, a runtime subdirectory and a persistent `settings.toml`.
The retained source profile's disc count is then the launch disc choice that
`status` reports as `readiness.selectable_discs`. A choice is written as that
setting in the restored settings after every other launch check, changing only
the `selected` value or adding that one line or a `[disc]` table, and is
captured with the session
like a choice made in the upstream launcher. Settings the editor cannot place
exactly refuse the choice and leave the file unchanged. Portcove never passes
`--disc`: the runtime then mounts that disc but keeps the previous save-state
disc scope. Desktop's detail Play defaults to **Saved disc**, which sends no
choice. Without the declaration, as for Final Fantasy VII whose prebuilt
runtime has no reviewed source, no choice is offered. Because the field joins
the retained operational identity, an existing installation keeps its retained
definition and offers the choice only after it is reinstalled or updated.

Reuse the PSX adapter’s preparation, preservation, and recovery evidence where
the kit uses `psxrecomp/psxrecomp_cli.py` and the `psx-runtime` target, the same
generated-player lifetime, and the same data layout. The
[controlled PSX progression](../crates/portcove-core/src/runtime_tests/psx_progression.rs)
exercises install and update with registered inputs. Independently inspect the selected kit,
disc and BIOS requirements, generated executable, and any title-specific
writers. Enroll the independently observed disc and generated-player facts
under `managed_psx` in the shared Windows archive fixture. A change to the
build tools, launch lifetime, or data ownership calls for reassessing the
affected operation. Exact PSX source evidence stays attached to the observed
artifact. A compatible successor can use the same package rules without
inheriting that artifact’s source evidence. Run the Core repository proposal
inspection before delivery. [Reviewed seven-title precedent](https://github.com/boburning/portcove/pull/4676).

For a new compatible-release selection case, add the stable title ID to
`cases` in the shared Windows archive fixture. Set its `inventory` to a key
in `inventories` with at least two releases in oldest-to-newest order.
Record one independently identified exact asset name per release in
`selected_assets`. Set `channel` for a route that selects outside the default
stable channel. Keep the full observed release inventories and label
controlled successors in the title evidence. Reuse an inventory when another
title selects from the same releases. Use `other_zip_assets` to identify
competing ZIPs outside the enrolled routes by inventory, zero-based release
index and exact member name. The inventory check requires every ZIP to be
classified exactly once as selected or competing. Several titles may select the
same archive. Each title keeps independent release selection assertions and
unique enrollment, while selected asset coverage is deduplicated. Generated route entrypoints and shared lifecycle
fixtures separately cover registration, managed runtime replacement and data
ownership. Ordinary compatible successors use the unchanged authored selectors.
[Shared release-selection fixture](../crates/portcove-core/src/testdata/windows-archive-release-selection.json).
`node scripts/catalog-selection-enrollment.mts` transcribes the named releases
from a configured-upstream observation into an inventory and classifies its
remaining ZIPs. Pass the independently identified asset for each release and
platform with `--select`; the command previews by default and writes with
`--write`.

When a managed route replaces a strict prepared-only definition, keep the exact
previous port in a dated `*-retained-selected-YYYY-MM-DD.json` fixture and add
its ID and fixture basename to `retained-prepared-enrollment.json` in Core's
testdata directory. The generator enrolls the existing retained registration,
restart, Play and removal harness for that ID. Older rows can keep a historical
test name. New rows use the port ID. The independent current-route expectations
remain separate from the retained creating definition.

The retained native-engine selection cases keep their controlled successor
inventories and refusal filenames in the
[native-engine scenario fixture](../crates/portcove-core/src/testdata/native-engine-release-scenarios.json).
Use the exact observed package name as the player key. Shared repositories can
reuse one successor inventory while checking distinct expected players.

Optional authoring-only `package_observation_v1` retains an exact previously
accepted package/player inspection. Ordinary `prepare-port` consumes its receipt
with paired `--package-observation <json>` and
`--package-observation-reference <repository-relative-path>` options. The title,
upstream, independently expected archive digest, complete member CRC and bounded
header must identify the unique declared prepared player. Installer headers do
not substitute for an unobserved child; incomplete or ambiguous coverage refuses.
This consumes existing accepted evidence and does not authenticate an unsigned
report, download or execute a player, or grant publication authority.

For listing-only prepared routes the selected AMD64 PE header derives descriptive
Windows x86-64 metadata. The authored record must not also repeat `platforms`.
Other header architectures remain unknown; managed platform authority stays in
the integration. A changed selected executable, working folder, literal arguments
or upstream makes the retained observation inapplicable, without blocking an
otherwise eligible runtime. Accepted bytes changing under a retained package or
member identity refuse even when an explicit replacement record omits or replaces
the old observation. A distinct upstream artifact gets its own binding.

The existing private preparation checkpoint reuses an unchanged projection bound
to the artifact, member, selected-player contract and actual validator module
bytes. Relevant changes invalidate that result; unrelated prose, data-location
narration or receipt notes do not require another package inspection. Receipts
retain their original evidence provenance and scope. Ordinary generation also
writes `accepted-route-expectations.generated.json` from applicable accepted
member observations and their bound launch vectors, feeding the same lifecycle
harness without a second per-title expectations edit. Unknown header architecture
still enrolls its applicable prepared-player contract. A changed selection contract
needs a correspondingly accepted observation before authoring generation; it
cannot accidentally disappear from the lifecycle inventory. Probe execution remains
separate from upstream binary execution, dependency/gameplay and Supported
qualification. Historical concrete definitions and prior receipts remain intact.
GitHub owner/repository casing alone preserves applicable evidence and checkpoint
reuse. Historical observations keep their exact repository spelling, selection
hash and scope; a genuinely different repository or selected-player contract
still needs newly applicable evidence. Changes to either shared authoring module
select the existing generator's actual output-integrity check in local/hosted CI.

### Describe the game and its artwork

Optional listing `original_game` is a version-1 descriptive identity: an explicitly
reviewed stable `id`, one to eight public HTTPS `evidence_urls`, and up to sixteen
`source_editions`. Each edition has its own stable `id`, descriptive `title`,
optional original `system` slug and evidence URLs. For example `nintendo-64` and
`xbox-360` identify source systems, independently of the port's Windows/Linux/macOS
targets. Multiple required or accepted editions remain explicit. An absent game
identity never groups entries by title similarity; absent editions/system mean
**Not specified**, never PC. Shared game IDs group presentation only and never
replace port, installed, pending-setup, source-contract or path identities.

The same optional object projects into operational `presentation.original_game`.
Descriptive directories containing it use listing format 3; current readers retain
formats 1 and 2. Earlier accepted records without metadata stay valid. Authoring
checks bound identifiers, text, edition counts and HTTPS provenance; Core validates
the projected fields without granting installation, execution or media rights.
Game and edition IDs are maintained explicitly, not inferred from project names,
artwork mappings or a frozen prototype registry. Unknown editions remain unknown
until their own upstream evidence has been reviewed.

Repository authoring also accepts an optional top-level `original_game_review` with
`disposition` (`unresolved`, `multi-game`, `helper`, `framework` or `separate`), a
specific `reason`, and one to eight public HTTPS `evidence_urls`. This review stays
outside operational definitions and listings. Use it to explain missing identity
evidence, an engine/collection scope, or deliberate separation from a plausible
same-name family. A clear single-game relationship uses the existing
`listing.original_game`; a different source edition or implementation alone is
not a reason to invent another game ID. Keep established IDs because Saved,
preferred implementations and original-game media already refer to them.

`node scripts/catalog-game-identity.mts report` derives a complete authored-port
report, including source hashes, retained source/lineage facts, title candidates,
partial/conflicting mappings and generated-definition/listing identity drift.
Maintenance universe entries separately expose canonical game ID and retained
lineage target. Neither candidate similarity nor a lineage target assigns a game.
Implementation entries in that universe do not inflate port coverage counts.

For descriptive batches, use the tool's `apply --assignments <file>` dry-run,
then `--write` after relationship review. Each assignment binds the complete
input-file SHA-256 and explicitly supplies `original_game`,
`original_game_title` and/or `original_game_review`. Existing IDs cannot be
replaced through this helper. It preflights the entire catalog and every changed
projection before writing, retains partial-publication recovery evidence, and
preserves unrelated source, runtime and lineage fields. Regenerate with
`node scripts/generate-catalog.mts`; identity-only work does not need another
release, package, artwork or gameplay investigation when applicable evidence is
already retained. Preparation reports missing grouping decisions without
pretending that preliminary research admits a mapping; promotion requires the
decision. The standard generator’s `--check` gate requires every current authored
record to carry a game identity or explicit review, checks known-family candidates
for conflicting new IDs, and refuses unexplained partial lineage groups.
Older accepted catalogs and installations keep their optional-metadata
compatibility. Repeated edition IDs are checked within their original-game scope;
conflicting specified systems refuse authoring, while naming/provenance aliases
and unspecified edition details remain valid.

Optional authored `media` carries at most two `header`, two `key_art`, two `logo`
and eight `screenshot` assets through the same listing and operational presentation
projection. Identity roles permit one candidate per exact subject. Every
asset declares its exact port or authored original-game plus source-edition ID,
caption, digest, dimensions, image/source URLs, attribution, a supported license
identifier and `rights_url` evidence. Reviewers inspect the source and rights
evidence; metadata admission validates shape and bounds, not a legal grant. A
parent project license alone is not distribution consent. No third-party files
are copied merely to fill a gallery.

Legacy header/screenshot media requires listing format 3. Game key art/logos,
IGDB image metadata, explicit `edition_neutral` evidence or a second header require
format 5; current readers retain formats 1–4. New optional fields preserve old
records, not old strict readers' ability to consume new fields or enum values.
Normal audience/reader compatibility review remains required before publication.
Typed IGDB backgrounds use the existing `header` role with an `artwork` record
positively classified as Key Art Without Logo and a fit of at least 3:2.
Typed screenshots use `screenshot` and its distinct IGDB endpoint identity.
Both use the bounded `720p` PNG derivative. These records require directory
format 13. Author them in the port listing. Strict operational packages,
retained user-selected runtime contracts, pending downloads and exports through
format 12 omit these new records while preserving legacy media.
Legacy strict presentation with
no `media` field may use reviewed directory media for the same exact identity;
an explicit empty array clears it. An existing local artwork override takes
precedence for the header, including its unavailable state; screenshots remain
authored read-only media. Image retrieval accepts only pinned raw GitHub commit
URLs, the IGDB image CDN and Wikimedia Commons, with no redirects, URL queries or
credentials. Cached `.image` originals share the existing disposable 64 MiB
artwork cache and bounded decoding work; local overrides remain separate.

Game details and Continue use a suitable admitted logo, then the existing Cover
choice, then the game title. For automatic hero logos and backgrounds, Desktop tries exact port artwork
before artwork specific to the verified edition, then uses reviewed
edition-neutral artwork as a fallback. An offered original edition is not a selected edition: every
media role requires actual applicable edition context or explicitly reviewed
`edition_neutral: true`; absence remains unknown. Backgrounds and screenshots
resolve independently, and a portrait cover is never stretched into a banner.
Reviewed format-14 bindings connect an original release to the exact source
game, variant and representation. Continue and game details can check one
visible registered source within a bounded read and use its current exact
match. An active installation uses that match only when its effective launch
can use the exact default registration. A different setup original, a retained
release that can use another saved original, or an unresolved release-specific
input uses the neutral fallback. Prepared runtimes without an exact
installed-source identity use the same fallback. The full
saved-file check remains available when the bounded read cannot verify a file
set. Players can use **Screenshot source** to view reviewed screenshots for
an original release.
This choice applies only to the gallery. Exact port media and the Cover and
text fallbacks remain available. Offered editions and similar ID strings do not
establish a selected source edition.

Maintainer `--prepare-artwork`/`--prepare-proposal` can additionally use
`--hero-media igdb` with the existing identity facts, private credentials and Core
image validator. It queries `/v4/logos`, `/v4/artworks` and `/v4/screenshots` through
the same paced, bounded authenticated transport. Key art and backgrounds share the
artwork query for the exact game. Key art requires a positive `image_type.id/name`
classification. A background specifically requires Key Art Without Logo and a
decoded image at least 3:2. An original-game screenshot identifies its subject in
the caption. Source image-type IDs are observed rather than hard-coded.

The optional image-type inventory uses IGDB's maximum 500-record page and a
separate one-record overflow query when the page is full. Overflow, malformed
responses and provider failures remain unknown; they never establish missing key
art. Role preparation classifies each image using its expanded `image_type.id/name`
relationship and does not require a separate inventory request.
Original identity facts bind `source_edition_id` explicitly. Optional
`hero_media_edition_neutral` records reviewed applicability for logo and key art.
Proposed backgrounds and screenshots retain their exact edition binding.
Image records are bound to the verified game ID before download.
Fit variants are PNG `logo_med_2x` and `720p`, with Core content validation, finite
candidate chains and independent role failures. Preparation may fill a missing
background and propose one screenshot when a subject has none. It preserves
reviewed scenes and respects catalog role limits. Exact HTTP 410 observations sweep
all candidate references and prevent batch reselection; failed or incomplete
requests do not establish absence or withdrawal.

The artwork evidence includes background and screenshot coverage by port,
original release and IGDB game identity. It records existing catalog images,
fresh proposals and exact observed withdrawals separately. An empty provider
inventory is missing evidence for that role in that provider. A failed,
incomplete or unrun query remains unknown. Conflicting provider identities
stay visible for review. The default report also retains listing-only entries
outside the proposal input, including their already reviewed media.

Preparation proposes remote URLs, provenance, hashes and provider terms; it grants no admission, signing, publication
or permission to bundle/export image payloads. `LicenseRef-IGDB-Terms` identifies
provider access terms, not a permissive copyright license.

For registration-only routes, use `external_registration_v1: true` with the
`user-prepared` provider, the `staged-source-portable` adapter and the declared
platforms. The generator creates the user-selected registration contract for each
platform. Keep the original-file instructions, package preparation, working
folder, and player or upstream ownership in the authored record. Use explicit
`user_prepared` entries for accepted packages and per-platform distinctions.
The CPS2Recomp routes use this shared registration form.

### Regenerate catalog projections

`node scripts/generate-catalog.mts` deterministically assembles these sources into
the embedded `catalog.json` and `listings.json`, plus the generated route-enrollment
and test-data projections. All are generated outputs, and `--check` refuses a stale
projection. There is no separate committed authoring copy of `catalog.json`: it
duplicated the embedded catalog byte for byte, and keeping it doubled every
catalog conflict. Fixtures that need an editable aggregate copy `catalog.json`
into scratch space.
Filename/ID disagreement, duplicate IDs or JSON keys and a second shared port authority are
refused. The migrated records retain their established order; new records sort
by stable ID. Unknown retained operational metadata and ordered arrays remain
unchanged. Never hand-merge the generated aggregates. After a rebase or merge,
resolve and stage any conflicted authored sources (`ports/`, `catalog-shared.json`),
then run `node scripts/catalog-staged-check.mts --resolve-conflicts`: it regenerates
every aggregate from those sources and stages the result, and refuses while any other
path is still unmerged. A Git merge driver cannot replace this step, because a driver
sees one file at a time before the merged sources exist and is ignored by hosted merges.
`generate-catalog.mts --check` stays the required consistency gate.
Core owns the temporary
schema-1 compatibility projection required by the existing matcher and rejects
any conflicting projection supplied by catalog input. The deterministic
historical migration is no longer a current authoring path. It reads the frozen
`catalog-schema1-fixture.json` and checks only the frozen
`catalog-schema2-migration-fixture.json`; current ports, evidence, and
qualification records must not be added to that migration.

#### Check the generated operational catalog

After regenerating for a direct edit to a strict integration or its listing
summary, check and inspect the final embedded catalog before pushing. Use the same trusted
CLI that preparation accepts as `--validator-cli`.

```sh
node scripts/generate-catalog.mts --check
TRUSTED_PORTCOVE_CLI --technical-details catalog inspect-proposal --repository-authoring crates/portcove-core/catalog/catalog.json
```

Replace `TRUSTED_PORTCOVE_CLI` with the path to the executable. A successful
inspection covers the exact generated bytes and checks that every strict port
has an original game title and an outcome summary.
Describe the player outcome in the summary and put route and support details in
their structured fields. The staged coherence check compares projections.
Core inspection also validates the declarations and summary convention.
Reuse a successful preparation receipt for the same exact bytes and
repository-authoring mode when its JSON inspection scope includes
`repository-original-game-title-policy`. Use a CLI with that scope to check
the original-game title when an earlier receipt covers only summaries.

#### Prepare a new or updated record

Shared upstream families retain independent per-ID records. The authoring tests
compare Raze's platform, profile and update guide facts and Namco's common upstream
and platform links. Original-file requirements, canonical issues, identities and
independently reviewed acquisition restrictions stay local to each record.

```text
node scripts/prepare-port.mts --issue 156 --output-dir /path/to/preparation
node scripts/prepare-port.mts --project https://github.com/owner/project --id stable-id --name "Project name" --output-dir /path/to/preparation
node scripts/prepare-port.mts --project https://github.com/owner/project --original-game /path/to/game-identity.json --output-dir /path/to/preparation
node scripts/prepare-port.mts --record /path/to/stable-id.json --route download --release-tag v1.2 --validator-cli TRUSTED_PORTCOVE_CLI --output-dir /path/to/preparation
node scripts/prepare-port.mts --listing-observations /path/to/catalog-upstream-observations/source.json --validator-cli TRUSTED_PORTCOVE_CLI --output-dir /path/to/observation-preparation
```

The command accepts a canonical Portcove issue number/URL, a direct public
project URL or a reviewed authored record. It refuses conflicting stable IDs or
unreviewed origin changes and asks for a stable ID when a shared upstream is ambiguous.
A reviewed `--record` can append the lineage transition described below. Supply a
non-GitHub project's reviewed `--id`, `--name` and optional `--summary`; no generic
web scrape is required. A listing needs identity and origin, not a save audit,
release history, README or resolved tag. GitHub listing collection reads repository
metadata only. `--route download` collects one 20-release candidate window or the
explicit `--release-tag` and at most two 100-asset pages. Truncated or unavailable
assets remain Unknown. Metadata never supplies package authenticity or executable
acceptance.

The `--original-game` input uses the same reviewed object as
`listing.original_game` in an authored record. It carries the stable game ID,
evidence URLs and identified source editions. Paired with the official project
URL, it starts issue-free preparation and collects the initial bounded GitHub
release window by default. Use `--route listing` for identity-only preparation.
When GitHub confirms the repository identity, the proposal records its
immutable ID as the initial lineage. GitHub URL aliases reuse the existing
authored origin. A repository ID already recorded under a different project
URL needs lineage review before it can move.
Include `--record` with the same project URL and reviewed game identity to
prepare an already-reviewed operational contract. If the record has initial
lineage, its GitHub repository ID must match the observed repository. Existing
lineage and issue assignments stay bound to their catalog records. A new
GitHub-managed route starts from its official project repository.
For an issue-free project URL, a unique reviewed game ID and exact set of
source edition IDs selects the existing listing. Its full reviewed identity
and evidence must still match. Use `--id` to disambiguate identical siblings,
unbound legacy listings, or overlapping or unspecified editions of the same game.
A distinct game or disjoint, specified editions of the same game can start a
separate listing at the same upstream URL with a deterministic ID.
For a non-GitHub project, supply `--name` if the game identity has no single
source edition to name the listing. Resolving a different previously reviewed
game or edition requires a reviewed record edit. The observed release window
is evidence for assessing a route and does not declare one.

`--listing-observations` consumes a retained source handoff from the existing
catalog observer. It prepares complete canonical records through the same
projection, compatibility, Core-inspection and immutable-checkpoint path, without
provider requests or artwork refresh. Only `listing.upstream_observation` changes;
authored setup, acquisition restrictions, integration contracts, artwork and pin
maintenance remain with their existing owners. The handoff must match the current
declaration and, after any observation has been accepted, its exact observation
preimage. An older proposal cannot erase a later accepted snapshot. Legacy
handoffs without preimages work only before the first accepted observation.
Prepared records remain unsigned proposals for normal catalog review and existing
protected delivery. The receipt preserves the handoff and its semantic digest;
Core inspection is reported as pending when no compatible validator is supplied.

When a record names a canonical issue, `canonical_preparation` points to its exact
retained specification in `files.upstream`, with the observed timestamp and UTF-8
body SHA-256, or explicitly says that it was not observed. Read the complete
specification and relevant Roadmap context before deciding route, lineage,
acquisition conditions or deferrals. `--issue` uses the existing bounded issue
read; record/project preparation does not gain a new request or approval gate.
This feedback does not infer permission, a hold, support or ownership from prose.
An already published package and technical fit do not resolve an existing named
condition. Carry a reviewed operation condition through the existing
[acquisition restrictions](#acquisition-restrictions) where applicable.

For a proposed `native-portable` record, the completion receipt also shows literal
package-hint matches among the supported ZIP/tar.gz/tgz archives for each declared platform, whether each matching asset has
a published SHA-256, and whether the selected release's asset enumeration is
complete. Resolve missing or ambiguous matches before acquisition review. This is
authoring feedback, not a second package selector or a capability certificate.
Review the executable headers and launch folder, then the runtime's actual writes
and update behavior. Include compatible original inputs, generated data, mods,
settings and relevant logs in the declared preservation contract. An empty
contract is useful when evidence establishes external storage; describe that
location and its backup limits, and classify the main saves/settings as
`external-user-owned`. Inspect emitted writes beyond the save folder, including
first-run failure instructions, preference exports, registry settings and mod
state. A self-updater without a qualifying upstream switch (see
[managed native portable packages](#managed-native-portable-packages)), or a setup
kit that regenerates version-dependent runtime code, needs the appropriate
existing integration or non-owning handoff. Keep the player's installed contract unchanged when adding a
new route.

The owned output directory is a resumable preparation checkpoint. Reuse it for
several IDs sharing a repository to reuse endpoint observations. Collection is
bounded to 12 HTTP requests including redirects, 8 MiB and two minutes per call.
For a listing-only download, a reviewed `release_url` may identify a related
upstream setup launcher while `project_url`, stable ID and canonical issue keep
the game identity. Preparation records that public release repository separately
and verifies release/asset provenance within the same budget and cache. The URL's
tag path does not pin a version; `--release-tag` selects the exact observation.
Managed package feedback uses the operational release specification instead of
an optional listing helper. A provider outside the bounded GitHub collector
remains explicitly unobserved; it never falls back to a different repository.
Repository observations expire after 24 hours; issue/release/asset observations
after one hour. Failed refreshes retain prior observations separately and do not
report them as current; provider backoff survives resume. Malformed checkpoints
are preserved and refused. A lock refuses concurrent writers to the same
checkpoint. Interrupted locks require verifying the prior preparer has stopped
before removing only that checkpoint's `active.lock` directory.

Artwork preparation runs automatically for the selected ID. Reviewed
`listing.original_game_title` supplies a name-only underlying-game declaration
with the listing's project URL as evidence. Optional `--identities` overrides that
default; no IGDB game, slug or platform IDs are guessed. `--credentials-file` and
the established maintainer configuration supply provider credentials. Missing
credentials, ambiguity or provider failure produce an independently retryable
generated fallback. Unchanged accepted mappings remain reusable before lookup.
Single-port and selected artwork batches share per-title checkpoints. The selected
declaration, applicable accepted mappings, identity inputs, artwork tools and
validator determine reuse. A resumed proposal assembles and checks the current
full catalog. Reused artwork evidence identifies previously checked bytes.
Use a fresh checkpoint with the existing artwork refresh route, or use due
maintenance, to check current provider bytes for an accepted title. Earlier whole-catalog single-port receipts remain historical
evidence. The first run on the new cache can require a lookup for a cover that
has yet to be accepted. Existing accepted covers and upstream observation
checkpoints are still usable offline. Operational changes require `--validator-cli`; captured Core
`inspect-proposal --repository-authoring` checks their exact assembled bytes
and applies the same outcome-summary convention as embedded-catalog CI. Use a
validator built from a checkout that supports this flag. Whenever that CLI is
supplied, `catalog inspect-listings --path` also validates the generated listing
document, and its returned document must match the exact input semantics.
Successful receipts bind input bytes and validator identity and survive resume.
Without a CLI, listing-only preparation reports Core inspection as pending.
Ordinary CI remains the final catalog/listing validation boundary.

The concise completion receipt links proposed per-ID files, full generated
projections, upstream facts, cover outcomes, Core checks and independent
compatibility review. `preparation_costs` records monotonic elapsed time and its
boundary, including provider/subprocess waiting and excluding final completion
writing. This measures preparation, not authoring effort, gameplay or delivery.
Files are content addressed; unchanged reruns do not create
duplicate authored records or alter accepted sources. Copy reviewed proposed
records into `catalog/ports`, regenerate, and complete normal review and delivery.
Preparation does not download or run packages, post issue comments, install an
unsigned catalog, publish a feed or establish actual user delivery. A malformed
candidate does not replace previously prepared records. Keep discovery listing,
accepted executable behavior and published client/catalog delivery separate.

Current embedded ports include an additive `presentation` object for installation
method, required game/BIOS labels, verification method, and saves/settings
behavior. The authored integration records these facts beside the
same adapter and source-contract authority, and core rejects labels or verification methods
that disagree with those bindings. Existing platform, channel, support,
upstream-state, and qualification fields remain the structured authority for
those facts. Older catalogs may omit presentation and remain readable; clients
must report the missing detail instead of inferring it from an adapter ID.
`original_game_title` and optional `variant_label` are reviewed descriptive
presentation metadata. They do not change the project `name`, port/source IDs,
release selection, support or qualification, and never group implementations.
Current entries provide a recognizable game title; retained and older definitions
may omit it and display their project name instead. A variant may describe an
edition, prototype or original-platform distinction, without widening the source
contract. Empty, padded or control-bearing display text is rejected.
Signed format 1 may update presentation without changing its frozen execution,
source, persistence, or installed-code contracts.
Summaries remain one outcome sentence and do not duplicate channel, platform,
verification, setup, or storage claims.

`catalog-schema1-fixture.json` preserves the full pre-migration document and
`catalog-schema2-migration-fixture.json` preserves its reviewed historical output, while
`catalog-schema1-admission-baseline.json` fingerprints every source profile and
the complete port/profile/adapter binding set. Tests compare every projected
profile and port definition to that frozen input. The reviewed
Bomberman Party Edition correction records raw MODE2/2352 and cooked ISO as two
physical alternatives using the upstream contract at commit
`0aef0b66186b3f8f29d1bd9a3ba15b6307739c7b`; the compatibility projection keeps
the old matcher boundary unchanged until the shared schema-2 inspector lands.

The same migration records the reviewed versioned N64 contracts without
broadening that temporary matcher: Ghostship 2.0.0 (US and Japanese), Lighthouse
1.1.0 (US revisions 0 and 1, PAL, and Japanese), Ship of Harkinian 9.2.3,
2Ship2Harkinian 5.0.1, Zelda 64: Recompiled 1.2.2, Starship 2.0.0's selected US
revisions, and Banjo: Recompiled 1.0.2. Each contract points to its immutable
upstream commit and selects variants from the shared game identity. Transitional
`legacy_projection_only` variants preserve schema-1 matching and cannot be
selected by a schema-2 contract.

The core source inspector matches ordinary-file and cartridge-ZIP observations
against schema 2. It records original-container, original-file or archive-member,
normalized-content, and canonical N64 big-endian digests separately. Every
digest present in one identity must match; representations remain alternatives,
and multiple matching representations are an ambiguity rather than an automatic
choice. Extension-only compatibility can pass existing structural admission but
is never reported by discovery as an exact identity.

An admitted cartridge archive member may be copied unchanged to a different fixed
runtime filename, such as `game.md` inside a ZIP becoming `game.bin`. The source
representation must explicitly admit that member extension; the runtime filename
does not broaden source admission. Preparation binds both the outer ZIP identity
and the checked member's name, size and SHA-256, and freshly verifies cached
runtime bytes. This is exact byte copying, not interleaving or header conversion.
Registrations without structured member observations retain legacy selection
until checked again. The bounded ZIP32 source-reader limits and unsupported
container recovery are documented in the architecture contract.

For an `archive-member` representation, `extensions` is matched against the
decompressed original's extension, just like `member_extensions`; the reader
recognizes the ZIP container separately. For example, an unchanged Genesis
original stored as `.bin` or `.md` uses those extensions in both lists and
`archive-member` digest scope. Putting `zip` in `extensions` does not admit a
`.md` member. The outer ZIP hash is a container observation, never the expected
original-byte identity.

File-set representations match only when every declared member has exactly one
top-level filename match and one conjunctive digest identity. Directory
symlinks and nested or traversal-shaped ZIP entries cannot satisfy a member.
Observed member facts remain available separately from the aggregate identity.

## Admission decisions and protected publication target

Operation eligibility is independent of publisher/source trust, artifact
integrity, game-file compatibility, and evidence/health. Release channels and
Project stages are separate. Untested entries may remain useful catalog entries
when their actually offered operation prerequisites pass.
Missing/stale gameplay reports change the evidence display, not automatically
installation or update eligibility. A known relevant failure holds only the
affected operation/artifact/platform/variant. A schema pass is not an install
test, and source-file correctness is not gameplay certification.

The following table is the approved target for #246 and related publisher
work, not behavior shipped by the current manual catalog workflow. The
current core evaluator applies the operation-specific rules above; automatic
candidate acceptance and publication still require their protected pipeline.
Under that future pipeline, reusable capabilities, templates and narrowly
scoped publisher authorities are reviewed once; deterministic checks decide
routine candidates within them.

| Candidate                                                                                  | Planned result                                                                                     |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Accepted upstream, ordinary new artifact, supported contract and required checks pass      | Automatically available; verify its new digest. Existing selectors need no needless definition PR. |
| New definition or path/metadata correction inside accepted capabilities and authority      | Automatically admit with honest evidence, including zero gameplay reports.                         |
| Established asset identity unexpectedly changes bytes                                      | Hold replacement, retain pinned identity and deduplicate the exception.                            |
| New authority, ambiguous identity, new capability, widened access or unsupported migration | Scoped trust/engineering review; retain usable versions.                                           |
| Missing optional input or gameplay                                                         | Not run/Unknown, not a blanket block or a fabricated pass.                                         |
| Integrity, archive, source, executable or mandatory operation failure                      | Reject/hold the affected operation; untested cannot bypass it.                                     |
| Unsupported client capability or failing platform                                          | Isolate the affected definition/platform, retaining compatible entries.                            |

Source hashes, variants and relative paths may be accepted data inside a bounded
schema. Ownership reinterpretation needs explicit migration/consent semantics;
safe reusable migration templates can later be policy-authorized. Publisher
onboarding specifies actual repository/artifact authority and reauthorization
conditions, not a broad domain popularity rule. The authorized
[#315](https://github.com/boburning/portcove/issues/315) policy allows an
independently reviewed catalog-curated exact hash for an attributable release.
Core implements this route for GitHub definitions with protected accepted-byte
records and exact upstream identity under authenticated policy schema 4. Other provider
routes retain their existing expected-digest and provenance requirements.
The protected production canary and repeated eligible progression remain open
under #315. See [Acquisition decision](DEFINITION-DELIVERY.md#acquisition-decision)
for the separate integrity, publisher identity and operation checks.

Local/community definitions use the same validator, explicit namespaced origin,
conflict handling and scoped trust. Partial management may permit install/launch
while saves or updates are unavailable. Unknown persistence cannot authorize
destructive replacement, cleanup, broad backups or false recovery claims. This
future behavior is owned by [#268](https://github.com/boburning/portcove/issues/268).

Evidence collection distinguishes reusable adapter fixtures, actual artifact
lifecycle checks and voluntary attributed observations. Invalidate only facts
whose relevant inputs change; preserve historical and legacy evidence honestly.
Opt-in reports must exclude game data, secrets and personal paths; untrusted
reports cannot revoke the whole catalog. Ordinary success needs no owner action;
exceptions have bounded retries, scope and a reproducible resume condition.

## Upstream lineage and alternative implementations

The stable port ID and canonical port issue identify the Portcove integration.
Its upstream lineage records who continues that implementation. An accepted
release identifies exact repository/release/asset/platform/size/digest facts;
acquisition locations describe where those accepted bytes may be obtained under
their own authority. A location change does not replace any of these identities.

| Relationship | Meaning and catalog treatment                                                                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Relocation   | The same project moves location, including to another host. Retain the port ID and canonical issue after reviewed continuity. A different known repository ID on the same host is not a same-repository relocation. |
| Successor    | A continued implementation with attributable continuity, potentially under different maintainers or repository identity. Retain the port and issue only after independent review accepts that exact relationship.   |
| Fork         | A derived implementation with independent continuing identity. Give it a distinct port record and canonical issue; retain the original.                                                                             |
| Alternative  | A separately selectable implementation of the same game or target. Give it a distinct port and issue; a recommendation does not merge identities.                                                                   |
| Independent  | A separate product or game/target, even if it shares a repository or some code. Keep its distinct port and issue.                                                                                                   |

Assess sufficient attributable continuity for the concrete proposal. Record the
supporting facts, contextual facts, contradictory evidence, rationale and exact
reconsideration condition. A name, redirect, shared commit, copied credits or
popularity alone is insufficient. There is no mandatory announcement format,
universal evidence checklist or numerical trust score. Unresolved contradictions
prevent acceptance; insufficient evidence remains `unresolved`, and evidence
against the proposed relationship can produce `rejected`. Neither changes the
current accepted upstream. Independent review may be an authorized separate
non-writing agent; this policy creates no universal human gate.

### One authoring representation and decision boundary

The optional `upstream_lineage` object lives on the existing per-port authored
record, beside `listing` and `integration`. `scripts/upstream-lineage.mts` is the
shared validator and assessor used by generation and preparation. It is not a
second project inventory and is excluded from every runtime/catalog/listing
projection, signed definition and installed contract.

Format 1 contains `target_key`, `origin` and ordered `decisions`. The stable
lowercase kebab-case target key identifies the underlying game/target; reuse the
same key for implementations of that target. An identity contains `project_url`
and, when actually observed, `repository: { host, id }` with the provider's stable
ID. Provider IDs are scoped to their host. Explicit GitHub identities name a
repository root without query or fragment; case, trailing slash and `.git`
spellings cannot create duplicate known aliases. Other hosts keep their own path
semantics, supporting cross-host migrations without assuming GitHub identity.

Each decision records `from`, `to`, `relationship`, `outcome`, `rationale`,
`evidence` and `reconsider_when`. Evidence entries contain `kind` (`supporting`,
`context` or `contradiction`), an attributable HTTPS `reference` and a bounded
`note`. Accepted decisions require supporting evidence and a `review` containing
its reference and `decision_sha256`. `lineageDecisionDigest(record, lineage,
decision)` computes the canonical SHA-256 over all decision facts except
`review`, bound to the stable port, canonical issue and target. This detects stale
or copied declarations; it does not authenticate a reviewer. The referenced
evidence and independent PR review establish the actual decision, not a supplied
hash or evidence label.

Accepted relocation/succession advances the current upstream; all prior
identities remain in history. Accepted fork/alternative/independent decisions
instead require `related_port: { id, issue_number }`, matching a separate
catalog record and its known destination identity. They leave the original
current upstream intact. Generation rejects duplicate canonical issues and
duplicate known upstream implementations for one target, while allowing different
targets in one repository. Unknown historical IDs must not be invented.

Records without lineage remain `legacy-unassessed`; no mass migration or inferred
acceptance occurs. Their existing projection and runtime behavior stay intact.
For an ordinary update, start from the current authored record, append the exact
proposed decision, obtain independent review, bind its digest and reference, then
use `prepare-port.mts --record ...`. Preparation checks the previous record,
preserves known port/issue/target/origin and all earlier decisions, and reports
the assessment. A known provider ID conflicting with collected metadata refuses
the proposal even when its URL is unchanged. Unavailable provider metadata does
not become a verified identity. Failure retains accepted input files.

Reversal appends a new reviewed decision from the current identity to the retained
earlier identity. Never delete a failed or accepted event to make a transition
pass. Generation checks internal chain consistency; direct file edits and
historical imports additionally require Git diff review against the retained
record. A self-consistent edited chain alone cannot prove immutable history.

### Preservation and authority

Lineage acceptance does not accept a new release, authorize a mirror, clear an
operation hold, grant distribution, widen publisher authority or migrate saves.
Release selectors and acquisition declarations remain separately reviewed
operational fields. A source/tag match cannot substitute for an accepted
artifact's exact bytes. Historical qualification stays attached to its original
artifact, source, platform and environment; it does not transfer to a successor.

Existing installations, pins, retained versions and rollback keep their captured
definition, accepted release/source identity, execution and save/configuration
ownership. Core's retained-contract tests exercise catalog changes across legacy
and successor versions; lineage metadata does not enter that interpretation.
The authoring tests check identical complete runtime projections and preservation
of existing inputs through accepted, refused and reversed decisions. Signed
catalog format 1 retains its existing compatibility policy: it permits the
already supported release/project-location metadata updates while preserving
source, execution and persistence contracts. No new format or relaxed validator
is introduced here.

The [October 23 policy record](archive/2026-10-23-upstream-lineage-policy.md)
imports the independently delivered ReCut relocation and retains the initial
unresolved Star Fox event. The later
[Star Fox successor decision](archive/2026-10-23-star-fox-successor.md) accepts
attributable project continuity from newly reviewed maintainer statements and
corroborating history. It appends acceptance and updates the current project URL;
the historical release repository, accepted artifact and operational contracts
remain unchanged. The restored source tag does not recover the accepted ZIP, and
the newer Windows release's antivirus investigation remains unresolved. #139's
policy case stays complete; #2440 owns this finite transition. #251 consumes the
shared contract; #1306 owns preservation/failover, #315 release/distribution
authority, #246 protected delivery and #254 proposals.

### Artifact preservation capture

`scripts/artifact-preservation.mts` is the maintainer-side capture contract for
[#1306](https://github.com/boburning/portcove/issues/1306). It covers an
explicitly declared finite scope of accepted artifacts, keyed by port, platform
and numeric asset ID, and only for listed distribution bases. Anything outside
that scope is recorded as `ineligible` and is never fetched. Capture streams the
original bytes against the accepted size bound, rejects a differing SHA-256
before publication, and publishes `<sha256>.asset` without replacing an existing
object. A record becomes `verified` only after a separate complete read of the
stored object matches the accepted size and SHA-256. Upload success and stream
hashing never qualify.

A replay or backfill verifies an existing object instead of uploading it again.
A differing stored object becomes `failed` and is preserved for review, not
overwritten. Exhausted capacity, including running out of space mid-transfer,
records a deferred `pending` state and evicts nothing. Each artifact is recorded
independently, so a storage error on one does not stop a backfill. Inventory
export includes verified records only, one per accepted identity (one object
may carry several), in a canonical order that
gives a stable digest. Restore streams each object through the same bounded
size and SHA-256 check before publishing it in the target. It then reads the
target back and never changes accepted identity. Interrupted private
`.partial-*` staging files are never usable objects. This tooling does not sweep
abandoned ones automatically.

This tooling grants no authority and changes no client behavior. Core
acquisition still freshly observes upstream metadata as described in
[definition delivery](DEFINITION-DELIVERY.md). No backend, credential,
preserved location or failover path is configured. Those depend on the owner
decision recorded on #1306.

## Read-only disappearance reporting

`scripts/check-catalog-repositories.mts` reports six separate facts for each
selected port: declared project/acquisition reachability, retained lineage,
exact accepted-artifact obtainability, preservation, applicable holds and
qualification. Its format-3 output records the catalog and policy hashes,
per-observation health contracts and observation interval. `collection_status`
states whether collection completed; condition `outcome`, classifications and
degradation state whether observed problems are accounted for. A completely
observed 404 or identity mismatch can remain actionable. Neither a complete
collection nor an accounted condition establishes installability.

DirectManifest entries retain their exact version/platform/digest/size and
acquisition URL. Declared project and acquisition roles are inventoried
separately, so a project URL change does not erase an older release repository.
A user-prepared runtime may name its repository with a hosted slug or a complete
HTTPS GitHub/GitLab repository URL. The health collector applies its existing
upstream URL validation and retains the acquisition role independently of the
project role; this observes repository metadata without inferring a delivered
runtime or accepted artifact. Other hosted providers retain their slug contract.
Hosted endpoints use bounded metadata requests; direct artifact and other project
endpoints use credential-free HEAD without following redirects. Matching
Content-Length establishes endpoint reachability only. Accepted bytes remain
Unknown until their identity is verified. Missing, corrupt, inaccessible,
contradictory or partial inputs remain explicit.

Lineage fields retain the [shared authoring contract](#upstream-lineage-and-alternative-implementations)
facts available when the port is observed, including reviewed decisions and
history. Cached reports retain those observation-time facts; they are not a
continuously refreshed lineage service or new decisions. Preservation remains
owned by #1306 and artifact/operation holds by #315/#246. This collector modifies
none of those authorities. Catalog qualification stays attached to its exact
artifact/source/platform scope; legacy platform arrays are labeled historical.
Neither transfers to another release or location. Absent preservation or hold
evidence is Unknown, never permission or a clean hold status.
Validated authoring lineage participates in the port's freshness contract and PR
selection independently of the generated runtime catalog. A lineage-only decision
therefore requests a new observation instead of retaining a stale decision as fresh.

The retained Star Fox Enhanced incident in #247 (run 36735216087, job
109955016518, source `5d6905ea8bf90fb887bb49a6a8524ab2ecc5846b`) reported
`kandowontu/starfox-enhanced: github returned 404`. That remains historical
disappearance evidence. The later
[accepted successor decision](archive/2026-10-23-star-fox-successor.md) rests on
separate attributable continuity evidence and updates the current project URL.
The old release repository remains inventoried under its acquisition role, with
its exact known 404 accounted for and still visibly unknown. The successor does
not restore the historical release, recover accepted bytes, transfer qualification
or clear holds. A bare 404 neither establishes retirement/deletion nor selects
a successor; known endpoint failure and accepted project continuity can coexist.

Reviewed catalog maintenance declarations (`retired`, `superseded`, `abandoned`)
account for a 404 only at the port's declared project scope. They retain degraded
output and cannot suppress a missing artifact, new access/integrity failure,
repository-name reuse or an unclassified shared location. An archived flag or
bare 404 creates no such declaration.

Players see these reviewed declarations, never this maintainer report. Separately,
Core keeps the repository archive flag and latest push time that GitHub reported
in the metadata it already reads to select a release (#5407). The update check
records them as `upstream_activity`, and Desktop shows them in the port details:
archived, no changes for two years before that observation, or the latest change
month, each dated to GitHub's report. An observation belongs only to the GitHub
repository the port still names. This player fact is a dated provider observation with no catalog,
admission, hold or update authority. Ports that were never checked, other
providers and missing push times remain unknown.

The format-2 `.github/upstream-health-accounting.json` preserves the reviewed
monitoring dispositions and existing numeric release-pin identities. Versioned
artifact bindings cover only the relevant port/platform/provider and exact
URL/version/size/SHA-256; presentation edits and other platforms do not invalidate
them. Endpoint conditions bind an explicit project/acquisition role and its
relevant declaration, maintenance state, operation and HTTP rule. A reviewed 301
also binds its numeric redirect identity. These dispositions grant no lineage,
relocation, artifact, distribution or catalog mutation authority. Changed or
unclassified conditions remain actionable in the report.

Ordinary GitHub release-download 302 responses need no new exception record.
Three fixed API metadata reads can validate the catalog's exact repository/tag,
complete asset collection, URL/name/size and provider SHA-256 claim. A pin without
a reviewed numeric binding reports `provider-reported-pin-observed` and
`identity-unbound`. Existing reviewed repository/release/asset IDs and fact hashes
remain mandatory for their artifact scope, producing `provider-reported-pin-present`
only when they match; generic observations cannot replace those bindings. Both paths
retain the HEAD redirect as unknown, with destination availability unknown and
accepted bytes unverified. No redirect is followed or artifact downloaded or
executed. Reviewed immutable source archives have a separate bounded commit
metadata path with the same byte-verification boundary. See
[upstream observations](UPSTREAM-OBSERVATIONS.md#health-inputs-and-reviewed-accounting)
for the complete accounting contract.

Historical qualification identities are inventoried at their exact refs and
declared hosted locations, or the matching immutable DirectManifest pin.
Provider-reported digests remain metadata, never verified bytes. Empty,
conflicting, capped or partial asset collections stay Unknown. A historical
identity without a locatable declaration stays visibly unmonitored. Failed
qualification records are reported at their original scope without creating or
clearing a publisher hold.

Each condition has a deterministic key binding the port, location, operation,
rule and relevant observation contract. First-seen time and recurrence survive
unchanged repeats; material HTTP/identity/digest/size/classification changes and
fresh recovery are reported separately. Narrow contracts preserve comparison
across unrelated catalog edits. Prior numeric identity is a comparison baseline,
never ownership or continuity evidence. The standalone `--previous-report=PATH`
accepts bounded comparison evidence and writes no state or issue comments.

The workflow coordinator persists validated main-only observation history and
automatically drains checkpointed operations of at most 352 requests and 512 new
location assessments. Individually oversized collections continue by endpoint
without starving smaller scopes; compatible completed facts retain their original
24-hour clocks and do not consume another request or new-location slot.
Its report distinguishes this run's assessed ports from retained observations,
stale/unmonitored entries
and recent partial attempts, with a 24-hour freshness window and the complete
inventory denominator. PRs compare actual merge-target health inputs with the
merge result; presentation-only edits select no probes, while related semantic
changes select their owning ports. PRs can read history but cannot advance the
main checkpoint. Collection failures retain partial reports and failure history;
invalid coordinator inputs preserve the prior checkpoint and emit a failure
report. The diagnostic job is not a required merge check. Its collection exit
is distinct from the standalone checker's stricter condition outcome, and neither
changes required catalog validation, qualification or publication authority.

The exact ReGaiden v0.4.1 Windows prepared-runtime route uses this closed
shared-preference contract. Its [qualification report](qualification/slice6-regaiden-prepared-windows-2026-10-19.md)
records original/artifact identity, the preserved ImGui failure, corrected
consent and operation acceptance, and the separate delivery boundaries.

### Accepted descriptive freshness and retained setup explanations

Listing format 4 adds optional inert `upstream_observation`, reason-bearing
`availability_override_reason`, and `release_maintenance` metadata. Formats 1–3
refuse these fields; accepted projection/registration paths promote the effective
format while preserving older serialized documents. Signed listing delivery
retains the same publisher, revision, integrity, atomic selection and recovery
boundary. Unsupported or invalid replacement data does not replace last-good
cached listings or grant managed operations.

Listing format8 adds supported GitLab descriptive observations with existing provider-qualified
project/tag release identities and numeric generic registry file identities. GitHub IDs
and serialized observations remain unchanged. Exporting a GitLab-bearing directory
to an older format refuses; unknown formats retain existing last-good delivery
behavior. Authored format derivation selects8 only when these fields occur. This
adds no managed GitLab authority and leaves unsupported package layouts incomplete.

Authored availability remains attributable. An explicit availability override
requires its reason and takes display precedence. Otherwise accepted observations
show package candidates or release assets with their provenance, original fact
clock, expiry and complete/incomplete/unavailable/failed attempt state. Discover
uses the same assessment for rank and detail. Only a fresh complete observation
with a recognized package platform can raise a listing's rank over its authored
availability. An empty
or incomplete bounded window never means source-only, unsupported or unavailable
upstream. Provider digest claims remain unverified. The renderer does not query
providers, update action permissions or rewrite acquisition links.

Authored pin reasons and reconsideration conditions have one source; projected
pin versions/dates come from existing Direct contracts. Listing observations can
request compatibility reassessment without changing those immutable artifacts.
Newer external setup guidance can intentionally describe another route.

Core's optional `LaunchReadiness.setup_contract` explains the effective route:
installation method, source requirements, saves/settings ownership, declared
persistence and authored guidance. Installed routes derive these facts from their
retained catalog; invalid retained metadata supplies no substituted new-catalog
facts. Older clients lacking that projection may still show the authored guide
under an explicit current-catalog scope; recorded mechanical facts stay unavailable. Existing activity, artifact records, source assessments and action
assessments retain their own owners. Mechanical explanation does not authorize
preparation, updates or backups. Marathon's shared authored guide replaces its
identical duplicated preparation paragraph; game-specific guidance is retained.

## Optional recommendation observations

`presentation.recommendation` is inert optional format-1 metadata. Its named
outcomes, attributable public sources, explicit observation kinds and complete
artifact/edition/environment/source/route scopes feed the shared Core query.
It is not a numeric quality field or executable policy. Missing, malformed and
future versions preserve ordinary project listings; older catalog readers can
ignore it. Accepted regression and correction authority remains with the existing
reviewed catalog inputs, not arbitrary release notes. See the
[recommendation contract](reference/port-recommendation-policy.md).

Write browse summaries and setup guides using [Content design](CONTENT-DESIGN.md).
Collect source and release evidence first. Write a short description of the
project, its inputs and the setup route a player can use. Preserve dated
technical findings in reference notes or the owning evidence document.

### Setup actions and reference notes

Authored `manual_setup.steps` contains only setup actions. Put immediate edition,
permission, shared-save and backup consequences in `warnings`, which clients show
before the relevant choice. Optional `manual_setup.references` retains save paths,
build-specific options, dated release observations and maintenance information.
Desktop and Playnite show these as **Save locations and version notes**, after the
actions. Keep necessary warnings out of that optional disclosure.

Structured references require catalog schema 3 or listing format 6. The authored
assembler selects those formats only when needed. Existing formats remain readable;
explicit CLI legacy exports flatten references without losing text. See
[API schema history](reference/cli-schema-history.md#api-schema-85). Catalog schema 3
uses the same source authority as schema 2; this presentation metadata does not
change eligibility, runtime ownership or save compatibility. Do not add an unknown
field to an older strict format or infer reference sections from heading text.

### Reviewed upstream status

The operational definition retains the legacy `upstream_status` values. Use
`upstream_active_reviewed: true` to declare that an upstream project was
reviewed as active. A legacy `active` value without this marker is unrecorded.
Retired, superseded, and abandoned values are explicit declarations on their
own. Repository activity observations retain their own dates and do not supply
a catalog declaration. An indexed definition carrying this marker uses entry
schema 2 and matching catalog projection schema 2. Keep serving schema 1 to
readers that only support schema 1.

## Frozen artifact readers

Core compiles `historical-artifacts.json` into its offline reader. The table binds
old DKR-R manifests to their frozen catalog, preserves the four historical
Direct Windows reader exceptions and selects frozen package and cartridge
interpretations. Each lookup keeps its creating reader's recorded coordinates.
For example, an early DKR-R manifest may omit its platform, but must match the
exact release, asset name, size, digest and executable basename. The Direct
exception uses the version and digest from the retained Windows definition.

Stored retained definitions and their registered manifests take precedence
where the reader historically used them. Keep the frozen projections at their
recorded revisions. The compiled table confers no publisher grant, replacement
ownership, source approval or upstream package eligibility.

Existing reusable managed profiles can select a new package through their
ordinary reviewed GitHub rules and independent publisher grant. For single-lane
Windows profiles that need an exact compatibility list, use
`managed_runtime_applies_to` rows containing `version`, `size` and `sha256`.
The list applies to the reusable TFE, Chocolate, RaceWave and GB Recompiled
behaviors. The ordinary resolver checks the selected official package against
the list before acquisition. Direct and curated lanes keep their existing
separate bindings.

Publication requires a schema 4 indexed entry declaring
`runtime.reviewed-compatibility-artifacts-v1`, a schema 3 catalog projection
and the independent exact publisher admission. Core reopens a prior install
using its own captured list. Older definitions without the list retain their
existing rules. Format-1 output cannot carry the list.

## Package-only settings defaults

Use `game_settings.format_version: 2` for one independent whole-file setting
that a verified Windows package ships. Declare its exact persistent path,
format, byte bound and release archive identities. Leave the file's `settings`
array empty. This authorizes the existing Core settings update and recovery
protocol for a supported managed package and keeps scalar editing unavailable.

For a ready staged-source GitHub package, the declaration applies when the
file is a standalone persistent path, the runtime uses the existing mirrored
data contract, and no partitioned or runtime-data policy owns the file. Check
the exact package member and the upstream code that reads it. Core captures
the bytes from verified acquisition, before persistence restoration can
replace the packaged file. A later stable patch in an enrolled numeric
major/minor series uses the same declaration when the normal acquisition
path independently admits its ZIP. An explicitly enrolled release retains
its exact archive digest. A new series needs review of the package layout
and configuration consumer. Previously installed packages without a captured
baseline remain held if activation needs that baseline. Retain the ordinary
settings recovery and guarded backup receipts.

The change from Super Mario World Recompiled v0.15.9 to v0.15.10 has an exact
Windows archive and independent `config.ini` comparison. v0.15.11 retains the
v0.15.10 settings bytes. The scopes and evidence are in
[the package settings observation](qualification/smw-package-settings-defaults-2026-11-21.md).
