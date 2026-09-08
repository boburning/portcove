//! Fixed host-tool definitions and the shared environment/saved/discovery resolver.

use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    ChildProcessClass, ChildProcessPolicy, HostPreferenceStore, HostToolSource, HostToolState,
    HostToolStatus, Platform, PortcoveError, Result,
};

const MAX_EXECUTABLE_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct HostToolProbePolicy {
    pub arguments: Vec<String>,
    pub accepted_exit_codes: Vec<i32>,
    pub expected_output: String,
    pub required_output_markers: Vec<String>,
    pub timeout_millis: u64,
    pub max_output_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct HostToolDefinition {
    pub id: String,
    pub display_name: String,
    pub configuration_variable: String,
    pub purpose: String,
    pub official_url: String,
    pub supported_platforms: Vec<Platform>,
    pub probe: HostToolProbePolicy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum HostToolProbeState {
    Missing,
    Invalid,
    Blocked,
    TimedOut,
    ExcessiveOutput,
    FailedProbe,
    IncompatibleVersion,
    Cancelled,
    Success,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct HostToolProbeResult {
    pub tool_id: String,
    pub path: PathBuf,
    pub state: HostToolProbeState,
    pub message: String,
    pub sha256: Option<String>,
    pub persisted: bool,
    pub retry_action: String,
    pub clear_action_available: bool,
}

pub fn definitions() -> Vec<HostToolDefinition> {
    let registry = fixed_definitions();
    debug_assert!(validate_definitions(&registry).is_ok());
    registry
}

fn fixed_definitions() -> Vec<HostToolDefinition> {
    let all = vec![
        Platform::WindowsX86_64,
        Platform::LinuxX86_64,
        Platform::MacosX86_64,
        Platform::MacosAarch64,
    ];
    vec![
        HostToolDefinition {
            id: "chdman".into(),
            display_name: "chdman".into(),
            configuration_variable: "PORTCOVE_CHDMAN".into(),
            purpose: "CHD validation and disc-image materialization".into(),
            official_url: "https://docs.mamedev.org/tools/chdman.html".into(),
            supported_platforms: all.clone(),
            probe: HostToolProbePolicy {
                arguments: vec!["-help".into()],
                // chdman prints its complete help successfully but exits 1.
                accepted_exit_codes: vec![0, 1],
                expected_output: "chdman".into(),
                required_output_markers: vec!["verify".into(), "extractdvd".into()],
                timeout_millis: 5_000,
                max_output_bytes: 64 * 1024,
            },
        },
        HostToolDefinition {
            id: "dolphin_tool".into(),
            display_name: "DolphinTool".into(),
            configuration_variable: "PORTCOVE_DOLPHIN_TOOL".into(),
            purpose: "compressed GameCube validation and ISO materialization".into(),
            official_url: "https://dolphin-emu.org/download/".into(),
            supported_platforms: all,
            probe: HostToolProbePolicy {
                arguments: vec!["--help".into()],
                accepted_exit_codes: vec![0],
                expected_output: "DolphinTool".into(),
                required_output_markers: vec!["convert".into(), "verify".into()],
                timeout_millis: 5_000,
                max_output_bytes: 64 * 1024,
            },
        },
    ]
}

pub(crate) fn validate_definitions(registry: &[HostToolDefinition]) -> Result<()> {
    let expected = fixed_definitions();
    if registry.len() != expected.len() {
        return Err(PortcoveError::usage(format!(
            "host-tool registry must contain exactly {} reviewed definitions",
            expected.len()
        )));
    }

    let mut seen = std::collections::HashSet::new();
    for definition in registry {
        if !seen.insert(definition.id.as_str()) {
            return Err(PortcoveError::usage(format!(
                "duplicate host-tool ID: {}",
                definition.id
            )));
        }
        let reviewed = expected
            .iter()
            .find(|candidate| candidate.id == definition.id)
            .ok_or_else(|| {
                PortcoveError::usage(format!(
                    "unknown host-tool ID is not reviewed: {}",
                    definition.id
                ))
            })?;
        let url = reqwest::Url::parse(&definition.official_url).map_err(|error| {
            PortcoveError::usage(format!(
                "host-tool {} has an invalid official URL: {error}",
                definition.id
            ))
        })?;
        if url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || definition.official_url != reviewed.official_url
        {
            return Err(PortcoveError::usage(format!(
                "host-tool {} official URL is not the reviewed HTTPS reference",
                definition.id
            )));
        }
        if definition.supported_platforms != reviewed.supported_platforms {
            return Err(PortcoveError::usage(format!(
                "host-tool {} has an unsupported platform policy",
                definition.id
            )));
        }
        if definition.probe != reviewed.probe {
            return Err(PortcoveError::usage(format!(
                "host-tool {} has an inconsistent probe definition",
                definition.id
            )));
        }
        if definition.display_name != reviewed.display_name
            || definition.configuration_variable != reviewed.configuration_variable
            || definition.purpose != reviewed.purpose
        {
            return Err(PortcoveError::usage(format!(
                "host-tool {} does not match its reviewed definition",
                definition.id
            )));
        }
    }
    Ok(())
}

pub fn definition(id: &str) -> Result<HostToolDefinition> {
    definitions()
        .into_iter()
        .find(|definition| definition.id == id)
        .ok_or_else(|| PortcoveError::usage(format!("unknown host tool: {id}")))
}

pub fn probe_host_tool(id: &str, path: &Path) -> Result<HostToolProbeResult> {
    let definition = definition(id)?;
    Ok(probe_definition(&definition, path, || {}))
}

pub fn probe_host_tool_with_cancellation(
    id: &str,
    path: &Path,
    cancelled: impl Fn() -> bool,
) -> Result<HostToolProbeResult> {
    let definition = definition(id)?;
    Ok(probe_definition_with_cancellation(
        &definition,
        path,
        || {},
        cancelled,
    ))
}

pub fn configure_host_tool(
    preferences: &HostPreferenceStore,
    id: &str,
    path: &Path,
) -> Result<HostToolProbeResult> {
    configure_host_tool_with_cancellation(preferences, id, path, || false)
}

pub fn configure_host_tool_with_cancellation(
    preferences: &HostPreferenceStore,
    id: &str,
    path: &Path,
    cancelled: impl Fn() -> bool,
) -> Result<HostToolProbeResult> {
    configure_host_tool_with_hooks(preferences, id, path, || {}, cancelled)
}

fn configure_host_tool_with_hooks(
    preferences: &HostPreferenceStore,
    id: &str,
    path: &Path,
    before_persist: impl FnOnce(),
    cancelled: impl Fn() -> bool,
) -> Result<HostToolProbeResult> {
    let previous = preferences.host_tool_preference(id)?;
    let mut result = probe_host_tool_with_cancellation(id, path, cancelled)?;
    result.clear_action_available = previous.is_some();
    if result.state == HostToolProbeState::Success {
        let sha256 = result
            .sha256
            .as_deref()
            .expect("a successful probe has a fingerprint");
        before_persist();
        if preferences.replace_host_tool_path_if_unchanged(id, previous.as_ref(), path, sha256)? {
            result.persisted = true;
            result.clear_action_available = true;
        } else {
            result.state = HostToolProbeState::Invalid;
            result.message = "the host-tool preference changed while the probe was running".into();
            result.sha256 = None;
            result.clear_action_available = preferences.host_tool_path(id)?.is_some();
        }
    }
    Ok(result)
}

pub fn clear_host_tool(preferences: &HostPreferenceStore, id: &str) -> Result<()> {
    preferences.clear_host_tool_path(id)
}

fn probe_definition(
    definition: &HostToolDefinition,
    path: &Path,
    before_spawn: impl FnOnce(),
) -> HostToolProbeResult {
    probe_definition_with_cancellation(definition, path, before_spawn, || false)
}

fn probe_definition_with_cancellation(
    definition: &HostToolDefinition,
    path: &Path,
    before_spawn: impl FnOnce(),
    cancelled: impl Fn() -> bool,
) -> HostToolProbeResult {
    let platform = match Platform::current() {
        Ok(platform) => platform,
        Err(error) => {
            return probe_result(
                definition,
                path,
                HostToolProbeState::Blocked,
                error.message,
                None,
            );
        }
    };
    if !definition.supported_platforms.contains(&platform) {
        return probe_result(
            definition,
            path,
            HostToolProbeState::Blocked,
            format!(
                "{} is not supported on this platform",
                definition.display_name
            ),
            None,
        );
    }
    let initial = match selected_file_fingerprint(path, platform) {
        Ok(fingerprint) => fingerprint,
        Err(failure) => {
            return probe_result(definition, path, failure.state, failure.message, None);
        }
    };

    before_spawn();
    let pre_spawn = match selected_file_fingerprint(path, platform) {
        Ok(fingerprint) => fingerprint,
        Err(failure) => {
            return probe_result(definition, path, failure.state, failure.message, None);
        }
    };
    if initial != pre_spawn {
        return probe_result(
            definition,
            path,
            HostToolProbeState::Invalid,
            "the selected executable changed before its probe started".into(),
            None,
        );
    }

    if let Err(failure) = run_fixed_probe(definition, path, cancelled) {
        return probe_result(definition, path, failure.state, failure.message, None);
    }
    let final_fingerprint = match selected_file_fingerprint(path, platform) {
        Ok(fingerprint) => fingerprint,
        Err(failure) => {
            return probe_result(definition, path, failure.state, failure.message, None);
        }
    };
    if initial != final_fingerprint {
        return probe_result(
            definition,
            path,
            HostToolProbeState::Invalid,
            "the selected executable changed while it was being probed".into(),
            None,
        );
    }
    probe_result(
        definition,
        path,
        HostToolProbeState::Success,
        format!("{} passed its fixed probe", definition.display_name),
        Some(initial.sha256),
    )
}

fn run_fixed_probe(
    definition: &HostToolDefinition,
    path: &Path,
    cancelled: impl Fn() -> bool,
) -> std::result::Result<(), ProbeFailure> {
    let mut command = ChildProcessPolicy::native_command(ChildProcessClass::HostTool, path)
        .map_err(|error| ProbeFailure {
            state: HostToolProbeState::Blocked,
            message: error.message,
        })?;
    command
        .args(&definition.probe.arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|error| ProbeFailure {
        state: spawn_error_state(error.kind()),
        message: format!("could not start the fixed probe: {error}"),
    })?;
    let process_group = match ProbeProcessGroup::attach(&child) {
        Ok(process_group) => process_group,
        Err(failure) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(failure);
        }
    };
    let total = Arc::new(AtomicU64::new(0));
    let (exceeded_tx, exceeded_rx) = mpsc::channel();
    let stdout = child.stdout.take().expect("piped probe stdout");
    let stderr = child.stderr.take().expect("piped probe stderr");
    let max_output = definition.probe.max_output_bytes;
    let stdout_reader = spawn_output_reader(stdout, total.clone(), max_output, exceeded_tx.clone());
    let stderr_reader = spawn_output_reader(stderr, total.clone(), max_output, exceeded_tx);
    let deadline = Instant::now() + Duration::from_millis(definition.probe.timeout_millis);
    let (status, interrupted) = wait_for_probe(
        &mut child,
        &process_group,
        deadline,
        &exceeded_rx,
        cancelled,
    )?;
    let stdout = stdout_reader.join().ok().and_then(std::result::Result::ok);
    let stderr = stderr_reader.join().ok().and_then(std::result::Result::ok);
    if let Some(state) = interrupted {
        return Err(ProbeFailure {
            state,
            message: interrupted_probe_message(state).into(),
        });
    }
    let (Some(stdout), Some(stderr)) = (stdout, stderr) else {
        return Err(ProbeFailure {
            state: HostToolProbeState::FailedProbe,
            message: "could not collect the fixed probe output".into(),
        });
    };
    if total.load(Ordering::Relaxed) > max_output {
        return Err(ProbeFailure {
            state: HostToolProbeState::ExcessiveOutput,
            message: interrupted_probe_message(HostToolProbeState::ExcessiveOutput).into(),
        });
    }
    let status = status.expect("an uninterrupted probe has an exit status");
    if !status
        .code()
        .is_some_and(|code| definition.probe.accepted_exit_codes.contains(&code))
    {
        return Err(ProbeFailure {
            state: HostToolProbeState::FailedProbe,
            message: format!("the fixed probe exited unsuccessfully: {status}"),
        });
    }
    validate_probe_output(definition, stdout, stderr)
}

fn wait_for_probe(
    child: &mut std::process::Child,
    process_group: &ProbeProcessGroup,
    deadline: Instant,
    exceeded: &mpsc::Receiver<()>,
    cancelled: impl Fn() -> bool,
) -> std::result::Result<(Option<std::process::ExitStatus>, Option<HostToolProbeState>), ProbeFailure>
{
    loop {
        let interrupted = if cancelled() {
            Some(HostToolProbeState::Cancelled)
        } else if exceeded.try_recv().is_ok() {
            Some(HostToolProbeState::ExcessiveOutput)
        } else if Instant::now() >= deadline {
            Some(HostToolProbeState::TimedOut)
        } else {
            None
        };
        if let Some(state) = interrupted {
            terminate_probe(child, process_group);
            return Ok((None, Some(state)));
        }
        match child.try_wait() {
            Ok(Some(status)) => return Ok((Some(status), None)),
            Ok(None) => thread::sleep(Duration::from_millis(10)),
            Err(error) => {
                terminate_probe(child, process_group);
                return Err(ProbeFailure {
                    state: HostToolProbeState::FailedProbe,
                    message: format!("could not observe the fixed probe: {error}"),
                });
            }
        }
    }
}

fn validate_probe_output(
    definition: &HostToolDefinition,
    mut stdout: Vec<u8>,
    stderr: Vec<u8>,
) -> std::result::Result<(), ProbeFailure> {
    stdout.extend(stderr);
    let output = String::from_utf8(stdout).map_err(|_| ProbeFailure {
        state: HostToolProbeState::Invalid,
        message: "the fixed probe returned malformed output".into(),
    })?;
    if output.trim().is_empty() {
        return Err(ProbeFailure {
            state: HostToolProbeState::Invalid,
            message: "the fixed probe returned malformed output".into(),
        });
    }
    let normalized = output.to_ascii_lowercase();
    if !normalized.contains(&definition.probe.expected_output.to_ascii_lowercase()) {
        return Err(ProbeFailure {
            state: HostToolProbeState::Invalid,
            message: format!("probe output does not identify {}", definition.display_name),
        });
    }
    if definition
        .probe
        .required_output_markers
        .iter()
        .any(|marker| !normalized.contains(&marker.to_ascii_lowercase()))
    {
        return Err(ProbeFailure {
            state: HostToolProbeState::IncompatibleVersion,
            message: format!(
                "{} does not advertise the required commands for this Portcove version",
                definition.display_name
            ),
        });
    }
    Ok(())
}

fn interrupted_probe_message(state: HostToolProbeState) -> &'static str {
    match state {
        HostToolProbeState::TimedOut => "the fixed probe exceeded its time limit",
        HostToolProbeState::Cancelled => "the fixed probe was cancelled and cleaned up",
        _ => "the fixed probe exceeded its output limit",
    }
}

fn spawn_error_state(kind: std::io::ErrorKind) -> HostToolProbeState {
    match kind {
        std::io::ErrorKind::NotFound => HostToolProbeState::Missing,
        std::io::ErrorKind::PermissionDenied => HostToolProbeState::Blocked,
        _ => HostToolProbeState::FailedProbe,
    }
}

#[derive(Debug)]
struct ProbeFailure {
    state: HostToolProbeState,
    message: String,
}

#[derive(Debug, PartialEq, Eq)]
struct SelectedFileFingerprint {
    size: u64,
    sha256: String,
}

fn selected_file_fingerprint(
    path: &Path,
    platform: Platform,
) -> std::result::Result<SelectedFileFingerprint, ProbeFailure> {
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(ProbeFailure {
            state: HostToolProbeState::Invalid,
            message: "host-tool selections must use an absolute path without parent traversal"
                .into(),
        });
    }
    if crate::path::unicode(path, "host-tool executable").is_err()
        || crate::path::refuse_symlink_ancestors(path).is_err()
    {
        return Err(ProbeFailure {
            state: HostToolProbeState::Invalid,
            message: "host-tool selections cannot use symlinks or non-Unicode paths".into(),
        });
    }
    let metadata = fs::symlink_metadata(path).map_err(|error| ProbeFailure {
        state: match error.kind() {
            std::io::ErrorKind::NotFound => HostToolProbeState::Missing,
            std::io::ErrorKind::PermissionDenied => HostToolProbeState::Blocked,
            _ => HostToolProbeState::Invalid,
        },
        message: format!("could not inspect the selected executable: {error}"),
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(ProbeFailure {
            state: HostToolProbeState::Invalid,
            message: "the selected path must be a regular file and cannot be a symlink".into(),
        });
    }
    validate_platform_path(path, platform)?;
    #[cfg(unix)]
    if crate::permissions::platform_requires_executable(platform)
        && !crate::permissions::executable_intent(path).unwrap_or(false)
    {
        return Err(ProbeFailure {
            state: HostToolProbeState::Invalid,
            message: "the selected file is not executable on this host".into(),
        });
    }
    if metadata.len() > MAX_EXECUTABLE_BYTES {
        return Err(ProbeFailure {
            state: HostToolProbeState::Invalid,
            message: "the selected executable exceeds the validation size limit".into(),
        });
    }
    let mut file = fs::File::open(path).map_err(|error| ProbeFailure {
        state: if error.kind() == std::io::ErrorKind::PermissionDenied {
            HostToolProbeState::Blocked
        } else {
            HostToolProbeState::Invalid
        },
        message: format!("could not read the selected executable: {error}"),
    })?;
    let mut hasher = Sha256::new();
    let mut read = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|error| ProbeFailure {
            state: if error.kind() == std::io::ErrorKind::PermissionDenied {
                HostToolProbeState::Blocked
            } else {
                HostToolProbeState::Invalid
            },
            message: format!("could not read the selected executable: {error}"),
        })?;
        if count == 0 {
            break;
        }
        read = read.saturating_add(count as u64);
        if read > MAX_EXECUTABLE_BYTES {
            return Err(ProbeFailure {
                state: HostToolProbeState::Invalid,
                message: "the selected executable grew beyond the validation size limit".into(),
            });
        }
        hasher.update(&buffer[..count]);
    }
    Ok(SelectedFileFingerprint {
        size: read,
        sha256: hex::encode(hasher.finalize()),
    })
}

fn validate_platform_path(
    path: &Path,
    platform: Platform,
) -> std::result::Result<(), ProbeFailure> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(
        extension.as_str(),
        "bat" | "cmd" | "ps1" | "psm1" | "sh" | "bash" | "zsh" | "fish"
    ) {
        return Err(ProbeFailure {
            state: HostToolProbeState::Blocked,
            message: "script files cannot be selected as native host tools".into(),
        });
    }
    if platform == Platform::WindowsX86_64 && extension != "exe" {
        return Err(ProbeFailure {
            state: HostToolProbeState::Invalid,
            message: "Windows host tools must be native .exe files".into(),
        });
    }
    Ok(())
}

fn spawn_output_reader(
    mut reader: impl Read + Send + 'static,
    total: Arc<AtomicU64>,
    limit: u64,
    exceeded: mpsc::Sender<()>,
) -> thread::JoinHandle<std::io::Result<Vec<u8>>> {
    thread::spawn(move || {
        let mut captured = Vec::new();
        let mut buffer = [0_u8; 8 * 1024];
        loop {
            let count = reader.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            let previous = total.fetch_add(count as u64, Ordering::Relaxed);
            if previous.saturating_add(count as u64) > limit {
                let _ = exceeded.send(());
                break;
            }
            captured.extend_from_slice(&buffer[..count]);
        }
        Ok(captured)
    })
}

fn terminate_probe(child: &mut std::process::Child, process_group: &ProbeProcessGroup) {
    process_group.terminate(child);
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(unix)]
struct ProbeProcessGroup;

#[cfg(unix)]
impl ProbeProcessGroup {
    fn attach(_child: &std::process::Child) -> std::result::Result<Self, ProbeFailure> {
        Ok(Self)
    }

    fn terminate(&self, child: &std::process::Child) {
        unsafe {
            libc::kill(-(child.id() as i32), libc::SIGKILL);
        }
    }
}

#[cfg(windows)]
struct ProbeProcessGroup {
    job: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
impl ProbeProcessGroup {
    fn attach(child: &std::process::Child) -> std::result::Result<Self, ProbeFailure> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject,
        };

        unsafe {
            let candidate = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if candidate.is_null() {
                return Err(process_group_failure());
            }
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = SetInformationJobObject(
                candidate,
                JobObjectExtendedLimitInformation,
                (&raw const limits).cast(),
                std::mem::size_of_val(&limits) as u32,
            );
            if configured == 0 {
                let failure = process_group_failure();
                windows_sys::Win32::Foundation::CloseHandle(candidate);
                return Err(failure);
            }
            if AssignProcessToJobObject(
                candidate,
                child.as_raw_handle() as windows_sys::Win32::Foundation::HANDLE,
            ) == 0
            {
                let failure = process_group_failure();
                windows_sys::Win32::Foundation::CloseHandle(candidate);
                return Err(failure);
            }
            Ok(Self { job: candidate })
        }
    }

    fn terminate(&self, _child: &std::process::Child) {
        if !self.job.is_null() {
            unsafe {
                windows_sys::Win32::System::JobObjects::TerminateJobObject(self.job, 1);
            }
        }
    }
}

#[cfg(windows)]
fn process_group_failure() -> ProbeFailure {
    ProbeFailure {
        state: HostToolProbeState::Blocked,
        message: format!(
            "could not contain the fixed probe process tree: {}",
            std::io::Error::last_os_error()
        ),
    }
}

#[cfg(windows)]
impl Drop for ProbeProcessGroup {
    fn drop(&mut self) {
        if !self.job.is_null() {
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(self.job);
            }
        }
    }
}

fn probe_result(
    definition: &HostToolDefinition,
    path: &Path,
    state: HostToolProbeState,
    message: String,
    sha256: Option<String>,
) -> HostToolProbeResult {
    HostToolProbeResult {
        tool_id: definition.id.clone(),
        path: path.to_path_buf(),
        state,
        message,
        sha256,
        persisted: false,
        retry_action: format!(
            "select a valid {} executable and retry",
            definition.display_name
        ),
        clear_action_available: false,
    }
}

pub(crate) fn resolve(
    id: &str,
    candidates: Vec<PathBuf>,
    preferences: &HostPreferenceStore,
) -> Result<HostToolStatus> {
    let definition = definition(id)?;
    let configured = std::env::var_os(&definition.configuration_variable)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    resolve_with_environment(definition, candidates, preferences, configured)
}

fn resolve_with_environment(
    definition: HostToolDefinition,
    candidates: Vec<PathBuf>,
    preferences: &HostPreferenceStore,
    configured: Option<PathBuf>,
) -> Result<HostToolStatus> {
    let platform = Platform::current()?;
    if !definition.supported_platforms.contains(&platform) {
        return Ok(status(&definition, HostToolState::Unsupported, None, None));
    }
    if let Some(path) = configured {
        return Ok(status(
            &definition,
            if path.is_file() {
                HostToolState::Available
            } else {
                HostToolState::Misconfigured
            },
            Some(path),
            Some(HostToolSource::Environment),
        ));
    }
    if let Some(selection) = preferences.host_tool_preference(&definition.id)? {
        let valid = selected_file_fingerprint(&selection.path, platform)
            .is_ok_and(|fingerprint| fingerprint.sha256 == selection.sha256);
        return Ok(status(
            &definition,
            if valid {
                HostToolState::Available
            } else {
                HostToolState::Misconfigured
            },
            Some(selection.path),
            Some(HostToolSource::Saved),
        ));
    }
    let path = candidates.into_iter().find(|candidate| candidate.is_file());
    let source = path.as_ref().map(|_| HostToolSource::Discovery);
    Ok(status(
        &definition,
        if path.is_some() {
            HostToolState::Available
        } else {
            HostToolState::Missing
        },
        path,
        source,
    ))
}

pub(crate) fn require_path(status: &HostToolStatus, searched: &[PathBuf]) -> Result<PathBuf> {
    match status.state {
        HostToolState::Available => Ok(status.path.clone().expect("available tool has a path")),
        HostToolState::Misconfigured => Err(PortcoveError::source(format!(
            "{} does not point to a file: {}",
            status.configuration_variable,
            status
                .path
                .as_deref()
                .unwrap_or_else(|| Path::new(""))
                .display()
        ))
        .detail("tool_id", &status.id)
        .detail(
            "tool_path",
            status
                .path
                .as_ref()
                .map(|path| path.display().to_string())
                .unwrap_or_default(),
        )
        .detail(
            "setup_hint",
            format!(
                "select a valid {} executable or clear the explicit setting",
                status.display_name
            ),
        )),
        HostToolState::Missing => Err(PortcoveError::source(format!(
            "{} was not found; install it or select its full executable path",
            status.display_name
        ))
        .detail("tool_id", &status.id)
        .detail(
            "searched_paths",
            searched
                .iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>()
                .join(";"),
        )
        .detail(
            "setup_hint",
            format!(
                "open {} or select the installed executable",
                status.official_url
            ),
        )),
        HostToolState::Unsupported => Err(PortcoveError::unsupported(format!(
            "{} is not supported on this platform",
            status.display_name
        ))),
    }
}

fn status(
    definition: &HostToolDefinition,
    state: HostToolState,
    path: Option<PathBuf>,
    source: Option<HostToolSource>,
) -> HostToolStatus {
    HostToolStatus {
        id: definition.id.clone(),
        display_name: definition.display_name.clone(),
        state,
        path,
        source,
        configuration_variable: definition.configuration_variable.clone(),
        purpose: definition.purpose.clone(),
        official_url: definition.official_url.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::HashSet, fs};

    fn remember_test_selection(store: &HostPreferenceStore, id: &str, path: &Path) {
        crate::permissions::normalize_archive_entry(path, false, true).unwrap();
        let sha256 = selected_file_fingerprint(path, Platform::current().unwrap())
            .unwrap()
            .sha256;
        assert!(
            store
                .replace_host_tool_path_if_unchanged(id, None, path, &sha256)
                .unwrap()
        );
    }

    fn build_probe(directory: &Path) -> PathBuf {
        let executable = directory.join(if cfg!(windows) {
            "host_tool_probe.exe"
        } else {
            "host_tool_probe"
        });
        if let Some(prepared) = std::env::var_os("PORTCOVE_HOST_TOOL_FIXTURE") {
            fs::copy(prepared, &executable).unwrap();
            crate::permissions::normalize_archive_entry(&executable, false, true).unwrap();
            return executable;
        }
        let source = directory.join("host_tool_probe.rs");
        fs::write(&source, include_str!("testdata/host_tool_probe.rs.txt")).unwrap();
        let mut rustc =
            ChildProcessPolicy::native_command(ChildProcessClass::ManagedBuilder, "rustc").unwrap();
        assert!(
            rustc
                .arg(&source)
                .arg("-o")
                .arg(&executable)
                .status()
                .unwrap()
                .success()
        );
        crate::permissions::normalize_archive_entry(&executable, false, true).unwrap();
        executable
    }

    fn test_definition(arguments: &[&str]) -> HostToolDefinition {
        HostToolDefinition {
            id: "test_tool".into(),
            display_name: "TestTool".into(),
            configuration_variable: "PORTCOVE_TEST_TOOL".into(),
            purpose: "test fixed probes".into(),
            official_url: "https://example.invalid/test-tool".into(),
            supported_platforms: vec![Platform::current().unwrap()],
            probe: HostToolProbePolicy {
                arguments: arguments
                    .iter()
                    .map(|argument| (*argument).into())
                    .collect(),
                accepted_exit_codes: vec![0],
                expected_output: "testtool".into(),
                required_output_markers: vec!["verify".into(), "convert".into()],
                timeout_millis: 200,
                max_output_bytes: 512,
            },
        }
    }

    #[test]
    fn fixed_registry_has_unique_safe_complete_definitions() {
        let registry = definitions();
        let mut ids = HashSet::new();
        assert_eq!(registry.len(), 2);
        for definition in registry {
            assert!(ids.insert(definition.id.clone()));
            assert!(definition.official_url.starts_with("https://"));
            assert!(!definition.supported_platforms.is_empty());
            assert!(!definition.probe.arguments.is_empty());
            assert!(!definition.probe.accepted_exit_codes.is_empty());
            assert!(
                definition
                    .probe
                    .accepted_exit_codes
                    .iter()
                    .all(|code| *code >= 0)
            );
            assert!(
                definition
                    .probe
                    .arguments
                    .iter()
                    .all(|argument| !argument.trim().is_empty())
            );
            assert!(definition.probe.timeout_millis <= 5_000);
            assert!(definition.probe.max_output_bytes <= 64 * 1024);
        }
        validate_definitions(&definitions()).unwrap();
        assert!(definition("unknown").is_err());
    }

    #[test]
    fn registry_validation_rejects_unreviewed_definitions() {
        let mut registry = definitions();
        registry[1].id = registry[0].id.clone();
        assert!(validate_definitions(&registry).is_err());

        let mut registry = definitions();
        registry[0].id = "unknown".into();
        assert!(validate_definitions(&registry).is_err());

        for url in [
            "http://docs.mamedev.org/tools/chdman.html",
            "https://example.invalid/chdman",
        ] {
            let mut registry = definitions();
            registry[0].official_url = url.into();
            assert!(validate_definitions(&registry).is_err());
        }

        let mut registry = definitions();
        registry[0].supported_platforms.pop();
        assert!(validate_definitions(&registry).is_err());

        let mut registry = definitions();
        registry[0].probe.arguments.clear();
        assert!(validate_definitions(&registry).is_err());
        let mut registry = definitions();
        registry[0].probe.accepted_exit_codes.clear();
        assert!(validate_definitions(&registry).is_err());
        let mut registry = definitions();
        registry[0].probe.expected_output.clear();
        assert!(validate_definitions(&registry).is_err());
        let mut registry = definitions();
        registry[0].probe.required_output_markers.clear();
        assert!(validate_definitions(&registry).is_err());
        let mut registry = definitions();
        registry[0].probe.timeout_millis = 0;
        assert!(validate_definitions(&registry).is_err());
        let mut registry = definitions();
        registry[0].probe.max_output_bytes = 0;
        assert!(validate_definitions(&registry).is_err());
    }

    #[test]
    fn selected_file_validation_rejects_missing_directories_scripts_and_bad_permissions() {
        let temporary = tempfile::tempdir().unwrap();
        let missing = temporary.path().join(if cfg!(windows) {
            "missing.exe"
        } else {
            "missing"
        });
        assert_eq!(
            probe_definition(&test_definition(&["--success"]), &missing, || {}).state,
            HostToolProbeState::Missing
        );
        assert_eq!(
            probe_definition(&test_definition(&["--success"]), temporary.path(), || {}).state,
            HostToolProbeState::Invalid
        );

        let helper = build_probe(temporary.path());
        let blocked = temporary.path().join("looks-safe.cmd");
        fs::copy(&helper, &blocked).unwrap();
        crate::permissions::normalize_archive_entry(&blocked, false, true).unwrap();
        assert_eq!(
            probe_definition(&test_definition(&["--success"]), &blocked, || {}).state,
            HostToolProbeState::Blocked
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::{PermissionsExt, symlink};
            let non_executable = temporary.path().join("non-executable");
            fs::copy(&helper, &non_executable).unwrap();
            fs::set_permissions(&non_executable, fs::Permissions::from_mode(0o644)).unwrap();
            assert_eq!(
                probe_definition(&test_definition(&["--success"]), &non_executable, || {}).state,
                HostToolProbeState::Invalid
            );
            let link = temporary.path().join("linked-tool");
            symlink(&helper, &link).unwrap();
            assert_eq!(
                probe_definition(&test_definition(&["--success"]), &link, || {}).state,
                HostToolProbeState::Invalid
            );
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::symlink_file;
            let link = temporary.path().join("linked-tool.exe");
            if symlink_file(&helper, &link).is_ok() {
                assert_eq!(
                    probe_definition(&test_definition(&["--success"]), &link, || {}).state,
                    HostToolProbeState::Invalid
                );
            }
        }
        assert_eq!(
            spawn_error_state(std::io::ErrorKind::PermissionDenied),
            HostToolProbeState::Blocked
        );
    }

    #[test]
    fn fixed_probe_reports_every_bounded_process_and_compatibility_outcome() {
        let temporary = tempfile::tempdir().unwrap();
        let helper = build_probe(temporary.path());
        assert_eq!(
            probe_definition(&definition("chdman").unwrap(), &helper, || {}).state,
            HostToolProbeState::Success,
            "chdman's complete help is valid even though the tool exits 1"
        );
        for (argument, expected) in [
            ("--success", HostToolProbeState::Success),
            ("--nonzero", HostToolProbeState::FailedProbe),
            ("--sleep", HostToolProbeState::TimedOut),
            ("--large", HostToolProbeState::ExcessiveOutput),
            ("--malformed", HostToolProbeState::Invalid),
            ("--incompatible", HostToolProbeState::IncompatibleVersion),
        ] {
            assert_eq!(
                probe_definition(&test_definition(&[argument]), &helper, || {}).state,
                expected,
                "probe outcome for {argument}"
            );
        }

        let mut accepted_nonzero = test_definition(&["--nonzero"]);
        accepted_nonzero.probe.accepted_exit_codes.push(7);
        assert_eq!(
            probe_definition(&accepted_nonzero, &helper, || {}).state,
            HostToolProbeState::Invalid,
            "an accepted exit code still requires valid identity and command markers"
        );

        let cancellations = std::sync::atomic::AtomicUsize::new(0);
        let cancelled = probe_definition_with_cancellation(
            &test_definition(&["--sleep"]),
            &helper,
            || {},
            || cancellations.fetch_add(1, Ordering::Relaxed) > 1,
        );
        assert_eq!(cancelled.state, HostToolProbeState::Cancelled);

        let changed = probe_definition(&test_definition(&["--success"]), &helper, || {
            fs::write(&helper, b"changed before spawn").unwrap();
        });
        assert_eq!(changed.state, HostToolProbeState::Invalid);
        assert!(changed.message.contains("changed before"));
    }

    #[test]
    fn timed_out_probe_cleans_up_its_process_tree() {
        let temporary = tempfile::tempdir().unwrap();
        let helper = build_probe(temporary.path());
        let orphan_marker = temporary.path().join("orphan-marker");
        let result = probe_definition(
            &test_definition(&["--tree", orphan_marker.to_str().unwrap()]),
            &helper,
            || {},
        );
        assert_eq!(result.state, HostToolProbeState::TimedOut);
        thread::sleep(Duration::from_millis(1_100));
        assert!(!orphan_marker.exists());
    }

    #[test]
    fn native_probe_treats_shell_text_and_shell_looking_paths_as_literal_data() {
        let temporary = tempfile::tempdir().unwrap();
        let helper = build_probe(temporary.path());
        let special = temporary.path().join(if cfg!(windows) {
            "tool & echo injected.exe"
        } else {
            "tool & echo injected"
        });
        fs::rename(&helper, &special).unwrap();
        let recorded = temporary.path().join("arguments with spaces.txt");
        let injected = temporary.path().join("injected");
        let shell_text = "quotes-'\"' & | ; $(touch injected)";
        let mut definition = test_definition(&["--record", recorded.to_str().unwrap(), shell_text]);
        // The assertion exercises literal native argument delivery, not the
        // timeout path. Allow for Windows executable scanning under test load.
        definition.probe.timeout_millis = 5_000;

        let result = probe_definition(&definition, &special, || {});

        assert_eq!(result.state, HostToolProbeState::Success);
        assert_eq!(fs::read_to_string(recorded).unwrap(), shell_text);
        assert!(!injected.exists());
    }

    #[test]
    fn failed_configuration_preserves_the_previous_valid_selection_and_hash_binding() {
        let temporary = tempfile::tempdir().unwrap();
        let store = HostPreferenceStore::new(temporary.path().join("preferences.json")).unwrap();
        let helper = build_probe(temporary.path());
        let configured = configure_host_tool(&store, "chdman", &helper).unwrap();
        assert_eq!(configured.state, HostToolProbeState::Success);
        assert!(configured.persisted);
        let saved = store.host_tool_preference("chdman").unwrap().unwrap();

        let missing = temporary.path().join(if cfg!(windows) {
            "missing.exe"
        } else {
            "missing"
        });
        let rejected = configure_host_tool(&store, "chdman", &missing).unwrap();
        assert_eq!(rejected.state, HostToolProbeState::Missing);
        assert!(rejected.clear_action_available);
        assert_eq!(store.host_tool_preference("chdman").unwrap(), Some(saved));

        fs::write(&helper, b"changed after validation").unwrap();
        let status =
            resolve_with_environment(definition("chdman").unwrap(), Vec::new(), &store, None)
                .unwrap();
        assert_eq!(status.state, HostToolState::Misconfigured);
        assert_eq!(status.source, Some(HostToolSource::Saved));
    }

    #[test]
    fn preference_change_invalidates_a_completed_probe_before_persistence() {
        let temporary = tempfile::tempdir().unwrap();
        let store = HostPreferenceStore::new(temporary.path().join("preferences.json")).unwrap();
        let helper = build_probe(temporary.path());
        let concurrent = temporary.path().join(if cfg!(windows) {
            "concurrent.exe"
        } else {
            "concurrent"
        });
        fs::copy(&helper, &concurrent).unwrap();
        crate::permissions::normalize_archive_entry(&concurrent, false, true).unwrap();

        let result = configure_host_tool_with_hooks(
            &store,
            "chdman",
            &helper,
            || {
                let configured = configure_host_tool(&store, "chdman", &concurrent).unwrap();
                assert!(configured.persisted);
            },
            || false,
        )
        .unwrap();

        assert_eq!(result.state, HostToolProbeState::Invalid);
        assert!(!result.persisted);
        assert_eq!(store.host_tool_path("chdman").unwrap(), Some(concurrent));
    }

    #[test]
    fn platform_rules_cover_every_supported_native_executable_shape() {
        assert!(
            validate_platform_path(Path::new("tools/chdman.exe"), Platform::WindowsX86_64).is_ok()
        );
        assert!(
            validate_platform_path(Path::new("tools/chdman"), Platform::WindowsX86_64).is_err()
        );
        for platform in [
            Platform::LinuxX86_64,
            Platform::MacosX86_64,
            Platform::MacosAarch64,
        ] {
            assert!(validate_platform_path(Path::new("tools/chdman"), platform).is_ok());
            assert!(validate_platform_path(Path::new("tools/chdman.sh"), platform).is_err());
        }
    }

    #[test]
    fn saved_path_precedes_discovery_and_invalid_saved_path_does_not_fall_back() {
        let temporary = tempfile::tempdir().unwrap();
        let store = HostPreferenceStore::new(temporary.path().join("preferences.json")).unwrap();
        let suffix = if cfg!(windows) { ".exe" } else { "" };
        let saved = temporary.path().join(format!("saved-tool{suffix}"));
        let discovered = temporary.path().join(format!("discovered-tool{suffix}"));
        fs::write(&saved, b"saved").unwrap();
        fs::write(&discovered, b"discovered").unwrap();
        remember_test_selection(&store, "chdman", &saved);
        let selected = resolve("chdman", vec![discovered.clone()], &store).unwrap();
        assert_eq!(selected.path.as_deref(), Some(saved.as_path()));
        assert_eq!(selected.source, Some(HostToolSource::Saved));

        fs::remove_file(&saved).unwrap();
        let invalid = resolve("chdman", vec![discovered], &store).unwrap();
        assert_eq!(invalid.state, HostToolState::Misconfigured);
        assert_eq!(invalid.source, Some(HostToolSource::Saved));
    }

    #[test]
    fn environment_path_precedes_saved_and_invalid_environment_does_not_fall_back() {
        let temporary = tempfile::tempdir().unwrap();
        let store = HostPreferenceStore::new(temporary.path().join("preferences.json")).unwrap();
        let suffix = if cfg!(windows) { ".exe" } else { "" };
        let saved = temporary.path().join(format!("saved-tool{suffix}"));
        let environment = temporary.path().join(format!("environment-tool{suffix}"));
        fs::write(&saved, b"saved").unwrap();
        fs::write(&environment, b"environment").unwrap();
        remember_test_selection(&store, "chdman", &saved);
        let selected = resolve_with_environment(
            definition("chdman").unwrap(),
            Vec::new(),
            &store,
            Some(environment.clone()),
        )
        .unwrap();
        assert_eq!(selected.path.as_deref(), Some(environment.as_path()));
        assert_eq!(selected.source, Some(HostToolSource::Environment));

        fs::remove_file(&environment).unwrap();
        let invalid = resolve_with_environment(
            definition("chdman").unwrap(),
            Vec::new(),
            &store,
            Some(environment),
        )
        .unwrap();
        assert_eq!(invalid.state, HostToolState::Misconfigured);
        assert_eq!(invalid.source, Some(HostToolSource::Environment));
    }

    #[test]
    fn discovery_and_missing_results_are_structured() {
        let temporary = tempfile::tempdir().unwrap();
        let store = HostPreferenceStore::new(temporary.path().join("preferences.json")).unwrap();
        let discovered = temporary.path().join("DolphinTool");
        fs::write(&discovered, b"tool").unwrap();
        let available = resolve("dolphin_tool", vec![discovered.clone()], &store).unwrap();
        assert_eq!(available.path.as_deref(), Some(discovered.as_path()));
        assert_eq!(available.source, Some(HostToolSource::Discovery));
        let missing = resolve(
            "dolphin_tool",
            vec![temporary.path().join("missing")],
            &store,
        )
        .unwrap();
        assert_eq!(missing.state, HostToolState::Missing);
        assert_eq!(missing.source, None);
    }

    #[test]
    fn unsupported_platform_state_is_explicit_and_never_resolves_a_path() {
        let temporary = tempfile::tempdir().unwrap();
        let store = HostPreferenceStore::new(temporary.path().join("preferences.json")).unwrap();
        let mut definition = test_definition(&["--success"]);
        definition.supported_platforms.clear();

        let status = resolve_with_environment(definition, Vec::new(), &store, None).unwrap();

        assert_eq!(status.state, HostToolState::Unsupported);
        assert!(status.path.is_none());
        assert_eq!(
            require_path(&status, &[]).unwrap_err().code,
            crate::ErrorCode::Unsupported
        );
    }
}
