# Persona owned-input selection and compatibility proposal

This finite #143 proposal repairs selection of the already offered Windows
managed route. It changes no catalog definition, source identity, support tier,
platform qualification or publication authority.

## Exact observed packages

The [official releases](https://github.com/NJH-1001/RevPRecompile/releases)
were read on October 11, 2026. Each of v0.1.0 and v0.1.1 has nine release assets;
the paginated asset inventory agrees with the embedded inventory. The checked-in
metadata fixture retains both complete asset lists, including competing ordinary
Windows packages, other platforms, source packages and checksum companions.
This is inert provider metadata, not authenticated artifact or execution proof.

| Release | Owned-input kit                             |      Bytes | Expected SHA-256                                                   |
| ------- | ------------------------------------------- | ---------: | ------------------------------------------------------------------ |
| v0.1.0  | `revp-0.1.0-windows-x86_64-owned-input.zip` | 30,422,833 | `3b387f7e0705fab70677535a1c1f6d314df8f8443e0d638bd904e80a67eaccc3` |
| v0.1.1  | `revp-0.1.1-windows-x86_64-owned-input.zip` | 29,260,787 | `f4336030ba9c0e032061ad6892aa5ce9ff01c4cedcbaf3a5355428e6d728158a` |

The definition's `windows-x86_64-owned-input` hint selects a preparation kit for
the managed PSX adapter. That declared class is required when present in the
definition. An absent kit cannot fall back to the ordinary Windows runtime ZIP.
Platform, auxiliary-package and checksum exclusions still apply. Equal top
matches remain ambiguous; missing expected digest remains held by the existing
observer. Other adapters and ordinary platform hints retain scoring semantics.

The controls apply the unchanged definition to both complete version inventories
in rotated and reversed order, and cover absent kit, ambiguous kit, absent digest
and unchanged ordinary-hint behavior. Observer output remains unauthenticated,
unverified and unadmitted. Selection never transfers earlier qualification.

## Compatibility facts retained

The recorded v0.1.0 generated-executable lookup failure remains a failure on
[the canonical owner](https://github.com/boburning/portcove/issues/143).
Selecting its kit is not a repair or a new launch pass. The proposal targets the
existing v0.1.1 route and reuses the exact
[update and rollback record](revelations-persona-recompiled-windows-2026-09-15.md)
and [clean reinstall record](revelations-persona-recompiled-windows-reinstall-2026-09-15.md)
delivered through #829/#846. No native or upstream executable was run for this
selector repair.

Those records bind the accepted USA SLUS-00339 Track 01 source and owned-input
toolchain, generated `build-portcove/Revelations__Persona_Recompiled.exe`,
2,094-file immutable verification, normal-close collection, canonical persistence
and healthy backup. The clean reinstall restored runtime `input.ini` and
`keybinds.ini` byte-for-byte and kept the immutable `game.toml` template unchanged.
Their original artifacts, limits and failed evidence retain their provenance.

## Protected acceptance and precise resume conditions

The canonical Port owner must retain exact source, kit, generated-output and
persistence facts for each compatible proposal. For a successor, compare the
accepted normalized source identity; validate the owned-input manifest/toolchain
and generated executable lookup; inventory setup and launch writes; verify
immutable output separately from canonical configuration and disposable reports;
then qualify offered update/rollback/removal/reinstall continuity only where the
candidate changes those contracts. An unchanged existing receipt may be reused;
an invalidated check must be repeated under its original guards.

#254 owns proposal preparation. #246 owns authenticated compatible acceptance,
correction and delivery to unchanged clients. #534 retains production custody,
signing, publication and activation authority. This document requests none of
those protected actions and establishes no installed-client, gameplay or
non-Windows result. Integration remains open until its actual remaining minimum
is independently satisfied. The frozen cohort and Linux GLib hold remain intact.
