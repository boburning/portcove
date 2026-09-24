# Open Nectar Pikmin Windows observations — 2026-09-24

This record documents the first Portcove integration exercise for Open Nectar.
It supports a limited Windows setup and supervised-launch workflow; it does not
qualify gameplay or make a supported-platform claim.

| Field | Observed value |
| --- | --- |
| Portcove catalog ID | `open-nectar-pikmin` |
| Upstream | [SSunnKing/Open-Nectar---Pikmin-Native-PC-Mobile-Port](https://github.com/SSunnKing/Open-Nectar---Pikmin-Native-PC-Mobile-Port) |
| Reviewed README | [commit `2462f20cecdf578d8a5ba77fb6dee36130fc668f`](https://github.com/SSunnKing/Open-Nectar---Pikmin-Native-PC-Mobile-Port/blob/2462f20cecdf578d8a5ba77fb6dee36130fc668f/README.md) |
| Exercised release | [0.8.5](https://github.com/SSunnKing/Open-Nectar---Pikmin-Native-PC-Mobile-Port/releases/tag/0.8.5) |
| Portcove platform | Windows x86-64 only |
| Tested source variant | Pikmin USA Rev. 1, supplied from private local storage |

The pinned README documents native Windows and Linux builds and Android, USA
Rev. 1 (`GPIE01` revision 1) and Europe (`GPIP01` revision 0) discs, and a
headless Windows launcher using `--rom`, `--install-dir`, and `--extract-only`.
Portcove's catalog accepts those two disc identities and ISO, GCM, RVZ, WIA, and
GCZ inputs. Europe, Linux, and Android were not exercised here.

## Release and preparation

Portcove resolved the Windows `nectar-windows.zip` release asset for 0.8.5. Its
size was 8,472,398 bytes and its GitHub-published SHA-256 was
`0e3ca0fddc6410747d735d98e0e515f534143417319af3f1c666c9b71b932d29`; the local
download matched that digest. The upstream release is unsigned, so this
integrity check binds the downloaded bytes to GitHub's release metadata and is
not a publisher signature.

The private RVZ input was byte-verified against the selected source profile,
then the official DolphinTool 2603a converted it to a temporary ISO for the
upstream launcher. The launcher completed its `--extract-only` preparation and
created the declared `assets/.pikmin-assets` marker. Portcove validated the
copied generated tree rather than relying on that marker alone: 3,497 asset
files totaling 661,389,111 bytes were admitted, including 55 filenames with
Unicode characters. The original disc and converted ISO remained outside the
installed payload.

Portcove's source record still reports the profile's pinned validator as
`not_run`. The launcher accepted the materialized input during preparation, but
the current source-verification record does not persist that setup result as a
validator pass. These are separate observations; this record does not claim a
Portcove source-validator pass.

The prepared tree writes player data to `save/` and
`pikmin_settings.conf`. A real first-launch run created nine
`nectar-windows/shader_cache` files, which the initial catalog definition had
not classified; verification correctly failed. The definition now owns only
that exact path as disposable runtime output. A newly prepared installation
then passed final verification after runtime writes: 3,504 files checked,
`valid=true`, with no failures. Saves and settings remain in managed player
storage.

## Launch and player-data observations

Portcove supervised two Windows launches of the prepared 0.8.5 installation.
Each started the `nectar.exe` process and displayed the Open Nectar main
window, then closed normally. This establishes startup only. No title-screen
interaction, gameplay, controls, rendering, audio, or in-game saving was
tested.

During each session, a synthetic probe file under `save/card0/` and an empty
`pikmin_settings.conf` were written in the actual runtime paths. After normal
supervisor exit, the active files and Portcove's canonical player-data copies
matched byte-for-byte. The probe is not a real game save. A later attempt to
test restore removed the active probe before relaunch; Portcove correctly
propagated that user deletion to canonical storage, so that attempt did not
test restore. The probe was recreated and collected on a subsequent normal
exit. Save restoration across launch remains untested.

## Release selection and limits

The Windows asset selector uses the stable `nectar-windows` hint rather than a
version-specific pin. Focused tests exercise a synthetic 0.8.5 to 0.8.6
successor with a distinct digest, and reject equally qualified Windows assets,
an unsupported Linux request, and a release lacking both a digest and a
checksum sidecar. The 0.8.6 case is a controlled fixture, not a claim about an
actual upstream successor.

The following remain unknown or untested:

- first gameplay, rendering, audio, controller and keyboard behavior;
- actual in-game save creation, loading, import, and restoration across launch;
- the Europe disc, Linux, Android, and other Windows hosts;
- a distinct upstream update, rollback, repair, backup/restore, or removal;
- behavior of a real future release beyond the controlled selector fixture; and
- production catalog-feed publication or availability to already-installed
  Portcove clients.

The catalog therefore declares only Windows x86-64 availability, retains an
empty Portcove-tested-platform list and no gameplay qualification records, and
states that gameplay has not been tested by Portcove.
