use std::time::Duration;

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
pub(crate) fn process_alive(pid: u32) -> bool {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, STILL_ACTIVE},
        System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    };

    // SAFETY: OpenProcess returns an owned handle or null. The handle is queried
    // without mutation and closed exactly once before returning.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut exit_code = 0_u32;
        let alive =
            GetExitCodeProcess(handle, &mut exit_code) != 0 && exit_code == STILL_ACTIVE as u32;
        CloseHandle(handle);
        alive
    }
}

#[cfg(unix)]
pub(crate) fn process_alive(pid: u32) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    // SAFETY: signal 0 performs an existence/permission check and does not
    // deliver a signal to the target process.
    let result = unsafe { libc::kill(pid, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

pub(crate) fn wait_for_process_exit(pid: u32) {
    while process_alive(pid) {
        std::thread::sleep(Duration::from_millis(200));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_and_impossible_process_ids_are_distinguished() {
        assert!(process_alive(std::process::id()));
        assert!(!process_alive(u32::MAX));
    }
}
