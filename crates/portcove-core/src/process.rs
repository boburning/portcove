use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
    process::Command,
};

use crate::{PortcoveError, Result};

/// The trust boundary crossed by a child process.
///
/// Every production child must select a class even though the current classes
/// share the same conservative host-session inheritance policy. The class is a
/// reviewed extension point for future differences; credential filtering is
/// intentionally common and cannot be relaxed per call site.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChildProcessClass {
    Game,
    UpstreamSetup,
    HostTool,
    ManagedBuilder,
    HostIntegration,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchKind {
    Native,
    WindowsBatch,
}

impl LaunchKind {
    pub fn for_executable(executable: &Path) -> Self {
        match executable
            .extension()
            .and_then(OsStr::to_str)
            .map(str::to_ascii_lowercase)
            .as_deref()
        {
            Some("bat" | "cmd") => Self::WindowsBatch,
            _ => Self::Native,
        }
    }
}

/// A fully reviewed game process request.
#[derive(Debug, Clone)]
pub struct GameProcessSpec {
    pub executable: PathBuf,
    pub launch_kind: LaunchKind,
    pub working_directory: PathBuf,
    pub environment: BTreeMap<String, String>,
    /// Arguments owned by the embedded, validated catalog and adapter.
    pub fixed_arguments: Vec<String>,
}

/// A launch resolved by an adapter, including both process and installation
/// context. Process construction remains centralized in this module.
#[derive(Debug, Clone)]
pub struct LaunchSpec {
    pub executable: PathBuf,
    pub install_root: PathBuf,
    pub working_directory: PathBuf,
    pub environment: BTreeMap<String, String>,
    pub arguments: Vec<String>,
    pub launch_kind: LaunchKind,
}

impl LaunchSpec {
    pub fn process_spec(&self) -> GameProcessSpec {
        GameProcessSpec {
            executable: self.executable.clone(),
            launch_kind: self.launch_kind,
            working_directory: self.working_directory.clone(),
            environment: self.environment.clone(),
            fixed_arguments: self.arguments.clone(),
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct ChildProcessPolicy;

impl ChildProcessPolicy {
    pub fn native_command(class: ChildProcessClass, program: impl AsRef<OsStr>) -> Result<Command> {
        if LaunchKind::for_executable(Path::new(program.as_ref())) == LaunchKind::WindowsBatch {
            return Err(PortcoveError::launch(
                "scripts cannot be used where a native child executable is required",
            )
            .detail("process_class", format!("{class:?}")));
        }
        Ok(Self::command_with_environment(
            class,
            program,
            std::env::vars_os(),
        ))
    }

    pub fn game_command(spec: &GameProcessSpec, forwarded_arguments: &[String]) -> Result<Command> {
        if spec.launch_kind == LaunchKind::WindowsBatch && !forwarded_arguments.is_empty() {
            return Err(PortcoveError::launch(
                "caller-supplied arguments are not supported for Windows batch launchers",
            )
            .detail("launch_kind", "windows_batch"));
        }
        if spec.launch_kind == LaunchKind::WindowsBatch {
            for argument in &spec.fixed_arguments {
                validate_windows_batch_argument(argument)?;
            }
        }

        let mut command = Self::command_with_environment(
            ChildProcessClass::Game,
            &spec.executable,
            std::env::vars_os(),
        );
        command.current_dir(&spec.working_directory);
        command.args(&spec.fixed_arguments);
        if spec.launch_kind == LaunchKind::Native {
            command.args(forwarded_arguments);
        }
        for (name, value) in &spec.environment {
            if is_credential_name(name) {
                return Err(PortcoveError::launch(
                    "a credential-shaped variable cannot be added to a child process",
                )
                .detail("variable", name));
            }
            command.env(name, value);
        }
        Ok(command)
    }

    fn command_with_environment(
        _class: ChildProcessClass,
        program: impl AsRef<OsStr>,
        environment: impl IntoIterator<Item = (OsString, OsString)>,
    ) -> Command {
        let mut command = Command::new(program);
        command.env_clear();
        command.envs(environment.into_iter().filter(|(name, _)| {
            name.to_str()
                .is_some_and(|name| !is_credential_name(name) && is_reviewed_session_variable(name))
        }));
        command
    }
}

pub(crate) fn is_credential_name(name: &str) -> bool {
    let normalized = name.to_ascii_uppercase();
    matches!(
        normalized.as_str(),
        "PORTCOVE_GITHUB_TOKEN"
            | "GH_TOKEN"
            | "GITHUB_TOKEN"
            | "GITLAB_TOKEN"
            | "GL_TOKEN"
            | "AWS_ACCESS_KEY_ID"
            | "AWS_SECRET_ACCESS_KEY"
            | "AWS_SESSION_TOKEN"
            | "AZURE_CLIENT_SECRET"
            | "GOOGLE_APPLICATION_CREDENTIALS"
            | "NPM_TOKEN"
            | "NODE_AUTH_TOKEN"
            | "CARGO_REGISTRY_TOKEN"
            | "SSH_AUTH_SOCK"
            | "SSH_AGENT_PID"
            | "GIT_ASKPASS"
            | "SSH_ASKPASS"
            | "TOKEN"
            | "PASSWORD"
            | "API_KEY"
            | "ACCESS_TOKEN"
            | "REFRESH_TOKEN"
    ) || normalized.ends_with("_TOKEN")
        || normalized.ends_with("_SECRET")
        || normalized.ends_with("_PASSWORD")
        || normalized.ends_with("_API_KEY")
        || normalized.ends_with("_ACCESS_KEY")
}

pub(crate) fn is_reviewed_session_variable(name: &str) -> bool {
    let normalized = name.to_ascii_uppercase();
    matches!(
        normalized.as_str(),
        "PATH"
            | "PATHEXT"
            | "SYSTEMROOT"
            | "WINDIR"
            | "COMSPEC"
            | "TEMP"
            | "TMP"
            | "TMPDIR"
            | "HOME"
            | "USERPROFILE"
            | "HOMEDRIVE"
            | "HOMEPATH"
            | "APPDATA"
            | "LOCALAPPDATA"
            | "PROGRAMDATA"
            | "ALLUSERSPROFILE"
            | "PROGRAMFILES"
            | "PROGRAMFILES(X86)"
            | "COMMONPROGRAMFILES"
            | "COMMONPROGRAMFILES(X86)"
            | "LANG"
            | "LANGUAGE"
            | "TZ"
            | "TERM"
            | "COLORTERM"
            | "DISPLAY"
            | "WAYLAND_DISPLAY"
            | "XAUTHORITY"
            | "DBUS_SESSION_BUS_ADDRESS"
            | "DESKTOP_SESSION"
            | "GDMSESSION"
            | "PULSE_SERVER"
            | "PIPEWIRE_REMOTE"
            | "ALSA_CONFIG_PATH"
            | "LD_LIBRARY_PATH"
            | "DYLD_LIBRARY_PATH"
            | "STEAMAPPID"
            | "STEAMGAMEID"
            | "STEAMOVERLAYGAMEID"
            | "STEAM_RUNTIME"
            | "WINEPREFIX"
            | "WINEARCH"
            | "WINEDLLOVERRIDES"
            | "__CFBUNDLEIDENTIFIER"
            | "OS_ACTIVITY_MODE"
    ) || [
        "LC_",
        "XDG_",
        "SDL_",
        "VK_",
        "MESA_",
        "LIBGL_",
        "__GL_",
        "STEAM_COMPAT_",
        "PRESSURE_VESSEL_",
        "PROTON_",
        "DXVK_",
        "VKD3D_",
    ]
    .iter()
    .any(|prefix| normalized.starts_with(prefix))
}

fn validate_windows_batch_argument(argument: &str) -> Result<()> {
    if argument.is_empty()
        || argument.chars().any(|character| {
            matches!(
                character,
                '%' | '!' | '&' | '|' | '<' | '>' | '^' | '(' | ')' | '"' | '\r' | '\n' | '\0'
            )
        })
    {
        return Err(PortcoveError::launch(
            "a catalog argument is unsafe for a Windows batch launcher",
        )
        .detail("launch_kind", "windows_batch"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{fs, io::Write, process::Stdio};

    use tempfile::TempDir;

    use super::*;

    fn build_probe(directory: &Path) -> PathBuf {
        let source = directory.join("process_probe.rs");
        fs::write(
            &source,
            r#"use std::{env, fs};
fn main() {
    let output = env::var_os("PROBE_OUTPUT").expect("PROBE_OUTPUT");
    let mut lines = env::args().skip(1).map(|arg| format!("arg={arg}")).collect::<Vec<_>>();
    for key in ["PORTCOVE_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "SAMPLE_API_KEY", "PATH", "DISPLAY", "PORTCOVE_PORT_ID"] {
        lines.push(format!("env:{key}={}", env::var(key).unwrap_or_default()));
    }
    fs::write(output, lines.join("\n")).expect("write probe");
}
"#,
        )
        .unwrap();
        let executable = directory.join(if cfg!(windows) {
            "process_probe.exe"
        } else {
            "process_probe"
        });
        let status = Command::new("rustc")
            .arg(&source)
            .arg("-o")
            .arg(&executable)
            .status()
            .expect("rustc should build the process probe");
        assert!(status.success());
        executable
    }

    #[test]
    fn helper_observes_filtered_environment_and_native_arguments() {
        let temporary = TempDir::new().unwrap();
        let executable = build_probe(temporary.path());
        let output = temporary.path().join("probe.txt");
        let inherited = [
            (
                OsString::from("PORTCOVE_GITHUB_TOKEN"),
                OsString::from("pc-secret"),
            ),
            (OsString::from("GH_TOKEN"), OsString::from("gh-secret")),
            (
                OsString::from("GITHUB_TOKEN"),
                OsString::from("github-secret"),
            ),
            (
                OsString::from("SAMPLE_API_KEY"),
                OsString::from("api-secret"),
            ),
            (OsString::from("PATH"), OsString::from("reviewed-path")),
            (OsString::from("DISPLAY"), OsString::from(":42")),
        ];
        let mut command = ChildProcessPolicy::command_with_environment(
            ChildProcessClass::Game,
            &executable,
            inherited,
        );
        command
            .args(["literal argument", "& remains literal for native programs"])
            .env("PROBE_OUTPUT", &output)
            .env("PORTCOVE_PORT_ID", "test-port")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        assert!(command.status().unwrap().success());
        let observed = fs::read_to_string(output).unwrap();
        assert!(observed.contains("arg=literal argument"));
        assert!(observed.contains("arg=& remains literal for native programs"));
        assert!(observed.contains("env:PORTCOVE_GITHUB_TOKEN="));
        assert!(observed.contains("env:GH_TOKEN="));
        assert!(observed.contains("env:GITHUB_TOKEN="));
        assert!(observed.contains("env:SAMPLE_API_KEY="));
        assert!(observed.contains("env:PATH=reviewed-path"));
        assert!(observed.contains("env:DISPLAY=:42"));
        assert!(observed.contains("env:PORTCOVE_PORT_ID=test-port"));
        assert!(!observed.contains("secret"));
    }

    #[test]
    fn game_command_rejects_forwarded_batch_arguments_before_spawn() {
        let spec = GameProcessSpec {
            executable: PathBuf::from("launch.bat"),
            launch_kind: LaunchKind::WindowsBatch,
            working_directory: PathBuf::from("."),
            environment: BTreeMap::new(),
            fixed_arguments: Vec::new(),
        };
        let error = ChildProcessPolicy::game_command(&spec, &["& whoami".into()]).unwrap_err();
        assert!(error.message.contains("caller-supplied arguments"));
    }

    #[test]
    fn game_command_rejects_credential_shaped_overlays() {
        let spec = GameProcessSpec {
            executable: PathBuf::from("game"),
            launch_kind: LaunchKind::Native,
            working_directory: PathBuf::from("."),
            environment: BTreeMap::from([("FUTURE_SERVICE_TOKEN".into(), "secret".into())]),
            fixed_arguments: Vec::new(),
        };
        let error = ChildProcessPolicy::game_command(&spec, &[]).unwrap_err();
        assert_eq!(
            error.details.get("variable").map(String::as_str),
            Some("FUTURE_SERVICE_TOKEN")
        );
        assert!(!format!("{error:?}").contains("secret"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_batch_receives_only_reviewed_fixed_arguments() {
        let temporary = TempDir::new().unwrap();
        let batch = temporary.path().join("launch.bat");
        let output = temporary.path().join("batch-output.txt");
        fs::write(&batch, "@echo off\r\n> \"%~1\" echo fixed=%~2\r\n").unwrap();
        let spec = GameProcessSpec {
            executable: batch,
            launch_kind: LaunchKind::WindowsBatch,
            working_directory: temporary.path().to_path_buf(),
            environment: BTreeMap::new(),
            fixed_arguments: vec![output.display().to_string(), "safe-value".into()],
        };
        let status = ChildProcessPolicy::game_command(&spec, &[])
            .unwrap()
            .status()
            .unwrap();
        assert!(status.success());
        assert_eq!(
            fs::read_to_string(output).unwrap().trim(),
            "fixed=safe-value"
        );
    }

    #[test]
    fn batch_fixed_arguments_reject_shell_metacharacters() {
        for value in [
            "%PATH%", "!value!", "a&b", "a|b", "<in", ">out", "^x", "(x)", "\"x\"",
        ] {
            let error = validate_windows_batch_argument(value).unwrap_err();
            assert_eq!(
                error.details.get("launch_kind").map(String::as_str),
                Some("windows_batch")
            );
        }
        let path_with_spaces = PathBuf::from("Program Files")
            .join("Portcove")
            .display()
            .to_string();
        for value in ["--game", "jak1", "import/disc.cue", &path_with_spaces] {
            validate_windows_batch_argument(value).unwrap();
        }
    }

    #[test]
    fn every_process_class_uses_the_same_credential_boundary() {
        for class in [
            ChildProcessClass::Game,
            ChildProcessClass::UpstreamSetup,
            ChildProcessClass::HostTool,
            ChildProcessClass::ManagedBuilder,
            ChildProcessClass::HostIntegration,
        ] {
            let mut command = ChildProcessPolicy::command_with_environment(
                class,
                "unused",
                [(OsString::from("GITHUB_TOKEN"), OsString::from("secret"))],
            );
            let mut debug = Vec::new();
            write!(&mut debug, "{command:?}").unwrap();
            assert!(!String::from_utf8(debug).unwrap().contains("secret"));
            command.stdin(Stdio::null());
        }
    }
}
