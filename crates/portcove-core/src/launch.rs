use std::{process::Child, time::Duration};

use crate::{LaunchSignal, PortcoveError, Result};

pub(crate) fn configure_supervised_game(command: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        command.creation_flags(CREATE_NEW_PROCESS_GROUP);
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
    let path = format!("/proc/{pid}/stat");
    let body = match std::fs::read_to_string(&path) {
        Ok(body) => body,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
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
fn linux_process_state_and_identity_from_stat<'a>(
    pid: u32,
    body: &'a str,
) -> Result<(&'a str, String)> {
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
        return if error.raw_os_error() == Some(libc::ESRCH) {
            Ok(None)
        } else {
            Err(PortcoveError::state(format!(
                "could not identify process {pid}: {error}"
            )))
        };
    }
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
