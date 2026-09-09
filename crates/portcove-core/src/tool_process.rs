//! Native tool process-tree lifetime shared by probes and managed setup.
#[cfg(test)]
#[path = "tool_process_tests.rs"]
mod tests;
use std::{
    io::Read,
    path::Path,
    process::{ExitStatus, Stdio},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    time::Duration,
};

use crate::{ChildProcessClass, ChildProcessPolicy, PortcoveError, Result};

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
) -> Result<SetupOutput> {
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
    let total = Arc::new(AtomicUsize::new(0));
    let (sender, receiver) = mpsc::channel();
    capture_setup_output(
        child.stdout.take().expect("piped setup stdout"),
        total.clone(),
        sender.clone(),
    );
    capture_setup_output(
        child.stderr.take().expect("piped setup stderr"),
        total.clone(),
        sender,
    );
    let status = loop {
        if let Err(error) = checkpoint() {
            group.terminate(&child);
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        match poll_setup(&mut child, &group) {
            Ok(Some(status)) => break status,
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
                return Err(PortcoveError::launch(format!(
                    "could not observe setup completion: {error}"
                )));
            }
        }
    };
    // Windows closes this exact job's descendants. Unix poll_setup stops the
    // group before reaping its leader, while its PID still cannot be reused.
    drop(group);
    let mut output = Vec::new();
    for _ in 0..2 {
        let bytes = receiver
            .recv_timeout(Duration::from_secs(1))
            .map_err(|_| {
                PortcoveError::launch(
                    "setup exited without closing its output streams; preparation was not accepted",
                )
            })??;
        output.extend(bytes);
    }
    checkpoint()?;
    Ok(SetupOutput {
        status,
        output: String::from_utf8_lossy(&output).into_owned(),
        truncated: total.load(Ordering::Relaxed) > SETUP_OUTPUT_LIMIT,
    })
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
    total: Arc<AtomicUsize>,
    sender: mpsc::Sender<std::io::Result<Vec<u8>>>,
) {
    std::thread::spawn(move || {
        let result = (|| {
            let mut output = Vec::new();
            let mut buffer = [0_u8; 8192];
            loop {
                let count = reader.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                let previous = total.fetch_add(count, Ordering::Relaxed);
                let retain = count.min(SETUP_OUTPUT_LIMIT.saturating_sub(previous));
                output.extend_from_slice(&buffer[..retain]);
            }
            Ok(output)
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
