//! Native tool process-tree lifetime shared by probes and managed setup.
#[cfg(test)]
#[path = "tool_process_tests.rs"]
mod tests;
use std::{
    io::Read,
    path::Path,
    process::{ExitStatus, Stdio},
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
    checkpoint: &dyn Fn() -> Result<()>,
    activity_id: &str,
    record: &mut dyn FnMut(&ActivityDiagnostic) -> Result<()>,
) -> Result<SetupOutput> {
    let capture = DiagnosticCapture::default();
    record(&capture.snapshot(activity_id, false)?)?;
    checkpoint()?;
    let mut command =
        ChildProcessPolicy::native_command(ChildProcessClass::UpstreamSetup, program)?;
    command
        .args(arguments)
        .arg(source)
        .current_dir(working_directory)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|error| {
        PortcoveError::launch(format!("could not start the admitted setup tool: {error}"))
    })?;
    let group = match ToolProcessGroup::attach(&child) {
        Ok(group) => group,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
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
    let result = loop {
        let observation = checkpoint().and_then(|()| {
            if last_snapshot.elapsed() >= Duration::from_millis(500) {
                record(&capture.snapshot(activity_id, false)?)?;
                last_snapshot = Instant::now();
            }
            Ok(())
        });
        if let Err(error) = observation {
            group.terminate(&child);
            let _ = child.kill();
            let _ = child.wait();
            break Err(error);
        }
        match poll_setup(&mut child, &group) {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(error) => {
                // On Unix an unexpected reaper can invalidate PID ownership.
                // Retain private work rather than signal an unverified PID.
                #[cfg(windows)]
                {
                    group.terminate(&child);
                    let _ = child.kill();
                    let _ = child.wait();
                }
                break Err(PortcoveError::launch(format!(
                    "could not observe setup completion: {error}"
                )));
            }
        }
    };
    // Windows closes this exact job's descendants. Unix poll_setup stops the
    // group before reaping its leader, while its PID still cannot be reused.
    drop(group);
    let diagnostic = (|| {
        let drained = drain_setup_output(&receiver);
        let snapshot = capture.snapshot(activity_id, drained.is_ok())?;
        record(&snapshot)?;
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
    group.terminate(child);
    child.wait().map(Some)
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
    pub(crate) fn attach(_child: &std::process::Child) -> Result<Self> {
        Ok(Self)
    }

    pub(crate) fn terminate(&self, child: &std::process::Child) {
        unsafe {
            libc::kill(-(child.id() as i32), libc::SIGKILL);
        }
    }
}

#[cfg(windows)]
pub(crate) struct ToolProcessGroup {
    job: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
impl ToolProcessGroup {
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
            Ok(Self { job: candidate })
        }
    }

    pub(crate) fn terminate(&self, _child: &std::process::Child) {
        if !self.job.is_null() {
            unsafe {
                windows_sys::Win32::System::JobObjects::TerminateJobObject(self.job, 1);
            }
        }
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
