# Archived rscheck 0.1.0 crates

These are the original published `rscheck-cli`, `rscheck` and `rscheck-semantic`
0.1.0 `.crate` archives, byte for byte. The crates were removed from crates.io,
and the remaining public copies live on two external mirrors whose storage
hosts vary per request, which made installation unreliable on restricted
networks. Their license is `MIT OR Apache-2.0`, carried inside each archive.

`scripts/install-qualification-rscheck.py` owns the archived crates.io index
SHA-256 for each archive and verifies these files with it before use, exactly as
it verifies mirror downloads; the mirrors remain fallbacks. A vendored file is
an origin of bytes, never of versions or checksums. Retire this directory and its
installer origin together with the archived-source custody when the pinned
`rscheck-cli` changes.
