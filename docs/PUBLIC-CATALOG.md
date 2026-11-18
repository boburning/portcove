# Generated public catalog

`scripts/public-catalog.mts` builds read-only pages from the existing generated
descriptive directory and operational catalog. It does not create an editable
catalog, a scheduler, a hosted service or an installation decision.

Generate a development preview in a new output directory:

```sh
node scripts/public-catalog.mts \
  --listings crates/portcove-core/catalog/listings.json \
  --catalog crates/portcove-core/catalog/catalog.json \
  --revision "$(git rev-parse HEAD)" \
  --observed-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --output work/public-catalog-preview
```

Serve that directory with a local static HTTP server. The output has a catalog
index, a compact `search-index.json`, stable `games/<reviewed-game-id>/index.html`
pages and `projects/<implementation-id>/index.html` pages for ungrouped projects.
Implementations of a reviewed game have separate sections and comparison rows.
Matching titles alone never group projects. Source editions remain separate from
target platforms. A shared runtime never combines different original games.

Search and platform/method filters use only the generated local index. All links
remain in static HTML if JavaScript is disabled or the index cannot load. A failed
index leaves a visible explanation and disables unavailable filters. Missing or
unknown optional method metadata leaves the rest of the page useful.

The projection copies only an explicit public field allowlist: descriptions,
reviewed game identities and editions, upstream links, target platforms, optional
method/dependency evidence, setup instructions, limitations and declared scoped
check platforms. It excludes private maintenance data, user library records,
local paths, credentials, arbitrary extra fields and artwork. External text is
escaped and only HTTPS links without credentials are rendered. Input reads,
search downloads, generated file counts and aggregate bytes have finite bounds.
Output goes through a new staging directory; an existing result is preserved.

## Development and published delivery

Every current page is explicitly a **development catalog**. The generator records
the exact source revision, input digests and observation time. A captured catalog
is not a new upstream verification, a gameplay result or a published delivery.
Availability is labeled an upstream claim; release existence alone cannot become
a playable package. Definition presence is labeled a development integration.
Published delivery remains **Not checked**. No app handoff URL is manufactured.

`composeCatalogSiteFiles` accepts the optional `browse` projection returned by
`projectPublicCatalog`. The fixed renderer writes it under `catalog/browse/`,
which the existing complete-site generation inventory already owns. The normal
application update retains the exact catalog subtree. A catalog refresh without
optional browsing input retains its prior browse output. The byte composer and
generated pages have no publication authority; independent catalog and application
roots, authenticated history and the sole protected Pages writer remain required.

There is no new publication trigger. The protected caller is not activated by
this change. To publish the development pages, the existing catalog publication
owner must supply the bounded public projection to `composeCatalogSiteFiles`
through its reviewed protected caller, complete existing catalog/site checks and
use the existing Pages publisher. The result would be served at
`catalog/browse/index.html` below the existing site. Before making public support
or app-handoff claims, integrate a verified published-input readback through that
same delivery owner; a caller-supplied success flag is insufficient. Until then,
report these pages as built and unpublished.

## Verification

`node --test scripts/public-catalog.test.mts scripts/release-site-composer.test.mts`
exercises grouping, title collisions, unknown metadata, source-versus-target
facts, the OpenSHC research-release regression, safe rendering, private-field
exclusion, deterministic generation, preserved existing outputs and catalog/app
composition. The real Majora's Mask records exercise 2Ship2Harkinian versus
Zelda 64: Recompiled. Browser observations remain distinct from native Desktop
and published-site acceptance.
