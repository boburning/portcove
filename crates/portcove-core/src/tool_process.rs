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

pub(crate) fn copy_proof_details(error: &PortcoveError) -> BTreeMap<String, String> {
    const KEYS: [&str; 8] = [
        "process_tree_first_failure",
        "process_tree_api_error",
        "process_tree_retained_members",
        "process_tree_membership_complete",
        "process_tree_deadline_exhausted",
        "process_tree_active",
        "process_tree_total",
        "process_tree_wait_result",
    ];
    KEYS.into_iter()
        .filter_map(|key| {
            error
                .details
                .get(key)
                .map(|value| (key.to_owned(), value.clone()))
        })
        .collect()
}

pub(crate) struct SetupOutput {
    pub status: ExitStatus,
    pub output: String,
    pub truncated: bool,
    #[cfg(feature = "qualification-fixtures")]
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
        #[cfg(windows)]
        group.observe_members();
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
    #[cfg(windows)]
    let result = if process_quiesced {
        result
    } else {
        result.map_err(|error| group.with_proof_details(error))
    };
    // Windows closes this exact job's descendants. Unix poll_setup stops the
    // group before reaping its leader, while its PID still cannot be reused;
    // its group marker owns no resource that requires a destructor.
    #[cfg(all(windows, feature = "qualification-fixtures"))]
    let process_tree_proof = copy_proof_details(
        &group.with_proof_details(PortcoveError::state("native tool process-tree observation")),
    );
    #[cfg(all(not(windows), feature = "qualification-fixtures"))]
    let process_tree_proof = BTreeMap::new();
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
        #[cfg(feature = "qualification-fixtures")]
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
    members: std::cell::RefCell<BTreeMap<u32, std::os::windows::io::OwnedHandle>>,
    complete: std::cell::Cell<bool>,
    termination_deadline: std::cell::Cell<Option<Instant>>,
    proof_failure: std::cell::RefCell<Option<(&'static str, Option<u32>)>>,
    accounting: std::cell::Cell<Option<(u32, u32)>>,
    wait_result: std::cell::Cell<Option<u32>>,
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
        use std::os::windows::io::{AsRawHandle, BorrowedHandle};
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
            let leader =
                match BorrowedHandle::borrow_raw(child.as_raw_handle()).try_clone_to_owned() {
                    Ok(handle) => handle,
                    Err(error) => {
                        windows_sys::Win32::Foundation::CloseHandle(candidate);
                        return Err(PortcoveError::state(format!(
                            "could not retain native leader identity: {error}"
                        )));
                    }
                };
            let group = Self {
                job: candidate,
                members: std::cell::RefCell::new(BTreeMap::from([(child.id(), leader)])),
                complete: std::cell::Cell::new(true),
                termination_deadline: std::cell::Cell::new(None),
                proof_failure: Default::default(),
                accounting: Default::default(),
                wait_result: Default::default(),
            };
            if let Err(error) = resume_primary_thread(child.id()) {
                // Closing this configured job terminates the still-suspended
                // leader. No admitted tool code has executed on this path.
                drop(group);
                return Err(error);
            }
            Ok(group)
        }
    }

    fn observe_members(&self) {
        use std::os::windows::io::{FromRawHandle, OwnedHandle};
        use windows_sys::Win32::System::{
            JobObjects::{
                IsProcessInJob, JOBOBJECT_BASIC_PROCESS_ID_LIST, JobObjectBasicProcessIdList,
                QueryInformationJobObject,
            },
            Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE},
        };
        // Bounded storage; a truncated snapshot or lifetime count gap is held.
        let mut buffer = [0_usize; 513];
        let queried = unsafe {
            QueryInformationJobObject(
                self.job,
                JobObjectBasicProcessIdList,
                buffer.as_mut_ptr().cast(),
                std::mem::size_of_val(&buffer) as u32,
                std::ptr::null_mut(),
            )
        };
        if queried == 0 {
            self.record_proof_failure(
                "membership_query",
                Some(unsafe { windows_sys::Win32::Foundation::GetLastError() }),
            );
            self.complete.set(false);
            return;
        }
        let list = unsafe { &*buffer.as_ptr().cast::<JOBOBJECT_BASIC_PROCESS_ID_LIST>() };
        if list.NumberOfAssignedProcesses != list.NumberOfProcessIdsInList
            || list.NumberOfProcessIdsInList > 512
        {
            self.record_proof_failure("membership_capacity", None);
            self.complete.set(false);
            return;
        }
        let ids = unsafe {
            std::slice::from_raw_parts(
                list.ProcessIdList.as_ptr(),
                list.NumberOfProcessIdsInList as usize,
            )
        };
        let mut members = self.members.borrow_mut();
        for &pid in ids {
            let Ok(pid) = u32::try_from(pid) else {
                self.record_proof_failure("member_id_range", None);
                self.complete.set(false);
                return;
            };
            if members.contains_key(&pid) {
                continue;
            }
            if members.len() >= 512 {
                self.record_proof_failure("retained_handle_capacity", None);
                self.complete.set(false);
                return;
            }
            let raw = unsafe {
                OpenProcess(
                    PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                    0,
                    pid,
                )
            };
            if raw.is_null() {
                self.record_proof_failure(
                    "member_open",
                    Some(unsafe { windows_sys::Win32::Foundation::GetLastError() }),
                );
                self.complete.set(false);
                return;
            }
            let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
            let mut in_job = 0;
            let queried = unsafe { IsProcessInJob(raw, self.job, &raw mut in_job) };
            if queried == 0 || in_job == 0 {
                self.record_proof_failure(
                    "member_job_identity",
                    (queried == 0)
                        .then(|| unsafe { windows_sys::Win32::Foundation::GetLastError() }),
                );
                self.complete.set(false);
                return;
            }
            members.insert(pid, handle);
        }
    }

    fn record_proof_failure(&self, reason: &'static str, api_error: Option<u32>) {
        // A later termination/accounting failure must not erase the first gap.
        self.proof_failure
            .borrow_mut()
            .get_or_insert((reason, api_error));
    }

    fn with_proof_details(&self, mut error: PortcoveError) -> PortcoveError {
        if let Some((reason, api_error)) = *self.proof_failure.borrow() {
            error = error.detail("process_tree_first_failure", reason);
            if let Some(code) = api_error {
                error = error.detail("process_tree_api_error", code.to_string());
            }
        }
        error = error
            .detail(
                "process_tree_retained_members",
                self.members.borrow().len().to_string(),
            )
            .detail(
                "process_tree_membership_complete",
                self.complete.get().to_string(),
            )
            .detail(
                "process_tree_deadline_exhausted",
                self.termination_deadline
                    .get()
                    .is_some_and(|deadline| Instant::now() >= deadline)
                    .to_string(),
            );
        if let Some((active, total)) = self.accounting.get() {
            error = error
                .detail("process_tree_active", active.to_string())
                .detail("process_tree_total", total.to_string());
        }
        if let Some(waited) = self.wait_result.get() {
            error = error.detail("process_tree_wait_result", waited.to_string());
        }
        error
    }

    fn deadline(&self) -> Instant {
        if let Some(deadline) = self.termination_deadline.get() {
            return deadline;
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        self.termination_deadline.set(Some(deadline));
        deadline
    }

    fn proves_tree_quiescence(&self) -> bool {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::{
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JobObjectBasicAccountingInformation,
            QueryInformationJobObject, TerminateJobObject,
        };
        use windows_sys::Win32::{
            Foundation::{WAIT_FAILED, WAIT_OBJECT_0},
            System::Threading::WaitForSingleObject,
        };
        self.observe_members();
        let deadline = self.deadline();
        // Retain handles across the job's asynchronous termination accounting.
        if unsafe { TerminateJobObject(self.job, 1) } == 0 {
            self.record_proof_failure(
                "job_termination",
                Some(unsafe { windows_sys::Win32::Foundation::GetLastError() }),
            );
            return false;
        }
        let members = self.members.borrow();
        for handle in members.values() {
            let remaining = deadline
                .saturating_duration_since(Instant::now())
                .as_millis()
                .min(u32::MAX as u128) as u32;
            let waited = unsafe { WaitForSingleObject(handle.as_raw_handle(), remaining) };
            if waited != WAIT_OBJECT_0 {
                self.wait_result.set(Some(waited));
                self.record_proof_failure(
                    "member_wait",
                    (waited == WAIT_FAILED)
                        .then(|| unsafe { windows_sys::Win32::Foundation::GetLastError() }),
                );
                return false;
            }
        }
        if !self.complete.get() {
            // Diagnostic-only accounting cannot repair failed membership coverage.
            let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
            if unsafe {
                QueryInformationJobObject(
                    self.job,
                    JobObjectBasicAccountingInformation,
                    (&raw mut accounting).cast(),
                    std::mem::size_of_val(&accounting) as u32,
                    std::ptr::null_mut(),
                )
            } != 0
            {
                self.accounting.set(Some((
                    accounting.ActiveProcesses,
                    accounting.TotalProcesses,
                )));
            }
            return false;
        }
        loop {
            let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
            let queried = unsafe {
                QueryInformationJobObject(
                    self.job,
                    JobObjectBasicAccountingInformation,
                    (&raw mut accounting).cast(),
                    std::mem::size_of_val(&accounting) as u32,
                    std::ptr::null_mut(),
                )
            };
            if queried == 0 {
                self.record_proof_failure(
                    "accounting_query",
                    Some(unsafe { windows_sys::Win32::Foundation::GetLastError() }),
                );
                return false;
            }
            self.accounting.set(Some((
                accounting.ActiveProcesses,
                accounting.TotalProcesses,
            )));
            if accounting.ActiveProcesses == 0 {
                let complete = accounting.TotalProcesses as usize == members.len();
                if !complete {
                    self.record_proof_failure("lifetime_count_gap", None);
                }
                return complete;
            }
            if Instant::now() >= deadline {
                self.record_proof_failure("accounting_deadline", None);
                return false;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    pub(crate) fn terminate(&self, _child: &std::process::Child) {
        self.observe_members();
        self.deadline();
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
        loop {
            if let Some(status) = child.try_wait()? {
                return Ok(status);
            }
            if Instant::now() >= self.deadline() {
                self.record_proof_failure("leader_deadline", None);
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "native tool leader did not exit within the owned-tree bound",
                ));
            }
            std::thread::sleep(Duration::from_millis(10));
        }
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
