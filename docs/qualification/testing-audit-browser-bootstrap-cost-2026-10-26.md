# Browser bootstrap cost, 2026-10-26

Audit 22 of [#2420](https://github.com/boburning/portcove/issues/2420) requires cold/warm identity and cost evidence before considering a hosted browser cache. The bounded decision is to retain the current installer and readiness checks. No cache, package or production workflow changes are introduced.

## Identity and actual readiness

The checkout-owned browser directory was absent before the local cold run. The maintained guarded bootstrap then installed and launched the exact headless shell; two subsequent warm runs retained the same package fingerprint, registry revision and actual browser version. No shared cache was removed. Package compatibility checks pass, and the existing bootstrap contract suite passes 9 cases in one executed file with no skips.

The pinned identity is Playwright 1.64.1, headless-shell revision 1248 and Chromium 156.0.8078.4. The package manifest fingerprint is `313d23ce667d93962d3a1ab4be80908cefe840e4d9e48f1cd5863b91f65e8e39`; the 207,474,000-byte executable SHA-256 is `4fa61f0ba0b4f89b7bec242c32ca16d3bccf69dbfef0651924a9ba8fede5f9d6`. All three real install/launch/version/close sequences succeed. Presence diagnostics alone never substitute for those operations.

| Observation                 | Installer | Launch | Close |
| --------------------------- | --------: | -----: | ----: |
| Local absent-directory cold |    6207ms |  765ms |  68ms |
| Local warm 1                |     414ms |   42ms | 173ms |
| Local warm 2                |     401ms |   42ms | 404ms |
| Hosted Linux cold           |    5128ms |  813ms |  46ms |

Local whole-command times are 10.245s, 1.921s and 2.112s. They include separate resource/supervisor/process work and are not equivalent to download or readiness phases. The installer includes package checks, headless-shell/FFmpeg downloads and extraction; pure network time is not isolated and is bounded above by this phase.

## Hosted significance and disposition

The exact-source successful [CI40271163933/a1](https://github.com/boburning/portcove/actions/runs/40271163933) retains the same package fingerprint, executable revision and actual browser version. Its verified timing artifact records an absent executable before installation, 5.128s of installer time and 393.756s of UI execution. Installation is at most 1.286% of those two sequential stages; pure download time is no larger. That observation does not show download domination, so it does not justify adding a cache.

[The structured packet](testing-audit-browser-bootstrap-cost-2026-10-26.json) preserves local phases, observed identities, all hosted timing records and the verified archive digest. Hosted source `e8929b7dcc392eb47887f75ddafa861104d2ce34` and provider `8779dc6ab61d649c9bcdc77fd7c2517739ff8664` were independently verified through the required CI provenance/readback chain. The local measurement used clean source `78fc6ad84d3e54929c3849d0198c5d33cdf9776a`. Original null source/checkout labels in local frontend case observations remain null; the separate request binds the actual root/head.

Archive, restore, upload and net-gain costs remain unknown, not zero. No hosted cache is adopted and no end-to-end improvement is claimed. Revisit under #1104 if repeated equivalent hosted observations show material installer domination; measure the full transfer round trip and preserve exact platform/package/revision keys and compatibility/readiness checks before adopting one.

## Limits

This is one hosted Linux cold observation and three local Linux runs. Absent local cache does not mean cold OS, network or CDN caches. Warm command differences include process/page-cache and supervisor variation. These observations establish no Windows/macOS costs, actual native Desktop acceptance or installed-package coverage.
