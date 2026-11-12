//! Windows tracked handoff for one supervised game session whose definition
//! declares `windows_tracked_handoff`.
//!
//! The game starts suspended inside a fresh job object named after its durable
//! launch session and runs only after assignment, so successors it starts from
//! its own process tree (for example `_wexecv` restarts) are session members.
//! Only members whose image lies inside the session's install root hold the
//! session; a browser, launcher client or editor opened by the game does not.
//! The job sets no kill-on-close, memory or UI limits: closing Portcove never
//! stops the game. Explicit `CREATE_BREAKAWAY_FROM_JOB` remains permitted and
//! leaves tracking; silent breakaway is not enabled. Nested jobs (Windows 8+)
//! keep any job that already contains the supervisor intact.
//!
//! A named object loses its name when its last handle closes, even while member
//! processes still run. Holding members therefore receive an inheritable
//! query-only duplicate, so recovery after a supervisor exit can reopen the job
//! by name while any handle-holding member survives.

use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsStr,
    io,
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
        process::CommandExt,
    },
    path::Path,
    process::{Child, Command, ExitStatus},
    time::Duration,
};

use super::{SessionMember, member_holds_session};
use windows_sys::Win32::{
    Foundation::{
        DuplicateHandle, ERROR_ALREADY_EXISTS, ERROR_FILE_NOT_FOUND, ERROR_INVALID_PARAMETER,
        ERROR_MORE_DATA, GetLastError, HANDLE, INVALID_HANDLE_VALUE, LocalFree, SetLastError,
    },
    Security::{
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            SDDL_REVISION_1,
        },
        GetTokenInformation, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
        TokenUser,
    },
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
        },
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob,
            JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
            JOBOBJECT_BASIC_LIMIT_INFORMATION, JobObjectBasicAccountingInformation,
            JobObjectBasicLimitInformation, JobObjectBasicProcessIdList, OpenJobObjectW,
            QueryInformationJobObject, SetInformationJobObject,
        },
        Threading::{
            CREATE_SUSPENDED, GetCurrentProcess, OpenProcess, OpenProcessToken, OpenThread,
            PROCESS_DUP_HANDLE, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
            QueryFullProcessImageNameW, ResumeThread, SuspendThread, THREAD_SUSPEND_RESUME,
        },
    },
};

// Windows SDK JOB_OBJECT_QUERY (winnt.h). Enough to read accounting/membership
// and to keep the job's name alive; it grants no control over the job.
const JOB_OBJECT_QUERY: u32 = 0x0004;
// Membership snapshot capacity. A larger job keeps the session held (fail closed).
const MEMBER_SNAPSHOT_LIMIT: usize = 4096;
const POLL_INTERVAL: Duration = Duration::from_millis(250);

/// One member lifetime, keyed by PID and process start identity.
type Lifetime = (u32, String);

/// One session job, its resolved install root and per-lifetime observations.
pub(crate) struct SessionJob {
    job: OwnedHandle,
    install_root: String,
    // In-job lifetimes already classified: `Some` holds the session.
    classified: BTreeMap<Lifetime, Option<SessionMember>>,
    // Holding lifetimes that already received the tracking handle.
    shared: BTreeSet<Lifetime>,
}

impl SessionJob {
    /// Creates the session's uniquely named job. An existing object with that
    /// name is refused instead of being joined.
    fn create(session_id: &str, install_root: &Path) -> io::Result<Self> {
        // Resolve the root first: an unresolvable root never starts tracking.
        let install_root = resolved_root(install_root)?;
        let name = wide_name(session_id)?;
        let descriptor = CurrentUserDescriptor::new()?;
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: 0,
        };
        // SAFETY: valid attributes and a NUL-terminated name. The previous
        // error is cleared so an existing object is distinguished exactly.
        let (raw, error) = unsafe {
            SetLastError(0);
            let raw = CreateJobObjectW(&attributes, name.as_ptr());
            (raw, GetLastError())
        };
        drop(descriptor);
        if raw.is_null() {
            return Err(io::Error::from_raw_os_error(error as i32));
        }
        let job = owned(raw)?;
        if error == ERROR_ALREADY_EXISTS {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "another object already uses this launch session's process job name",
            ));
        }
        let limits = JOBOBJECT_BASIC_LIMIT_INFORMATION {
            LimitFlags: JOB_OBJECT_LIMIT_BREAKAWAY_OK,
            ..Default::default()
        };
        // SAFETY: the live job handle and a correctly sized limit structure.
        if unsafe {
            SetInformationJobObject(
                job.as_raw_handle(),
                JobObjectBasicLimitInformation,
                (&raw const limits).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self::with_handle(job, install_root))
    }

    fn with_handle(job: OwnedHandle, install_root: String) -> Self {
        Self {
            job,
            install_root,
            classified: BTreeMap::new(),
            shared: BTreeSet::new(),
        }
    }

    /// Reopens a recorded session job. `None` means no handle to it remains.
    /// An unresolvable recorded root is an error, so recovery keeps the
    /// session for review instead of releasing it.
    pub(crate) fn open(session_id: &str, install_root: &Path) -> io::Result<Option<Self>> {
        let name = wide_name(session_id)?;
        // SAFETY: NUL-terminated name; the returned handle has one owner.
        let raw = unsafe { OpenJobObjectW(JOB_OBJECT_QUERY, 0, name.as_ptr()) };
        if raw.is_null() {
            // SAFETY: reads the calling thread's error for the failed open.
            let code = unsafe { GetLastError() };
            return if code == ERROR_FILE_NOT_FOUND {
                Ok(None)
            } else {
                Err(io::Error::from_raw_os_error(code as i32))
            };
        }
        let job = owned(raw)?;
        Ok(Some(Self::with_handle(job, resolved_root(install_root)?)))
    }

    /// Spawns the configured game suspended, assigns it to the session job,
    /// shares the tracking handle and only then lets it run.
    pub(crate) fn spawn(
        command: &mut Command,
        session_id: &str,
        install_root: &Path,
    ) -> io::Result<(Child, Self)> {
        let mut job = Self::create(session_id, install_root)
            .map_err(|error| context("could not create the session process job", error))?;
        // std replaces earlier creation flags, so compose the supervised-game
        // flags configured by configure_supervised_game with suspension.
        command.creation_flags(super::SUPERVISED_GAME_CREATION_FLAGS | CREATE_SUSPENDED);
        let mut child = command.spawn()?;
        if let Err(error) = job.adopt_suspended(&child) {
            // The game has not run any of its own code yet.
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        Ok((child, job))
    }

    fn adopt_suspended(&mut self, child: &Child) -> io::Result<()> {
        let process = child.as_raw_handle();
        // SAFETY: both handles are live; Child owns full process access.
        if unsafe { AssignProcessToJobObject(self.job.as_raw_handle(), process) } == 0 {
            return Err(context(
                "could not place the game in its session process job (an outer job that does not allow nested jobs can cause this)",
                io::Error::last_os_error(),
            ));
        }
        self.share_into(process)
            .map_err(|error| context("could not share the session process job", error))?;
        // SAFETY: Child owns a live process handle for this call.
        let identity = unsafe { super::process_identity_from_windows_handle(process, child.id()) };
        if let Ok(identity) = identity {
            self.shared.insert((child.id(), identity));
        }
        resume_primary_thread(child.id())
            .map_err(|error| context("could not start the suspended game", error))
    }

    /// Waits for the original child while sharing the tracking handle with
    /// in-install members that did not inherit it.
    pub(crate) fn wait_for_child(&mut self, child: &mut Child) -> io::Result<ExitStatus> {
        loop {
            if let Some(status) = child.try_wait()? {
                return Ok(status);
            }
            let _ = self.holding_members();
            std::thread::sleep(POLL_INTERVAL);
        }
    }

    /// Waits until no member inside the install root remains. `on_waiting`
    /// receives each changed, non-empty set of holding members.
    pub(crate) fn wait_until_released(
        &mut self,
        on_waiting: &mut dyn FnMut(&[SessionMember]),
    ) -> io::Result<()> {
        let mut reported: Vec<SessionMember> = Vec::new();
        loop {
            let members = self.holding_members()?;
            if members.is_empty() {
                return Ok(());
            }
            if members != reported {
                on_waiting(&members);
                reported = members;
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    }

    #[cfg(test)]
    fn active_processes(&self) -> io::Result<u32> {
        let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        query(
            &self.job,
            JobObjectBasicAccountingInformation,
            &mut accounting,
        )?;
        Ok(accounting.ActiveProcesses)
    }

    /// Current members that hold the session, sorted by PID, after sharing the
    /// tracking handle with any that lack it. Each lifetime's image is read and
    /// resolved once. A member that cannot be identified, an unreadable or
    /// unresolvable image, or a membership list that does not fit holds the
    /// session (fail closed).
    fn holding_members(&mut self) -> io::Result<Vec<SessionMember>> {
        let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        query(
            &self.job,
            JobObjectBasicAccountingInformation,
            &mut accounting,
        )?;
        if accounting.ActiveProcesses == 0 {
            self.classified.clear();
            self.shared.clear();
            return Ok(Vec::new());
        }
        let (ids, complete) = self.member_ids()?;
        let live: BTreeSet<u32> = ids.iter().copied().collect();
        self.classified.retain(|(pid, _), _| live.contains(pid));
        self.shared.retain(|(pid, _)| live.contains(pid));
        let mut holding = Vec::new();
        if !complete {
            holding.push(unidentified(0));
        }
        for pid in ids {
            if let Some(member) = self.observe_member(pid) {
                holding.push(member);
            }
        }
        holding.sort();
        holding.dedup();
        Ok(holding)
    }

    fn observe_member(&mut self, pid: u32) -> Option<SessionMember> {
        // SAFETY: OpenProcess returns an owned handle or null.
        let raw = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if raw.is_null() {
            // SAFETY: reads the error of the failed open on this thread.
            let code = unsafe { GetLastError() };
            // An exited member disappears; any other refusal fails closed.
            return (code != ERROR_INVALID_PARAMETER).then(|| unidentified(pid));
        }
        let Ok(process) = owned(raw) else {
            return Some(unidentified(pid));
        };
        // SAFETY: `process` is a live handle with limited query access.
        let identity =
            unsafe { super::process_identity_from_windows_handle(process.as_raw_handle(), pid) };
        let Ok(identity) = identity else {
            return Some(unidentified(pid));
        };
        let lifetime = (pid, identity);
        let member = match self.classified.get(&lifetime) {
            Some(member) => member.clone(),
            None => {
                let mut inside = 0;
                // A PID can be reused between snapshot and open; only a
                // process still in this exact job is a member.
                // SAFETY: both handles are live and `inside` is writable.
                if unsafe {
                    IsProcessInJob(
                        process.as_raw_handle(),
                        self.job.as_raw_handle(),
                        &mut inside,
                    )
                } == 0
                {
                    return Some(unidentified(pid));
                }
                let member = (inside != 0)
                    .then(|| self.classify(&process, pid))
                    .flatten();
                self.classified.insert(lifetime.clone(), member.clone());
                member
            }
        };
        if member.is_some() && !self.shared.contains(&lifetime) && self.share_with_pid(pid) {
            self.shared.insert(lifetime);
        }
        member
    }

    // `Some` when this in-job process holds the session.
    fn classify(&self, process: &OwnedHandle, pid: u32) -> Option<SessionMember> {
        let image = image_path(process)
            .and_then(|image| std::fs::canonicalize(&image).ok())
            .map(|path| path.to_string_lossy().into_owned());
        member_holds_session(image.as_deref(), &self.install_root).then(|| SessionMember {
            pid,
            image_name: image.as_deref().and_then(|image| {
                Path::new(image)
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
            }),
        })
    }

    /// JOBOBJECT_BASIC_PROCESS_ID_LIST with bounded storage. `false` means the
    /// returned IDs are not the complete membership.
    fn member_ids(&self) -> io::Result<(Vec<u32>, bool)> {
        #[repr(C)]
        struct ProcessIds {
            assigned: u32,
            returned: u32,
            ids: [usize; MEMBER_SNAPSHOT_LIMIT],
        }
        let mut buffer = Box::new(ProcessIds {
            assigned: 0,
            returned: 0,
            ids: [0; MEMBER_SNAPSHOT_LIMIT],
        });
        let complete = match query(&self.job, JobObjectBasicProcessIdList, &mut *buffer) {
            Ok(()) => buffer.returned >= buffer.assigned,
            Err(error) if error.raw_os_error() == Some(ERROR_MORE_DATA as i32) => false,
            Err(error) => return Err(error),
        };
        let returned = (buffer.returned as usize).min(MEMBER_SNAPSHOT_LIMIT);
        Ok((
            buffer.ids[..returned]
                .iter()
                .filter_map(|&pid| u32::try_from(pid).ok())
                .collect(),
            complete,
        ))
    }

    // Best effort: a member that cannot be opened keeps live tracking through
    // this handle; only recovery coverage narrows.
    fn share_with_pid(&self, pid: u32) -> bool {
        // SAFETY: OpenProcess returns an owned handle or null.
        let raw = unsafe {
            OpenProcess(
                PROCESS_DUP_HANDLE | PROCESS_QUERY_LIMITED_INFORMATION,
                0,
                pid,
            )
        };
        let Ok(process) = owned(raw) else {
            return false;
        };
        let mut inside = 0;
        // SAFETY: both handles are live and `inside` is writable.
        (unsafe {
            IsProcessInJob(
                process.as_raw_handle(),
                self.job.as_raw_handle(),
                &mut inside,
            )
        } != 0)
            && inside != 0
            && self.share_into(process.as_raw_handle()).is_ok()
    }

    // Leaves one inheritable query-only job handle in the target process, so
    // successors created with handle inheritance keep the job name reachable.
    fn share_into(&self, process: HANDLE) -> io::Result<()> {
        let mut target = std::ptr::null_mut();
        // SAFETY: live source/target handles; the duplicate belongs to the
        // target process and is intentionally not closed here.
        if unsafe {
            DuplicateHandle(
                GetCurrentProcess(),
                self.job.as_raw_handle(),
                process,
                &mut target,
                JOB_OBJECT_QUERY,
                1,
                0,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

fn query<T>(
    job: &OwnedHandle,
    class: windows_sys::Win32::System::JobObjects::JOBOBJECTINFOCLASS,
    value: &mut T,
) -> io::Result<()> {
    // SAFETY: the live job handle and a writable output of the declared size;
    // callers pass the structure that matches `class`.
    if unsafe {
        QueryInformationJobObject(
            job.as_raw_handle(),
            class,
            (value as *mut T).cast(),
            std::mem::size_of::<T>() as u32,
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn unidentified(pid: u32) -> SessionMember {
    SessionMember {
        pid,
        image_name: None,
    }
}

/// The install root as a final path. Tracking never starts or continues
/// against a root it cannot resolve.
fn resolved_root(install_root: &Path) -> io::Result<String> {
    std::fs::canonicalize(install_root)
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|error| context("could not resolve the installation folder", error))
}

fn image_path(process: &OwnedHandle) -> Option<String> {
    let mut buffer = vec![0_u16; 32_768];
    let mut length = buffer.len() as u32;
    // SAFETY: live process handle, writable buffer and its length in characters.
    if unsafe {
        QueryFullProcessImageNameW(
            process.as_raw_handle(),
            PROCESS_NAME_WIN32,
            buffer.as_mut_ptr(),
            &mut length,
        )
    } == 0
    {
        return None;
    }
    buffer.truncate(length as usize);
    Some(String::from_utf16_lossy(&buffer))
}

/// Resumes only threads of `pid` that hold exactly the creation suspension.
fn resume_primary_thread(pid: u32) -> io::Result<()> {
    // SAFETY: a system-wide thread snapshot with one owner.
    let snapshot = owned(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) })?;
    let mut entry = THREADENTRY32 {
        dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
        ..Default::default()
    };
    let mut resumed = 0_usize;
    // SAFETY: the snapshot is live and `entry` declares its exact size.
    let mut present = unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) } != 0;
    while present {
        if entry.th32OwnerProcessID == pid {
            // SAFETY: OpenThread returns an owned handle or null.
            let thread =
                owned(unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) })?;
            // Read the suspend count without changing it: suspend once, then
            // undo that suspension.
            // SAFETY: the thread handle is live with suspend/resume access.
            let previous = unsafe { SuspendThread(thread.as_raw_handle()) };
            if previous == u32::MAX {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: as above; undoes the inspection suspension.
            if unsafe { ResumeThread(thread.as_raw_handle()) } == u32::MAX {
                return Err(io::Error::last_os_error());
            }
            if previous == 1 {
                // SAFETY: as above; releases the creation suspension.
                if unsafe { ResumeThread(thread.as_raw_handle()) } != 1 {
                    return Err(io::Error::last_os_error());
                }
                resumed += 1;
            }
        }
        entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
        // SAFETY: as above.
        present = unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) } != 0;
    }
    if resumed == 0 {
        return Err(io::Error::other(
            "the suspended game process had no thread to resume",
        ));
    }
    Ok(())
}

fn wide_name(session_id: &str) -> io::Result<Vec<u16>> {
    let name = super::session_job_name(session_id).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "launch session ID cannot name a process job",
        )
    })?;
    Ok(OsStr::new(&name).encode_wide().chain(Some(0)).collect())
}

fn owned(raw: HANDLE) -> io::Result<OwnedHandle> {
    if raw.is_null() || raw == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: caller transfers exactly one newly created handle into RAII ownership.
    Ok(unsafe { OwnedHandle::from_raw_handle(raw) })
}

fn context(message: &str, error: io::Error) -> io::Error {
    io::Error::new(error.kind(), format!("{message}: {error}"))
}

/// A protected DACL granting the current account full access and nobody else.
struct CurrentUserDescriptor(PSECURITY_DESCRIPTOR);

impl CurrentUserDescriptor {
    fn new() -> io::Result<Self> {
        let sid = current_user_sid()?;
        let sddl: Vec<u16> = format!("D:P(A;;GA;;;{sid})")
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let mut descriptor = std::ptr::null_mut();
        // SAFETY: NUL-terminated SDDL and a writable output pointer; the
        // allocation is released by Drop with LocalFree.
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(descriptor))
    }
}

impl Drop for CurrentUserDescriptor {
    fn drop(&mut self) {
        // SAFETY: allocated by ConvertStringSecurityDescriptorToSecurityDescriptorW.
        unsafe {
            LocalFree(self.0);
        }
    }
}

fn current_user_sid() -> io::Result<String> {
    let mut raw_token = std::ptr::null_mut();
    // SAFETY: valid output pointer and the current process pseudo handle.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw_token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = owned(raw_token)?;
    // Aligned fixed storage bounds TOKEN_USER and the maximum Windows SID.
    let mut storage = [0_usize; 128];
    let mut length = 0_u32;
    // SAFETY: aligned writable storage and the live query token.
    if unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            storage.as_mut_ptr().cast(),
            std::mem::size_of_val(&storage) as u32,
            &mut length,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    if (length as usize) < std::mem::size_of::<TOKEN_USER>() {
        return Err(io::Error::other("invalid account token size"));
    }
    // SAFETY: the OS initialized a complete TOKEN_USER in aligned storage.
    let sid = unsafe { (*storage.as_ptr().cast::<TOKEN_USER>()).User.Sid };
    let mut text = std::ptr::null_mut();
    // SAFETY: the SID lives in `storage`; the returned string is LocalFree'd.
    if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: Windows returned a NUL-terminated UTF-16 string.
    let value = unsafe {
        let mut length = 0;
        while *text.add(length) != 0 {
            length += 1;
        }
        let value = String::from_utf16_lossy(std::slice::from_raw_parts(text, length));
        LocalFree(text.cast());
        value
    };
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{process::Stdio, time::Instant};
    use windows_sys::Win32::System::JobObjects::TerminateJobObject;

    fn session_id() -> String {
        uuid::Uuid::new_v4().to_string()
    }

    fn system_directory() -> std::path::PathBuf {
        Path::new(&std::env::var_os("SystemRoot").unwrap()).join("System32")
    }

    #[test]
    fn existing_session_job_names_are_refused_instead_of_joined() {
        let id = session_id();
        let root = system_directory();
        let first = SessionJob::create(&id, &root).unwrap();
        let error = SessionJob::create(&id, &root).err().unwrap();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        drop(first);
        assert!(SessionJob::open(&id, &root).unwrap().is_none());
    }

    #[test]
    fn suspended_spawn_runs_tracks_exit_and_releases_the_job_name() {
        let id = session_id();
        let root = system_directory();
        let mut command = Command::new(root.join("cmd.exe"));
        command
            .args(["/d", "/c", "exit 7"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let (mut child, mut job) = SessionJob::spawn(&mut command, &id, &root).unwrap();
        assert_eq!(job.wait_for_child(&mut child).unwrap().code(), Some(7));
        let deadline = Instant::now() + Duration::from_secs(30);
        while job.active_processes().unwrap() != 0 {
            assert!(Instant::now() < deadline, "session job did not drain");
            std::thread::sleep(Duration::from_millis(20));
        }
        let mut waited = Vec::new();
        job.wait_until_released(&mut |members| waited.push(members.to_vec()))
            .unwrap();
        assert!(waited.is_empty());
        assert!(SessionJob::open(&id, &root).unwrap().is_some());
        drop(job);
        assert!(SessionJob::open(&id, &root).unwrap().is_none());
    }

    #[test]
    fn members_outside_the_install_root_never_hold_the_session() {
        let id = session_id();
        let system = system_directory();
        let install = tempfile::tempdir().unwrap();
        // cmd.exe starts ping and exits; both images live outside the install.
        let mut command = Command::new(system.join("cmd.exe"));
        command
            .args(["/d", "/c", "start \"\" /b ping -n 30 127.0.0.1"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let (mut child, mut job) = SessionJob::spawn(&mut command, &id, install.path()).unwrap();
        let status = job.wait_for_child(&mut child);
        let active = job.active_processes();
        let mut waited = Vec::new();
        let released = job.wait_until_released(&mut |members| waited.push(members.to_vec()));
        // SAFETY: the test-created job handle has full access; this stops
        // only the fixture's own ping.
        unsafe { TerminateJobObject(job.job.as_raw_handle(), 1) };
        assert!(status.unwrap().success());
        assert!(active.unwrap() > 0, "ping should outlive cmd.exe");
        released.unwrap();
        assert!(waited.is_empty(), "{waited:?}");
    }
}
