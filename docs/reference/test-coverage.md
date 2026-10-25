# Opt-in measured JavaScript coverage

Coverage is an investigation of explicitly selected modules. It is separate from
ordinary checks, and adds no percentage gate. Use the repository-pinned Node and
installed dependencies. The V8 coverage provider must match the installed Vitest
version; the command refuses a mismatch instead of installing another runner.

```powershell
pnpm run test:coverage:node --module scripts/runtime-values.mts --test scripts/report-summary.test.mts
pnpm run test:coverage:unit --module apps/desktop/src/interface-size-controller.ts --test apps/desktop/src/interface-size-controller.test.ts
pnpm run test:coverage:browser --module apps/desktop/src/components/Artwork.tsx --test apps/desktop/src/components/Artwork.browser.test.tsx
```

Repeat `--module FILE` and `--test FILE` for additional literal files, up to sixteen
of each. Missing files, globs, duplicates, escapes, fixture/generated modules and
mixed unit/browser selections are refused before execution. Root Node scripts,
frontend unit tests and real Chromium tests produce separate reports. Do not add
their coverage denominators together or infer native/package acceptance.

The Node route uses the pinned runtime's native V8 coverage and serial test-file
execution. Frontend routes use the pinned Vitest V8 provider. Only the browser
route invokes the maintained Chromium bootstrap/readiness path. The unit route
does not bootstrap a browser. Coverage investigations retain the repository's
resource admission and process supervisor; provision the existing development
profile first, including the Windows supervisor toolchain where applicable. No
compiler is installed implicitly.

Each invocation creates a fresh `work/test-coverage/<uuid>/` directory containing:

- `request.json` and `receipt.json`: mode, selected files, runtime/provider,
  platform, original Git head/tree/dirty state, observed source hashes, commands,
  outcomes and completeness.
- `observed-source/` and `executor-source/`: original selected source and executor
  bytes, including the dependency manifests used by the executor. This bounds the
  observation; it does not attest every transitive input or an entire dirty tree.
- Raw stdout/stderr for each executed stage, plus Node JSON or Vitest
  `coverage-final.json` and `lcov.info` under `coverage/`.
- `maps/`: hashed generated JavaScript and mapping artifacts for every selected
  module. Node captures V8's final compiled source and verifies an identity mapping
  over the original UTF-16 offsets after whitespace-preserving type stripping;
  Node's appended source URL comment is explicitly unmapped. A rewritten module
  that cannot prove this mapping refuses completeness. Frontend capture retains
  the actual version 3 source map and code returned to the pinned V8 remapper,
  including the original source content. Chromium's remapper adds its own fixed
  inline-map comment after this transform boundary.

Inspect uncovered branches alongside the copied source and mapped report
locations. Node's native TypeScript offsets and Vitest's remapped coverage have
different counter models. Passing tests alone do not prove branch execution,
exhaustive paths, or product acceptance. An unimported selected Node module remains
missing coverage rather than receiving an invented zero/complete result.

Failed tests keep their original nonzero command status and raw evidence. Missing
measurements or source changes during execution also refuse a complete result.
Packets cannot be reused to replace earlier coverage. The command uses finite
15-minute admission and 20-minute execution budgets per stage, with zero automatic
test retries. Browser bootstrap is a separate retained stage.

Physical directory replacements and redirects are refused. The receipt file is
opened before execution so an output-directory replacement can still retain the
original nonzero child status through that owned descriptor. Reports and sources
use bounded regular-file reads. Mapping capture allows at most 64 observations
across workers, with at most 1 MiB of generated code and 2 MiB of map per
observation (192 MiB combined). Exceeding a bound retains prior evidence and
refuses completeness; use a smaller selection. This is diagnostic instrumentation
and does not establish uninstrumented performance.

The implementation follows the pinned runtime and SDK, with the
[Node test coverage API](https://nodejs.org/api/test.html#collecting-code-coverage)
and [Vitest coverage guide](https://vitest.dev/guide/coverage.html) as upstream
references. Coverage from Node/V8 or Chromium does not establish support for
Firefox, another JavaScript engine, Rust paths or installed native operations.
