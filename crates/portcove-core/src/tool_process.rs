//! Native tool process-tree lifetime shared by probes and managed setup.
#[cfg(test)]
#[path = "tool_process_tests.rs"]
mod tests;
use std::{
    collections::BTreeMap,
    io::Read,
    path::Path,
    process::{Command, ExitStatus, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

use crate::activity_diagnostics::DiagnosticCapture;
use crate::{ActivityDiagnostic, ChildProcessClass, ChildProcessPolicy, PortcoveError, Result};

const SETUP_OUTPUT_LIMIT: usize = 64 * 1024;

pub(crate) struct SetupOutput {
    pub status: ExitStatus,
    pub output: String,
    pub truncated: bool,
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
        ChildProcessPolicy::native_command(ChildProcessClass::UpstreamSetup, program)?;
    command
        .args(arguments)
        .arg(source)
        .current_dir(working_directory)
        .envs(environment);
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
    command: &mut Command,
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
                (sink.record)(&value)?;
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
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    ToolProcessGroup::prepare(command);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            if let Some(confirm) = quiesced.as_mut() {
                confirm()?;
            }
            return Err(PortcoveError::launch(format!(
                "could not start the admitted tool: {error}"
            )));
        }
    };
    let group = match ToolProcessGroup::attach(&child) {
        Ok(group) => group,
        Err(error) => {
            let _ = child.kill();
            if child.wait().is_ok()
                && let Some(confirm) = quiesced.as_mut()
            {
                confirm()?;
            }
            return Err(error);
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
            Ok(Some(status)) => break (Ok(status), group.proves_tree_quiescence()),
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(error) => {
                // On Unix an unexpected reaper can invalidate PID ownership.
                // Retain private work rather than signal an unverified PID.
                #[cfg(windows)]
                let stopped = group.terminate_and_wait(&mut child).is_ok();
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
    #[cfg(windows)]
    drop(group);
    #[cfg(unix)]
    let _ = group;
    if process_quiesced && let Some(confirm) = quiesced.as_mut() {
        confirm()?;
    }
    let diagnostic = (|| {
        let drained = drain_setup_output(&receiver);
        let snapshot = snapshot(drained.is_ok(), true)?
            .expect("the final diagnostic capture is always projected");
        drained?;
        Ok::<_, PortcoveError>(snapshot)
    })();
    let status = result.map_err(|error| match &diagnostic {
        Err(capture_error) => error.detail("diagnostic_error", &capture_error.message),
        Ok(_) => error,
    })?;
    let diagnostic = diagnostic?;
    checkpoint()?;
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
    child: &mut std::process::Child,
    _group: &ToolProcessGroup,
) -> std::io::Result<Option<ExitStatus>> {
    child.try_wait()
}

#[cfg(unix)]
fn poll_setup(
    child: &mut std::process::Child,
    group: &ToolProcessGroup,
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
pub(crate) struct ToolProcessGroup;

#[cfg(unix)]
impl ToolProcessGroup {
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

#[cfg(windows)]
pub(crate) struct ToolProcessGroup {
    job: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
impl ToolProcessGroup {
    /// Keep the process's primary thread suspended until `attach` has placed
    /// it in the kill-on-close job. Otherwise a fast tool can create a child
    /// during the spawn/assignment gap that the new job does not inherit.
    pub(crate) fn prepare(command: &mut Command) {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::CREATE_SUSPENDED;

        command.creation_flags(CREATE_SUSPENDED);
    }

    pub(crate) fn attach(child: &std::process::Child) -> Result<Self> {
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
            let group = Self { job: candidate };
            if let Err(error) = resume_primary_thread(child.id()) {
                // Closing this configured job terminates the still-suspended
                // leader. No admitted tool code has executed on this path.
                drop(group);
                return Err(error);
            }
            Ok(group)
        }
    }

    fn proves_tree_quiescence(&self) -> bool {
        true
    }

    pub(crate) fn terminate(&self, _child: &std::process::Child) {
        if !self.job.is_null() {
            unsafe {
                windows_sys::Win32::System::JobObjects::TerminateJobObject(self.job, 1);
            }
        }
    }

    pub(crate) fn terminate_and_wait(
        &self,
        child: &mut std::process::Child,
    ) -> std::io::Result<ExitStatus> {
        self.terminate(child);
        let _ = child.kill();
        child.wait()
    }
}

#[cfg(windows)]
fn resume_primary_thread(process_id: u32) -> Result<()> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First,
                Thread32Next,
            },
            Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME},
        },
    };

    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(process_group_failure());
        }
        let mut entry = THREADENTRY32 {
            dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };
        let mut thread_id = None;
        if Thread32First(snapshot, &raw mut entry) != 0 {
            loop {
                if entry.th32OwnerProcessID == process_id
                    && thread_id.replace(entry.th32ThreadID).is_some()
                {
                    CloseHandle(snapshot);
                    return Err(PortcoveError::state(
                        "the suspended native tool unexpectedly had multiple threads before containment",
                    ));
                }
                if Thread32Next(snapshot, &raw mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);
        let thread_id = thread_id.ok_or_else(|| {
            PortcoveError::state(
                "could not find the suspended native tool thread before containment",
            )
        })?;
        let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, thread_id);
        if thread.is_null() {
            return Err(process_group_failure());
        }
        let previous_count = ResumeThread(thread);
        if previous_count == u32::MAX {
            let failure = process_group_failure();
            CloseHandle(thread);
            return Err(failure);
        }
        CloseHandle(thread);
        if previous_count != 1 {
            return Err(PortcoveError::state(format!(
                "the native tool thread had unexpected suspend count {previous_count} before containment"
            )));
        }
        Ok(())
    }
}

#[cfg(windows)]
fn process_group_failure() -> PortcoveError {
    PortcoveError::state(format!(
        "could not contain the native tool process tree: {}",
        std::io::Error::last_os_error()
    ))
}

#[cfg(windows)]
impl Drop for ToolProcessGroup {
    fn drop(&mut self) {
        if !self.job.is_null() {
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(self.job);
            }
        }
    }
}
