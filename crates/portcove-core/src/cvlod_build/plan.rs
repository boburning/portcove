//! Sealed fixed-object graphs and bounded, preflighted Ninja execution units.
use super::super::{cmake_path, digest};
use crate::{PortcoveError, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

#[derive(Clone, Copy)]
pub(super) enum Stage {
    Game,
    Recompiler,
    Zlib,
    Freetype,
}
impl Stage {
    pub(super) fn key(self) -> &'static str {
        match self {
            Self::Game => "game",
            Self::Recompiler => "n64recomp",
            Self::Zlib => "zlib",
            Self::Freetype => "freetype",
        }
    }
    fn count(self) -> usize {
        match self {
            Self::Game => 851,
            Self::Recompiler => 50,
            Self::Zlib => 15,
            Self::Freetype => 44,
        }
    }
    fn configuration(self) -> &'static str {
        if matches!(self, Self::Game) {
            "RelWithDebInfo"
        } else {
            "Release"
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn plan() -> Plan {
        Plan {
            objects: vec![
                "CMakeFiles/game.dir/a.cpp.obj".into(),
                "CMakeFiles/game.dir/b.cpp.obj".into(),
                "CMakeFiles/game.dir/c.cpp.obj".into(),
            ],
            helpers: vec![Helper {
                description: "Generating fixed.h".into(),
                target: "fixed.h".into(),
            }],
            manifest_sha256: String::new(),
            rules_sha256: String::new(),
        }
    }
    #[test]
    fn cvlod_dry_run_counts_dependency_compilation_and_refuses_unplanned_actions() {
        let plan = plan();
        let requested_two_with_dependency = "[1/3] Building CXX object CMakeFiles/game.dir/c.cpp.obj\n[2/3] Building CXX object CMakeFiles/game.dir/a.cpp.obj\n[3/3] Building CXX object CMakeFiles/game.dir/b.cpp.obj\n";
        assert!(
            !plan
                .actions(requested_two_with_dependency, true)
                .unwrap()
                .bounded()
        );
        assert!(
            plan.actions(
                "[1/1] Building CXX object CMakeFiles/game.dir/outside.cpp.obj\n",
                true
            )
            .is_err()
        );
        assert!(plan.actions("[1/1] Re-running CMake...\n", true).is_err());
        assert!(plan.actions("unclassified command\n", true).is_err());
        let valid = plan.actions("[1/2] Generating fixed.h\n[2/2] Building CXX object CMakeFiles/game.dir/a.cpp.obj\n", true).unwrap();
        assert!(valid.bounded());
        assert_eq!(valid.helpers[0].target, "fixed.h");
        assert!(
            plan.actions("[1/2] Generating fixed.h\n[2/2] Generating fixed.h\n", true)
                .is_err()
        );
        assert!(
            plan.actions("ninja: no work to do.\n", true)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn cvlod_freetype_graph_requires_the_fixed_windows_resource() {
        let fixed: BTreeMap<String, Vec<String>> =
            serde_json::from_str(include_str!("objects.json")).unwrap();
        let objects = &fixed["freetype"];
        let resource = "CMakeFiles/freetype.dir/src/base/ftver.rc.res";
        assert_eq!(objects.len(), 44);
        assert_eq!(objects.iter().filter(|s| s.ends_with(".obj")).count(), 43);
        assert_eq!(
            objects
                .iter()
                .filter(|s| s.ends_with(".res"))
                .collect::<Vec<_>>(),
            [&resource.to_string()]
        );
        let helpers: BTreeMap<String, Vec<Helper>> =
            serde_json::from_str(include_str!("helpers.json")).unwrap();
        let mut lines = vec!["include CMakeFiles\\rules.ninja".to_string()];
        for object in objects {
            let kind = if object.ends_with(".res") { "RC" } else { "C" };
            lines.push(format!(
                "build {}: {kind}_COMPILER__freetype_unscanned_Release fixed-source",
                object.replace('/', "\\")
            ));
        }
        for helper in &helpers["freetype"] {
            lines.push(format!("build {}: phony", helper.target));
        }
        let manifest = lines.join("\r\n") + "\r\n";
        let temporary = tempfile::tempdir().unwrap();
        let build = temporary.path();
        std::fs::create_dir(build.join("CMakeFiles")).unwrap();
        std::fs::write(
            build.join("CMakeFiles/rules.ninja"),
            "rule fixed\n  command = fixed\n",
        )
        .unwrap();
        let inspect = |text: &str| {
            std::fs::write(build.join("build.ninja"), text).unwrap();
            Plan::read(build, Stage::Freetype)
        };
        let plan = inspect(&manifest).unwrap();
        assert!(plan.objects.iter().any(|s| s == resource));
        let resource_line = lines.iter().find(|s| s.contains("ftver.rc.res")).unwrap();
        let missing = inspect(&manifest.replace(resource_line, "")).err().unwrap();
        assert_eq!(missing.details["stage"], "freetype");
        assert_eq!(missing.details["missing_targets"], resource);
        assert_eq!(missing.details["observed_count"], "43");
        assert!(inspect(&manifest.replace("ftver.rc.res", "outside.rc.res")).is_err());
        assert!(inspect(&(manifest.clone() + "build CMakeFiles/freetype.dir/extra.rc.res: RC_COMPILER__freetype_unscanned_Release fixed-source\n")).is_err());
        assert!(
            inspect(&manifest.replace(
                "RC_COMPILER__freetype_unscanned_Release",
                "RC_COMPILER__freetype_unscanned_Debug"
            ))
            .is_err()
        );
        assert!(inspect(&(manifest.clone() + resource_line + "\n")).is_err());
    }

    #[test]
    fn cvlod_game_graph_selects_only_exact_reviewed_windows_object_aliases() {
        let fixed: BTreeMap<String, Vec<String>> =
            serde_json::from_str(include_str!("objects.json")).unwrap();
        let aliases: BTreeMap<String, String> =
            serde_json::from_str(include_str!("object-aliases.json")).unwrap();
        assert_eq!(aliases.len(), 13);
        let helpers: BTreeMap<String, Vec<Helper>> =
            serde_json::from_str(include_str!("helpers.json")).unwrap();
        let graph = |shortened: bool| {
            let mut lines = vec!["include CMakeFiles/rules.ninja".to_owned()];
            for canonical in &fixed["game"] {
                let target = if shortened {
                    aliases.get(canonical).unwrap_or(canonical)
                } else {
                    canonical
                };
                let group = canonical
                    .rsplit_once("CMakeFiles/")
                    .unwrap()
                    .1
                    .split_once(".dir/")
                    .unwrap()
                    .0;
                lines.push(format!(
                    "build {target}: C_COMPILER__{group}_unscanned_RelWithDebInfo fixed-source"
                ));
            }
            for helper in &helpers["game"] {
                lines.push(format!("build {}: phony", helper.target));
            }
            lines.join("\n") + "\n"
        };
        let temporary = tempfile::tempdir().unwrap();
        let build = temporary.path();
        std::fs::create_dir(build.join("CMakeFiles")).unwrap();
        std::fs::write(
            build.join("CMakeFiles/rules.ninja"),
            "rule fixed\n  command = fixed\n",
        )
        .unwrap();
        let inspect = |text: &str| {
            std::fs::write(build.join("build.ninja"), text).unwrap();
            Plan::read(build, Stage::Game)
        };
        let plain = graph(false);
        let shortened = graph(true);
        assert_eq!(inspect(&plain).unwrap().objects, fixed["game"]);
        let selected = inspect(&shortened).unwrap();
        assert_eq!(selected.objects.len(), 851);
        for (canonical, alias) in &aliases {
            assert!(selected.objects.contains(alias));
            assert!(!selected.objects.contains(canonical));
            let diagnostic = format!("[1/1] Building C object {alias}\n");
            assert_eq!(
                selected.actions(&diagnostic, true).unwrap().objects,
                [alias.clone()]
            );
            assert!(
                selected
                    .actions(&format!("[1/1] Building C object {canonical}\n"), true)
                    .is_err()
            );
            // Every reviewed alias also works in a mixed graph, independently.
            assert!(inspect(&plain.replace(canonical, alias)).is_ok());
            let line = shortened
                .lines()
                .find(|line| line.starts_with(&format!("build {alias}:")))
                .unwrap();
            assert!(inspect(&shortened.replace(line, "")).is_err());
            assert!(
                inspect(&(shortened.clone() + &line.replace(alias, canonical) + "\n")).is_err()
            );
            assert!(inspect(&(shortened.clone() + line + "\n")).is_err());
            let unknown = alias.replacen(".dir/", ".dir/unknown/", 1);
            assert!(inspect(&shortened.replace(alias, &unknown)).is_err());
            assert!(inspect(&shortened.replace(alias, &(alias.clone() + ".obj"))).is_err());
        }
        assert!(inspect(&shortened.replace("_RelWithDebInfo", "_Debug")).is_err());
        assert!(
            inspect(&shortened.replace("C_COMPILER__rabbitizer", "CUSTOM_COMMAND__rabbitizer"))
                .is_err()
        );
        assert!(
            inspect(&shortened.replace(
                "include CMakeFiles/rules.ninja",
                "include CMakeFiles/other.ninja"
            ))
            .is_err()
        );
        let selected = inspect(&shortened).unwrap();
        std::fs::write(build.join("build.ninja"), plain).unwrap();
        assert!(selected.require_unchanged(build).is_err());
    }

    #[test]
    fn cvlod_graph_allows_only_one_fixed_rule_include_with_either_separator() {
        for manifest in [
            "include CMakeFiles/rules.ninja\n",
            "include CMakeFiles\\rules.ninja\r\n",
        ] {
            validate_graph_includes(manifest, "rule C_COMPILER\n  command = cl.exe\n").unwrap();
            for rules in [
                "include CMakeFiles/rules.ninja\n",
                "include CMakeFiles\\rules.ninja\n",
                "subninja CMakeFiles/rules.ninja\n",
            ] {
                assert!(validate_graph_includes(manifest, rules).is_err());
            }
        }
        for manifest in [
            "",
            "include CMakeFiles/rules.ninja\ninclude CMakeFiles\\rules.ninja\n",
            "include CMakeFiles/other.ninja\n",
            "include CMakeFiles\\..\\rules.ninja\n",
            "include C:/rules.ninja\n",
            "subninja CMakeFiles/rules.ninja\n",
            "include CMakeFiles/rules.ninja \n",
        ] {
            assert!(validate_graph_includes(manifest, "").is_err());
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Helper {
    pub(super) description: String,
    pub(super) target: String,
}

#[derive(Serialize)]
pub(super) struct Plan {
    pub(super) objects: Vec<String>,
    helpers: Vec<Helper>,
    manifest_sha256: String,
    rules_sha256: String,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct Actions {
    pub(super) objects: Vec<String>,
    pub(super) helpers: Vec<Helper>,
}
impl Actions {
    pub(super) fn bounded(&self) -> bool {
        self.objects.len() <= 2 && self.helpers.len() <= 8
    }
    pub(super) fn is_empty(&self) -> bool {
        self.objects.is_empty() && self.helpers.is_empty()
    }
    pub(super) fn identities(&self) -> BTreeMap<String, usize> {
        let mut identities = BTreeMap::new();
        for target in self
            .objects
            .iter()
            .chain(self.helpers.iter().map(|h| &h.target))
        {
            *identities.entry(target.clone()).or_default() += 1;
        }
        identities
    }
}

fn graph(build: &Path) -> Result<(Vec<u8>, Vec<u8>)> {
    Ok((
        crate::path::read_bounded_regular(&build.join("build.ninja"), 4 * 1024 * 1024)?,
        crate::path::read_bounded_regular(&build.join("CMakeFiles/rules.ninja"), 1024 * 1024)?,
    ))
}

fn validate_target(target: &str) -> Result<()> {
    crate::archive::validate_relative_path(target, false)?;
    if target.len() > 1024
        || !target
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/._-".contains(&b))
    {
        return Err(PortcoveError::verification(
            "CVLoD fixed compiler target differs",
        ));
    }
    Ok(())
}

fn validate_graph_includes(manifest: &str, rules: &str) -> Result<()> {
    let includes = manifest
        .lines()
        .filter(|line| line.starts_with("include ") || line.starts_with("subninja "))
        .collect::<Vec<_>>();
    // The fixed Windows CMake generator spells this same relative rule file
    // with backslashes. Admit only its two separator spellings, exactly once;
    // no other build file or nested include gains execution authority.
    if (includes != ["include CMakeFiles/rules.ninja"]
        && includes != [r"include CMakeFiles\rules.ninja"])
        || rules
            .lines()
            .any(|line| line.starts_with("include ") || line.starts_with("subninja "))
    {
        return Err(PortcoveError::verification(
            "CVLoD graph introduced another build file",
        ));
    }
    Ok(())
}

impl Plan {
    pub(super) fn read(build: &Path, stage: Stage) -> Result<Self> {
        let mut fixed: BTreeMap<String, Vec<String>> =
            serde_json::from_str(include_str!("objects.json"))?;
        let mut helpers: BTreeMap<String, Vec<Helper>> =
            serde_json::from_str(include_str!("helpers.json"))?;
        let objects = fixed
            .remove(stage.key())
            .ok_or_else(|| PortcoveError::verification("CVLoD object plan is absent"))?;
        let helpers = helpers
            .remove(stage.key())
            .ok_or_else(|| PortcoveError::verification("CVLoD helper plan is absent"))?;
        if objects.len() != stage.count() {
            return Err(PortcoveError::verification(
                "CVLoD fixed object count differs",
            ));
        }
        let mut wanted = BTreeSet::new();
        let mut groups = BTreeSet::new();
        for object in &objects {
            validate_target(object)?;
            if !wanted.insert(object.clone()) {
                return Err(PortcoveError::verification(
                    "CVLoD compiler target collides",
                ));
            }
            let group = object
                .rsplit_once("CMakeFiles/")
                .and_then(|(_, s)| s.split_once(".dir/"))
                .map(|(s, _)| s)
                .ok_or_else(|| PortcoveError::verification("CVLoD compiler group differs"))?;
            groups.insert(group);
        }
        // CMake shortens these reviewed Rabbitizer paths on Windows. Admit only
        // the exact observed spellings, never a basename or arbitrary hash.
        let aliases: BTreeMap<String, String> = if matches!(stage, Stage::Game) {
            serde_json::from_str(include_str!("object-aliases.json"))?
        } else {
            BTreeMap::new()
        };
        let mut canonical_aliases = BTreeMap::new();
        for (canonical, alias) in &aliases {
            validate_target(alias)?;
            if !wanted.contains(canonical)
                || wanted.contains(alias)
                || canonical_aliases.insert(alias, canonical).is_some()
            {
                return Err(PortcoveError::verification(
                    "CVLoD fixed object alias differs",
                ));
            }
        }
        let (manifest, rules) = graph(build)?;
        let manifest_text = std::str::from_utf8(&manifest)
            .map_err(|_| PortcoveError::verification("CVLoD graph is not UTF-8"))?;
        let rule_text = std::str::from_utf8(&rules)
            .map_err(|_| PortcoveError::verification("CVLoD rules are not UTF-8"))?;
        validate_graph_includes(manifest_text, rule_text)?;
        let mut declared = BTreeSet::new();
        let mut selected = BTreeMap::new();
        let mut outputs = BTreeSet::new();
        for line in manifest_text
            .lines()
            .filter_map(|l| l.strip_prefix("build "))
        {
            let Some((targets, rest)) = line.split_once(": ") else {
                continue;
            };
            let rule = rest.split_whitespace().next().unwrap_or_default();
            // All admitted compiler outputs are simple relative targets. The
            // remaining graph may contain CMake's absolute implicit aliases.
            let target = targets
                .split_whitespace()
                .next()
                .unwrap_or_default()
                .replace('\\', "/");
            outputs.insert(target.clone());
            let Some(group) = target
                .rsplit_once("CMakeFiles/")
                .and_then(|(_, s)| s.split_once(".dir/"))
                .map(|(s, _)| s)
            else {
                continue;
            };
            if !groups.contains(group) || !(target.ends_with(".obj") || target.ends_with(".res")) {
                continue;
            }
            validate_target(&target)?;
            let expected = ["C_COMPILER", "CXX_COMPILER", "RC_COMPILER"]
                .map(|kind| format!("{kind}__{group}_unscanned_{}", stage.configuration()));
            let canonical = canonical_aliases
                .get(&target)
                .map_or(target.as_str(), |canonical| canonical.as_str());
            if !expected.contains(&rule.to_owned())
                || targets.contains(' ')
                || !declared.insert(canonical.to_owned())
            {
                return Err(PortcoveError::verification(
                    "CVLoD compiler graph differs from its fixed target contract",
                ));
            }
            selected.insert(canonical.to_owned(), target);
        }
        if declared != wanted {
            return Err(
                PortcoveError::verification("CVLoD compiler object inventory differs")
                    .detail("stage", stage.key())
                    .detail("expected_count", wanted.len().to_string())
                    .detail("observed_count", declared.len().to_string())
                    .detail(
                        "missing_targets",
                        wanted
                            .difference(&declared)
                            .take(16)
                            .cloned()
                            .collect::<Vec<_>>()
                            .join(", "),
                    )
                    .detail(
                        "unexpected_targets",
                        declared
                            .difference(&wanted)
                            .take(16)
                            .cloned()
                            .collect::<Vec<_>>()
                            .join(", "),
                    ),
            );
        }
        let mut helper_names = BTreeSet::new();
        for helper in &helpers {
            validate_target(&helper.target)?;
            if !outputs.contains(&helper.target) || !helper_names.insert(&helper.description) {
                return Err(PortcoveError::verification("CVLoD helper target differs"));
            }
        }
        Ok(Self {
            objects: objects
                .into_iter()
                .map(|object| selected[&object].clone())
                .collect(),
            helpers,
            manifest_sha256: digest(&manifest),
            rules_sha256: digest(&rules),
        })
    }

    pub(super) fn require_unchanged(&self, build: &Path) -> Result<()> {
        let (manifest, rules) = graph(build)?;
        if digest(&manifest) != self.manifest_sha256 || digest(&rules) != self.rules_sha256 {
            return Err(PortcoveError::verification(
                "CVLoD sealed build graph changed",
            ));
        }
        Ok(())
    }

    /// Dry-run output is complete diagnostic authority, before any compiler or
    /// helper executes. Unknown/reconfiguration commands always refuse.
    pub(super) fn actions(&self, stdout: &str, dry_run: bool) -> Result<Actions> {
        let mut actions = Actions {
            objects: Vec::new(),
            helpers: Vec::new(),
        };
        for line in stdout.lines().map(str::trim).filter(|l| !l.is_empty()) {
            let status = line
                .strip_prefix('[')
                .and_then(|s| s.split_once("] "))
                .filter(|(prefix, _)| {
                    !prefix.is_empty() && prefix.bytes().all(|b| b.is_ascii_digit() || b == b'/')
                });
            let Some((_, description)) = status else {
                if !dry_run
                    || line.starts_with("ninja: Entering directory ")
                    || line == "ninja: no work to do."
                {
                    continue;
                }
                return Err(PortcoveError::verification(
                    "CVLoD dry-run output contains an unplanned command",
                ));
            };
            let description = description.replace('\\', "/");
            if let Some(target) = [
                "Building C object ",
                "Building CXX object ",
                "Building RC object ",
            ]
            .iter()
            .find_map(|prefix| description.strip_prefix(prefix))
            {
                if !self.objects.iter().any(|o| o == target) {
                    return Err(PortcoveError::verification(
                        "CVLoD dry run requires an unadmitted compiler target",
                    ));
                }
                actions.objects.push(target.to_owned());
            } else if let Some(helper) = self.helpers.iter().find(|h| h.description == description)
            {
                actions.helpers.push(helper.clone());
            } else {
                return Err(PortcoveError::verification(
                    "CVLoD dry run requires an unadmitted helper",
                ));
            }
        }
        if actions.identities().values().any(|count| *count != 1) {
            return Err(PortcoveError::verification(
                "CVLoD dry-run command identity repeats",
            ));
        }
        Ok(actions)
    }

    pub(super) fn ninja_arguments(
        build: &Path,
        targets: &[String],
        dry_run: bool,
    ) -> Result<Vec<String>> {
        if targets.is_empty() || targets.len() > 2 {
            return Err(PortcoveError::verification(
                "CVLoD compiler request exceeds fixed scope",
            ));
        }
        for target in targets {
            validate_target(target)?;
        }
        let mut arguments = vec!["-C".into(), cmake_path(build)?, "-j2".into()];
        if dry_run {
            arguments.push("-n".into());
        }
        arguments.extend_from_slice(targets);
        Ok(arguments)
    }
}
