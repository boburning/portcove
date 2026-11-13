# Reviewed OpenX package layouts

The six managed routes below use the same staging layout gate as
[#4780](https://github.com/boburning/portcove/issues/4780). For each route,
the new offline CLI observer verified the publisher's exact size and SHA-256
on a private archive capture and produced equal layouts for both releases.
It used the existing managed archive readers and did not open a library.

| Route                  | Earlier asset ID | Successor asset ID | Directories | Program paths |
| ---------------------- | ---------------- | ------------------ | ----------- | ------------- |
| OpenXW Windows x86-64  | 596164128        | 598208588          | 4           | 1             |
| OpenXW Linux x86-64    | 596164250        | 598208754          | 5           | 6             |
| OpenXWA Windows x86-64 | 509286678        | 538528489          | 3           | 1             |
| OpenXWA Linux x86-64   | 509286629        | 538528524          | 4           | 6             |
| OpenXvT Windows x86-64 | 607639116        | 627809818          | 3           | 1             |
| OpenXvT Linux x86-64   | 607639019        | 627809761          | 4           | 6             |

The release pairs are
[OpenXW v0.0.2](https://github.com/elyosh/OpenXW/releases/tag/v0.0.2) and
[v0.0.3](https://github.com/elyosh/OpenXW/releases/tag/v0.0.3),
[OpenXWA v0.0.16](https://github.com/elyosh/OpenXWA/releases/tag/v0.0.16) and
[v0.0.17](https://github.com/elyosh/OpenXWA/releases/tag/v0.0.17),
and [OpenXvT v0.0.4](https://github.com/elyosh/OpenXvT/releases/tag/v0.0.4) and
[v0.0.5](https://github.com/elyosh/OpenXvT/releases/tag/v0.0.5).
The Linux observations use bounded TAR.XZ staging and include the executable
modes from the packages. The Windows observations use the ZIP path and program
extensions. Core observations match a separate archive metadata comparison.

All three titles keep their existing original-data instructions and upstream
profile custody. The new expectations constrain staging, and each platform
retains its current asset selector. Apple Silicon stays with the existing
upstream setup. No upstream player, original game data, native gameplay,
populated saves, or protected publication was exercised.
