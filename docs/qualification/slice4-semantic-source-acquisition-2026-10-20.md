# Automatic semantic source acquisition preparation

Owner: [#534](https://github.com/boburning/portcove/issues/534). This implements the
fixed worker's source acquisition before its existing two-stage semantic runtime.
No setup, credential, reviewer launch, Check issuance or release authority is
established by this component.

The previous worker required a separately refreshed local source object cache.
Its four-file version-preparation hydrator could not provide the full new source
and publication snapshots. The worker now creates a fresh bare object store and
uses a fixed anonymous public Git route. It preserves raw commits, including
non-UTC unsigned actor offsets and annotated tags, without reconstructing them
from REST-normalized dates. There is no candidate checkout, hook, submodule,
credential helper, alternate object store, ref update or lazy fetch.

The existing semantic limits remain: at most 1,600 changed commits, regular-file
snapshots, 16 MiB per selected blob and 192 MiB total selected bytes. Complete
provider tree inventories are reconstructed and hashed before selecting blob
wants. Exact local object types and sizes are checked afterwards; the existing
semantic freezer still independently verifies the change set and every consumed
blob. Truncated, unavailable, changed or excessive inputs stop the technical
attempt rather than becoming a model or issuer result.

Acquisition has one 120-second deadline, including resource queue time, and at
most 30 seconds per fetch. Before Git parses an incoming pack, the fixed Python
launcher sets a 1 GiB address-space ceiling, finite CPU/wall limits and per-file
64 MiB commit-pack / 256 MiB blob-pack ceilings. The parent additionally checks a
512 MiB object-store ceiling after each fetch. Those file limits do not assert
that compressed bytes equal decoded bytes; the memory/CPU/wall limits bound
parser work separately. The same pre-execution limits also cover every later
local Git decoding/query/import operation, through a fixed operation enum with
network disabled. The existing resource supervisor owns fetch process-tree
cleanup. Failure evidence remains in the original technical attempt.

Before handoff, every changed/base/source/publication commit passes the existing
128 KiB-per-commit / 32 MiB-total preflight. Only those commits, exact snapshot
trees/blobs and bounded publication tags are exported to a second bare store,
with delta and object reuse disabled. Subsequent existing freezer reads therefore
do not inherit network-selected delta bases or unrelated objects. Its shallow
boundary is the explicit review base; raw parent bytes remain unchanged and the
existing independent provider comparison still verifies the complete change set.

The still-unprovisioned worker setup must additionally pin `source_git_sha256`
for `/usr/bin/git`; the existing Python pin is reused. `source_repository` remains
a compatibility field but is no longer used as a freshness prerequisite. The
worker's exact checkout/configuration and current journal request are checked
again before any reviewer invocation. Its dedicated source API token, reviewer
authentication and isolated issuer remain separate.

Local disposable Git tests cover a genuinely empty store, raw non-UTC commits,
annotated publication, binary snapshots, no refs/checkout/alternates, and bounded
metadata/type/size refusals. Inert Python fixtures cover the literal public
route, scrubbed environment, pre-parser limits and expired/injected requests.
The ordinary Linux workflow exercises the actual public Git/helper route with
no token or model invocation and retains only bounded public result JSON for
seven days. Its result is source-transport qualification only; actual worker
setup, runtime/authentication, semantic acceptance and protected execution remain
separate and unobserved until their applicable evidence exists.
