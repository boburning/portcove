//! Keeps a Windows launch job reachable after its supervisor exits.

use std::{
    io::{Read, Write},
    os::windows::{
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
        process::CommandExt,
    },
    process::{Child, Stdio},
    sync::mpsc,
    time::Duration,
};

use windows_sys::Win32::{
    Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT},
    System::Threading::{
        CREATE_NEW_PROCESS_GROUP, DETACHED_PROCESS, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SYNCHRONIZE, WaitForSingleObject,
    },
};

use crate::{
    ChildProcessClass, ChildProcessPolicy, ErrorCode, LaunchSessionPhase, LaunchSessionRecord,
    Library, PortcoveError, PortcoveService, Result,
};

use super::{SessionProcesses, process_identity_from_windows_handle};

pub const LAUNCH_JOB_KEEPER_MODE: &str = "--portcove-launch-job-keeper";
const READY: u8 = 1;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(10);
const READBACK_INTERVAL_MS: u32 = 1000;

/// Uses a private stdout pipe to distinguish this helper's acknowledgement
/// from files left by other launches. The game is still suspended or absent.
pub(super) fn start(library: &Library, session: &LaunchSessionRecord) -> Result<Child> {
    let executable = std::env::current_exe()?;
    let mut command =
        ChildProcessPolicy::native_command(ChildProcessClass::HostIntegration, executable)?;
    command
        .arg(LAUNCH_JOB_KEEPER_MODE)
        .arg(library.root())
        .arg(&session.id)
        .arg(session.supervisor_pid.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS);
    let mut child = command.spawn()?;
    let result = (|| {
        let mut acknowledgement = child.stdout.take().ok_or_else(|| {
            PortcoveError::state("Windows launch keeper acknowledgement pipe was unavailable")
        })?;
        let (sender, receiver) = mpsc::sync_channel(1);
        std::thread::Builder::new()
            .name("launch-job-keeper-ack".into())
            .spawn(move || {
                let mut byte = [0];
                let result = acknowledgement.read_exact(&mut byte).map(|()| byte[0]);
                let _ = sender.send(result);
            })?;
        if !matches!(receiver.recv_timeout(STARTUP_TIMEOUT), Ok(Ok(READY))) {
            return Err(PortcoveError::launch(
                "Windows launch keeper did not acknowledge the session job",
            ));
        }
        Ok(())
    })();
    if let Err(error) = result {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    Ok(child)
}

/// Internal entrypoint used by the native CLI and Desktop adapters. A keeper
/// takes a query-only handle to a job that the actual supervisor already made.
pub fn run_launch_job_keeper(library: Library, id: &str, supervisor_pid: u32) -> Result<()> {
    let session = library.active_launch_session(id)?.ok_or_else(|| {
        PortcoveError::not_found("Windows launch keeper found no active launch session")
    })?;
    let expected = session.supervisor_identity.as_deref().ok_or_else(|| {
        PortcoveError::verification("Windows launch keeper requires the supervisor start identity")
    })?;
    if session.supervisor_pid != supervisor_pid || session.phase != LaunchSessionPhase::Preparing {
        return Err(PortcoveError::verification(
            "Windows launch keeper launch ownership changed",
        ));
    }
    // SAFETY: OpenProcess accepts a PID and access flags. A non-null result
    // transfers a new handle with query and wait access to this worker.
    let raw = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            supervisor_pid,
        )
    };
    if raw.is_null() {
        return Err(std::io::Error::last_os_error().into());
    }
    // SAFETY: raw is a newly owned process handle.
    let supervisor = unsafe { OwnedHandle::from_raw_handle(raw) };
    // SAFETY: the owned handle has PROCESS_QUERY_LIMITED_INFORMATION access.
    let actual = unsafe {
        process_identity_from_windows_handle(supervisor.as_raw_handle(), supervisor_pid)
    }?;
    if actual != expected {
        return Err(PortcoveError::verification(
            "Windows launch keeper supervisor identity changed",
        ));
    }
    let _processes = SessionProcesses::reopen(id, &session.install_root)?.ok_or_else(|| {
        PortcoveError::verification("Windows launch keeper could not open the session job")
    })?;

    {
        let mut stdout = std::io::stdout().lock();
        stdout.write_all(&[READY])?;
        stdout.flush()?;
    }

    let mut recovery_attempted = false;
    loop {
        match library.launch_request(id) {
            // Terminal rows may be pruned after the library durably completes
            // them. Missing authenticated rows cannot become active again.
            Ok(None) => return Ok(()),
            Ok(Some(session)) if session.outcome.is_some() => return Ok(()),
            Ok(Some(_)) => {}
            Err(error) => tracing::warn!(%error, "could not read Windows launch keeper session"),
        }
        // SAFETY: the process handle has wait access and remains live.
        match unsafe { WaitForSingleObject(supervisor.as_raw_handle(), READBACK_INTERVAL_MS) } {
            WAIT_OBJECT_0 => {
                if !recovery_attempted {
                    let recovery = PortcoveService::new_read_only(library.clone())
                        .and_then(|service| service.recover_launch_session(id));
                    recovery_attempted = match recovery {
                        Ok(()) => continue,
                        Err(error)
                            if error.code == ErrorCode::Conflict
                                && error.details.get("operation").map(String::as_str)
                                    == Some("launch-recovery") =>
                        {
                            false
                        }
                        Err(error) => {
                            tracing::warn!(%error, "Windows launch keeper is awaiting session recovery");
                            true
                        }
                    };
                }
                std::thread::sleep(Duration::from_millis(u64::from(READBACK_INTERVAL_MS)));
            }
            WAIT_TIMEOUT => {}
            _ => {
                tracing::warn!("could not wait on Windows launch supervisor");
                std::thread::sleep(Duration::from_millis(u64::from(READBACK_INTERVAL_MS)));
            }
        }
    }
}
