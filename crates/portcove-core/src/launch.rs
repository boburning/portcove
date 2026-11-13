use std::{
    path::Path,
    process::{Child, ExitStatus},
    time::Duration,
};

use crate::{LaunchSignal, PortcoveError, Result};

#[cfg(windows)]
mod session_job;

/// Native-portable capability version whose readers enforce
/// `windows_tracked_handoff`. Delivered definitions declaring the field must
/// require it whatever their adapter, so older readers refuse them instead of
/// dropping the field.
pub(crate) const TRACKED_HANDOFF_NATIVE_CAPABILITY: u32 = 28;

/// Windows `CREATE_NEW_PROCESS_GROUP`: every supervised game leads its own
/// console process group so a forwarded console break reaches only it.
#[cfg(windows)]
const SUPERVISED_GAME_CREATION_FLAGS: u32 = 0x0000_0200;

/// The kernel object name of one launch session's Windows process job. Only
/// plain identifier characters are accepted, so a session ID can never address
/// another namespace or object.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn session_job_name(session_id: &str) -> Option<String> {
    let plain = !session_id.is_empty()
        && session_id.len() <= 64
        && session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-');
    plain.then(|| format!("Local\\Portcove.LaunchSession.{session_id}"))
}

/// Normalizes a Win32 path for a case-insensitive containment comparison:
/// verbatim prefixes are removed, separators unified and trailing separators
/// dropped. It never touches the filesystem.
#[cfg_attr(not(windows), allow(dead_code))]
fn comparable_windows_path(path: &str) -> String {
    let path = path.replace('/', "\\");
    // `\\?\` verbatim prefix; `\\?\UNC\server\share` becomes `\\server\share`.
    let path = match path.strip_prefix("\\\\?\\") {
        Some(verbatim) => match verbatim.strip_prefix("UNC\\") {
            Some(unc) => format!("\\\\{unc}"),
            None => verbatim.to_owned(),
        },
        None => path,
    };
    path.trim_end_matches('\\').to_lowercase()
}

/// Whether a session job member keeps a tracked-handoff session running. Only
/// a process whose image lies inside the session's install root holds it; a
/// browser, launcher client or editor the game opened elsewhere does not. An
/// unreadable image fails closed and holds the session.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn member_holds_session(image: Option<&str>, install_root: &str) -> bool {
    let Some(image) = image else {
        return true;
    };
    let root = comparable_windows_path(install_root);
    let image = comparable_windows_path(image);
    !root.is_empty()
        && image
            .strip_prefix(&root)
            .is_some_and(|rest| rest.starts_with('\\') && rest.len() > 1)
}

/// One session process that still holds a tracked-handoff session.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct SessionMember {
    pub(crate) pid: u32,
    /// The image file name; `None` when Windows would not report it.
    pub(crate) image_name: Option<String>,
}

/// Player-facing explanation retained on a running session while it waits for
/// game processes that outlived the original child.
pub(crate) fn waiting_message(members: &[SessionMember]) -> String {
    let names = members
        .iter()
        .map(|member| {
            format!(
                "{} (process {})",
                member
                    .image_name
                    .as_deref()
                    .unwrap_or("an unidentified program"),
                member.pid
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    let close = if members.len() == 1 { "it" } else { "them" };
    format!(
        "The game is still running as {names}. Close {close} to finish this play session; updates and backups wait until then."
    )
}

/// The processes of one supervised game session.
///
/// Without a reviewed Windows tracked handoff, and on Unix, the original child
/// is the whole session: an exec-based restart keeps its PID on Unix. With the
/// handoff, a Windows game starts inside the session's named job object and
/// the session also waits for job members whose image lies in its install root.
pub(crate) struct SessionProcesses {
    #[cfg(windows)]
    job: Option<session_job::SessionJob>,
}

impl SessionProcesses {
    /// Whether this session tracks successors in a Windows session job.
    pub(crate) fn is_tracked(&self) -> bool {
        #[cfg(windows)]
        return self.job.is_some();
        #[cfg(not(windows))]
        false
    }

    /// Waits for the original child. A tracked session keeps sharing its job
    /// handle with in-install members meanwhile, for recovery coverage.
    pub(crate) fn wait_for_child(&mut self, child: &mut Child) -> std::io::Result<ExitStatus> {
        #[cfg(windows)]
        if let Some(job) = self.job.as_mut() {
            return job.wait_for_child(child);
        }
        child.wait()
    }

    /// Waits until no tracked in-install process remains. `on_waiting` receives
    /// each changed set of processes that still hold the session.
    pub(crate) fn wait_for_successors(
        &mut self,
        on_waiting: &mut dyn FnMut(&[SessionMember]),
    ) -> Result<()> {
        #[cfg(windows)]
        if let Some(job) = self.job.as_mut() {
            job.wait_until_released(on_waiting).map_err(|error| {
                PortcoveError::launch(format!(
                    "could not observe the game's remaining processes: {error}"
                ))
            })?;
        }
        let _ = on_waiting;
        Ok(())
    }

    /// Reopens a recorded session's processes after its supervisor exited.
    /// `None` means no tracked job is reachable (always without a tracked
    /// handoff and on Unix), so only the recorded child remains to wait for.
    pub(crate) fn reopen(session_id: &str, install_root: &Path) -> Result<Option<Self>> {
        #[cfg(windows)]
        {
            session_job::SessionJob::open(session_id, install_root)
                .map(|job| job.map(|job| Self { job: Some(job) }))
                .map_err(|error| {
                    PortcoveError::conflict(format!(
                        "could not inspect the recorded game processes: {error}"
                    ))
                    .detail("launch_session_id", session_id)
                    .detail("recovery_action", "manual_review")
                })
        }
        #[cfg(not(windows))]
        {
            let _ = (session_id, install_root);
            Ok(None)
        }
    }
}

/// Starts a configured supervised game. With `tracked_install_root` on
/// Windows, the game's process tree belongs to the session job; otherwise the
/// launch is unchanged. The original child is returned for status and identity.
pub(crate) fn spawn_supervised_game(
    command: &mut std::process::Command,
    session_id: &str,
    tracked_install_root: Option<&Path>,
) -> std::io::Result<(Child, SessionProcesses)> {
    #[cfg(windows)]
    {
        if let Some(root) = tracked_install_root {
            let (child, job) = session_job::SessionJob::spawn(command, session_id, root)?;
            return Ok((child, SessionProcesses { job: Some(job) }));
        }
        let _ = session_id;
        Ok((command.spawn()?, SessionProcesses { job: None }))
    }
    #[cfg(not(windows))]
    {
        let _ = (session_id, tracked_install_root);
        Ok((command.spawn()?, SessionProcesses {}))
    }
}

pub(crate) fn configure_supervised_game(command: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(SUPERVISED_GAME_CREATION_FLAGS);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
}

#[cfg(windows)]
pub fn forward_launch_signal(pid: u32, _signal: LaunchSignal) -> Result<()> {
    use windows_sys::Win32::System::Console::{CTRL_BREAK_EVENT, GenerateConsoleCtrlEvent};

    // SAFETY: the child is created as a process-group leader with this PID.
    if unsafe { GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, pid) } == 0 {
        return Err(PortcoveError::launch(format!(
            "could not forward console break to child process {pid}: {}",
            std::io::Error::last_os_error()
        )));
    }
    Ok(())
}

#[cfg(unix)]
pub fn forward_launch_signal(pid: u32, signal: LaunchSignal) -> Result<()> {
    let pid = i32::try_from(pid)
        .map_err(|_| PortcoveError::launch("child process ID is outside the platform range"))?;
    let signal = match signal {
        LaunchSignal::Interrupt => libc::SIGINT,
        LaunchSignal::Terminate => libc::SIGTERM,
    };
    // SAFETY: the negative PID addresses the process group created for the
    // supervised game, and SIGINT/SIGTERM are valid signal constants.
    if unsafe { libc::kill(-pid, signal) } != 0 {
        return Err(PortcoveError::launch(format!(
            "could not forward signal to child process group {pid}: {}",
            std::io::Error::last_os_error()
        )));
    }
    Ok(())
}

#[cfg(windows)]
pub(crate) fn process_identity(pid: u32) -> Result<Option<String>> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, GetLastError, STILL_ACTIVE},
        System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    };

    // SAFETY: OpenProcess returns an owned handle or null. The handle is queried
    // without mutation and closed exactly once before returning.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            let code = GetLastError();
            return if code == ERROR_INVALID_PARAMETER {
                Ok(None)
            } else {
                Err(PortcoveError::state(format!(
                    "could not identify process {pid}: {}",
                    std::io::Error::from_raw_os_error(code as i32)
                )))
            };
        }
        let mut exit_code = 0_u32;
        if GetExitCodeProcess(handle, &mut exit_code) == 0 {
            let error = std::io::Error::last_os_error();
            CloseHandle(handle);
            return Err(PortcoveError::state(format!(
                "could not read process {pid} state: {error}"
            )));
        }
        if exit_code != STILL_ACTIVE as u32 {
            CloseHandle(handle);
            return Ok(None);
        }
        let identity = process_identity_from_windows_handle(handle, pid);
        CloseHandle(handle);
        identity.map(Some)
    }
}

#[cfg(windows)]
unsafe fn process_identity_from_windows_handle(
    handle: windows_sys::Win32::Foundation::HANDLE,
    pid: u32,
) -> Result<String> {
    use windows_sys::Win32::{Foundation::FILETIME, System::Threading::GetProcessTimes};
    let mut created = FILETIME::default();
    let mut exited = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    // SAFETY: all pointers refer to initialized writable FILETIME values and
    // the caller guarantees that `handle` is a live process handle.
    if unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) } == 0 {
        return Err(PortcoveError::state(format!(
            "could not read process {pid} creation time: {}",
            std::io::Error::last_os_error()
        )));
    }
    let ticks = (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
    Ok(format!("windows-filetime:{ticks}"))
}

#[cfg(windows)]
pub(crate) fn process_identity_for_child(child: &Child) -> Result<Option<String>> {
    use std::os::windows::io::AsRawHandle;
    // SAFETY: Child owns a valid process handle for its lifetime.
    unsafe { process_identity_from_windows_handle(child.as_raw_handle(), child.id()).map(Some) }
}

#[cfg(target_os = "linux")]
pub(crate) fn process_identity(pid: u32) -> Result<Option<String>> {
    linux_process_identity_with_reader(pid, |path| std::fs::read_to_string(path))
}

#[cfg(target_os = "linux")]
fn linux_process_identity_with_reader(
    pid: u32,
    read: impl FnOnce(&str) -> std::io::Result<String>,
) -> Result<Option<String>> {
    let path = format!("/proc/{pid}/stat");
    let body = match read(&path) {
        Ok(body) => body,
        // proc_single_show returns ESRCH when the task disappears after open.
        // This observes only this PID's identity, not process-group quiescence.
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound
                || error.raw_os_error() == Some(libc::ESRCH) =>
        {
            return Ok(None);
        }
        Err(error) => {
            return Err(PortcoveError::state(format!(
                "could not identify process {pid}: {error}"
            )));
        }
    };
    linux_process_identity_from_stat(pid, &body)
}

#[cfg(target_os = "linux")]
fn linux_process_identity_from_stat(pid: u32, body: &str) -> Result<Option<String>> {
    let (state, identity) = linux_process_state_and_identity_from_stat(pid, body)?;
    if matches!(state, "Z" | "X" | "x") {
        return Ok(None);
    }
    Ok(Some(identity))
}

#[cfg(target_os = "linux")]
fn linux_process_state_and_identity_from_stat(pid: u32, body: &str) -> Result<(&str, String)> {
    let end = body.rfind(')').ok_or_else(|| {
        PortcoveError::state(format!("process {pid} returned malformed /proc identity"))
    })?;
    let mut fields = body[end + 1..].split_whitespace();
    let state = fields
        .next()
        .ok_or_else(|| PortcoveError::state(format!("process {pid} has no process state")))?;
    let start_ticks = fields
        .nth(18)
        .ok_or_else(|| PortcoveError::state(format!("process {pid} has no start identity")))?;
    if !start_ticks.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(PortcoveError::state(format!(
            "process {pid} returned an invalid start identity"
        )));
    }
    Ok((state, format!("linux-start-ticks:{start_ticks}")))
}

#[cfg(target_os = "macos")]
pub(crate) fn process_identity(pid: u32) -> Result<Option<String>> {
    use std::ffi::c_void;

    #[repr(C)]
    struct ProcBsdInfo {
        pbi_flags: u32,
        pbi_status: u32,
        pbi_xstatus: u32,
        pbi_pid: u32,
        pbi_ppid: u32,
        pbi_uid: u32,
        pbi_gid: u32,
        pbi_ruid: u32,
        pbi_rgid: u32,
        pbi_svuid: u32,
        pbi_svgid: u32,
        rfu_1: u32,
        pbi_comm: [u8; 16],
        pbi_name: [u8; 32],
        pbi_nfiles: u32,
        pbi_pgid: u32,
        pbi_pjobc: u32,
        e_tdev: u32,
        e_tpgid: u32,
        pbi_nice: i32,
        pbi_start_tvsec: u64,
        pbi_start_tvusec: u64,
    }

    #[link(name = "proc")]
    unsafe extern "C" {
        fn proc_pidinfo(
            pid: i32,
            flavor: i32,
            arg: u64,
            buffer: *mut c_void,
            buffersize: i32,
        ) -> i32;
    }

    const PROC_PIDTBSDINFO: i32 = 3;
    let Ok(pid) = i32::try_from(pid) else {
        return Ok(None);
    };
    let mut info = std::mem::MaybeUninit::<ProcBsdInfo>::zeroed();
    let expected = std::mem::size_of::<ProcBsdInfo>();
    // SAFETY: `info` points to `expected` writable bytes and proc_pidinfo does
    // not retain the pointer after returning.
    let read = unsafe {
        proc_pidinfo(
            pid,
            PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            expected as i32,
        )
    };
    if read == 0 {
        let error = std::io::Error::last_os_error();
        #[cfg(test)]
        child_diagnostic::record(
            pid as u32,
            "proc_pidinfo",
            "error",
            error.raw_os_error(),
            Some(i64::from(read)),
        );
        return if error.raw_os_error() == Some(libc::ESRCH) {
            Ok(None)
        } else {
            Err(PortcoveError::state(format!(
                "could not identify process {pid}: {error}"
            )))
        };
    }
    #[cfg(test)]
    child_diagnostic::record(
        pid as u32,
        "proc_pidinfo",
        "returned",
        None,
        Some(i64::from(read)),
    );
    if read as usize != expected {
        return Err(PortcoveError::state(format!(
            "process {pid} returned an incomplete start identity"
        )));
    }
    // SAFETY: proc_pidinfo initialized exactly the full structure.
    let info = unsafe { info.assume_init() };
    Ok(Some(format!(
        "macos-start-time:{}:{}",
        info.pbi_start_tvsec, info.pbi_start_tvusec
    )))
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
pub(crate) fn process_identity(pid: u32) -> Result<Option<String>> {
    let Ok(pid) = i32::try_from(pid) else {
        return Ok(None);
    };
    // SAFETY: signal 0 performs an existence/permission check without delivery.
    if unsafe { libc::kill(pid, 0) } != 0
        && std::io::Error::last_os_error().raw_os_error() != Some(libc::EPERM)
    {
        return Ok(None);
    }
    Err(PortcoveError::unsupported(
        "this Unix platform cannot prove process start identity",
    ))
}

#[cfg(target_os = "linux")]
pub(crate) fn process_identity_for_child(child: &Child) -> Result<Option<String>> {
    let pid = child.id();
    let body = std::fs::read_to_string(format!("/proc/{pid}/stat")).map_err(|error| {
        PortcoveError::state(format!(
            "child process {pid} exited before its start identity was recorded: {error}"
        ))
    })?;
    let (_, identity) = linux_process_state_and_identity_from_stat(pid, &body)?;
    Ok(Some(identity))
}

#[cfg(all(unix, not(target_os = "linux")))]
pub(crate) fn process_identity_for_child(child: &Child) -> Result<Option<String>> {
    process_identity(child.id())
}

pub(crate) fn process_matches(pid: u32, expected: &str) -> Result<bool> {
    Ok(process_identity(pid)?.as_deref() == Some(expected))
}

pub(crate) fn wait_for_process_exit(pid: u32, expected: &str) -> Result<()> {
    loop {
        match process_identity(pid)? {
            Some(actual) if actual == expected => {
                std::thread::sleep(Duration::from_millis(200));
            }
            Some(_) => {
                return Err(PortcoveError::conflict(format!(
                    "process {pid} no longer matches the recorded launch identity"
                ))
                .detail("process_id", pid.to_string())
                .detail("recovery_action", "manual_review"));
            }
            None => return Ok(()),
        }
    }
}

// Opt-in diagnostics for the owned child of one unit test. This is absent from
// production builds and never changes native identity or recovery authority.
#[cfg(test)]
pub(crate) mod child_diagnostic {
    use std::{
        cell::RefCell,
        io::Write,
        process::{Child, ExitStatus},
        time::Instant,
    };

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(crate) enum Control {
        Observe,
        MissingPending,
        MissingCompleted,
    }

    #[derive(Clone, Debug)]
    pub(crate) struct Event {
        pub(crate) stage: &'static str,
        pub(crate) outcome: &'static str,
        pub(crate) raw_error: Option<i32>,
        pub(crate) value: Option<i64>,
        pub(crate) identity: Option<String>,
        pub(crate) elapsed_us: u128,
    }

    struct Trace {
        start: Instant,
        control: Control,
        pid: Option<u32>,
        events: Vec<Event>,
        dropped: usize,
    }

    thread_local! { static TRACE: RefCell<Option<Trace>> = const { RefCell::new(None) }; }
    const MAX_EVENTS: usize = 16;

    pub(crate) struct Guard(std::marker::PhantomData<std::rc::Rc<()>>);
    impl Guard {
        pub(crate) fn begin(control: Control) -> Self {
            TRACE.with_borrow_mut(|trace| {
                assert!(trace.is_none(), "child diagnostic scope is already active");
                *trace = Some(Trace {
                    start: Instant::now(),
                    control,
                    pid: None,
                    events: Vec::new(),
                    dropped: 0,
                });
            });
            Self(std::marker::PhantomData)
        }
        pub(crate) fn events(&self) -> Vec<Event> {
            TRACE.with_borrow(|trace| trace.as_ref().unwrap().events.clone())
        }
    }
    impl Drop for Guard {
        fn drop(&mut self) {
            if let Some(trace) = TRACE.with_borrow_mut(Option::take) {
                // Numeric fields, static labels and a bounded numeric identity
                // only: never command arguments, paths, environment or secrets.
                let mut output = std::io::stderr().lock();
                let _ = writeln!(
                    output,
                    "PORTCOVE_CHILD_DIAGNOSTIC v1 control={:?} pid={:?} dropped={}",
                    trace.control, trace.pid, trace.dropped
                );
                for (order, event) in trace.events.iter().enumerate() {
                    let _ = writeln!(
                        output,
                        "PORTCOVE_CHILD_DIAGNOSTIC order={order} us={} stage={} outcome={} raw_error={:?} value={:?} identity={:?}",
                        event.elapsed_us,
                        event.stage,
                        event.outcome,
                        event.raw_error,
                        event.value,
                        event.identity
                    );
                }
            }
        }
    }

    pub(crate) fn record(
        pid: u32,
        stage: &'static str,
        outcome: &'static str,
        raw_error: Option<i32>,
        value: Option<i64>,
    ) {
        push(pid, stage, outcome, raw_error, value, None);
    }
    fn push(
        pid: u32,
        stage: &'static str,
        outcome: &'static str,
        raw_error: Option<i32>,
        value: Option<i64>,
        identity: Option<String>,
    ) {
        TRACE.with_borrow_mut(|trace| {
            let Some(trace) = trace.as_mut().filter(|trace| trace.pid == Some(pid)) else {
                return;
            };
            if trace.events.len() == MAX_EVENTS {
                trace.dropped += 1;
                return;
            }
            trace.events.push(Event {
                stage,
                outcome,
                raw_error,
                value,
                identity,
                elapsed_us: trace.start.elapsed().as_micros(),
            });
        });
    }
    pub(crate) fn spawned(child: &mut Child) {
        let control = TRACE.with_borrow_mut(|trace| {
            let trace = trace.as_mut()?;
            assert!(trace.pid.is_none(), "diagnostic scope already owns a child");
            trace.pid = Some(child.id());
            Some(trace.control)
        });
        record(child.id(), "spawn", "owned", None, None);
        if control == Some(Control::MissingCompleted) {
            let result = child.wait();
            waited(child.id(), "control_wait", &result);
            if result.is_err() {
                cleanup(child);
                panic!("completed-exit control could not reap its owned child");
            }
        }
    }
    pub(crate) fn identity(
        pid: u32,
        result: crate::Result<Option<String>>,
    ) -> crate::Result<Option<String>> {
        let (outcome, value) = match &result {
            Ok(Some(identity)) => (
                "present",
                Some(identity.clone()).filter(|identity| {
                    identity.len() <= 96
                        && identity
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'-'))
                }),
            ),
            Ok(None) => ("missing", None),
            Err(_) => ("error", None),
        };
        push(pid, "identity_original", outcome, None, None, value);
        let injected = TRACE.with_borrow(|trace| {
            trace
                .as_ref()
                .is_some_and(|trace| trace.pid == Some(pid) && trace.control != Control::Observe)
        });
        if injected {
            record(pid, "identity_control", "injected_missing", None, None);
            Ok(None)
        } else {
            result
        }
    }
    pub(crate) fn tried_wait(
        pid: u32,
        result: std::io::Result<Option<ExitStatus>>,
    ) -> std::io::Result<Option<ExitStatus>> {
        match &result {
            Ok(Some(status)) => record(
                pid,
                "try_wait_original",
                "completed",
                None,
                status.code().map(i64::from),
            ),
            Ok(None) => record(pid, "try_wait_original", "pending", None, None),
            Err(error) => record(
                pid,
                "try_wait_original",
                "error",
                error.raw_os_error(),
                None,
            ),
        }
        let injected = TRACE.with_borrow(|trace| {
            trace.as_ref().is_some_and(|trace| {
                trace.pid == Some(pid) && trace.control == Control::MissingPending
            })
        });
        if injected {
            record(pid, "try_wait_control", "injected_pending", None, None);
            Ok(None)
        } else {
            result
        }
    }
    pub(crate) fn waited(pid: u32, stage: &'static str, result: &std::io::Result<ExitStatus>) {
        match result {
            Ok(status) => record(pid, stage, "reaped", None, status.code().map(i64::from)),
            Err(error) => record(pid, stage, "error", error.raw_os_error(), None),
        }
    }
    pub(crate) fn cleanup(child: &mut Child) {
        let result = child.kill();
        match result {
            Ok(()) => record(child.id(), "kill", "returned_ok", None, None),
            Err(error) => record(child.id(), "kill", "error", error.raw_os_error(), None),
        }
        let result = child.wait();
        waited(child.id(), "cleanup_wait", &result);
    }

    mod tests {
        use super::*;

        #[test]
        fn recorder_is_bounded_thread_local_and_does_not_change_identity_result() {
            let guard = Guard::begin(Control::Observe);
            // Synthetic recorder token: no process operation is performed.
            TRACE.with_borrow_mut(|trace| trace.as_mut().unwrap().pid = Some(41));
            std::thread::spawn(|| record(41, "fixture", "other_thread", None, None))
                .join()
                .unwrap();
            record(42, "fixture", "other_pid", None, None);
            assert!(guard.events().is_empty());
            let original = "private/path is never printed".to_owned();
            assert_eq!(
                identity(41, Ok(Some(original.clone()))).unwrap(),
                Some(original)
            );
            assert!(guard.events()[0].identity.is_none());
            for _ in 0..MAX_EVENTS + 3 {
                record(41, "fixture", "synthetic", None, None);
            }
            assert_eq!(guard.events().len(), MAX_EVENTS);
            assert_eq!(
                TRACE.with_borrow(|trace| trace.as_ref().unwrap().dropped),
                4
            );
            drop(guard);
            assert!(TRACE.with_borrow(Option::is_none));
        }

        #[test]
        fn diagnostic_scope_clears_on_unwind() {
            let result = std::panic::catch_unwind(|| {
                let _guard = Guard::begin(Control::Observe);
                panic!("synthetic diagnostic unwind");
            });
            assert!(result.is_err());
            assert!(TRACE.with_borrow(Option::is_none));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_job_names_accept_only_plain_session_ids() {
        let id = "0f8fad5b-d9cb-469f-a165-70867728950e";
        assert_eq!(
            session_job_name(id).as_deref(),
            Some("Local\\Portcove.LaunchSession.0f8fad5b-d9cb-469f-a165-70867728950e")
        );
        for refused in [
            "",
            "..\\Global\\x",
            "Global\\name",
            "a/b",
            "id with space",
            "é",
            &"a".repeat(65),
        ] {
            assert_eq!(session_job_name(refused), None, "{refused:?}");
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn unix_sessions_have_no_separate_successor_tracking() {
        let id = "0f8fad5b-d9cb-469f-a165-70867728950e";
        let root = Path::new("/");
        for tracked in [None, Some(root)] {
            let mut command = crate::process::ChildProcessPolicy::native_command(
                crate::process::ChildProcessClass::HostTool,
                "/bin/sh",
            )
            .unwrap();
            command.args(["-c", "exit 3"]);
            let (mut child, mut processes) =
                spawn_supervised_game(&mut command, id, tracked).unwrap();
            assert_eq!(
                processes.wait_for_child(&mut child).unwrap().code(),
                Some(3)
            );
            let mut waited = Vec::new();
            processes
                .wait_for_successors(&mut |members| waited.push(members.to_vec()))
                .unwrap();
            assert!(waited.is_empty());
        }
        assert!(SessionProcesses::reopen(id, root).unwrap().is_none());
    }

    #[test]
    fn only_members_inside_the_install_root_hold_a_tracked_session() {
        // Paths are joined from segments so no literal spells a host path.
        fn win(segments: &[&str]) -> String {
            segments.join("\\")
        }
        const VERBATIM: &str = "\\\\?\\";
        let install = [
            "C:", "Users", "Player", "Portcove", "versions", "yakumo", "abc",
        ];
        let root = win(&install);
        let inside_of = |rest: &[&str]| win(&[&install[..], rest].concat());
        for inside in [
            inside_of(&["Yakumo.exe"]),
            win(&[
                "c:", "users", "player", "portcove", "VERSIONS", "Yakumo", "ABC", "bin", "game.exe",
            ]),
            format!("{VERBATIM}{}", inside_of(&["Yakumo.exe"])),
            inside_of(&["Yakumo.exe"]).replace('\\', "/"),
        ] {
            assert!(member_holds_session(Some(&inside), &root), "{inside}");
            assert!(
                member_holds_session(Some(&inside), &format!("{VERBATIM}{root}\\")),
                "{inside}"
            );
        }
        for outside in [
            win(&[
                "C:",
                "Program Files",
                "Google",
                "Chrome",
                "Application",
                "chrome.exe",
            ]),
            win(&["C:", "Program Files (x86)", "Steam", "steam.exe"]),
            win(&["C:", "Windows", "System32", "notepad.exe"]),
            win(&[
                "C:",
                "Users",
                "Player",
                "Portcove",
                "versions",
                "yakumo",
                "abcdef",
                "Yakumo.exe",
            ]),
            root.clone(),
            format!("{root}\\"),
            win(&[
                "D:",
                "Users",
                "Player",
                "Portcove",
                "versions",
                "yakumo",
                "abc",
                "Yakumo.exe",
            ]),
        ] {
            assert!(!member_holds_session(Some(&outside), &root), "{outside}");
        }
        let share = |segments: &[&str]| format!("\\\\{}", win(segments));
        assert!(member_holds_session(
            Some(&share(&[
                "server",
                "share",
                "Games",
                "Yakumo",
                "Yakumo.exe"
            ])),
            &format!(
                "{VERBATIM}UNC\\{}",
                win(&["server", "share", "games", "yakumo"])
            )
        ));
        // An unreadable image fails closed.
        assert!(member_holds_session(None, &root));
        assert!(!member_holds_session(
            Some(&win(&["C:", "Game", "a.exe"])),
            ""
        ));
    }

    #[test]
    fn waiting_message_names_each_remaining_process() {
        let message = waiting_message(&[
            SessionMember {
                pid: 42,
                image_name: Some("Yakumo.exe".into()),
            },
            SessionMember {
                pid: 7,
                image_name: None,
            },
        ]);
        assert_eq!(
            message,
            "The game is still running as Yakumo.exe (process 42), an unidentified program (process 7). Close them to finish this play session; updates and backups wait until then."
        );
    }

    #[test]
    fn current_and_impossible_process_ids_are_distinguished() {
        let current = process_identity(std::process::id()).unwrap().unwrap();
        assert!(process_matches(std::process::id(), &current).unwrap());
        assert!(process_identity(u32::MAX).unwrap().is_none());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn zombie_process_state_is_not_treated_as_live() {
        let live = std::fs::read_to_string(format!("/proc/{}/stat", std::process::id())).unwrap();
        let end = live.rfind(')').unwrap();
        let (_, remaining_fields) = live[end + 1..].trim_start().split_once(' ').unwrap();
        let zombie = format!("{} Z {remaining_fields}", &live[..=end]);

        assert!(
            linux_process_identity_from_stat(std::process::id(), &zombie)
                .unwrap()
                .is_none()
        );
        assert!(
            linux_process_identity_from_stat(std::process::id(), &live)
                .unwrap()
                .is_some()
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn procfs_disappearance_preserves_unexpected_observation_errors() {
        for error in [
            std::io::Error::from(std::io::ErrorKind::NotFound),
            std::io::Error::from_raw_os_error(libc::ESRCH),
        ] {
            let mut calls = 0;
            let observed = linux_process_identity_with_reader(42, |path| {
                calls += 1;
                assert_eq!(path, "/proc/42/stat");
                Err(error)
            })
            .unwrap();
            assert_eq!(calls, 1);
            assert!(observed.is_none());
        }
        for code in [libc::EPERM, libc::EACCES, libc::EIO, libc::EINTR] {
            let error = std::io::Error::from_raw_os_error(code);
            let diagnostic = error.to_string();
            let observed = linux_process_identity_with_reader(42, |_| Err(error)).unwrap_err();
            assert_eq!(observed.code, crate::ErrorCode::State);
            assert!(observed.message.contains(&diagnostic));
        }
        let pid = std::process::id();
        let live = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap();
        assert_eq!(
            linux_process_identity_with_reader(pid, |_| Ok(live)).unwrap(),
            process_identity(pid).unwrap()
        );
        assert!(linux_process_identity_with_reader(42, |_| Ok("malformed".into())).is_err());
    }
}
