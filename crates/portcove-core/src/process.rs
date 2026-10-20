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
    /// Core derives this from the retained runtime's reviewed launch contract.
    pub fixed_arguments_only: bool,
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
    pub fixed_arguments_only: bool,
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
            fixed_arguments_only: self.fixed_arguments_only,
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct ChildProcessPolicy;

/// Complete private launch input for supervised native tools. Unlike `Command`,
/// this has no implicit ambient environment or hidden platform launch options.
/// The Windows controller can consume it without guessing Command's state.
#[derive(Clone)]
pub(crate) struct NativeToolLaunchSpec {
    pub(crate) program: OsString,
    pub(crate) arguments: Vec<OsString>,
    pub(crate) environment: BTreeMap<OsString, OsString>,
    pub(crate) working_directory: Option<PathBuf>,
    pub(crate) decoder_limits: Option<DecoderLimits>,
    #[cfg(all(windows, test))]
    pub(crate) raw_arguments: Vec<OsString>,
}

/// Private resource boundary for decoding an untrusted source container.
/// Ordinary setup and launch specifications do not enable this boundary.
#[derive(Clone, Copy, Debug)]
pub(crate) struct DecoderLimits {
    pub(crate) memory_bytes: usize,
    pub(crate) file_bytes: u64,
}

impl std::fmt::Debug for NativeToolLaunchSpec {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("NativeToolLaunchSpec")
            .field("program", &self.program)
            .field("argument_count", &self.arguments.len())
            .field("environment_count", &self.environment.len())
            .field("working_directory", &self.working_directory)
            .finish_non_exhaustive()
    }
}

impl NativeToolLaunchSpec {
    pub(crate) fn arg(&mut self, argument: impl AsRef<OsStr>) -> &mut Self {
        self.arguments.push(argument.as_ref().to_owned());
        self
    }

    pub(crate) fn args<I, S>(&mut self, arguments: I) -> &mut Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        for argument in arguments {
            self.arg(argument);
        }
        self
    }

    pub(crate) fn current_dir(&mut self, directory: impl AsRef<Path>) -> &mut Self {
        self.working_directory = Some(directory.as_ref().to_owned());
        self
    }

    pub(crate) fn env(&mut self, name: impl AsRef<OsStr>, value: impl AsRef<OsStr>) -> &mut Self {
        self.env_remove(name.as_ref());
        self.environment
            .insert(name.as_ref().to_owned(), value.as_ref().to_owned());
        self
    }

    pub(crate) fn envs<I, K, V>(&mut self, environment: I) -> &mut Self
    where
        I: IntoIterator<Item = (K, V)>,
        K: AsRef<OsStr>,
        V: AsRef<OsStr>,
    {
        for (name, value) in environment {
            self.env(name, value);
        }
        self
    }

    pub(crate) fn env_remove(&mut self, name: impl AsRef<OsStr>) -> &mut Self {
        self.environment
            .retain(|key, _| !environment_names_equal(key, name.as_ref()));
        self
    }

    // Only the existing guarded junction fixtures need shell-native syntax.
    // Production native tools cannot opt into raw arguments or shell expansion.
    #[cfg(all(windows, test))]
    pub(crate) fn raw_arg(&mut self, argument: impl AsRef<OsStr>) -> &mut Self {
        self.raw_arguments.push(argument.as_ref().to_owned());
        self
    }

    pub(crate) fn command(&self) -> Result<Command> {
        if self
            .decoder_limits
            .is_some_and(|limits| limits.memory_bytes == 0 || limits.file_bytes == 0)
        {
            return Err(PortcoveError::launch(
                "source decoder resource limits must be positive",
            ));
        }
        for name in self.environment.keys() {
            if name.to_str().is_some_and(is_credential_name) {
                return Err(PortcoveError::launch(
                    "a credential-shaped variable cannot be added to a child process",
                )
                .detail("variable", name.to_string_lossy()));
            }
        }
        let mut command = Command::new(&self.program);
        command
            .env_clear()
            .envs(&self.environment)
            .args(&self.arguments);
        if let Some(directory) = &self.working_directory {
            command.current_dir(directory);
        }
        #[cfg(all(windows, test))]
        {
            use std::os::windows::process::CommandExt;
            for argument in &self.raw_arguments {
                command.raw_arg(argument);
            }
        }
        Ok(command)
    }
}

pub(crate) fn environment_names_equal(left: &OsStr, right: &OsStr) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Globalization::{CSTR_EQUAL, CompareStringOrdinal};
        let left: Vec<_> = left.encode_wide().collect();
        let right: Vec<_> = right.encode_wide().collect();
        let (Ok(left_len), Ok(right_len)) = (i32::try_from(left.len()), i32::try_from(right.len()))
        else {
            return false;
        };
        // SAFETY: both buffers have exactly the supplied lengths. Ordinal Windows
        // environment comparison is case-insensitive, including Unicode names.
        unsafe {
            CompareStringOrdinal(left.as_ptr(), left_len, right.as_ptr(), right_len, 1)
                == CSTR_EQUAL
        }
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

impl ChildProcessPolicy {
    pub(crate) fn native_tool_spec(
        class: ChildProcessClass,
        program: impl AsRef<OsStr>,
    ) -> Result<NativeToolLaunchSpec> {
        Self::require_native(class, program.as_ref())?;
        Ok(Self::tool_spec_with_environment(
            program,
            std::env::vars_os(),
        ))
    }

    fn tool_spec_with_environment(
        program: impl AsRef<OsStr>,
        environment: impl IntoIterator<Item = (OsString, OsString)>,
    ) -> NativeToolLaunchSpec {
        let mut spec = NativeToolLaunchSpec {
            program: program.as_ref().to_owned(),
            arguments: Vec::new(),
            environment: BTreeMap::new(),
            working_directory: None,
            decoder_limits: None,
            #[cfg(all(windows, test))]
            raw_arguments: Vec::new(),
        };
        spec.envs(reviewed_environment(environment));
        spec
    }

    pub fn native_command(class: ChildProcessClass, program: impl AsRef<OsStr>) -> Result<Command> {
        Self::require_native(class, program.as_ref())?;
        Ok(Self::command_with_environment(
            class,
            program,
            std::env::vars_os(),
        ))
    }

    fn require_native(class: ChildProcessClass, program: &OsStr) -> Result<()> {
        if LaunchKind::for_executable(Path::new(program)) == LaunchKind::WindowsBatch {
            return Err(PortcoveError::launch(
                "scripts cannot be used where a native child executable is required",
            )
            .detail("process_class", format!("{class:?}")));
        }
        Ok(())
    }

    pub fn game_command(spec: &GameProcessSpec, forwarded_arguments: &[String]) -> Result<Command> {
        if spec.fixed_arguments_only && !forwarded_arguments.is_empty() {
            return Err(PortcoveError::launch(
                "this runtime offers only its fixed ordinary launch; additional arguments are not supported",
            ));
        }
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
        command.envs(reviewed_environment(environment));
        command
    }
}

fn reviewed_environment(
    environment: impl IntoIterator<Item = (OsString, OsString)>,
) -> impl Iterator<Item = (OsString, OsString)> {
    environment.into_iter().filter(|(name, _)| {
        name.to_str()
            .is_some_and(|name| !is_credential_name(name) && is_reviewed_session_variable(name))
    })
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
    // SDL interprets this as a native library to load, not an ordinary hint.
    // Inherited host settings cannot select a different SDL implementation DLL.
    if normalized == "SDL_DYNAMIC_API" {
        return false;
    }
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

    #[test]
    fn native_library_override_is_filtered_without_losing_sdl_hints() {
        for name in ["SDL_DYNAMIC_API", "sdl_dynamic_api", "sDl_DyNaMiC_aPi"] {
            let spec = ChildProcessPolicy::tool_spec_with_environment(
                "never-spawned",
                [
                    (name.into(), "unreviewed-native-library".into()),
                    ("SDL_RENDER_DRIVER".into(), "software".into()),
                    ("PATH".into(), "reviewed-path".into()),
                    ("VK_DRIVER_FILES".into(), "reviewed-driver-setting".into()),
                ],
            );
            let command = spec.command().unwrap();
            let environment = command
                .get_envs()
                .map(|(key, value)| (key.to_owned(), value.unwrap().to_owned()))
                .collect::<BTreeMap<_, _>>();
            assert!(!environment.contains_key(OsStr::new(name)));
            assert_eq!(environment[OsStr::new("SDL_RENDER_DRIVER")], "software");
            assert_eq!(environment[OsStr::new("PATH")], "reviewed-path");
            assert_eq!(
                environment[OsStr::new("VK_DRIVER_FILES")],
                "reviewed-driver-setting"
            );
        }
    }

    #[test]
    fn tool_spec_carries_complete_filtered_launch_input() {
        let environment = [
            ("PATH".into(), "reviewed-path".into()),
            ("DISPLAY".into(), ":42".into()),
            ("GITHUB_TOKEN".into(), "fixture-secret".into()),
            ("UNREVIEWED_HOST_SETTING".into(), "fixture-secret".into()),
        ];
        let mut spec = ChildProcessPolicy::tool_spec_with_environment("native-tool", environment);
        spec.args(["", "quoted \"argument\"", "Unicode 日本語", "trailing\\"])
            .current_dir("private preparation")
            .env_remove("DISPLAY")
            .env("HOME", "private home");
        let command = spec.command().unwrap();
        assert_eq!(command.get_program(), "native-tool");
        assert_eq!(
            command.get_current_dir(),
            Some(Path::new("private preparation"))
        );
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            spec.arguments
                .iter()
                .map(OsString::as_os_str)
                .collect::<Vec<_>>()
        );
        assert_eq!(
            command
                .get_envs()
                .map(|(key, value)| (key.to_owned(), value.unwrap().to_owned()))
                .collect::<BTreeMap<_, _>>(),
            BTreeMap::from([
                ("HOME".into(), "private home".into()),
                ("PATH".into(), "reviewed-path".into())
            ])
        );
        assert!(!format!("{spec:?}").contains("fixture-secret"));
    }

    #[test]
    fn tool_spec_and_existing_commands_share_session_inheritance() {
        let environment = [
            ("PATH".into(), "reviewed-path".into()),
            ("HOME".into(), "reviewed-home".into()),
            ("LD_LIBRARY_PATH".into(), "reviewed-runtime".into()),
            ("STEAMAPPID".into(), "480".into()),
            ("FUTURE_SERVICE_TOKEN".into(), "fixture-secret".into()),
            ("PORTCOVE_UNREVIEWED".into(), "fixture-secret".into()),
        ];
        let old = ChildProcessPolicy::command_with_environment(
            ChildProcessClass::ManagedBuilder,
            "native-tool",
            environment.clone(),
        );
        let new = ChildProcessPolicy::tool_spec_with_environment("native-tool", environment)
            .command()
            .unwrap();
        let collect = |command: &Command| {
            command
                .get_envs()
                .map(|(key, value)| (key.to_owned(), value.map(OsStr::to_owned)))
                .collect::<BTreeMap<_, _>>()
        };
        assert_eq!(collect(&new), collect(&old));
    }

    #[test]
    fn tool_spec_refuses_credential_overlays_before_command_construction() {
        let mut spec = ChildProcessPolicy::tool_spec_with_environment("never-spawned", []);
        spec.env("FUTURE_SERVICE_TOKEN", "fixture-secret");
        let error = spec.command().unwrap_err();
        assert_eq!(error.details["variable"], "FUTURE_SERVICE_TOKEN");
        assert!(!format!("{error:?}").contains("fixture-secret"));
        assert!(!format!("{spec:?}").contains("fixture-secret"));
    }

    #[cfg(windows)]
    #[test]
    fn tool_spec_windows_overlays_replace_and_remove_case_aliases() {
        let mut spec = ChildProcessPolicy::tool_spec_with_environment(
            "never-spawned",
            [("Path".into(), "host".into())],
        );
        spec.env("PATH", "pinned")
            .env("日本Ä", "first")
            .env("日本ä", "second");
        assert_eq!(spec.environment.len(), 2);
        assert_eq!(spec.environment[OsStr::new("PATH")], "pinned");
        assert_eq!(spec.environment[OsStr::new("日本ä")], "second");
        spec.env_remove("path").env_remove("日本Ä");
        assert!(spec.environment.is_empty());
    }

    #[test]
    fn tool_spec_rejects_batch_programs() {
        for program in ["setup.cmd", "setup.BAT"] {
            assert!(
                ChildProcessPolicy::native_tool_spec(ChildProcessClass::UpstreamSetup, program)
                    .is_err()
            );
        }
    }

    fn build_probe(directory: &Path) -> PathBuf {
        let source = directory.join("process_probe.rs");
        fs::write(
            &source,
            r#"use std::{env, fs};
fn main() {
    let output = env::var_os("PROBE_OUTPUT").expect("PROBE_OUTPUT");
    let mut lines = env::args().skip(1).map(|arg| format!("arg={arg}")).collect::<Vec<_>>();
    for key in ["PORTCOVE_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "SAMPLE_API_KEY", "PATH", "DISPLAY", "PORTCOVE_PORT_ID", "SDL_DYNAMIC_API", "SDL_RENDER_DRIVER"] {
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
            (
                OsString::from("SDL_DYNAMIC_API"),
                OsString::from("unreviewed-native-library"),
            ),
            (
                OsString::from("SDL_RENDER_DRIVER"),
                OsString::from("software"),
            ),
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
        assert!(observed.contains("env:SDL_DYNAMIC_API=\n"));
        assert!(observed.contains("env:SDL_RENDER_DRIVER=software"));
        assert!(!observed.contains("unreviewed-native-library"));
        assert!(!observed.contains("secret"));
    }

    #[test]
    fn fixed_native_runtime_refuses_unoffered_output_arguments_before_spawn() {
        let mut spec = GameProcessSpec {
            executable: PathBuf::from("game.exe"),
            launch_kind: LaunchKind::Native,
            working_directory: PathBuf::from("."),
            environment: BTreeMap::new(),
            fixed_arguments: vec!["game.gba".into()],
            fixed_arguments_only: true,
        };
        let error = ChildProcessPolicy::game_command(
            &spec,
            &["--record".into(), "output & command".into()],
        )
        .unwrap_err();
        assert!(error.message.contains("fixed ordinary launch"));
        let ordinary = ChildProcessPolicy::game_command(&spec, &[]).unwrap();
        assert_eq!(
            ordinary.get_args().collect::<Vec<_>>(),
            [OsStr::new("game.gba")]
        );
        spec.fixed_arguments_only = false;
        let existing = ChildProcessPolicy::game_command(&spec, &["--example".into()]).unwrap();
        assert_eq!(
            existing.get_args().collect::<Vec<_>>(),
            [OsStr::new("game.gba"), OsStr::new("--example")]
        );
    }

    #[test]
    fn game_command_rejects_forwarded_batch_arguments_before_spawn() {
        let spec = GameProcessSpec {
            executable: PathBuf::from("launch.bat"),
            launch_kind: LaunchKind::WindowsBatch,
            working_directory: PathBuf::from("."),
            environment: BTreeMap::new(),
            fixed_arguments: Vec::new(),
            fixed_arguments_only: false,
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
            fixed_arguments_only: false,
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
            fixed_arguments_only: false,
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
