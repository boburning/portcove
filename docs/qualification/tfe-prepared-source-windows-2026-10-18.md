<!-- portcove-slice6-tfe-exact-source-20261018 -->

## Exact TFE prepared-source readback — October 18, 2026

The existing owner-approved PC installed-data source facts were freshly read and verified for fixed batch 6C-726C. No original was changed or redistributed.

- Owned installed-data ZIP: 29,697,820 bytes; SHA256 `983e6f1c9f20c6ced106a675ffc32ee66f6d09aeafa0c0a3c0a3b0add7f820c2`; 48 members, 68,386,776 expanded bytes (four GOBs and 44 LFD companions).
- Official TFE v1.22.420 ZIP: 10,561,878 bytes; SHA256 `30ee44b296f18273842c50c2db5d5e5dccb2bba278d4909881273737f90c4eac`; upstream commit `cc25205cc94c36a396f6f50295772f6ec83069a2`. Canonical `TheForceEngine/TheForceEngine` and historical `luciusDXL/TheForceEngine` resolve to the same GitHub repository ID `242802212`.
- Raw archive indexes were bounded before parser construction; every selected member passed CRC, path/type and exact byte-hash checks into a fresh disposable tree. Both original archives passed unchanged readback. The combined 200-file immutable tree is SHA256 `e07fc26a2027500b74548e511c5677ea78357e466d23510d94161e144ce6eaf8` under the existing Core tree algorithm.

Observed original GOB identities:

- `DARK.GOB` — 14,244,049 bytes; SHA256 `3ff0efca4fb5ce82b2e02bbf1ef3fc4246f1ecce5625959f5e729f80a0576c1b`.
- `SOUNDS.GOB` — 5,950,117 bytes; SHA256 `5cc43a1762341ba1ddeda6b3fa105f097fb59e4126d4b3d8e73cd5e7228c9d1c`.
- `SPRITES.GOB` — 2,816,419 bytes; SHA256 `d7d5d7f8125c28b9917a470091ca1d37e26303e53b384d71f85bfe64579452ab`.
- `TEXTURES.GOB` — 8,929,232 bytes; SHA256 `b36e507471ee2b64c18236503c34c58fc37233988424ce25f0767e412650ce42`.

These are attributable byte-identity facts, not an upstream-published digest allowlist or gameplay proof. The proposed ordinary-file profile checks only exact primary `DARK.GOB`; the separately accepted immutable prepared tree must pin all original companions and the package. This does not implement a generic directory-source launch route.

The proposed final runtime also requires present player-owned `settings.ini` and compatible `DARKPILO.CFG`, reusing the delivered required-file capability plus the versioned settings guard in #2146. Core neither seeds nor imports a pilot. Shipped `Mods/TFE` remains immutable; eleven known output paths stay externally owned. The pilot is not yet initialized in the disposable fixture. No TFE game, registration, native operation acceptance, repository admission, installed-client delivery or support promotion is claimed by this source readback.
