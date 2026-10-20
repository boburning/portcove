//! Fixed source-only cartridge recipes. Catalog data never supplies commands.
//!
//! These recipes use the existing cartridge installer, tool environment,
//! supervised worker, publication fence and immutable local-build receipt.
use super::{BuildArchive, TOOLCHAIN};
use crate::{PortcoveError, Result, SourceRecord};
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum SourceRecipe {
    AdvanceWarsUsaRev1,
    EarthBoundUsa,
    GundamWingJapan,
}

#[cfg(test)]
pub(in crate::cartridge_build) mod tests {
    use super::*;
    use std::collections::BTreeMap;

    pub(in crate::cartridge_build) fn fixture(
        recipe: SourceRecipe,
    ) -> (crate::PortDefinition, crate::SourceProfile) {
        let (mut port, mut profile) = super::super::tests::fixture_port();
        let facts = recipe.facts();
        let asset = recipe.primary_asset();
        port.id = facts.port_id.into();
        port.project_url = facts.project_url.into();
        port.source_profile = Some(facts.source_profile.into());
        port.release.provider = crate::ReleaseSource::DirectManifest;
        port.release.repository = facts
            .project_url
            .trim_start_matches("https://github.com/")
            .into();
        port.release.direct = BTreeMap::from([(
            crate::Platform::WindowsX86_64,
            crate::DirectReleaseSpec {
                version: facts.version.into(),
                url: asset.url,
                size: asset.size,
                sha256: asset.sha256,
                published_at: None,
            },
        )]);
        port.release.managed_build =
            BTreeMap::from([(crate::Platform::WindowsX86_64, recipe.recipe())]);
        port.release.asset_hints.clear();
        port.release.rolling_tag = None;
        port.executable_hints = BTreeMap::from([(
            crate::Platform::WindowsX86_64,
            vec![format!("{}.exe", facts.target)],
        )]);
        port.launch_arguments = vec![facts.original_filename.into()];
        port.launch_environment.clear();
        port.persistent_file_patterns.clear();
        port.persistent_paths = match recipe {
            SourceRecipe::AdvanceWarsUsaRev1 => vec!["game.sav", "game.eep"],
            SourceRecipe::EarthBoundUsa => vec![
                "config.ini",
                "config.local.ini",
                "keybinds.ini",
                "rom.cfg",
                "saves",
            ],
            SourceRecipe::GundamWingJapan => vec![
                "config.ini",
                "config.local.ini",
                "keybinds.ini",
                "rom.cfg",
                "saves",
            ],
        }
        .into_iter()
        .map(String::from)
        .collect();
        port.runtime_mutable_paths = if recipe == SourceRecipe::EarthBoundUsa {
            vec!["last_run_report.json".into(), "tier2_coverage.json".into()]
        } else if recipe == SourceRecipe::GundamWingJapan {
            vec![".snesrecomp_write_probe".into()]
        } else {
            vec![]
        };
        port.runtime_mutable_file_patterns = if recipe == SourceRecipe::EarthBoundUsa {
            vec![
                crate::PersistentFilePattern {
                    prefix: "crash_report_".into(),
                    suffix: ".json".into(),
                },
                crate::PersistentFilePattern {
                    prefix: "crash_minidump_".into(),
                    suffix: ".dmp".into(),
                },
            ]
        } else {
            vec![]
        };
        profile.id = facts.source_profile.into();
        profile.accepted_extensions = vec![
            if recipe != SourceRecipe::AdvanceWarsUsaRev1 {
                "sfc"
            } else {
                "gba"
            }
            .into(),
        ];
        profile.accepted_sha1.clear();
        profile.accepted_sha256.clear();
        match facts.original_identity {
            OriginalIdentity::Sha1(hash) => profile.accepted_sha1.push(hash.into()),
            OriginalIdentity::Sha256(hash) => profile.accepted_sha256.push(hash.into()),
        }
        (port, profile)
    }

    #[test]
    fn fixed_source_contracts_roundtrip_and_refuse_changed_output_source_or_writes() {
        for recipe in [
            SourceRecipe::AdvanceWarsUsaRev1,
            SourceRecipe::EarthBoundUsa,
            SourceRecipe::GundamWingJapan,
        ] {
            let (port, profile) = fixture(recipe);
            super::super::validate_port(&port, &profile).unwrap();
            assert_eq!(
                recipe.recipe().minimum_template_version(),
                if recipe == SourceRecipe::GundamWingJapan {
                    14
                } else {
                    9
                }
            );
            assert!(recipe.recipe().fixed_launch_arguments_only());
            assert_eq!(
                recipe.recipe().original_filename(),
                if recipe != SourceRecipe::AdvanceWarsUsaRev1 {
                    "game.sfc"
                } else {
                    "game.gba"
                }
            );
            let catalog = crate::Catalog::from_json(
                &serde_json::to_string(&crate::CatalogDocument {
                    schema_version: 1,
                    source_catalog: None,
                    source_profiles: vec![profile.clone()],
                    ports: vec![port.clone()],
                })
                .unwrap(),
            )
            .unwrap();
            let contract =
                crate::installed_contract::InstalledContract::capture(&catalog, &port.id).unwrap();
            let restored = contract.catalog(&port.id).unwrap();
            assert_eq!(
                serde_json::to_value(restored.port(&port.id).unwrap()).unwrap(),
                serde_json::to_value(&port).unwrap()
            );
            for changed in [
                "source",
                "executable",
                "argument",
                "mutable",
                "url",
                "setup",
            ] {
                let mut wrong = port.clone();
                match changed {
                    "source" => wrong.source_profile = Some("different-original".into()),
                    "executable" => {
                        wrong
                            .executable_hints
                            .insert(crate::Platform::WindowsX86_64, vec!["other.exe".into()]);
                    }
                    "argument" => wrong.launch_arguments.push("--record".into()),
                    "mutable" => wrong
                        .runtime_mutable_paths
                        .push(recipe.facts().original_filename.into()),
                    "url" => {
                        wrong
                            .release
                            .direct
                            .get_mut(&crate::Platform::WindowsX86_64)
                            .unwrap()
                            .url = "https://example.invalid/other.zip".into()
                    }
                    "setup" => wrong.setup_arguments.push("install".into()),
                    _ => unreachable!(),
                }
                assert!(
                    super::super::validate_port(&wrong, &profile).is_err(),
                    "{changed}"
                );
            }
        }
    }

    #[test]
    fn delivered_four_input_storage_identities_remain_unchanged() {
        // Frozen from f805cb5 before adding another source recipe.
        // Advance Wars uses an inert source digest; this is no original admission.
        for (recipe, original, expected) in [
            (
                SourceRecipe::AdvanceWarsUsaRev1,
                "1111111111111111111111111111111111111111111111111111111111111111",
                "d6b490ae9b3051ce9a23458435d28cf3daf2168809beed2ae14e8643a121795b",
            ),
            (
                SourceRecipe::EarthBoundUsa,
                "a8fe2226728002786d68c27ddddf0b90a894db52e4dfe268fdf72a68cae5f02e",
                "8f610f3778a5fcb3b5b0ea33196b64876ab1144aef7fa34aada7089b72b5fc64",
            ),
        ] {
            assert_eq!(
                recipe
                    .storage_identity(&recipe.primary_asset().sha256, original)
                    .unwrap(),
                expected
            );
            assert_eq!(recipe.archives().len(), 4);
        }
    }

    #[test]
    fn source_storage_binds_observed_sha256_even_for_sha1_original_contract() {
        let recipe = SourceRecipe::AdvanceWarsUsaRev1;
        let primary = recipe.primary_asset().sha256;
        let first = recipe.storage_identity(&primary, &"a".repeat(64)).unwrap();
        assert_ne!(
            first,
            recipe.storage_identity(&primary, &"b".repeat(64)).unwrap()
        );
        assert_ne!(
            first,
            SourceRecipe::EarthBoundUsa
                .storage_identity(&primary, &"a".repeat(64))
                .unwrap()
        );
        assert!(recipe.recipe().storage_identity(&primary).is_err());
    }

    #[test]
    fn original_record_metadata_cannot_authorize_wrong_raw_bytes_or_container() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("wrong.gba");
        std::fs::write(&file, b"wrong original").unwrap();
        for recipe in [
            SourceRecipe::AdvanceWarsUsaRev1,
            SourceRecipe::EarthBoundUsa,
            SourceRecipe::GundamWingJapan,
        ] {
            let facts = recipe.facts();
            let mut record = SourceRecord {
                profile_id: facts.source_profile.into(),
                path: file.clone(),
                sha256: super::super::digest(b"wrong original"),
                size: 14,
                storage_sha256: super::super::digest(b"wrong original"),
                storage_size: 14,
                updated_at: 0,
                observed_identity: None,
            };
            assert!(recipe.verify_original(&record, &|| Ok(())).is_err());
            record.storage_size += 1;
            assert!(recipe.verify_original(&record, &|| Ok(())).is_err());
        }
    }

    #[test]
    fn copied_original_is_bound_to_record_before_a_generator_can_consume_it() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("original.gba");
        let target = root.path().join("owned.gba");
        std::fs::write(&source, b"known bytes").unwrap();
        let record = SourceRecord {
            profile_id: "inert-fixture".into(),
            path: source,
            sha256: super::super::digest(b"known bytes"),
            size: 11,
            storage_sha256: super::super::digest(b"known bytes"),
            storage_size: 11,
            updated_at: 0,
            observed_identity: None,
        };
        SourceRecipe::copy_original(&record, &target, &|| Ok(())).unwrap();
        let changed = root.path().join("changed.gba");
        let calls = std::cell::Cell::new(0);
        assert!(
            SourceRecipe::copy_original(&record, &changed, &|| {
                calls.set(calls.get() + 1);
                if calls.get() == 2 {
                    std::fs::write(&changed, b"other bytes")?;
                }
                Ok(())
            })
            .is_err()
        );
    }

    #[test]
    fn dynamic_sdl_override_is_case_insensitively_refused_without_changing_the_host() {
        for name in ["SDL_DYNAMIC_API", "sdl_dynamic_api", "SdL_DyNaMiC_ApI"] {
            assert!(
                SourceRecipe::require_environment([(name.into(), "other.dll".into())]).is_err()
            );
        }
        assert!(
            SourceRecipe::require_environment([
                ("SDL_DYNAMIC_API".into(), "".into()),
                ("SDL_VIDEODRIVER".into(), "windows".into())
            ])
            .is_ok()
        );
    }
}

const ADVANCE_WARS: BuildArchive = BuildArchive {
    name: "advancewars-cb3facb53b6be32e4fc37e04d849ff4dddbab05f.zip",
    url: "https://codeload.github.com/sp00nznet/advancewars/zip/cb3facb53b6be32e4fc37e04d849ff4dddbab05f",
    size: 404_382,
    sha256: "fde85176e027f1fb78e7d5354817ef4e0baf28474bfcdab9bf0b4a7cd7d1057e",
    root: "advancewars-cb3facb53b6be32e4fc37e04d849ff4dddbab05f",
};
const GBARECOMP: BuildArchive = BuildArchive {
    name: "gbarecomp-ac1176f467cbb708f58785e65f36b4f091a8ab20.zip",
    url: "https://codeload.github.com/sp00nznet/gbarecomp/zip/ac1176f467cbb708f58785e65f36b4f091a8ab20",
    size: 365_706,
    sha256: "8f59c14663cb8b85b7ae02175d1208352eeebc174de6ff02bea2cc1c2d11b7fb",
    root: "gbarecomp-ac1176f467cbb708f58785e65f36b4f091a8ab20",
};
const EARTHBOUND: BuildArchive = BuildArchive {
    name: "EarthBoundRecomp-fe1155dc26ffc40df36a8003dd0e639e17af3349.zip",
    url: "https://codeload.github.com/nickclyde/EarthBoundRecomp/zip/fe1155dc26ffc40df36a8003dd0e639e17af3349",
    size: 69_441,
    sha256: "3cb01dc15d769defa1a8c3428b1ef5ce50f9c1cc224e3f0347f751841fc84710",
    root: "EarthBoundRecomp-fe1155dc26ffc40df36a8003dd0e639e17af3349",
};
const SNESRECOMP: BuildArchive = BuildArchive {
    name: "snesrecomp-27197198522b1ddec502be2fc8d76401a8cbe238.zip",
    url: "https://codeload.github.com/mstan/snesrecomp/zip/27197198522b1ddec502be2fc8d76401a8cbe238",
    size: 4_469_813,
    sha256: "b3ffdc6dffbf3b010836f94c39d87e64c9ad1635bf2478c6d33f1c652e069145",
    root: "snesrecomp-27197198522b1ddec502be2fc8d76401a8cbe238",
};
const SDL2: BuildArchive = BuildArchive {
    name: "SDL2-devel-2.32.10-mingw.zip",
    url: "https://github.com/libsdl-org/SDL/releases/download/release-2.32.10/SDL2-devel-2.32.10-mingw.zip",
    size: 14_260_563,
    sha256: "f15cff5fca62ec9381a016ef1d42a95c638cd72d2f226ba5781c76fe43dbd1ac",
    root: "SDL2-2.32.10",
};

#[derive(Clone, Copy)]
pub(super) enum OriginalIdentity {
    Sha1(&'static str),
    Sha256(&'static str),
}

pub(super) struct SourceFacts {
    pub port_id: &'static str,
    pub source_profile: &'static str,
    pub project_url: &'static str,
    pub target: &'static str,
    pub version: &'static str,
    pub original_filename: &'static str,
    pub original_size: Option<u64>,
    pub original_identity: OriginalIdentity,
    pub game: BuildArchive,
    pub engine: BuildArchive,
}

impl SourceRecipe {
    fn copy_original(
        source: &SourceRecord,
        target: &Path,
        checkpoint: &dyn Fn() -> Result<()>,
    ) -> Result<()> {
        super::copy_verified(&source.path, target, checkpoint)?;
        if crate::adapter::hash_file_bounded_with_checkpoint(target, source.size, checkpoint)?
            != (source.sha256.clone(), source.size)
        {
            return Err(PortcoveError::source(
                "owned build original differs from the admitted source",
            ));
        }
        Ok(())
    }

    pub(super) fn recipe(self) -> crate::CartridgeBuildRecipe {
        match self {
            Self::AdvanceWarsUsaRev1 => crate::CartridgeBuildRecipe::AdvanceWarsGbaSourceV1,
            Self::EarthBoundUsa => crate::CartridgeBuildRecipe::EarthBoundSnesSourceV1,
            Self::GundamWingJapan => crate::CartridgeBuildRecipe::GundamWingSnesSourceV1,
        }
    }

    pub(super) fn primary_asset(self) -> crate::ReleaseAsset {
        let facts = self.facts();
        // GitHub's archive URL preserves a .zip filename for the existing
        // downloader. Auxiliary acquisition still uses its fixed codeload URL.
        let revision = facts.game.url.rsplit('/').next().unwrap_or_default();
        crate::ReleaseAsset {
            name: format!("{revision}.zip"),
            url: format!("{}/archive/{revision}.zip", facts.project_url),
            size: facts.game.size,
            sha256: facts.game.sha256.into(),
        }
    }

    pub(super) fn validate_port(
        self,
        port: &crate::PortDefinition,
        profile: &crate::SourceProfile,
    ) -> Result<()> {
        use std::collections::BTreeMap;
        let facts = self.facts();
        let executable = format!("{}.exe", facts.target);
        let primary = self.primary_asset();
        let direct = BTreeMap::from([(
            crate::Platform::WindowsX86_64,
            crate::DirectReleaseSpec {
                version: facts.version.into(),
                url: primary.url,
                size: primary.size,
                sha256: primary.sha256,
                published_at: None,
            },
        )]);
        let (extension, persistent, mutable): (&str, &[&str], &[&str]) = match self {
            Self::AdvanceWarsUsaRev1 => ("gba", &["game.sav", "game.eep"], &[]),
            Self::EarthBoundUsa => (
                "sfc",
                &[
                    "config.ini",
                    "config.local.ini",
                    "keybinds.ini",
                    "rom.cfg",
                    "saves",
                ],
                &["last_run_report.json", "tier2_coverage.json"],
            ),
            Self::GundamWingJapan => (
                "sfc",
                &[
                    "config.ini",
                    "config.local.ini",
                    "keybinds.ini",
                    "rom.cfg",
                    "saves",
                ],
                &[".snesrecomp_write_probe"],
            ),
        };
        let patterns = if self == Self::EarthBoundUsa {
            vec![
                crate::PersistentFilePattern {
                    prefix: "crash_report_".into(),
                    suffix: ".json".into(),
                },
                crate::PersistentFilePattern {
                    prefix: "crash_minidump_".into(),
                    suffix: ".dmp".into(),
                },
            ]
        } else {
            Vec::new()
        };
        let identity = match facts.original_identity {
            OriginalIdentity::Sha1(hash) => {
                profile.accepted_sha1 == [hash] && profile.accepted_sha256.is_empty()
            }
            OriginalIdentity::Sha256(hash) => {
                profile.accepted_sha256 == [hash] && profile.accepted_sha1.is_empty()
            }
        };
        if port.id != facts.port_id
            || port.project_url != facts.project_url
            || port.release.provider != crate::ReleaseSource::DirectManifest
            || port.release.repository
                != facts.project_url.trim_start_matches("https://github.com/")
            || serde_json::to_value(&port.release.direct)? != serde_json::to_value(direct)?
            || port.release.managed_build
                != BTreeMap::from([(crate::Platform::WindowsX86_64, self.recipe())])
            || !port.release.user_prepared.is_empty()
            || !port.release.curated.is_empty()
            || !port.release.asset_hints.is_empty()
            || port.release.rolling_tag.is_some()
            || port.platforms != [crate::Platform::WindowsX86_64]
            || port.channels != [crate::ReleaseChannel::Stable]
            || port.adapter != crate::AdapterKind::StagedSourcePortable
            || port.portable_marker
            || port.n64_windows_initial_d3d12
            || port.launch_from_install_root
            || port.source_profile.as_deref() != Some(facts.source_profile)
            || profile.id != facts.source_profile
            || port.bios_source_profile.is_some()
            || profile.kind != crate::SourceKind::File
            || profile.accepted_extensions != [extension]
            || !identity
            || port.executable_hints
                != BTreeMap::from([(crate::Platform::WindowsX86_64, vec![executable])])
            || port
                .persistent_paths
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>()
                != persistent
            || port
                .runtime_mutable_paths
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>()
                != mutable
            || !port.persistent_file_patterns.is_empty()
            || port.runtime_mutable_file_patterns != patterns
            || !port.bundled_runtime.is_empty()
            || port.runtime_subdirectory.is_some()
            || port.runtime_source_filename.is_some()
            || port.runtime_source_materialization.is_some()
            || !port.runtime_source_hashes.is_empty()
            || !port.runtime_source_set.is_empty()
            || port.source_environment.is_some()
            || port.user_data_environment.is_some()
            || !port.launch_environment.is_empty()
            || port.launch_arguments != [facts.original_filename]
            || !port.setup_executable_hints.is_empty()
            || !port.setup_arguments.is_empty()
            || port.setup_marker.is_some()
            || !port.setup_output_paths.is_empty()
        {
            return Err(PortcoveError::verification(
                "fixed source build does not match its original, acquisition and runtime contract",
            ));
        }
        Ok(())
    }

    pub(super) fn prepare_install(
        self,
        work: &Path,
        payload: &Path,
        preparation: &super::CartridgeBuildPreparation,
        library: &crate::Library,
        operation: &crate::OperationCoordinator,
        quiesced: &mut bool,
    ) -> Result<()> {
        use super::{
            BuildInputs, BuildSession, RECEIPT, cmake_path, copy_verified, digest, inventory,
            write_new,
        };
        let checkpoint = || operation.checkpoint();
        self.verify_original(&preparation.source, &checkpoint)?;
        let facts = self.facts();
        let inputs = BuildInputs::capture(work, preparation.recipe, &checkpoint)?;
        std::fs::create_dir(work.join("temp"))?;
        std::fs::create_dir(work.join("build"))?;
        let session = BuildSession {
            inputs: &inputs,
            work,
            library,
            operation,
            deadline: std::time::Instant::now(),
            port_id: facts.port_id,
        };
        let (project, generation) =
            self.generate(&inputs, work, &preparation.source, &session, quiesced)?;
        let generated_root = project.join(match self {
            Self::AdvanceWarsUsaRev1 => "gen",
            Self::EarthBoundUsa | Self::GundamWingJapan => "src/gen",
        });
        let generated_files = inventory(&generated_root, &checkpoint)?;
        let generated_c_count = generated_files
            .iter()
            .filter(|file| file.path.ends_with(".c"))
            .count();
        if generated_c_count == 0 || generated_c_count > 256 {
            return Err(PortcoveError::verification(
                "generated compiler input inventory exceeds fixed recipe bounds",
            ));
        }
        let compiler_count = match self {
            Self::AdvanceWarsUsaRev1 => generated_c_count,
            // Pinned runner: 41 common/hardware inputs + Cx4 + config +
            // post-mortem; pinned game: five handwritten C inputs. Generated
            // sources are inventoried independently of the Ninja graph.
            Self::EarthBoundUsa => 49 + generated_c_count,
            // Independently counted in the authenticated offline CMake graph:
            // 66 runner/Cx4 inputs + config + seven game files + optional
            // presentation stubs + two real shared presentation helpers +
            // the real state-digest implementation (no transport).
            Self::GundamWingJapan => 78 + generated_c_count,
        };
        let project_inputs = inventory(&project, &checkpoint)?;
        let build = work.join("build");
        let build_project = if self == Self::AdvanceWarsUsaRev1 {
            generated_root
        } else {
            project.clone()
        };
        let mut arguments = super::configure_arguments(&inputs, &build_project, &build)?;
        arguments.extend([
            format!(
                "-DSDL2_DIR={}",
                cmake_path(&inputs.roots[2].join("x86_64-w64-mingw32/lib/cmake/SDL2"))?
            ),
            "-DCMAKE_REQUIRE_FIND_PACKAGE_SDL2=ON".into(),
        ]);
        if self == Self::EarthBoundUsa {
            arguments.extend([
                "-DSNESRECOMP_SDL_BACKEND=SDL2".into(),
                "-DEB_LAUNCHER_UI=OFF".into(),
                "-DSNESRECOMP_ENABLE_MODS=OFF".into(),
                "-DSNESRECOMP_ENABLE_NET=OFF".into(),
                "-DSNESRECOMP_ENABLE_TRACE=OFF".into(),
                "-DSNES_COSIM=OFF".into(),
                format!("-DSNESRECOMP_BUILD_VERSION={}", facts.version),
            ]);
        }
        session.run(
            &arguments,
            "bin/cmake.exe",
            "install.cartridge.source.configure",
            quiesced,
        )?;
        let graph = crate::path::read_bounded_regular(&build.join("build.ninja"), 1024 * 1024)?;
        if graph
            .windows(b"GBA_NO_SDL".len())
            .any(|window| window == b"GBA_NO_SDL")
        {
            return Err(PortcoveError::verification(
                "fixed GBA recipe refuses a headless-only build",
            ));
        }
        inputs.verify(&preparation.source, &checkpoint)?;
        if inventory(&project, &checkpoint)? != project_inputs {
            return Err(PortcoveError::verification(
                "configure changed authenticated or generated project inputs",
            ));
        }
        let plan = Self::compile_target(&session, &build, facts.target, compiler_count, quiesced)?;
        inputs.verify(&preparation.source, &checkpoint)?;
        if inventory(&project, &checkpoint)? != project_inputs {
            return Err(PortcoveError::verification(
                "compiler changed authenticated or generated project inputs",
            ));
        }
        let package = work.join("runtime");
        std::fs::create_dir(&package)?;
        let executable = format!("{}.exe", facts.target);
        copy_verified(
            &build.join(&executable),
            &package.join(&executable),
            &checkpoint,
        )?;
        copy_verified(
            &inputs.roots[2].join("x86_64-w64-mingw32/bin/SDL2.dll"),
            &package.join("SDL2.dll"),
            &checkpoint,
        )?;
        for name in ["libc++.dll", "libunwind.dll"] {
            copy_verified(
                &inputs.tool(&format!("bin/{name}"))?,
                &package.join(name),
                &checkpoint,
            )?;
        }
        Self::copy_original(
            &preparation.source,
            &package.join(facts.original_filename),
            &checkpoint,
        )?;
        let game_notices: &[(&str, &str)] = match self {
            Self::AdvanceWarsUsaRev1 => &[
                ("LICENSE", "Game-LICENSE.txt"),
                ("README.md", "Game-README.md"),
            ],
            Self::EarthBoundUsa => &[
                ("README.md", "Game-README.md"),
                ("refs/eb-disasm.pin", "eb-disasm.pin"),
            ],
            Self::GundamWingJapan => &[
                ("LICENSE", "Game-LICENSE.txt"),
                ("README.md", "Game-README.md"),
            ],
        };
        for (from, to) in game_notices {
            copy_verified(
                &inputs.roots[0].join(from),
                &package.join("licenses").join(to),
                &checkpoint,
            )?;
        }
        let engine_notices: &[(&str, &str)] = match self {
            Self::AdvanceWarsUsaRev1 => &[
                ("LICENSE", "gbarecomp-LICENSE.txt"),
                ("README.md", "gbarecomp-README.md"),
            ],
            Self::EarthBoundUsa => &[
                ("README.md", "snesrecomp-README.md"),
                (
                    "THIRD_PARTY_ATTRIBUTION.md",
                    "snesrecomp-THIRD_PARTY_ATTRIBUTION.md",
                ),
            ],
            Self::GundamWingJapan => &[
                ("LICENSE", "snesrecomp-LICENSE.txt"),
                ("README.md", "snesrecomp-README.md"),
                (
                    "THIRD_PARTY_ATTRIBUTION.md",
                    "snesrecomp-THIRD_PARTY_ATTRIBUTION.md",
                ),
            ],
        };
        for (from, to) in engine_notices {
            copy_verified(
                &inputs.roots[1].join(from),
                &package.join("licenses").join(to),
                &checkpoint,
            )?;
        }
        copy_verified(
            &inputs.roots[2].join("LICENSE.txt"),
            &package.join("licenses/SDL2-LICENSE.txt"),
            &checkpoint,
        )?;
        if self == Self::GundamWingJapan {
            copy_verified(
                &inputs.roots[5].join("LICENSE"),
                &package.join("licenses/recomp-ui-LICENSE.txt"),
                &checkpoint,
            )?;
        }
        copy_verified(
            &inputs.roots[3].join("LICENSE.TXT"),
            &package.join("licenses/LLVM-LICENSE.txt"),
            &checkpoint,
        )?;
        let mut imports = std::collections::BTreeMap::new();
        for (index, name) in [
            executable.as_str(),
            "SDL2.dll",
            "libc++.dll",
            "libunwind.dll",
        ]
        .iter()
        .enumerate()
        {
            imports.insert(
                *name,
                session.inspect_imports(
                    &package.join(name),
                    &format!("install.cartridge.source.imports.{index}"),
                    quiesced,
                )?,
            );
        }
        inputs.verify(&preparation.source, &checkpoint)?;
        let output = inventory(&package, &checkpoint)?;
        if !output.iter().any(|file| {
            file.path == facts.original_filename
                && file.sha256 == preparation.source.sha256
                && file.size == preparation.source.size
        }) {
            return Err(PortcoveError::source(
                "published original differs from the admitted source",
            ));
        }
        if !*quiesced {
            return Err(PortcoveError::state(
                "source builder has no quiescence proof",
            ));
        }
        let receipt = serde_json::json!({
            "format_version":1,"recipe":preparation.recipe,"runtime_origin":"locally-built",
            "original_sha256":preparation.source.sha256,"original_size":preparation.source.size,
            "auxiliary_archives":self.archives(),"input_tree_identities":inputs.identities,
            "derived_project_sha256":digest(&serde_json::to_vec(&project_inputs)?),
            "generated_sources":generated_files,"generation":generation,"configure_arguments":arguments,
            "compilation":{"plan":plan,"objects_per_invocation":super::OBJECTS_PER_INVOCATION,"independent_object_count":compiler_count,"supervisor_event_limit_unchanged":true},
            "imports":imports,"runtime_files":output,"builder_quiesced":*quiesced,
            "game_executed_by_builder":false,"use_scope":"private original-bound build; no binary redistribution grant inferred",
        });
        write_new(
            &package.join(RECEIPT),
            &serde_json::to_vec_pretty(&receipt)?,
        )?;
        self.verify_original(&preparation.source, &checkpoint)?;
        let parent = work
            .parent()
            .ok_or_else(|| PortcoveError::state("source build has no operation root"))?;
        if work.file_name() != Some(std::ffi::OsStr::new("cartridge-build"))
            || payload != parent.join("payload")
        {
            return Err(PortcoveError::state(
                "source build output is outside its private operation",
            ));
        }
        crate::path::refuse_symlink_ancestors(payload)?;
        crate::durability::rename_noreplace(payload, &work.join("primary-runtime-input"))?;
        crate::durability::rename_noreplace(&package, payload)?;
        checkpoint()
    }

    fn generate(
        self,
        inputs: &super::BuildInputs,
        work: &Path,
        source: &SourceRecord,
        session: &super::BuildSession<'_>,
        quiesced: &mut bool,
    ) -> Result<(PathBuf, serde_json::Value)> {
        let checkpoint = || session.operation.checkpoint();
        let project = self.copy_project(inputs, work, &checkpoint)?;
        let original = project.join(self.facts().original_filename);
        Self::copy_original(source, &original, &checkpoint)?;
        let before = super::inventory(&project, &checkpoint)?;
        let metadata = match self {
            Self::AdvanceWarsUsaRev1 => {
                let host_build = work.join("host-build");
                std::fs::create_dir(&host_build)?;
                let configure = super::configure_arguments(inputs, &inputs.roots[1], &host_build)?;
                session.run(
                    &configure,
                    "bin/cmake.exe",
                    "install.cartridge.source.host.configure",
                    quiesced,
                )?;
                // Seven independently listed host C files in the pinned toolkit.
                let plan = Self::compile_target(session, &host_build, "gbarecomp", 7, quiesced)?;
                let host = host_build.join("gbarecomp.exe");
                let host_identity = crate::adapter::hash_file_bounded_with_checkpoint(
                    &host,
                    64 * 1024 * 1024,
                    &checkpoint,
                )?;
                if host_identity.1 == 0 {
                    return Err(PortcoveError::verification(
                        "generated GBA translator is empty",
                    ));
                }
                let imports = session.inspect_imports(
                    &host,
                    "install.cartridge.source.host.imports",
                    quiesced,
                )?;
                if imports.iter().any(|name| name == "sdl2.dll") {
                    return Err(PortcoveError::verification(
                        "GBA translator has an undeclared SDL dependency",
                    ));
                }
                let script = work.join("translate.cmake");
                super::write_new(&script, br#"execute_process(COMMAND "${PROGRAM}" translate "${ROM}" -o "${OUTPUT}" --multi --entries "${ENTRIES}" WORKING_DIRECTORY "${ENGINE}" TIMEOUT 180 RESULT_VARIABLE result)
if(NOT result STREQUAL "0")
  message(FATAL_ERROR "fixed GBA translation failed: ${result}")
endif()
"#)?;
                let arguments = vec![
                    format!("-DPROGRAM={}", super::cmake_path(&host)?),
                    format!("-DROM={}", super::cmake_path(&original)?),
                    format!("-DOUTPUT={}", super::cmake_path(&project.join("gen"))?),
                    format!(
                        "-DENTRIES={}",
                        super::cmake_path(&project.join("entries.txt"))?
                    ),
                    format!("-DENGINE={}", super::cmake_path(&inputs.roots[1])?),
                    "-P".into(),
                    super::cmake_path(&script)?,
                ];
                inputs.verify(source, &checkpoint)?;
                session.run(
                    &arguments,
                    "bin/cmake.exe",
                    "install.cartridge.source.generate",
                    quiesced,
                )?;
                if crate::adapter::hash_file(&host)? != host_identity {
                    return Err(PortcoveError::verification(
                        "generated GBA translator changed during execution",
                    ));
                }
                serde_json::json!({"host_sha256":host_identity.0,"host_size":host_identity.1,"host_imports":imports,"host_plan":plan,"host_configure":configure,"arguments":arguments})
            }
            Self::EarthBoundUsa => {
                let tools = project.join("snesrecomp/tools");
                let emit = Self::python_arguments(
                    &tools.join("v2_emit.py"),
                    vec![
                        "--rom".into(),
                        super::cmake_path(&original)?,
                        "--cfg-dir".into(),
                        super::cmake_path(&project.join("recomp"))?,
                        "--out-dir".into(),
                        super::cmake_path(&project.join("src/gen"))?,
                        "--analysis-backend".into(),
                        "python".into(),
                    ],
                )?;
                session.run(
                    &emit,
                    "python/python.exe",
                    "install.cartridge.source.generate",
                    quiesced,
                )?;
                let sync = Self::python_arguments(
                    &tools.join("v2_sync_funcs_h.py"),
                    vec![
                        "--cfg-dir".into(),
                        super::cmake_path(&project.join("recomp"))?,
                        "--out".into(),
                        super::cmake_path(&project.join("recomp/funcs.h"))?,
                    ],
                )?;
                session.run(
                    &sync,
                    "python/python.exe",
                    "install.cartridge.source.headers",
                    quiesced,
                )?;
                serde_json::json!({"analysis_backend":"python","emit_arguments":emit,"header_arguments":sync})
            }
            Self::GundamWingJapan => {
                let analyzer = super::gundam::analyzer(inputs)?;
                let observed = session.run(
                    &super::gundam::analyzer_arguments(&analyzer)?,
                    "bin/llvm-readobj.exe",
                    "install.cartridge.source.analyzer.imports",
                    quiesced,
                )?;
                let imports = super::gundam::analyzer_imports(&observed)?;
                let arguments = Self::python_arguments(
                    &project.join("snesrecomp/tools/regen_project.py"),
                    vec![
                        "--project-root".into(),
                        super::cmake_path(&project)?,
                        "--rom".into(),
                        super::cmake_path(&original)?,
                        "--no-tests".into(),
                    ],
                )?;
                inputs.verify(source, &checkpoint)?;
                session.run_configured(
                    &arguments,
                    "python/python.exe",
                    "install.cartridge.source.generate",
                    quiesced,
                    |command| {
                        // An explicit authenticated path fails if missing;
                        // upstream cannot fall back to Cargo or network builds.
                        command.env("SNESRECOMP_NATIVE_ANALYZER", &analyzer);
                        Ok(())
                    },
                )?;
                super::gundam::analyzer(inputs)?;
                serde_json::json!({"analysis_backend":"native","analyzer_sha256":super::gundam::ANALYZER_SHA256,"analyzer_imports":imports,"arguments":arguments,"project_recipe":"cfg_roots=true; no prepare/postprocess hooks"})
            }
        };
        inputs.verify(source, &checkpoint)?;
        let after = super::inventory(&project, &checkpoint)?;
        // Generators may create their declared output and replace only the
        // derived SNES header. Authenticated input trees stay unchanged.
        let generated = match self {
            Self::AdvanceWarsUsaRev1 => "gen/",
            Self::EarthBoundUsa | Self::GundamWingJapan => "src/gen/",
        };
        let retained = |files: &[super::FileIdentity]| {
            files
                .iter()
                .filter(|file| {
                    !file.path.starts_with(generated)
                        && !(self != Self::AdvanceWarsUsaRev1 && file.path == "recomp/funcs.h")
                })
                .cloned()
                .collect::<Vec<_>>()
        };
        if retained(&before) != retained(&after) {
            return Err(PortcoveError::verification(
                "source generator changed undeclared project inputs",
            ));
        }
        Ok((project, metadata))
    }

    fn compile_target(
        session: &super::BuildSession<'_>,
        build: &Path,
        target: &str,
        count: usize,
        quiesced: &mut bool,
    ) -> Result<super::CompilePlan> {
        let plan = super::CompilePlan::read_target(build, target, count..=count)?;
        for (index, objects) in plan
            .object_targets
            .chunks(super::OBJECTS_PER_INVOCATION)
            .enumerate()
        {
            plan.require_unchanged(build)?;
            let mut arguments = vec![
                "-C".into(),
                super::cmake_path(build)?,
                "-j".into(),
                "2".into(),
            ];
            arguments.extend(objects.iter().cloned());
            session.run(
                &arguments,
                "bin/ninja.exe",
                &format!("install.cartridge.source.{target}.objects.{index}"),
                quiesced,
            )?;
            plan.require_unchanged(build)?;
        }
        session.run(
            &[
                "--build".into(),
                super::cmake_path(build)?,
                "--config".into(),
                "Release".into(),
                "--parallel".into(),
                "2".into(),
                "--target".into(),
                target.into(),
            ],
            "bin/cmake.exe",
            &format!("install.cartridge.source.{target}.link"),
            quiesced,
        )?;
        plan.require_unchanged(build)?;
        Ok(plan)
    }

    pub(super) fn require_runtime_environment(self) -> Result<()> {
        Self::require_environment(std::env::vars_os())
    }

    fn require_environment(
        environment: impl IntoIterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
    ) -> Result<()> {
        // SDL2's ordinary host/session hints remain available. Its dynamic API
        // override substitutes executable code for the authenticated SDL DLL,
        // so it cannot participate in either fixed recipe's launch contract.
        if environment.into_iter().any(|(name, value)| {
            name.to_string_lossy()
                .eq_ignore_ascii_case("SDL_DYNAMIC_API")
                && !value.is_empty()
        }) {
            return Err(PortcoveError::launch(
                "this fixed source runtime requires SDL_DYNAMIC_API to be unset; remove the override and restart Portcove",
            ));
        }
        Ok(())
    }

    fn copy_project(
        self,
        inputs: &super::BuildInputs,
        work: &Path,
        checkpoint: &dyn Fn() -> Result<()>,
    ) -> Result<PathBuf> {
        let project = work.join("project");
        std::fs::create_dir(&project)?;
        for file in &inputs.identities[0] {
            super::copy_verified(
                &inputs.roots[0].join(&file.path),
                &project.join(&file.path),
                checkpoint,
            )?;
        }
        if self != Self::AdvanceWarsUsaRev1 {
            for file in &inputs.identities[1] {
                super::copy_verified(
                    &inputs.roots[1].join(&file.path),
                    &project.join("snesrecomp").join(&file.path),
                    checkpoint,
                )?;
            }
        }
        if self == Self::GundamWingJapan {
            super::gundam::project(inputs, &project, checkpoint)?;
        }
        Ok(project)
    }

    fn python_arguments(script: &Path, arguments: Vec<String>) -> Result<Vec<String>> {
        let tools = script
            .parent()
            .ok_or_else(|| PortcoveError::state("generator has no tools root"))?;
        // Isolated Python imports only from its authenticated standard library
        // and the fixed framework tools directory. Neither cwd nor an ambient
        // PYTHONPATH chooses generator code.
        let mut command = vec![
            "-I".into(),
            "-B".into(),
            "-c".into(),
            "import runpy,sys;sys.path.insert(0,sys.argv[1]);sys.argv=sys.argv[2:];runpy.run_path(sys.argv[0],run_name='__main__')".into(),
            super::cmake_path(tools)?,
            super::cmake_path(script)?,
        ];
        command.extend(arguments);
        Ok(command)
    }

    pub(super) fn facts(self) -> SourceFacts {
        match self {
            Self::AdvanceWarsUsaRev1 => SourceFacts {
                port_id: "advance-wars-recompiled",
                source_profile: "advance-wars-gba-usa-rev1",
                project_url: "https://github.com/sp00nznet/advancewars",
                target: "AWRE",
                version: "source-cb3facb53b6b",
                original_filename: "game.gba",
                // Upstream identifies this original by SHA1. Do not invent a
                // canonical length; retain the finite GBA cartridge bound.
                original_size: None,
                original_identity: OriginalIdentity::Sha1(
                    "15053499d5b3f49128a941d7f2d84876f5424d0c",
                ),
                game: ADVANCE_WARS,
                engine: GBARECOMP,
            },
            Self::EarthBoundUsa => SourceFacts {
                port_id: "earthbound-recomp",
                source_profile: "earthbound-snes-usa",
                project_url: "https://github.com/nickclyde/EarthBoundRecomp",
                target: "EarthBoundRecomp",
                version: "source-fe1155dc26ff",
                original_filename: "game.sfc",
                original_size: Some(3_145_728),
                original_identity: OriginalIdentity::Sha256(
                    "a8fe2226728002786d68c27ddddf0b90a894db52e4dfe268fdf72a68cae5f02e",
                ),
                game: EARTHBOUND,
                engine: SNESRECOMP,
            },
            Self::GundamWingJapan => SourceFacts {
                port_id: "gundam-wing-endless-duel-recomp",
                source_profile: "gundam-wing-endless-duel-snes-japan",
                project_url: "https://github.com/TechnicallyComputers/GundamWingEndlessDuelSNESRecomp",
                target: "GundamWingEndlessDuelSNESRecomp",
                version: "source-c7aaaa152192",
                original_filename: "game.sfc",
                original_size: Some(2_097_152),
                original_identity: OriginalIdentity::Sha256(
                    "dd94308d822636c6ddf73c5e2644c84f2eb8fb4d9201150fc5f37d44d6f423f1",
                ),
                game: super::gundam::GAME,
                engine: super::gundam::ENGINE,
            },
        }
    }

    pub(super) fn archives(self) -> Vec<BuildArchive> {
        let facts = self.facts();
        let mut archives = vec![facts.game, facts.engine, SDL2, TOOLCHAIN];
        if self == Self::GundamWingJapan {
            archives.extend([super::gundam::ANALYZER, super::gundam::UI]);
        }
        archives
    }

    pub(super) fn storage_identity(
        self,
        primary_sha256: &str,
        source_sha256: &str,
    ) -> Result<String> {
        Ok(super::digest(&serde_json::to_vec(&(
            "Portcove fixed source cartridge build v1",
            self,
            primary_sha256,
            source_sha256,
            self.archives(),
        ))?))
    }

    pub(super) fn verify_original(
        self,
        source: &SourceRecord,
        checkpoint: &dyn Fn() -> Result<()>,
    ) -> Result<()> {
        use sha1::Digest;
        checkpoint()?;
        let facts = self.facts();
        // The build consumes a raw, verified original. Container registration
        // alone does not authorize giving archive bytes to the compiler.
        if source.profile_id != facts.source_profile
            || source.size == 0
            || source.size > 32 * 1024 * 1024
            || facts.original_size.is_some_and(|size| source.size != size)
            || source.storage_size != source.size
            || source.storage_sha256 != source.sha256
        {
            return Err(PortcoveError::source(
                "fixed source build requires its verified raw original file",
            ));
        }
        crate::path::refuse_symlink_ancestors(&source.path)?;
        let bytes = crate::path::read_bounded_regular(&source.path, source.size)?;
        if bytes.len() as u64 != source.size || super::digest(&bytes) != source.sha256 {
            return Err(PortcoveError::source("fixed build original changed"));
        }
        let accepted = match facts.original_identity {
            OriginalIdentity::Sha1(expected) => hex::encode(sha1::Sha1::digest(&bytes)) == expected,
            OriginalIdentity::Sha256(expected) => source.sha256 == expected,
        };
        if !accepted {
            return Err(PortcoveError::source(
                "fixed build original does not match the selected upstream input",
            ));
        }
        checkpoint()
    }
}
