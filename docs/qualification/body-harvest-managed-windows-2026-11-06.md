# Body Harvest managed Windows archive

This candidate adds a separate managed Windows x86-64 runtime. The upstream
player owns cartridge selection and the external profile. Existing prepared
copies retain their non-owning registration and upstream maintenance path.
[Canonical title #1448](https://github.com/boburning/portcove/issues/1448),
[rollout #2926](https://github.com/boburning/portcove/issues/2926).

## Exact inputs

GitHub release `402446213`, asset `607572513`, supplies
`BodyHarvestRecompiled-v1.0.0-Windows.zip` at 17,969,468 bytes.
The independently computed SHA-256
`c3bdb56f152c94c55af66d92bc1d9a37f9ce9eea358315700569c2dcca406a9f`
matches the published digest. All members passed CRC checks. The 37-entry
inventory has a root AMD64 `BodyHarvestRecompiled.exe`, SDL2 and DX libraries,
controller data and assets. The archive has no ROM or `portable.txt`.
The only packaged notice path observed in the existing packet is
`assets/promptfont/LICENSE.txt`. This consumes the previously reviewed
official-base grant for user-side acquisition at its stated scope.
[Release](https://github.com/mcsoderh/BodyHarvestRecomp/releases/tag/v1.0.0),
[component and package evidence](frontend-license-maintenance-2026-10-31.md).

## Runtime and profile boundaries

The entrypoint at `e90747cd09fd732340443c73ed0657eb9bee0fdf` registers the
frontend profile as the runtime configuration path and uses the upstream
single-game ROM picker. Its North American ROM entry uses hash
`0x9949AA9BC66F33CB`. The shipped player owns validation, byte-order
normalization and the private `bh.us.z64` copy. It runs the game from the
same player process. Portcove neither provides nor prepares the original.
[Entrypoint](https://github.com/mcsoderh/BodyHarvestRecomp/blob/e90747cd09fd732340443c73ed0657eb9bee0fdf/src/main/main.cpp).

The pinned frontend resolves the Windows profile under LocalAppData, except
when a deliberate working-folder `portable.txt` requests local data. The
managed archive uses the default profile. The copied ROM, configuration,
saves and mods remain under player/upstream ownership. Core can replace or
roll back its own runtime. Back up the actual external profile separately,
including when a prepared copy shares it. A change to the packaged marker,
profile coordinates, process lifetime or updater ownership needs renewed
assessment of the affected operation.
[Frontend path resolution](https://github.com/N64Recomp/RecompFrontend/blob/b1a1477c6556aeb7ed45defbfb5924f721efebc1/recompui/src/util/file.cpp).

## Reused validation

The managed route uses the existing NativePortable lifecycle and the
runtime-only ownership pattern used for CorsixTH. The checked per-title
entrypoint reuses install, update, staged activation, rollback and removal
with inert package members and verifies backup refusal when there is no
declared local player data. The existing explicit-registration and generic
download tests cover both routes beside the new managed offer. The observed
release inventory contains a competing macOS ZIP. The controlled successor
tests unchanged selection with a new digest and does not represent an actual
v1.0.1 release. Package inspection and controlled tests are separate from
native launch, gameplay, populated-save compatibility and protected delivery.
