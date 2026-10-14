# Retain declared inputs without turning copies into execution authority

Retained evidence uses private staging, verified no-clobber publication and content identities in a dedicated non-cache store. This costs persistent disk space but preserves observations after checkout changes; cleanup is explicit, with no automatic eviction. Only declared non-secret inputs are captured. Historical version-2 receipts remain observations at their original time, and later retention is a new observation.

The bootstrap’s established standalone driver executables consume retained artifacts. Product executables retain their original paths until their relocatable layout has independent proof; matching run metadata cannot supply that proof. Path-sensitive or unestablished layouts keep their original execution path with cooperative content verification and explicit limitations. Source helpers are checked by the trusted parent before target import, at application/driver launch boundaries and after execution; already loaded verifier sources are separately labeled observations. Neither copies nor matching metadata establish immutable execution. Original paths/bytes are never rewritten to manufacture custody.

Private Linux native drivers may depend on their original runtime layout and
remain cooperative live-path inputs. Declared non-secret verification metadata
is validated and snapshotted before capture, then read from its retained bytes;
original-read provenance remains separate from that consumed snapshot. Secret
fields refuse capture; bytes are never redacted and represented as original.
