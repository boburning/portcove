//! Decoder-only PID namespaces. Ordinary tools retain the Unix group contract.
//!
//! clone3 gives the parent a pidfd for the actual namespace init atomically.
//! Namespace-init teardown kills and joins its descendants; custody uses
//! waitid(P_PIDFD), never a PID lookup or a disappearing process-group marker.
#[cfg(test)]
#[path = "linux_tests.rs"]
mod tests;
use super::{ToolSpawnFailure, UnixProcessGroup};
use crate::{PortcoveError, Result, process::NativeToolLaunchSpec};
use std::{
    ffi::CString,
    io,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
        unix::{ffi::OsStrExt, process::ExitStatusExt},
    },
    process::{Child, ChildStderr, ChildStdout, ExitStatus},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

const STARTUP_BOUND: Duration = Duration::from_secs(10);
const JOIN_BOUND: Duration = Duration::from_secs(5);

pub(crate) struct ToolChild {
    pub(crate) stdout: Option<ChildStdout>,
    pub(crate) stderr: Option<ChildStderr>,
    inner: ChildKind,
}

enum ChildKind {
    Ordinary(Child),
    Decoder(Arc<NamespaceProcess>),
}
pub(crate) enum ToolProcessGroup {
    Ordinary(UnixProcessGroup),
    Decoder(Arc<NamespaceProcess>),
}

impl ToolChild {
    pub(crate) fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        match &mut self.inner {
            ChildKind::Ordinary(child) => child.try_wait(),
            ChildKind::Decoder(child) => child.observe(),
        }
    }
}

impl ToolProcessGroup {
    pub(super) fn proves_tree_quiescence(&self) -> bool {
        match self {
            Self::Ordinary(group) => group.proves_tree_quiescence(),
            Self::Decoder(child) => child.closed(),
        }
    }
    pub(super) fn with_proof_details(&self, error: PortcoveError) -> PortcoveError {
        match self {
            Self::Ordinary(_) => error.detail("process_tree_membership_complete", "false"),
            Self::Decoder(child) => {
                let closed = child.closed();
                error
                    .detail("process_tree_membership_complete", "true")
                    .detail(
                        "process_tree_proof_method",
                        "clone3_namespace_init_pidfd_waitid",
                    )
                    .detail("process_tree_active", if closed { "0" } else { "unknown" })
                    .detail("process_tree_all_retained_signaled", closed.to_string())
                    .detail(
                        "process_tree_identities",
                        format!(
                            "[{{\"pid\":{},\"kind\":\"held_namespace_init_pidfd\"}}]",
                            child.host_pid
                        ),
                    )
            }
        }
    }
    pub(crate) fn terminate_and_wait(&self, child: &mut ToolChild) -> io::Result<ExitStatus> {
        match (self, &mut child.inner) {
            (Self::Ordinary(group), ChildKind::Ordinary(child)) => group.terminate_and_wait(child),
            (Self::Decoder(group), ChildKind::Decoder(child)) if Arc::ptr_eq(group, child) => {
                child.signal()?;
                child.join(JOIN_BOUND)
            }
            _ => Err(io::Error::other(
                "tool process custody does not match its supervisor",
            )),
        }
    }
}

pub(crate) fn poll_setup(
    child: &mut ToolChild,
    group: &ToolProcessGroup,
) -> io::Result<Option<ExitStatus>> {
    match (&mut child.inner, group) {
        (ChildKind::Ordinary(child), ToolProcessGroup::Ordinary(group)) => {
            super::poll_unix_setup(child, group)
        }
        (ChildKind::Decoder(child), ToolProcessGroup::Decoder(group))
            if Arc::ptr_eq(child, group) =>
        {
            child.observe()
        }
        _ => Err(io::Error::other(
            "tool process custody does not match its supervisor",
        )),
    }
}

pub(crate) fn spawn_tool(
    spec: &NativeToolLaunchSpec,
) -> std::result::Result<(ToolChild, ToolProcessGroup), ToolSpawnFailure> {
    if spec.decoder_limits.is_none() {
        let (mut child, group) = super::spawn_unix_tool(spec)?;
        return Ok((
            ToolChild {
                stdout: child.stdout.take(),
                stderr: child.stderr.take(),
                inner: ChildKind::Ordinary(child),
            },
            ToolProcessGroup::Ordinary(group),
        ));
    }
    spawn_decoder(spec)
}

#[derive(Default)]
struct ExitObservation {
    status: Option<ExitStatus>,
    closed: bool,
}

pub(crate) struct NamespaceProcess {
    pidfd: OwnedFd,
    host_pid: libc::pid_t,
    observation: Mutex<ExitObservation>,
}

impl NamespaceProcess {
    fn terminal(&self) -> io::Result<bool> {
        let mut descriptor = libc::pollfd {
            fd: self.pidfd.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: poll receives one initialized, exclusively borrowed descriptor.
        let result = unsafe { libc::poll(&mut descriptor, 1, 0) };
        if result < 0 {
            return Err(io::Error::last_os_error());
        }
        if descriptor.revents & (libc::POLLERR | libc::POLLNVAL) != 0 {
            return Err(io::Error::other("decoder pidfd observation failed"));
        }
        Ok(descriptor.revents & libc::POLLIN != 0)
    }
    fn observe(&self) -> io::Result<Option<ExitStatus>> {
        let mut observation = self
            .observation
            .lock()
            .map_err(|_| io::Error::other("decoder exit observation was interrupted"))?;
        if let Some(status) = observation.status {
            return Ok(Some(status));
        }
        if !self.terminal()? {
            return Ok(None);
        }
        // SAFETY: initialized storage and a retained kernel pidfd identify this
        // exact owned child even if another reaper released its numeric PID.
        let mut information: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let result = unsafe {
            libc::waitid(
                libc::P_PIDFD,
                self.pidfd.as_raw_fd() as libc::id_t,
                &mut information,
                libc::WEXITED | libc::WNOHANG,
            )
        };
        if result != 0 {
            return Err(io::Error::last_os_error());
        }
        if unsafe { information.si_pid() } == 0 {
            return Ok(None);
        }
        let value = unsafe { information.si_status() };
        let raw = match information.si_code {
            libc::CLD_EXITED => value << 8,
            libc::CLD_KILLED => value,
            libc::CLD_DUMPED => value | 0x80,
            _ => {
                return Err(io::Error::other(
                    "decoder pidfd returned a nonterminal status",
                ));
            }
        };
        let status = ExitStatus::from_raw(raw);
        observation.status = Some(status);
        observation.closed = true;
        Ok(Some(status))
    }
    fn closed(&self) -> bool {
        self.observation
            .lock()
            .is_ok_and(|observation| observation.closed)
    }
    fn signal(&self) -> io::Result<()> {
        if self.closed() {
            return Ok(());
        }
        // SAFETY: SIGKILL targets the retained namespace-init pidfd, never a PID
        // or a legacy process group. There is no kill-on-close pidfd assumption.
        let result = unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                self.pidfd.as_raw_fd(),
                libc::SIGKILL,
                std::ptr::null::<libc::siginfo_t>(),
                0,
            )
        };
        if result == 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) && self.terminal()? {
            Ok(())
        } else {
            Err(error)
        }
    }
    fn join(&self, bound: Duration) -> io::Result<ExitStatus> {
        let deadline = Instant::now() + bound;
        loop {
            match self.observe() {
                Ok(Some(status)) => return Ok(status),
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(error) => return Err(error),
                Ok(None) => {}
            }
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "decoder namespace closure remains unknown",
                ));
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for NamespaceProcess {
    fn drop(&mut self) {
        // Panic or abandoned ownership still requests exact-identity shutdown.
        // Callers must independently retain staging unless normal proof arrived.
        if !self.closed() {
            let _ = self.signal();
            let _ = self.join(JOIN_BOUND);
        }
    }
}

#[repr(C)]
#[derive(Default)]
struct CloneArguments {
    flags: u64,
    pidfd: u64,
    child_tid: u64,
    parent_tid: u64,
    exit_signal: u64,
    stack: u64,
    stack_size: u64,
    tls: u64,
    set_tid: u64,
    set_tid_size: u64,
    cgroup: u64,
}

struct PreparedExecution {
    program: CString,
    _arguments: Vec<CString>,
    _environment: Vec<CString>,
    arguments: Vec<*const libc::c_char>,
    environment: Vec<*const libc::c_char>,
    directory: Option<CString>,
    uid_mapping: Vec<u8>,
    gid_mapping: Vec<u8>,
    default_action: libc::sigaction,
    empty_mask: libc::sigset_t,
    limits: crate::process::DecoderLimits,
}

impl PreparedExecution {
    fn new(spec: &NativeToolLaunchSpec) -> Result<Self> {
        // Preserve the existing native admission, argument and credential policy.
        let _ = spec.command()?;
        let c_string = |value: &[u8]| {
            CString::new(value)
                .map_err(|_| PortcoveError::launch("decoder launch contains a NUL byte"))
        };
        let program = c_string(spec.program.as_bytes())?;
        let mut arguments = vec![program.clone()];
        arguments.extend(
            spec.arguments
                .iter()
                .map(|argument| c_string(argument.as_bytes()))
                .collect::<Result<Vec<_>>>()?,
        );
        let environment = spec
            .environment
            .iter()
            .map(|(name, value)| {
                let mut entry = name.as_bytes().to_vec();
                entry.push(b'=');
                entry.extend_from_slice(value.as_bytes());
                c_string(&entry)
            })
            .collect::<Result<Vec<_>>>()?;
        let mut argv = arguments
            .iter()
            .map(|value| value.as_ptr())
            .collect::<Vec<_>>();
        argv.push(std::ptr::null());
        let mut envp = environment
            .iter()
            .map(|value| value.as_ptr())
            .collect::<Vec<_>>();
        envp.push(std::ptr::null());
        // All allocation, formatting and libc state construction precede clone.
        let mut default_action: libc::sigaction = unsafe { std::mem::zeroed() };
        let mut empty_mask: libc::sigset_t = unsafe { std::mem::zeroed() };
        unsafe {
            libc::sigemptyset(&mut default_action.sa_mask);
            libc::sigemptyset(&mut empty_mask);
        }
        default_action.sa_sigaction = libc::SIG_DFL;
        Ok(Self {
            program,
            _arguments: arguments,
            _environment: environment,
            arguments: argv,
            environment: envp,
            directory: spec
                .working_directory
                .as_ref()
                .map(|path| c_string(path.as_os_str().as_bytes()))
                .transpose()?,
            uid_mapping: format!("0 {} 1\n", unsafe { libc::geteuid() }).into_bytes(),
            gid_mapping: format!("0 {} 1\n", unsafe { libc::getegid() }).into_bytes(),
            default_action,
            empty_mask,
            limits: spec.decoder_limits.expect("decoder specification"),
        })
    }
}

fn pipe() -> io::Result<(OwnedFd, OwnedFd)> {
    let mut descriptors = [-1; 2];
    if unsafe { libc::pipe2(descriptors.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let read = unsafe { OwnedFd::from_raw_fd(descriptors[0]) };
    let write = unsafe { OwnedFd::from_raw_fd(descriptors[1]) };
    let read = normalize_descriptor(read)?;
    let write = normalize_descriptor(write)?;
    Ok((read, write))
}

fn normalize_descriptor(descriptor: OwnedFd) -> io::Result<OwnedFd> {
    if descriptor.as_raw_fd() > 2 {
        return Ok(descriptor);
    }
    let duplicate = unsafe { libc::fcntl(descriptor.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 3) };
    if duplicate < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(duplicate) })
}

fn start_socket() -> io::Result<(OwnedFd, OwnedFd)> {
    let mut descriptors = [-1; 2];
    if unsafe {
        libc::socketpair(
            libc::AF_UNIX,
            libc::SOCK_SEQPACKET | libc::SOCK_CLOEXEC,
            0,
            descriptors.as_mut_ptr(),
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    let read = unsafe { OwnedFd::from_raw_fd(descriptors[0]) };
    let write = unsafe { OwnedFd::from_raw_fd(descriptors[1]) };
    Ok((normalize_descriptor(read)?, normalize_descriptor(write)?))
}

fn spawn_decoder(
    spec: &NativeToolLaunchSpec,
) -> std::result::Result<(ToolChild, ToolProcessGroup), ToolSpawnFailure> {
    let execution = PreparedExecution::new(spec).map_err(ToolSpawnFailure::before_spawn)?;
    spawn_prepared(execution)
}

fn spawn_prepared(
    execution: PreparedExecution,
) -> std::result::Result<(ToolChild, ToolProcessGroup), ToolSpawnFailure> {
    spawn_prepared_with_start(execution, acknowledge_start)
}

fn spawn_prepared_with_start(
    execution: PreparedExecution,
    start: impl FnOnce(&OwnedFd, &OwnedFd) -> io::Result<()>,
) -> std::result::Result<(ToolChild, ToolProcessGroup), ToolSpawnFailure> {
    let (stdout_read, stdout_write) = pipe().map_err(ToolSpawnFailure::io_before_spawn)?;
    let (stderr_read, stderr_write) = pipe().map_err(ToolSpawnFailure::io_before_spawn)?;
    let (error_read, error_write) = pipe().map_err(ToolSpawnFailure::io_before_spawn)?;
    let (start_read, start_write) = start_socket().map_err(ToolSpawnFailure::io_before_spawn)?;
    let null = normalize_descriptor(
        std::fs::File::open("/dev/null")
            .map(OwnedFd::from)
            .map_err(ToolSpawnFailure::io_before_spawn)?,
    )
    .map_err(ToolSpawnFailure::io_before_spawn)?;
    let parent_descriptor = unsafe { libc::syscall(libc::SYS_pidfd_open, libc::getpid(), 0) };
    if parent_descriptor < 0 {
        return Err(ToolSpawnFailure::io_before_spawn(io::Error::last_os_error()));
    }
    let parent = normalize_descriptor(unsafe { OwnedFd::from_raw_fd(parent_descriptor as RawFd) })
        .map_err(ToolSpawnFailure::io_before_spawn)?;
    let mut all_signals: libc::sigset_t = unsafe { std::mem::zeroed() };
    let mut saved_mask: libc::sigset_t = unsafe { std::mem::zeroed() };
    unsafe {
        libc::sigfillset(&mut all_signals);
    }
    let masking =
        unsafe { libc::pthread_sigmask(libc::SIG_SETMASK, &all_signals, &mut saved_mask) };
    if masking != 0 {
        return Err(ToolSpawnFailure::io_before_spawn(
            io::Error::from_raw_os_error(masking),
        ));
    }
    let mut descriptor = -1_i32;
    let arguments = CloneArguments {
        flags: (libc::CLONE_NEWUSER | libc::CLONE_NEWPID | libc::CLONE_PIDFD) as u64,
        pidfd: (&mut descriptor as *mut i32) as u64,
        exit_signal: libc::SIGCHLD as u64,
        ..Default::default()
    };
    // SAFETY: no VM/files/thread sharing. Child follows only the syscall-only
    // path below and execs or _exits; every pointer was prepared before cloning.
    let result = unsafe {
        libc::syscall(
            libc::SYS_clone3,
            &arguments,
            std::mem::size_of::<CloneArguments>(),
        )
    };
    if result == 0 {
        unsafe {
            execute_child(
                &execution,
                null.as_raw_fd(),
                stdout_write.as_raw_fd(),
                stderr_write.as_raw_fd(),
                error_write.as_raw_fd(),
                start_read.as_raw_fd(),
                parent.as_raw_fd(),
            )
        }
    }
    let clone_error = if result < 0 {
        Some(io::Error::last_os_error())
    } else {
        None
    };
    let restoring =
        unsafe { libc::pthread_sigmask(libc::SIG_SETMASK, &saved_mask, std::ptr::null_mut()) };
    if let Some(error) = clone_error {
        return Err(ToolSpawnFailure::io_before_spawn(error));
    }
    let namespace = Arc::new(NamespaceProcess {
        pidfd: unsafe { OwnedFd::from_raw_fd(descriptor) },
        host_pid: result as libc::pid_t,
        observation: Mutex::new(ExitObservation::default()),
    });
    drop(stdout_write);
    drop(stderr_write);
    drop(error_write);
    drop(start_read);
    drop(parent);
    drop(null);
    let startup = if restoring != 0 {
        Err(io::Error::from_raw_os_error(restoring))
    } else {
        start(&error_read, &start_write)
    };
    if let Err(error) = startup {
        let _ = namespace.signal();
        let quiesced = namespace.join(JOIN_BOUND).is_ok() && namespace.closed();
        return Err(ToolSpawnFailure {
            error: PortcoveError::launch(format!("decoder namespace startup failed: {error}")),
            io_kind: Some(error.kind()),
            quiesced,
        });
    }
    Ok((
        ToolChild {
            stdout: Some(ChildStdout::from(stdout_read)),
            stderr: Some(ChildStderr::from(stderr_read)),
            inner: ChildKind::Decoder(namespace.clone()),
        },
        ToolProcessGroup::Decoder(namespace),
    ))
}

fn acknowledge_start(errors: &OwnedFd, start: &OwnedFd) -> io::Result<()> {
    let deadline = Instant::now() + STARTUP_BOUND;
    let ready = read_packet(errors.as_raw_fd(), deadline)?
        .ok_or_else(|| io::Error::other("decoder exited before registering its lifetime"))?;
    if ready != [0, 0] {
        return Err(io::Error::other(format!(
            "decoder setup phase {} failed with errno {}",
            ready[0], ready[1]
        )));
    }
    let byte = [1_u8];
    if unsafe {
        libc::send(
            start.as_raw_fd(),
            byte.as_ptr().cast(),
            1,
            libc::MSG_NOSIGNAL,
        )
    } != 1
    {
        return Err(io::Error::last_os_error());
    }
    if let Some(error) = read_packet(errors.as_raw_fd(), deadline)? {
        return Err(io::Error::other(format!(
            "decoder exec phase {} failed with errno {}",
            error[0], error[1]
        )));
    }
    Ok(())
}

fn read_packet(descriptor: RawFd, deadline: Instant) -> io::Result<Option<[u32; 2]>> {
    let mut bytes = [0_u8; 8];
    let mut filled = 0;
    while filled != bytes.len() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "decoder startup deadline expired",
            ));
        }
        let mut watched = libc::pollfd {
            fd: descriptor,
            events: libc::POLLIN,
            revents: 0,
        };
        let result = unsafe {
            libc::poll(
                &mut watched,
                1,
                remaining.as_millis().min(i32::MAX as u128) as i32,
            )
        };
        if result < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        if result == 0 {
            continue;
        }
        let result = unsafe {
            libc::read(
                descriptor,
                bytes[filled..].as_mut_ptr().cast(),
                bytes.len() - filled,
            )
        };
        if result < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        if result == 0 {
            return if filled == 0 {
                Ok(None)
            } else {
                Err(io::Error::other("decoder startup packet was truncated"))
            };
        }
        filled += result as usize;
    }
    Ok(Some([
        u32::from_ne_bytes(bytes[..4].try_into().unwrap()),
        u32::from_ne_bytes(bytes[4..].try_into().unwrap()),
    ]))
}

// All functions reachable after clone are allocation/lock/unwind-free and end
// in execve or _exit. A private ready/start gate binds the creating thread's
// lifetime: only it acknowledges after PDEATHSIG registration; pre-registration
// thread loss times out, and a parent pidfd covers earlier process death.
unsafe fn execute_child(
    execution: &PreparedExecution,
    null: RawFd,
    stdout: RawFd,
    stderr: RawFd,
    errors: RawFd,
    start: RawFd,
    parent: RawFd,
) -> ! {
    unsafe {
        if libc::getpid() != 1 {
            fail_child(errors, 1);
        }
        if libc::dup2(null, 0) < 0 || libc::dup2(stdout, 1) < 0 || libc::dup2(stderr, 2) < 0 {
            fail_child(errors, 2);
        }
        // Keep only stdio and the three private control descriptors during setup.
        let mut kept = [errors, start, parent];
        // Three-element sorting without allocation or library locks.
        if kept[0] > kept[1] {
            kept.swap(0, 1);
        }
        if kept[1] > kept[2] {
            kept.swap(1, 2);
        }
        if kept[0] > kept[1] {
            kept.swap(0, 1);
        }
        let mut first = 3_u32;
        for descriptor in kept {
            if first < descriptor as u32
                && libc::syscall(libc::SYS_close_range, first, descriptor as u32 - 1, 0) != 0
            {
                fail_child(errors, 3);
            }
            first = descriptor as u32 + 1;
        }
        if libc::syscall(libc::SYS_close_range, first, u32::MAX, 0) != 0 {
            fail_child(errors, 3);
        }
        write_mapping(
            c"/proc/self/uid_map".as_ptr(),
            &execution.uid_mapping,
            errors,
            4,
        );
        write_mapping(c"/proc/self/setgroups".as_ptr(), b"deny\n", errors, 5);
        write_mapping(
            c"/proc/self/gid_map".as_ptr(),
            &execution.gid_mapping,
            errors,
            6,
        );
        if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0
            || libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) != 0
        {
            fail_child(errors, 7);
        }
        for signal in 1..=64 {
            if signal == libc::SIGKILL || signal == libc::SIGSTOP || signal == 32 || signal == 33 {
                continue;
            }
            if libc::sigaction(signal, &execution.default_action, std::ptr::null_mut()) != 0 {
                fail_child(errors, 8);
            }
        }
        for (resource, value) in [
            (
                libc::RLIMIT_AS,
                execution.limits.memory_bytes as libc::rlim_t,
            ),
            (
                libc::RLIMIT_FSIZE,
                execution.limits.file_bytes as libc::rlim_t,
            ),
        ] {
            let limit = libc::rlimit {
                rlim_cur: value,
                rlim_max: value,
            };
            if libc::setrlimit(resource, &limit) != 0 {
                fail_child(errors, 9);
            }
        }
        if let Some(directory) = &execution.directory
            && libc::chdir(directory.as_ptr()) != 0
        {
            fail_child(errors, 10);
        }
        let ready = [0_u32, 0_u32];
        if libc::write(errors, ready.as_ptr().cast(), 8) != 8 {
            libc::_exit(126);
        }
        let mut watched = [
            libc::pollfd {
                fd: start,
                events: libc::POLLIN,
                revents: 0,
            },
            libc::pollfd {
                fd: parent,
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        if libc::poll(watched.as_mut_ptr(), 2, 5000) <= 0 || watched[1].revents != 0 {
            fail_child(errors, 11);
        }
        let mut byte = 0_u8;
        if libc::read(start, (&mut byte as *mut u8).cast(), 1) != 1 || byte != 1 {
            fail_child(errors, 11);
        }
        libc::close(start);
        libc::close(parent);
        // Caught dispositions reset above; glibc-reserved internal signals are
        // reset by exec. Ordinary ignored SIGCHLD/SIGPIPE do not survive.
        if libc::sigprocmask(
            libc::SIG_SETMASK,
            &execution.empty_mask,
            std::ptr::null_mut(),
        ) != 0
        {
            fail_child(errors, 12);
        }
        libc::execve(
            execution.program.as_ptr(),
            execution.arguments.as_ptr(),
            execution.environment.as_ptr(),
        );
        fail_child(errors, 13)
    }
}

unsafe fn write_mapping(path: *const libc::c_char, value: &[u8], errors: RawFd, phase: u32) {
    unsafe {
        let descriptor = libc::open(path, libc::O_WRONLY | libc::O_CLOEXEC);
        if descriptor < 0 {
            fail_child(errors, phase);
        }
        let written = libc::write(descriptor, value.as_ptr().cast(), value.len());
        let closed = libc::close(descriptor);
        if written != value.len() as isize || closed != 0 {
            fail_child(errors, phase);
        }
    }
}

unsafe fn fail_child(errors: RawFd, phase: u32) -> ! {
    unsafe {
        let packet = [phase, *libc::__errno_location() as u32];
        let _ = libc::write(errors, packet.as_ptr().cast(), 8);
        libc::_exit(126)
    }
}
