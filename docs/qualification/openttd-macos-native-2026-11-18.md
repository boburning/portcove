# OpenTTD Mac native workflows

Observed November 18, 2026 UTC. Existing finite owner [#2716](https://github.com/boburning/portcove/issues/2716) remains closed. This evidence supplements its upstream desktop setup guide; it does not grant Supported or managed Android/desktop operations.

[Run 44234680460/1](https://github.com/boburning/portcove/actions/runs/44234680460/attempts/1) passed two sequential native workflows on each host: a generated map and the exact resulting exit save reopened in a separate private profile. The delivering agent inspected all four recovered screenshots and verified their hashes against the owned-window receipts. The same town and terrain appear in each host's replay with its game date advanced.

| Host                                     | Job          | CLI bytes | CLI SHA-256                                                        |
| ---------------------------------------- | ------------ | --------- | ------------------------------------------------------------------ |
| Apple Silicon, macOS 15.8.2 build 24H232 | 134567841885 | 160512392 | `72a12fb2ad920e081852419545da47c370602e550ab37deb896c8e604d37d0db` |
| Intel, macOS 15.7.9 build 24G830         | 134567841664 | 160827696 | `7bfa8a0c203401488ba4ae3efac98260b35c22de1eb3cdf85195bceefff19999` |

Both compiled ordinary product source `27b0a6e994545e622d67b3bea016d32665224192`; controller source was separately `e9d7d85f36a7ae350dee567f5fa5f404fc605634`. The selected private CLI copies were byte-identical to their retained producers and had one link. Actual universal-player CPU slice was not queried; host architecture is not substituted for that observation.

## Publisher inputs

The official OpenTTD 15.3 universal Mac ZIP, 15,540,074 bytes, matched publisher SHA-256 `c2ac22ab3ac9ac1e82a8d9029b7e4ab069e425904420076605d860e64460f579`. Its full `OpenTTD.app` was retained; selected `Contents/MacOS/openttd` SHA-256 was `591d1eefb15f3d7a31bd893df8c12eb5f0422e8123d3a9c0b8cb875ca0cf2ccf`.

Free OpenGFX 8.0 ZIP, 3,583,152 bytes, matched publisher SHA-256 `43a0c1dabf39cb865394f3a6cc36d4da5c10ecfaaf55652043104806810903be`. Each fresh profile was seeded with that free graphics set. No retail assets or save binaries were uploaded. Publisher sources: [OpenTTD downloads](https://www.openttd.org/downloads/openttd-releases/latest), [OpenGFX downloads](https://www.openttd.org/downloads/opengfx-releases/latest).

## Operations and preserved state

Core external preview and selection bound exact executable, working directory and literal arguments, including an explicit private `-c` configuration. Explicit CLI Play recorded the supervisor and child. Kernel BSD start time, executable path, parent and UID matched those records before input/capture. The complete generated-map and save-reopen workflows both exited normally with code 0, successful launch outcomes and positive owned-process exit. No forced cleanup was used.

Each host created its own exit save; replay checked that recorded identity before copying and verified both source and replay-input copies afterward. These are actual generated-world saves, not manufactured campaign progress:

| Host          | First save bytes | First save SHA-256                                                 | Replay's new save bytes | Replay's new save SHA-256                                          |
| ------------- | ---------------- | ------------------------------------------------------------------ | ----------------------- | ------------------------------------------------------------------ |
| Apple Silicon | 15084            | `1c1e811c01e165af2cd65d77f608e0659bfaae0d9d5327a4cdd1fbd06a62b74e` | 14956                   | `3153db888d57230d6980887c041dc7e382f54cc2e5fb51017142f3385b8eef15` |
| Intel         | 15020            | `c3552d8b6a4acd0cb1fb1f14362e26230a26f433ad48048e853fc2f8cbd13cfb` | 15088                   | `6b21f80c0e0b5a0ddcb649846d1759b509febda93acbb559bb1b4a1431552b7a` |

Publisher files stayed unchanged. Registration removal left matching before/after inventories of 157 fresh-profile and 158 replay-profile files per host across the package, private profile and newly created known global paths. Registrations were absent afterward. Native admission was released only after positive owned-process exits.

The delivering agent's inspected images show Bundinghead Cross (550), its terrain and industries. Apple Silicon advances January 5 to January 10, 1950; Intel advances January 5 to January 12. This does not establish transport/economic progress, audio, physical controls, retail assets, Tauri/pickers or managed installation/update/backup/rollback.

## Custody and retained failures

The [Apple Silicon receipt](https://github.com/boburning/portcove/issues/2716#issuecomment-6968839286) and [Intel receipt](https://github.com/boburning/portcove/issues/2716#issuecomment-6969009424) bind the results and retained local PNG/JSON/logs. Decode the full job logs with the existing `native-backup-evidence.mts recover` tool. Save binaries were excluded.

Earlier run 44231390196/1 failed before title execution at publisher HTTP 403 with Python's default User-Agent. Run 44232682092/1 downloaded and verified the inputs but failed the first CLI identity check at a generic 64 MiB bound. Both failures retain their actual prelaunch scope. The final controller uses truthful publisher request identification and streaming SHA-256 with a finite 512 MiB bound only for its own debug CLI; player/save/capture checks remain bounded. Independent source/repair review cleared the controller, while the final successful run and inspected images supply native evidence.
