//! Native tool process-tree lifetime shared by probes and managed setup.
#[cfg(test)]
#[path = "tool_process_tests.rs"]
mod tests;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub(crate) use windows::{ToolChild, ToolProcessGroup, spawn_tool};
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub(crate) use linux::{ToolChild, ToolProcessGroup, poll_setup, spawn_tool};
#[cfg(all(unix, not(target_os = "linux")))]
pub(crate) type ToolChild = std::process::Child;
#[cfg(all(unix, not(target_os = "linux")))]
pub(crate) use spawn_unix_tool as spawn_tool;
#[cfg(all(unix, not(target_os = "linux")))]
pub(crate) type ToolProcessGroup = UnixProcessGroup;
#[cfg(unix)]
use std::process::{Command, Stdio};
use std::{
    collections::BTreeMap,
    io::Read,
    path::Path,
    process::ExitStatus,
    sync::mpsc,
    time::{Duration, Instant},
};

use crate::activity_diagnostics::DiagnosticCapture;
use crate::{ActivityDiagnostic, ChildProcessClass, ChildProcessPolicy, PortcoveError, Result};

const SETUP_OUTPUT_LIMIT: usize = 64 * 1024;

pub(crate) struct ToolSpawnFailure {
    pub(crate) error: PortcoveError,
    pub(crate) quiesced: bool,
    pub(crate) io_kind: Option<std::io::ErrorKind>,
}

impl ToolSpawnFailure {
    fn before_spawn(error: PortcoveError) -> Self {
        Self {
            error,
            quiesced: true,
            io_kind: None,
        }
    }

    fn io_before_spawn(error: std::io::Error) -> Self {
        Self {
            io_kind: Some(error.kind()),
            error: PortcoveError::launch(format!("could not start the admitted tool: {error}")),
            quiesced: true,
        }
    }
}

#[cfg(unix)]
pub(crate) fn spawn_unix_tool(
    spec: &crate::process::NativeToolLaunchSpec,
) -> std::result::Result<(std::process::Child, UnixProcessGroup), ToolSpawnFailure> {
    let mut command = spec.command().map_err(ToolSpawnFailure::before_spawn)?;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    UnixProcessGroup::prepare(&mut command);
    if let Some(limits) = spec.decoder_limits {
        use std::os::unix::process::CommandExt;
        // SAFETY: this child-only callback performs only async-signal-safe
        // setrlimit calls using copied values; it allocates and locks nothing.
        unsafe {
            command.pre_exec(move || {
                for (resource, value) in [
                    (libc::RLIMIT_AS, limits.memory_bytes as libc::rlim_t),
                    (libc::RLIMIT_FSIZE, limits.file_bytes as libc::rlim_t),
                ] {
                    let bound = libc::rlimit {
                        rlim_cur: value,
                        rlim_max: value,
                    };
                    if libc::setrlimit(resource, &bound) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                }
                Ok(())
            });
        }
    }
    let mut child = command.spawn().map_err(ToolSpawnFailure::io_before_spawn)?;
    match UnixProcessGroup::attach(&child) {
        Ok(group) => Ok((child, group)),
        Err(error) => {
            let _ = child.kill();
            let quiesced = child.wait().is_ok();
            Err(ToolSpawnFailure {
                error,
                quiesced,
                io_kind: None,
            })
        }
    }
}

pub(crate) fn copy_proof_details(error: &PortcoveError) -> BTreeMap<String, String> {
    const KEYS: &[&str] = &[
        "process_tree_first_failure",
        "process_tree_proof_method",
        "process_tree_api_error",
        "process_tree_observed_events",
        "process_tree_event_limit",
        "process_tree_nonsignaled_members",
        "process_tree_pending_debug_members",
        "process_tree_closure_trace",
        "process_tree_retained_members",
        "process_tree_membership_complete",
        "process_tree_deadline_exhausted",
        "process_tree_active",
        "process_tree_total",
        "process_tree_wait_result",
        "process_tree_all_retained_signaled",
        "process_tree_root_exit",
        "process_tree_identities",
        #[cfg(test)]
        "process_tree_image_identities",
    ];
    KEYS.iter()
        .copied()
        .filter_map(|key| {
            error
                .details
                .get(key)
                .map(|value| (key.to_owned(), value.clone()))
        })
        .collect()
}

fn attach_process_tree_proof(
    mut error: PortcoveError,
    proof: &BTreeMap<String, String>,
) -> PortcoveError {
    for (key, value) in proof {
        error.details.insert(key.clone(), value.clone());
    }
    error
}

pub(crate) struct SetupOutput {
    pub status: ExitStatus,
    pub output: String,
    pub truncated: bool,
    #[cfg(any(test, feature = "qualification-fixtures"))]
    pub process_tree_proof: BTreeMap<String, String>,
}

/// Run only the admitted native setup executable and its catalog-owned arguments.
/// Captured bytes never inherit a machine client's stdout, and excess output is
/// drained without growing memory or treating diagnostic verbosity as failure.
pub(crate) fn run_setup(
    program: &Path,
    arguments: &[String],
    source: &Path,
    working_directory: &Path,
    environment: &BTreeMap<String, String>,
    checkpoint: &dyn Fn() -> Result<()>,
    observer: ToolProcessObserver<'_>,
) -> Result<SetupOutput> {
    let mut command =
        ChildProcessPolicy::native_tool_spec(ChildProcessClass::UpstreamSetup, program)?;
    command
        .args(arguments)
        .arg(source)
        .current_dir(working_directory)
        .envs(environment);
    run_tool(&mut command, checkpoint, observer)
}

/// The closed Ghostship 2.0.0 bootstrap discovers its verified adjacent ROM.
/// Never append a source path: that exact runtime's nonempty argv loop is defective.
pub(crate) fn run_setup_without_source_argument(
    program: &Path,
    working_directory: &Path,
    environment: &BTreeMap<String, String>,
    checkpoint: &dyn Fn() -> Result<()>,
    observer: ToolProcessObserver<'_>,
) -> Result<SetupOutput> {
    let mut command =
        ChildProcessPolicy::native_tool_spec(ChildProcessClass::UpstreamSetup, program)?;
    command.current_dir(working_directory).envs(environment);
    run_tool(&mut command, checkpoint, observer)
}

pub(crate) struct ToolDiagnosticSink<'a> {
    pub activity_id: &'a str,
    pub phase: &'a str,
    pub record: &'a mut dyn FnMut(&ActivityDiagnostic) -> Result<()>,
}

#[derive(Default)]
pub(crate) struct ToolProcessObserver<'a> {
    pub diagnostics: Option<ToolDiagnosticSink<'a>>,
    pub quiesced: Option<&'a mut dyn FnMut() -> Result<()>>,
}

/// Supervise an admitted command and report durable process-tree quiescence
/// only on paths where no owned child or descendant can remain active.
pub(crate) fn run_tool(
    specification: &mut crate::process::NativeToolLaunchSpec,
    checkpoint: &dyn Fn() -> Result<()>,
    observer: ToolProcessObserver<'_>,
) -> Result<SetupOutput> {
    let ToolProcessObserver {
        mut diagnostics,
        mut quiesced,
    } = observer;
    let capture = DiagnosticCapture::default();
    let mut last_published = None;
    let mut snapshot = |final_capture, force| {
        let (id, phase) = diagnostics
            .as_ref()
            .map_or(("", ""), |sink| (sink.activity_id, sink.phase));
        let projected = capture.snapshot_if_changed(
            id,
            phase,
            final_capture,
            if force { None } else { last_published.as_ref() },
        )?;
        if let Some((revision, value)) = projected {
            if let Some(sink) = diagnostics.as_mut() {
                let recorded = (sink.record)(&value);
                // Only the forced terminal snapshot emits runtime metadata;
                // periodic capture persistence and output bytes stay separate.
                if force {
                    crate::runtime_diagnostics::observe_capture(&value, recorded.is_ok());
                }
                recorded?;
            }
            last_published = Some(revision);
            return Ok::<_, PortcoveError>(Some(value));
        }
        Ok(None)
    };
    if let Err(error) = snapshot(false, false).and_then(|_| checkpoint()) {
        if let Some(confirm) = quiesced.as_mut() {
            confirm()?;
        }
        return Err(error);
    }
    let (mut child, group) = match spawn_tool(specification) {
        Ok(value) => value,
        Err(failure) => {
            if failure.quiesced
                && let Some(confirm) = quiesced.as_mut()
            {
                confirm()?;
            }
            return Err(failure.error);
        }
    };
    let (sender, receiver) = mpsc::channel();
    capture_setup_output(
        child.stdout.take().expect("piped setup stdout"),
        capture.clone(),
        0,
        sender.clone(),
    );
    capture_setup_output(
        child.stderr.take().expect("piped setup stderr"),
        capture.clone(),
        1,
        sender,
    );
    let mut last_snapshot = Instant::now();
    let (result, process_quiesced) = loop {
        let observation = checkpoint().and_then(|()| {
            if last_snapshot.elapsed() >= Duration::from_millis(500) {
                snapshot(false, false)?;
                last_snapshot = Instant::now();
            }
            Ok(())
        });
        if let Err(error) = observation {
            let stopped =
                group.terminate_and_wait(&mut child).is_ok() && group.proves_tree_quiescence();
            break (Err(error), stopped);
        }
        match poll_setup(&mut child, &group) {
            Ok(Some(status)) => {
                let quiesced = group.proves_tree_quiescence();
                #[cfg(windows)]
                if !quiesced {
                    break (
                        Err(PortcoveError::state(
                            "native tool process-tree exit could not be verified; retain private preparation",
                        )),
                        false,
                    );
                }
                break (Ok(status), quiesced);
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(error) => {
                // On Unix an unexpected reaper can invalidate PID ownership.
                // Retain private work rather than signal an unverified PID.
                #[cfg(windows)]
                let stopped =
                    group.terminate_and_wait(&mut child).is_ok() && group.proves_tree_quiescence();
                #[cfg(unix)]
                let stopped = false;
                break (
                    Err(PortcoveError::launch(format!(
                        "could not observe tool completion: {error}"
                    ))),
                    stopped,
                );
            }
        }
    };
    // Windows closes this exact job's descendants. Unix poll_setup stops the
    // group before reaping its leader, while its PID still cannot be reused;
    // its group marker owns no resource that requires a destructor.
    #[cfg(any(windows, target_os = "linux"))]
    let process_tree_proof = copy_proof_details(
        &group.with_proof_details(PortcoveError::state("native tool process-tree observation")),
    );
    #[cfg(not(any(windows, target_os = "linux")))]
    let process_tree_proof = BTreeMap::new();
    #[cfg(windows)]
    drop(group);
    #[cfg(unix)]
    let _ = group;
    if process_quiesced && let Some(confirm) = quiesced.as_mut() {
        confirm().map_err(|error| attach_process_tree_proof(error, &process_tree_proof))?;
    }
    let diagnostic = (|| {
        let drained = drain_setup_output(&receiver);
        let snapshot = snapshot(drained.is_ok(), true)?
            .expect("the final diagnostic capture is always projected");
        drained?;
        Ok::<_, PortcoveError>(snapshot)
    })();
    let status = result.map_err(|error| {
        let error = match &diagnostic {
            Err(capture_error) => error.detail("diagnostic_error", &capture_error.message),
            Ok(_) => error,
        };
        attach_process_tree_proof(error, &process_tree_proof)
    })?;
    let diagnostic =
        diagnostic.map_err(|error| attach_process_tree_proof(error, &process_tree_proof))?;
    checkpoint().map_err(|error| attach_process_tree_proof(error, &process_tree_proof))?;
    let mut output = format!("{}\n{}", diagnostic.stdout.text, diagnostic.stderr.text);
    let truncated = diagnostic.stdout.truncated
        || diagnostic.stderr.truncated
        || output.len() > SETUP_OUTPUT_LIMIT;
    let mut end = SETUP_OUTPUT_LIMIT.min(output.len());
    while !output.is_char_boundary(end) {
        end -= 1;
    }
    output.truncate(end);
    Ok(SetupOutput {
        status,
        output,
        truncated,
        #[cfg(any(test, feature = "qualification-fixtures"))]
        process_tree_proof,
    })
}

fn drain_setup_output(receiver: &mpsc::Receiver<Result<()>>) -> Result<()> {
    let mut result = Ok(());
    for _ in 0..2 {
        let stream = receiver
            .recv_timeout(Duration::from_secs(1))
            .map_err(|_| {
                PortcoveError::launch(
                    "setup exited without closing its output streams; preparation was not accepted",
                )
            })
            .and_then(|value| value);
        if result.is_ok() {
            result = stream;
        }
    }
    result
}

#[cfg(windows)]
fn poll_setup(
    child: &mut ToolChild,
    _group: &ToolProcessGroup,
) -> std::io::Result<Option<ExitStatus>> {
    child.try_wait()
}

#[cfg(unix)]
fn poll_unix_setup(
    child: &mut std::process::Child,
    group: &UnixProcessGroup,
) -> std::io::Result<Option<ExitStatus>> {
    // SAFETY: info is initialized writable siginfo_t storage; P_PID selects
    // this owned child. WNOWAIT observes exit without releasing its PID.
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    let result = unsafe {
        libc::waitid(
            libc::P_PID,
            child.id() as libc::id_t,
            &mut info,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    };
    if result != 0 {
        let error = std::io::Error::last_os_error();
        return if error.kind() == std::io::ErrorKind::Interrupted {
            Ok(None)
        } else {
            Err(error)
        };
    }
    // SAFETY: waitid initializes the SIGCHLD fields, or leaves the zero PID
    // when no requested event is ready. No other thread owns this Child.
    if unsafe { info.si_pid() } == 0 {
        return Ok(None);
    }
    group.terminate_and_wait(child).map(Some)
}

#[cfg(all(unix, not(target_os = "linux")))]
fn poll_setup(
    child: &mut std::process::Child,
    group: &ToolProcessGroup,
) -> std::io::Result<Option<ExitStatus>> {
    poll_unix_setup(child, group)
}

fn capture_setup_output(
    mut reader: impl Read + Send + 'static,
    capture: DiagnosticCapture,
    stream: usize,
    sender: mpsc::Sender<Result<()>>,
) {
    std::thread::spawn(move || {
        let result = (|| {
            let mut buffer = [0_u8; 8192];
            loop {
                let count = reader.read(&mut buffer)?;
                if count == 0 {
                    return capture.close(stream);
                }
                capture.record(stream, &buffer[..count])?;
            }
        })();
        let _ = sender.send(result);
    });
}

#[cfg(unix)]
pub(crate) struct UnixProcessGroup;

#[cfg(unix)]
impl UnixProcessGroup {
    pub(crate) fn prepare(command: &mut Command) {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    pub(crate) fn attach(_child: &std::process::Child) -> Result<Self> {
        Ok(Self)
    }

    /// A process group can close ordinary descendants, but membership is
    /// voluntary: a helper may call setsid/setpgid and escape it. Retained
    /// cleanup must therefore remain unavailable after any Unix tool starts.
    fn proves_tree_quiescence(&self) -> bool {
        false
    }

    pub(crate) fn terminate(&self, child: &std::process::Child) {
        unsafe {
            libc::kill(-(child.id() as i32), libc::SIGKILL);
        }
    }

    /// Close the owned process group before releasing its leader PID.
    ///
    /// A descendant can be created around the first group signal. Keeping the
    /// leader waitable prevents PID reuse while a second signal closes that
    /// race. Only then is the leader reaped.
    pub(crate) fn terminate_and_wait(
        &self,
        child: &mut std::process::Child,
    ) -> std::io::Result<ExitStatus> {
        self.terminate(child);
        let _ = child.kill();
        let observed = wait_for_unreaped_exit(child);
        if observed.is_ok() {
            self.terminate(child);
        }
        let waited = child.wait();
        observed?;
        waited
    }
}

#[cfg(unix)]
fn wait_for_unreaped_exit(child: &std::process::Child) -> std::io::Result<()> {
    loop {
        // SAFETY: info is initialized writable siginfo_t storage; P_PID selects
        // this owned child, and WNOWAIT retains its PID until the group is closed.
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                child.id() as libc::id_t,
                &mut info,
                libc::WEXITED | libc::WNOWAIT,
            )
        };
        if result == 0 {
            // SAFETY: a successful blocking waitid initialized the SIGCHLD fields.
            if unsafe { info.si_pid() } == child.id() as i32 {
                return Ok(());
            }
            continue;
        }
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}
