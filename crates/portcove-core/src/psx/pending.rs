//! Pending work is a fresh observation, not a durable compile/retry grant.
use crate::{ActivityDiagnostic, PortcoveError, Result};
use std::path::Path;

// Console-pool edges print at start; ordinary edges print at completion. The
// finished-edge ordinal therefore cannot identify each printed command.
pub(super) const STATUS: &str = "[portcove:%t] ";
const MAX_COMMANDS: usize = 64;

pub(super) fn arguments(targets: &[String], dry_run: bool) -> Vec<String> {
    let mut arguments = vec!["-f".into(), "build.ninja".into(), "-j".into(), "2".into()];
    if dry_run {
        arguments.push("-n".into());
        // Compare command identity, never an upstream human description.
        arguments.push("-v".into());
    }
    // Graph output names are positional targets, including names beginning '-'.
    arguments.push("--".into());
    arguments.extend(targets.iter().cloned());
    arguments
}

pub(super) struct PendingCommands {
    pub(super) count: usize,
    commands: Vec<String>,
}

pub(super) fn inspect(capture: &ActivityDiagnostic, quiesced: bool) -> Result<PendingCommands> {
    let refused = || {
        PortcoveError::verification(
            "PS1 pending-command observation is incomplete or exceeds its command budget",
        )
    };
    if !quiesced
        || !capture.complete
        || capture.stdout.truncated
        || capture.stderr.truncated
        || capture.stdout.observed_bytes != capture.stdout.text.len() as u64
    {
        return Err(refused());
    }
    if capture.stdout.text.trim_end_matches(['\n', '\r']) == "ninja: no work to do." {
        return Ok(PendingCommands {
            count: 0,
            commands: Vec::new(),
        });
    }
    let mut expected_total = None;
    let mut completed = 0;
    let mut commands = Vec::new();
    for line in capture.stdout.text.lines() {
        let prefix = line.strip_prefix("[portcove:").ok_or_else(refused)?;
        let (total, command) = prefix.split_once("] ").ok_or_else(refused)?;
        if command.is_empty() {
            return Err(refused());
        }
        if total.is_empty() || !total.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(refused());
        }
        let total = total.parse::<usize>().map_err(|_| refused())?;
        if total == 0
            || total > MAX_COMMANDS
            || completed >= total
            || expected_total.is_some_and(|expected| expected != total)
        {
            return Err(refused());
        }
        expected_total = Some(total);
        completed += 1;
        commands.push(command.to_owned());
    }
    if expected_total != Some(completed) || completed == 0 {
        return Err(refused());
    }
    Ok(PendingCommands {
        count: completed,
        commands,
    })
}

/// Only two SDK actions intentionally have no material output. Their exact
/// commands are observed from the freshly fenced graph, not saved as later
/// execution authority. Call only after successful, positively closed execution.
pub(super) fn material_remaining(
    observed: &PendingCommands,
    tree: &super::stage::GeneratedTree,
    runtime: &str,
    targets: &[String],
    operation: &crate::OperationCoordinator,
) -> Result<usize> {
    operation.checkpoint()?;
    let root = tree.root();
    let graph = crate::external_runtime::read_stable_metadata(
        &root.join("build-portcove/build.ninja"),
        16 * 1024 * 1024,
    )?;
    tree.require_file_bytes(Path::new("build-portcove/build.ninja"), &graph)?;
    let graph = std::str::from_utf8(&graph)
        .map_err(|_| PortcoveError::verification("PS1 repeatable graph is not UTF-8"))?;
    let closure = super::compile_plan::selected_closure(graph, root, runtime, targets, operation)?;
    let commands = repeatable_commands(graph, &closure)?;
    for (owner, _) in &commands {
        operation.checkpoint()?;
        let output = root.join("build-portcove").join(owner);
        crate::path::refuse_symlink_ancestors(output.parent().expect("owned utility parent"))?;
        match std::fs::symlink_metadata(&output) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
            Ok(_) => {
                return Err(PortcoveError::verification(
                    "PS1 repeatable utility acquired a material output",
                ));
            }
        }
    }
    let mut available = commands.clone();
    let mut remaining = 0;
    for command in &observed.commands {
        operation.checkpoint()?;
        if let Some(index) = available.iter().position(|(_, allowed)| allowed == command) {
            available.remove(index);
        } else {
            remaining += 1;
        }
    }
    if remaining == 0
        && commands.iter().any(|(owner, command)| {
            owner == "CMakeFiles/psx-stage-configs.util" && observed.commands.contains(command)
        })
    {
        // copy_if_different must actually have copied the retained inputs. A
        // successful exit or a matching utility name alone is insufficient.
        for name in ["game.toml", "game_options.toml"] {
            operation.checkpoint()?;
            let source =
                crate::external_runtime::read_stable_metadata(&root.join(name), 1024 * 1024)?;
            let copied = crate::external_runtime::read_stable_metadata(
                &root.join("build-portcove").join(name),
                1024 * 1024,
            )?;
            if source != copied {
                return Err(PortcoveError::verification(
                    "PS1 staged build configuration changed",
                ));
            }
        }
    }
    Ok(remaining)
}

fn repeatable_commands(graph: &str, closure: &[String]) -> Result<Vec<(String, String)>> {
    let refused = || PortcoveError::verification("PS1 repeatable utility contract changed");
    let mut commands = Vec::new();
    let mut lines = graph.lines().peekable();
    while let Some(line) = lines.next() {
        let owner = if line == "build CMakeFiles/psx-stage-configs.util: CUSTOM_COMMAND" {
            "CMakeFiles/psx-stage-configs.util"
        } else if line
            == "build CMakeFiles/psx-runtime_require_generated | ${cmake_ninja_workdir}CMakeFiles/psx-runtime_require_generated: CUSTOM_COMMAND"
        {
            "CMakeFiles/psx-runtime_require_generated"
        } else {
            continue;
        };
        let known = closure.iter().any(|target| target == owner);
        if !known {
            continue;
        }
        let mut command = None;
        while lines.peek().is_some_and(|line| line.starts_with("  ")) {
            let binding = lines.next().expect("peeked line");
            if let Some(value) = binding.strip_prefix("  COMMAND = ") {
                if command.is_some()
                    || value.is_empty()
                    || value.contains('\0')
                    || value.len() > 128 * 1024
                {
                    return Err(refused());
                }
                // CMake escapes literal dollar signs; arbitrary Ninja variable
                // interpolation would make the printed command ambiguous.
                let expanded = value.replace("$$", "\u{0}");
                if expanded.contains('$') {
                    return Err(refused());
                }
                command = Some(expanded.replace('\0', "$"));
            } else if !binding.starts_with("  DESC = ") && binding != "  restat = 1" {
                return Err(refused());
            }
        }
        let command = command.ok_or_else(refused)?;
        if commands
            .iter()
            .any(|(prior_owner, prior_command)| prior_owner == owner || prior_command == &command)
        {
            return Err(refused());
        }
        commands.push((owner.to_owned(), command));
        if commands.len() > 2 {
            return Err(refused());
        }
    }
    Ok(commands)
}

pub(super) fn require_outputless_utilities(tree: &super::stage::GeneratedTree) -> Result<()> {
    for owner in [
        "CMakeFiles/psx-stage-configs.util",
        "CMakeFiles/psx-runtime_require_generated",
    ] {
        tree.require_absent(&Path::new("build-portcove").join(owner))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn utility_fixture(root: &Path) -> String {
        std::fs::create_dir_all(root.join("build-portcove")).unwrap();
        let graph = "include CMakeFiles/rules.ninja\nbuild CMakeFiles/psx-stage-configs.util: CUSTOM_COMMAND\n  COMMAND = exact copy command\n  DESC = misleading description\n  restat = 1\nbuild CMakeFiles/psx-runtime_require_generated | ${cmake_ninja_workdir}CMakeFiles/psx-runtime_require_generated: CUSTOM_COMMAND\n  COMMAND = exact guard command\nbuild first.obj: COMPILE\nbuild game.exe: LINK first.obj CMakeFiles/psx-stage-configs.util CMakeFiles/psx-runtime_require_generated\nbuild psx-runtime: phony game.exe\n";
        let workdir = root
            .join("build-portcove")
            .to_str()
            .unwrap()
            .replace('\\', "/")
            .replace(':', "$:")
            .replace(' ', "$ ");
        let graph = format!("cmake_ninja_workdir = {workdir}/\n{graph}");
        std::fs::write(root.join("build-portcove/build.ninja"), &graph).unwrap();
        for name in ["game.toml", "game_options.toml"] {
            std::fs::write(root.join(name), b"sealed configuration").unwrap();
            std::fs::write(
                root.join("build-portcove").join(name),
                b"sealed configuration",
            )
            .unwrap();
        }
        graph
    }

    #[test]
    fn ninja_repeatable_completion_requires_exact_reachable_multiset_and_postconditions() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path();
        utility_fixture(root);
        let operation = crate::OperationCoordinator::new("pending-owner", None);
        let tree = super::super::stage::GeneratedTree::capture(root, &operation, true).unwrap();
        let targets = vec!["game.exe".into()];
        let observe = |text| inspect(&capture(text), true).unwrap();
        let count = |text| {
            material_remaining(&observe(text), &tree, "game.exe", &targets, &operation).unwrap()
        };
        assert_eq!(
            count("[portcove:2] exact copy command\n[portcove:2] exact guard command\n"),
            0
        );
        assert_eq!(count("[portcove:1] misleading description\n"), 1);
        assert_eq!(count("[portcove:1] unknown compile command\n"), 1);
        // A material command colliding with an always-pending reachable guard
        // adds an occurrence, never another completion exemption.
        assert_eq!(
            count("[portcove:2] exact guard command\n[portcove:2] exact guard command\n"),
            1
        );
        let unrelated = observe("[portcove:1] exact guard command\n");
        assert_eq!(
            material_remaining(
                &unrelated,
                &tree,
                "game.exe",
                &["first.obj".into()],
                &operation
            )
            .unwrap(),
            1
        );
        // If a utility marker exists, its command need not be pending. A sole
        // colliding material command must never receive that exemption.
        let marker = root.join("build-portcove/CMakeFiles/psx-runtime_require_generated");
        std::fs::create_dir_all(marker.parent().unwrap()).unwrap();
        std::fs::write(&marker, b"unexpected material marker").unwrap();
        let late_capture =
            super::super::stage::GeneratedTree::capture(root, &operation, true).unwrap();
        assert!(require_outputless_utilities(&late_capture).is_err());
        assert!(material_remaining(&unrelated, &tree, "game.exe", &targets, &operation).is_err());
        std::fs::remove_file(&marker).unwrap();
        let cased_marker = marker.with_file_name("PSX-RUNTIME_REQUIRE_GENERATED");
        std::fs::write(&cased_marker, b"case alias").unwrap();
        let cased_capture =
            super::super::stage::GeneratedTree::capture(root, &operation, true).unwrap();
        assert!(require_outputless_utilities(&cased_capture).is_err());
        std::fs::remove_file(&cased_marker).unwrap();
        let graph_path = root.join("build-portcove/build.ninja");
        let graph = std::fs::read(&graph_path).unwrap();
        std::fs::write(
            &graph_path,
            String::from_utf8(graph.clone())
                .unwrap()
                .replace("exact guard command", "changed guard command"),
        )
        .unwrap();
        assert!(
            material_remaining(
                &observe("[portcove:1] changed guard command\n"),
                &tree,
                "game.exe",
                &targets,
                &operation
            )
            .is_err()
        );
        std::fs::write(&graph_path, graph).unwrap();
        let path = root.join("build-portcove/game.toml");
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        std::fs::write(&path, b"changed configuration").unwrap();
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(modified))
            .unwrap();
        assert!(
            material_remaining(
                &observe("[portcove:1] exact copy command\n"),
                &tree,
                "game.exe",
                &targets,
                &operation
            )
            .is_err()
        );
    }

    #[test]
    fn ninja_repeatable_contract_refuses_dynamic_duplicate_and_changed_edges() {
        let temporary = tempfile::tempdir().unwrap();
        let graph = utility_fixture(temporary.path());
        let closure = vec![
            "CMakeFiles/psx-stage-configs.util".into(),
            "CMakeFiles/psx-runtime_require_generated".into(),
        ];
        assert!(
            repeatable_commands(
                &graph.replace("exact copy command", "$unexpected"),
                &closure
            )
            .is_err()
        );
        assert!(
            repeatable_commands(
                &graph.replace("exact copy command", "exact guard command"),
                &closure
            )
            .is_err()
        );
        assert!(repeatable_commands(&(graph.clone() + "build CMakeFiles/psx-stage-configs.util: CUSTOM_COMMAND\n  COMMAND = other\n"), &closure).is_err());
        assert!(
            repeatable_commands(&graph.replace("  restat = 1", "  pool = unknown"), &closure)
                .is_err()
        );
        assert!(
            repeatable_commands(
                &graph.replace(
                    "psx-stage-configs.util: CUSTOM_COMMAND",
                    "psx-stage-configs.util: MATERIAL"
                ),
                &closure
            )
            .unwrap()
            .iter()
            .all(|(owner, _)| owner != "CMakeFiles/psx-stage-configs.util")
        );
    }
    #[test]
    fn ninja_pending_arguments_keep_graph_targets_out_of_option_parsing() {
        let targets = vec![
            "-tclean".into(),
            "-Cforeign".into(),
            "object with spaces.o".into(),
        ];
        assert_eq!(
            arguments(&targets, true),
            vec![
                "-f",
                "build.ninja",
                "-j",
                "2",
                "-n",
                "-v",
                "--",
                "-tclean",
                "-Cforeign",
                "object with spaces.o"
            ]
        );
        assert_eq!(
            arguments(&targets, false),
            vec![
                "-f",
                "build.ninja",
                "-j",
                "2",
                "--",
                "-tclean",
                "-Cforeign",
                "object with spaces.o"
            ]
        );
    }
    fn capture(text: &str) -> ActivityDiagnostic {
        ActivityDiagnostic {
            activity_id: "inert-pending".into(),
            phase: "install.ps1.builder".into(),
            stdout: crate::DiagnosticStream {
                text: text.into(),
                observed_bytes: text.len() as u64,
                truncated: false,
            },
            stderr: crate::DiagnosticStream {
                text: String::new(),
                observed_bytes: 0,
                truncated: false,
            },
            complete: true,
            updated_at: 0,
            stream_limit_bytes: 2 * 1024 * 1024,
        }
    }
    #[test]
    fn ninja_pending_observation_requires_complete_positive_closure_and_fixed_totals() {
        assert_eq!(
            inspect(&capture("[portcove:2] compile\n[portcove:2] link\n"), true)
                .unwrap()
                .count,
            2
        );
        assert_eq!(
            inspect(&capture("ninja: no work to do.\n"), true)
                .unwrap()
                .count,
            0
        );
        let text = "[portcove:1] compile\n";
        assert!(inspect(&capture(text), false).is_err());
        let mut partial = capture(text);
        partial.complete = false;
        assert!(inspect(&partial, true).is_err());
        partial = capture(text);
        partial.stdout.truncated = true;
        assert!(inspect(&partial, true).is_err());
        partial = capture(text);
        partial.stdout.observed_bytes += 1;
        assert!(inspect(&partial, true).is_err());
        for invalid in [
            "",
            "[portcove:2] incomplete\n",
            "[portcove:1] done\n[portcove:1] again\n",
            "[portcove:2] one\n[portcove:3] changed total\n",
            "ninja: no work to do.\n[portcove:1] contradictory\n",
            "[portcove:65] oversized\n",
            "[portcove:1] description\nunknown extra output\n",
            "[portcove:] missing total\n",
            "[portcove:0] impossible\n",
            "[portcove:0/1] obsolete finished ordinal\n",
        ] {
            assert!(inspect(&capture(invalid), true).is_err(), "{invalid}");
        }
    }
    #[test]
    fn ninja_pending_observation_counts_console_start_and_ordinary_finish_statuses() {
        // The owned total-only prefix is identical at console start (%f=0)
        // and ordinary completion. Console completion prints no second line.
        assert_eq!(
            inspect(&capture("[portcove:1] console command\n"), true)
                .unwrap()
                .count,
            1
        );
        assert_eq!(inspect(&capture("[portcove:3] console start\n[portcove:3] ordinary finish\n[portcove:3] final console start\n"), true).unwrap().count, 3);
        assert!(
            inspect(
                &capture("[portcove:3] console start\n[portcove:3] ordinary finish\n"),
                true
            )
            .is_err()
        );
    }
    #[test]
    fn ninja_pending_observation_accepts_exact_budget_without_widening_process_caps() {
        let text = (1..=MAX_COMMANDS)
            .map(|_| format!("[portcove:{MAX_COMMANDS}] command\n"))
            .collect::<String>();
        assert_eq!(inspect(&capture(&text), true).unwrap().count, MAX_COMMANDS);
    }
}
