//! One creation/event owner for each native tool tree. Caller checkpoints never
//! execute on this thread. All retained identities and accounting share one store.
use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    fs::File,
    io::{self, Read, Seek, SeekFrom},
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle},
        process::ExitStatusExt,
    },
    path::PathBuf,
    process::ExitStatus,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use super::ToolSpawnFailure;
use crate::{
    PortcoveError,
    process::{NativeToolEventBudget, NativeToolLaunchSpec},
};
use windows_sys::Win32::{
    Foundation::{
        DBG_CONTINUE, DBG_EXCEPTION_NOT_HANDLED, ERROR_INVALID_HANDLE, ERROR_INVALID_PARAMETER,
        ERROR_SEM_TIMEOUT, FILETIME, GetLastError, HANDLE, HANDLE_FLAG_INHERIT,
        INVALID_HANDLE_VALUE, STATUS_BREAKPOINT, SetHandleInformation, WAIT_FAILED, WAIT_OBJECT_0,
        WAIT_TIMEOUT,
    },
    Security::SECURITY_ATTRIBUTES,
    Storage::FileSystem::{
        CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_GENERIC_READ, FILE_SHARE_READ, FILE_SHARE_WRITE,
        GetFinalPathNameByHandleW, OPEN_EXISTING,
    },
    System::{
        Diagnostics::Debug::{
            CREATE_PROCESS_DEBUG_EVENT, CREATE_THREAD_DEBUG_EVENT, ContinueDebugEvent, DEBUG_EVENT,
            EXCEPTION_DEBUG_EVENT, EXIT_PROCESS_DEBUG_EVENT, EXIT_THREAD_DEBUG_EVENT,
            LOAD_DLL_DEBUG_EVENT, OUTPUT_DEBUG_STRING_EVENT, RIP_EVENT, UNLOAD_DLL_DEBUG_EVENT,
            WaitForDebugEventEx,
        },
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob,
            JOB_OBJECT_LIMIT_JOB_MEMORY, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JobObjectBasicAccountingInformation, JobObjectBasicProcessIdList,
            JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
            TerminateJobObject,
        },
        Pipes::CreatePipe,
        SystemInformation::{
            GetSystemDirectoryW, IMAGE_FILE_MACHINE_AMD64, IMAGE_FILE_MACHINE_UNKNOWN,
        },
        Threading::{
            CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessW, DEBUG_PROCESS,
            DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess,
            GetProcessId, GetProcessTimes, InitializeProcThreadAttributeList, IsWow64Process2,
            OpenProcess, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROCESS_INFORMATION,
            PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, ResumeThread,
            STARTF_USESTDHANDLES, STARTUPINFOEXW, TerminateProcess, UpdateProcThreadAttribute,
            WaitForSingleObject,
        },
    },
};

const MEMBER_LIMIT: usize = 512;
const CLOSURE_BOUND: Duration = Duration::from_secs(2);

#[derive(Default, Clone)]
struct Proof {
    event_budget: NativeToolEventBudget,
    observed_events: usize,
    first_failure: Option<(&'static str, Option<u32>)>,
    retained: usize,
    identities: Vec<Identity>,
    #[cfg(test)]
    images: Vec<(Identity, String)>,
    accounting: Option<(u32, u32)>,
    all_retained_signaled: Option<bool>,
    wait_result: Option<u32>,
    deadline: Option<Instant>,
    deadline_exhausted: bool,
    root_status: Option<ExitStatus>,
    done: bool,
    quiesced: bool,
}

impl Proof {
    fn record_event(&mut self) -> bool {
        self.observed_events = self.observed_events.saturating_add(1);
        if self.observed_events > self.event_budget.limit() {
            self.first_failure.get_or_insert(("event_capacity", None));
            self.quiesced = false;
            return false;
        }
        true
    }

    fn publish_members(&mut self, retained: usize, identities: impl Iterator<Item = Identity>) {
        self.retained = retained;
        self.identities = identities.collect();
        self.all_retained_signaled = None;
    }

    fn latch_deadline(&mut self, now: Instant) {
        if !self.done && self.deadline.is_some_and(|deadline| now >= deadline) {
            self.deadline_exhausted = true;
            self.first_failure.get_or_insert(("closure_deadline", None));
            self.quiesced = false;
        }
    }

    fn finish(&mut self, complete: bool, now: Instant) {
        self.latch_deadline(now);
        self.quiesced = complete && !self.deadline_exhausted && self.first_failure.is_none();
        self.done = true;
    }
}

#[derive(Default)]
struct Control {
    stop: AtomicBool,
    proof: Mutex<Proof>,
    changed: Condvar,
}

impl Control {
    fn lock(&self) -> std::sync::MutexGuard<'_, Proof> {
        self.proof
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn request_stop(&self) {
        let mut proof = self.lock();
        if !proof.done {
            proof
                .deadline
                .get_or_insert_with(|| Instant::now() + CLOSURE_BOUND);
            self.stop.store(true, Ordering::Release);
        }
        self.changed.notify_all();
    }

    fn wait_done(&self) -> Proof {
        self.request_stop();
        let mut proof = self.lock();
        while !proof.done {
            let remaining = proof
                .deadline
                .expect("stop has one deadline")
                .saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                proof.latch_deadline(Instant::now());
                break;
            }
            proof = self
                .changed
                .wait_timeout(proof, remaining)
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .0;
        }
        proof.clone()
    }
}

pub(crate) struct ToolChild {
    pub(crate) stdout: Option<File>,
    pub(crate) stderr: Option<File>,
    control: Arc<Control>,
}

impl ToolChild {
    pub(crate) fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        let proof = self.control.lock();
        if proof.done && proof.root_status.is_none() {
            return Err(io::Error::other(
                "native tool root exit lacks positive handle proof",
            ));
        }
        Ok(proof.root_status)
    }

    #[cfg(test)]
    pub(crate) fn wait(&mut self) -> io::Result<ExitStatus> {
        self.control
            .wait_done()
            .root_status
            .ok_or_else(|| io::Error::other("native tool root did not settle"))
    }
}

impl Drop for ToolChild {
    fn drop(&mut self) {
        self.control.request_stop();
    }
}

pub(crate) struct ToolProcessGroup {
    control: Arc<Control>,
    worker: Option<JoinHandle<()>>,
}

impl ToolProcessGroup {
    pub(crate) fn proves_tree_quiescence(&self) -> bool {
        let proof = self.control.wait_done();
        proof.done && proof.quiesced
    }

    pub(crate) fn terminate_and_wait(&self, _child: &mut ToolChild) -> io::Result<ExitStatus> {
        self.control.wait_done().root_status.ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::TimedOut,
                "native tool root did not exit within the owned-tree bound",
            )
        })
    }

    pub(crate) fn with_proof_details(&self, error: PortcoveError) -> PortcoveError {
        with_control_proof(&self.control, error)
    }
}

fn with_control_proof(control: &Control, mut error: PortcoveError) -> PortcoveError {
    let proof = control.lock();
    if let Some((reason, code)) = proof.first_failure {
        error = error.detail("process_tree_first_failure", reason);
        if let Some(code) = code {
            error = error.detail("process_tree_api_error", code.to_string());
        }
    }
    error = error
        .detail(
            "process_tree_observed_events",
            proof.observed_events.to_string(),
        )
        .detail(
            "process_tree_event_limit",
            proof.event_budget.limit().to_string(),
        )
        .detail("process_tree_retained_members", proof.retained.to_string())
        .detail(
            "process_tree_membership_complete",
            proof.first_failure.is_none().to_string(),
        )
        .detail(
            "process_tree_deadline_exhausted",
            proof.deadline_exhausted.to_string(),
        );
    if let Some((active, total)) = proof.accounting {
        error = error
            .detail("process_tree_active", active.to_string())
            .detail("process_tree_total", total.to_string());
    }
    if let Some(waited) = proof.wait_result {
        error = error.detail("process_tree_wait_result", waited.to_string());
    }
    if let Some(signaled) = proof.all_retained_signaled {
        error = error.detail("process_tree_all_retained_signaled", signaled.to_string());
    }
    if let Some(status) = proof.root_status {
        error = error.detail(
            "process_tree_root_exit",
            (status.code().unwrap() as u32).to_string(),
        );
    }
    if !proof.identities.is_empty() {
        // Decimal strings preserve FILETIME precision across JSON consumers.
        let identities = proof
            .identities
            .iter()
            .map(|identity| {
                format!(
                    "{{\"pid\":{},\"created_filetime\":\"{}\"}}",
                    identity.pid, identity.created
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        error = error.detail("process_tree_identities", format!("[{identities}]"));
    }
    #[cfg(test)]
    if let Ok(images) = serde_json::to_string(&proof.images.iter().map(|(identity,image)| {
        serde_json::json!({"pid":identity.pid,"created_filetime":identity.created.to_string(),"image":image})
    }).collect::<Vec<_>>()) {
        error = error.detail("process_tree_image_identities",images);
    }
    error
}

impl Drop for ToolProcessGroup {
    fn drop(&mut self) {
        let proof = self.control.wait_done();
        if let Some(worker) = self.worker.take() {
            // Never replace an expired closure budget with an unbounded join.
            while !worker.is_finished()
                && proof
                    .deadline
                    .is_some_and(|deadline| Instant::now() < deadline)
            {
                thread::sleep(Duration::from_millis(1));
            }
            if worker.is_finished() {
                let _ = worker.join();
            }
        }
    }
}

pub(crate) fn spawn_tool(
    spec: &NativeToolLaunchSpec,
) -> Result<(ToolChild, ToolProcessGroup), ToolSpawnFailure> {
    spawn_with_options(spec, TestOptions::default())
}

#[cfg(test)]
pub(super) fn spawn_with_occupied_slots(
    spec: &NativeToolLaunchSpec,
    occupied: usize,
) -> Result<(ToolChild, ToolProcessGroup), ToolSpawnFailure> {
    assert!((1..=MEMBER_LIMIT).contains(&occupied));
    spawn_with_options(
        spec,
        TestOptions {
            reserved_slots: occupied - 1,
            fail_capture: false,
            ..Default::default()
        },
    )
}

#[cfg(test)]
type LateRootExitObservation = Arc<Mutex<Option<(u32, u32, Identity)>>>;

#[derive(Default, Clone)]
struct TestOptions {
    // Start at the selected finite threshold; the next real debug event must stop.
    #[cfg(test)]
    prime_event_capacity: bool,
    #[cfg(test)]
    late_root_exit: Option<LateRootExitObservation>,
    #[cfg(test)]
    panic_tree: Option<Arc<PanicTreeObservation>>,
    #[cfg(test)]
    root_failure: Option<RootFailure>,
    #[cfg(test)]
    root_observation: Option<Arc<RefusedMember>>,
    #[cfg(test)]
    reserved_slots: usize,
    #[cfg(test)]
    fail_capture: bool,
    #[cfg(test)]
    refused_member: Option<Arc<RefusedMember>>,
    #[cfg(test)]
    pending_creation: Option<Arc<PendingCreation>>,
    #[cfg(test)]
    exception_trace: Option<Arc<Mutex<Vec<ExceptionObservation>>>>,
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RootFailure {
    Identity,
    Assignment,
    Resume,
    PanicBeforeAssignment,
    PanicAfterAssignment,
}

#[cfg(test)]
#[derive(Clone)]
struct ExceptionObservation {
    pid: u32,
    code: u32,
    first_chance: u32,
    continuation: i32,
}

#[cfg(test)]
#[derive(Default)]
struct PendingCreation {
    identity: Mutex<Option<Identity>>,
    cancellation_observed: AtomicBool,
}

#[cfg(test)]
#[derive(Default)]
struct RefusedMember {
    // An independent fixture observation of a refused member handle. It is
    // never inserted into Core membership or used to grant cleanup proof.
    member: Mutex<Option<(Identity, OwnedHandle)>>,
}

#[cfg(test)]
#[derive(Default)]
struct PanicTreeObservation {
    captured: Mutex<Option<PanickedTree>>,
}

#[cfg(test)]
struct PanickedTree {
    root_pid: u32,
    event_pid: u32,
    event_thread: u32,
    members: Vec<(Identity, OwnedHandle)>,
}

fn spawn_with_options(
    spec: &NativeToolLaunchSpec,
    options: TestOptions,
) -> Result<(ToolChild, ToolProcessGroup), ToolSpawnFailure> {
    let launch = EncodedLaunch::new(spec).map_err(ToolSpawnFailure::before_spawn)?;
    let control = Arc::new(Control::default());
    let worker_control = control.clone();
    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    let worker = thread::Builder::new()
        .name("portcove-tool-controller".into())
        .spawn(move || {
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                match Controller::new(launch, worker_control.clone(), options) {
                    Ok((mut controller, stdout, stderr)) => {
                        let _ = ready_tx.send(Ok((stdout, stderr)));
                        controller.run();
                    }
                    Err(error) => {
                        let _ = ready_tx.send(Err(error));
                    }
                }
            }));
            if outcome.is_err() {
                let mut proof = worker_control.lock();
                proof
                    .first_failure
                    .get_or_insert(("controller_panic", None));
                proof.quiesced = false;
                proof.done = true;
                worker_control.changed.notify_all();
            }
        })
        .map_err(ToolSpawnFailure::io_before_spawn)?;
    match ready_rx.recv_timeout(CLOSURE_BOUND) {
        Ok(Ok((stdout, stderr))) => Ok((
            ToolChild {
                stdout: Some(stdout),
                stderr: Some(stderr),
                control: control.clone(),
            },
            ToolProcessGroup {
                control,
                worker: Some(worker),
            },
        )),
        Ok(Err(error)) => {
            let _ = worker.join();
            Err(error)
        }
        Err(_) => {
            control.request_stop();
            if worker.is_finished() {
                let _ = worker.join();
            }
            // Preserve an observed controller panic. A live readiness timeout
            // remains incomplete custody; it cannot publish successful cleanup.
            {
                let mut proof = control.lock();
                proof
                    .first_failure
                    .get_or_insert(("controller_readiness", None));
                proof.quiesced = false;
            }
            Err(ToolSpawnFailure {
                error: with_control_proof(
                    &control,
                    PortcoveError::state(
                        "native tool controller did not establish creation custody",
                    ),
                ),
                quiesced: false,
                io_kind: None,
            })
        }
    }
}

struct EncodedLaunch {
    event_budget: NativeToolEventBudget,
    application: Vec<u16>,
    command: Vec<u16>,
    environment: Vec<u16>,
    directory: Option<Vec<u16>>,
    decoder_memory_bytes: Option<usize>,
}

impl EncodedLaunch {
    fn new(spec: &NativeToolLaunchSpec) -> crate::Result<Self> {
        // Reuse policy validation without inspecting Command's hidden state.
        spec.command()?;
        let program = PathBuf::from(&spec.program);
        #[cfg(test)]
        let program = if spec.program == "cmd.exe" {
            system_directory()?.join("cmd.exe")
        } else {
            program
        };
        if !program.is_absolute() {
            return Err(PortcoveError::launch(
                "supervised native tools require a resolved absolute executable",
            ));
        }
        let application = wide(program.as_os_str())?;
        let mut command = quote_argument(&application[..application.len() - 1]);
        for argument in &spec.arguments {
            command.push(b' ' as u16);
            let argument = wide(argument)?;
            command.extend(quote_argument(&argument[..argument.len() - 1]));
        }
        #[cfg(test)]
        for argument in &spec.raw_arguments {
            command.push(b' ' as u16);
            let argument = wide(argument)?;
            command.extend_from_slice(&argument[..argument.len() - 1]);
        }
        command.push(0);
        if command.len() > 32767 {
            return Err(PortcoveError::launch(
                "native tool command exceeds the Windows argument bound",
            ));
        }
        let mut environment = Vec::new();
        let mut entries = Vec::new();
        for (key, value) in &spec.environment {
            let key = wide(key)?;
            let value = wide(value)?;
            if key.len() <= 1 || key[..key.len() - 1].contains(&(b'=' as u16)) {
                return Err(PortcoveError::launch(
                    "native tool environment name is invalid",
                ));
            }
            entries.push((key, value));
        }
        entries.sort_by(|(a, _), (b, _)| {
            use windows_sys::Win32::Globalization::{
                CSTR_GREATER_THAN, CSTR_LESS_THAN, CompareStringOrdinal,
            };
            // SAFETY: NUL-terminated buffers have validated bounded lengths.
            match unsafe { CompareStringOrdinal(a.as_ptr(), -1, b.as_ptr(), -1, 1) } {
                CSTR_LESS_THAN => std::cmp::Ordering::Less,
                CSTR_GREATER_THAN => std::cmp::Ordering::Greater,
                _ => std::cmp::Ordering::Equal,
            }
        });
        for (key, value) in entries {
            environment.extend_from_slice(&key[..key.len() - 1]);
            environment.push(b'=' as u16);
            environment.extend(value);
        }
        if environment.is_empty() {
            environment.push(0);
        }
        environment.push(0);
        if environment.len() > 32767 {
            return Err(PortcoveError::launch(
                "native tool environment exceeds its bounded launch input",
            ));
        }
        Ok(Self {
            event_budget: if spec.decoder_limits.is_some() {
                NativeToolEventBudget::Ordinary
            } else {
                spec.event_budget
            },
            application,
            command,
            environment,
            decoder_memory_bytes: spec.decoder_limits.map(|limits| limits.memory_bytes),
            directory: spec
                .working_directory
                .as_ref()
                .map(|path| wide(path.as_os_str()))
                .transpose()?,
        })
    }
}

fn wide(value: &OsStr) -> crate::Result<Vec<u16>> {
    let mut units: Vec<_> = value.encode_wide().collect();
    if units.contains(&0) || units.len() >= 32767 {
        return Err(PortcoveError::launch(
            "native tool launch input contains NUL or exceeds its bound",
        ));
    }
    units.push(0);
    Ok(units)
}

fn quote_argument(argument: &[u16]) -> Vec<u16> {
    let mut quoted = vec![b'"' as u16];
    let mut slashes = 0;
    for &unit in argument {
        if unit == b'\\' as u16 {
            slashes += 1;
            continue;
        }
        quoted.extend(std::iter::repeat_n(
            b'\\' as u16,
            if unit == b'"' as u16 {
                slashes * 2 + 1
            } else {
                slashes
            },
        ));
        slashes = 0;
        quoted.push(unit);
    }
    quoted.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2));
    quoted.push(b'"' as u16);
    quoted
}

fn owned(raw: HANDLE) -> io::Result<OwnedHandle> {
    if raw.is_null() || raw == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: caller transfers exactly one newly created handle into RAII ownership.
    Ok(unsafe { OwnedHandle::from_raw_handle(raw) })
}

fn duplicate(raw: HANDLE) -> io::Result<OwnedHandle> {
    if raw.is_null() || raw == INVALID_HANDLE_VALUE {
        return Err(io::Error::other("invalid native process capture"));
    }
    // SAFETY: debugger event/creation handle remains open throughout duplication.
    unsafe { BorrowedHandle::borrow_raw(raw).try_clone_to_owned() }
}

fn pipe() -> io::Result<(File, OwnedHandle)> {
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: std::ptr::null_mut(),
        bInheritHandle: 1,
    };
    let (mut read, mut write) = (std::ptr::null_mut(), std::ptr::null_mut());
    if unsafe { CreatePipe(&mut read, &mut write, &attributes, 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let read = owned(read)?;
    let write = owned(write)?;
    if unsafe { SetHandleInformation(read.as_raw_handle(), HANDLE_FLAG_INHERIT, 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((File::from(read), write))
}

struct Attributes {
    words: Vec<usize>,
    initialized: bool,
}
impl Attributes {
    fn new(handles: &mut [HANDLE]) -> io::Result<Self> {
        let mut bytes = 0;
        unsafe {
            InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut bytes);
        }
        if bytes == 0 || bytes > 65536 {
            return Err(io::Error::other("invalid native handle-list storage"));
        }
        let mut attributes = Self {
            words: vec![0; bytes.div_ceil(std::mem::size_of::<usize>())],
            initialized: false,
        };
        let pointer = attributes.words.as_mut_ptr().cast();
        if unsafe { InitializeProcThreadAttributeList(pointer, 1, 0, &mut bytes) } == 0 {
            return Err(io::Error::last_os_error());
        }
        attributes.initialized = true;
        if unsafe {
            UpdateProcThreadAttribute(
                pointer,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                handles.as_ptr().cast(),
                std::mem::size_of_val(handles),
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(attributes)
    }
}
impl Drop for Attributes {
    fn drop(&mut self) {
        if self.initialized {
            unsafe {
                DeleteProcThreadAttributeList(self.words.as_mut_ptr().cast());
            }
        }
    }
}

struct SuspendedRootGuard {
    handle: OwnedHandle,
    contained: bool,
}

impl Drop for SuspendedRootGuard {
    fn drop(&mut self) {
        // A panic before Job assignment still stops the exact created root.
        // This is containment only, never a quiescence/cleanup acceptance claim.
        if !self.contained {
            unsafe {
                TerminateProcess(self.handle.as_raw_handle(), 1);
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct Identity {
    pid: u32,
    created: u64,
}

struct Member {
    handle: OwnedHandle,
    #[cfg(test)]
    image: Option<String>,
    initial_thread: Option<u32>,
    creation_seen: bool,
    startup_handled: bool,
    system_module: Option<(usize, usize)>,
}

#[cfg(test)]
fn test_process_image(handle: HANDLE) -> Option<String> {
    use windows_sys::Win32::System::Threading::QueryFullProcessImageNameW;
    // One bounded query against the retained lifetime handle before continuation.
    // No PID reopening, substitution, trust decision or production behavior.
    let mut buffer = [0u16; 1024];
    let mut length = buffer.len() as u32;
    if unsafe { QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut length) } == 0
        || length == 0
        || length as usize > buffer.len()
    {
        return None;
    }
    String::from_utf16(&buffer[..length as usize]).ok()
}

#[derive(Debug, PartialEq, Eq)]
enum ExceptionDisposition {
    Startup,
    Application,
    Unclassified,
}

impl Member {
    fn classify_exception(
        &mut self,
        thread: u32,
        code: i32,
        first_chance: u32,
        address: usize,
    ) -> ExceptionDisposition {
        if self.startup_handled {
            return ExceptionDisposition::Application;
        }
        if code == STATUS_BREAKPOINT
            && first_chance == 1
            && self.initial_thread == Some(thread)
            && self.creation_seen
            && self.system_module.is_some_and(|(base, size)| {
                address
                    .checked_sub(base)
                    .is_some_and(|offset| offset < size)
            })
        {
            self.startup_handled = true;
            ExceptionDisposition::Startup
        } else {
            ExceptionDisposition::Unclassified
        }
    }
}

fn identity(handle: HANDLE) -> io::Result<Identity> {
    let (mut created, mut exited, mut kernel, mut user) = (
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
    );
    if unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let pid = unsafe { GetProcessId(handle) };
    let created = (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
    if pid == 0 || created == 0 {
        return Err(io::Error::other("native creation identity is incomplete"));
    }
    Ok(Identity { pid, created })
}

fn positive_root_exit_status(
    handle: HANDLE,
) -> Result<Option<ExitStatus>, (&'static str, Option<u32>)> {
    match unsafe { WaitForSingleObject(handle, 0) } {
        WAIT_OBJECT_0 => {
            let mut code = 0;
            if unsafe { GetExitCodeProcess(handle, &mut code) } == 0 {
                Err(("root_exit_code", Some(unsafe { GetLastError() })))
            } else {
                Ok(Some(ExitStatus::from_raw(code)))
            }
        }
        WAIT_TIMEOUT => Ok(None),
        WAIT_FAILED => Err(("root_wait", Some(unsafe { GetLastError() }))),
        _ => Err(("root_wait", None)),
    }
}

struct Controller {
    job: OwnedHandle,
    root: Option<Identity>,
    primary_thread: Option<OwnedHandle>,
    members: BTreeMap<Identity, Member>,
    live_debug_members: BTreeMap<u32, Identity>,
    control: Arc<Control>,
    job_assigned: bool,
    terminating: bool,
    #[cfg(test)]
    options: TestOptions,
    #[cfg(test)]
    reserved: Vec<OwnedHandle>,
}

impl Controller {
    fn new(
        mut launch: EncodedLaunch,
        control: Arc<Control>,
        options: TestOptions,
    ) -> Result<(Self, File, File), ToolSpawnFailure> {
        control.lock().event_budget = launch.event_budget;
        #[cfg(test)]
        if options.prime_event_capacity {
            control.lock().observed_events = launch.event_budget.limit();
        }
        #[cfg(not(test))]
        let _ = options;
        let job = owned(unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) })
            .map_err(ToolSpawnFailure::io_before_spawn)?;
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if let Some(memory_bytes) = launch.decoder_memory_bytes {
            limits.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_JOB_MEMORY;
            limits.JobMemoryLimit = memory_bytes;
        }
        if unsafe {
            SetInformationJobObject(
                job.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&raw const limits).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        } == 0
        {
            return Err(ToolSpawnFailure::io_before_spawn(io::Error::last_os_error()));
        }
        let (stdout, stdout_writer) = pipe().map_err(ToolSpawnFailure::io_before_spawn)?;
        let (stderr, stderr_writer) = pipe().map_err(ToolSpawnFailure::io_before_spawn)?;
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: std::ptr::null_mut(),
            bInheritHandle: 1,
        };
        let null = wide(OsStr::new("NUL")).map_err(ToolSpawnFailure::before_spawn)?;
        let stdin = owned(unsafe {
            CreateFileW(
                null.as_ptr(),
                FILE_GENERIC_READ,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                &attributes,
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                std::ptr::null_mut(),
            )
        })
        .map_err(ToolSpawnFailure::io_before_spawn)?;
        let mut handles = [
            stdin.as_raw_handle(),
            stdout_writer.as_raw_handle(),
            stderr_writer.as_raw_handle(),
        ];
        let mut attributes =
            Attributes::new(&mut handles).map_err(ToolSpawnFailure::io_before_spawn)?;
        let mut startup = STARTUPINFOEXW::default();
        startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = handles[0];
        startup.StartupInfo.hStdOutput = handles[1];
        startup.StartupInfo.hStdError = handles[2];
        startup.lpAttributeList = attributes.words.as_mut_ptr().cast();
        let mut info = PROCESS_INFORMATION::default();
        if unsafe {
            CreateProcessW(
                launch.application.as_ptr(),
                launch.command.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
                CREATE_SUSPENDED
                    | DEBUG_PROCESS
                    | CREATE_UNICODE_ENVIRONMENT
                    | EXTENDED_STARTUPINFO_PRESENT,
                launch.environment.as_ptr().cast(),
                launch
                    .directory
                    .as_ref()
                    .map_or(std::ptr::null(), |value| value.as_ptr()),
                &startup.StartupInfo,
                &mut info,
            )
        } == 0
        {
            return Err(ToolSpawnFailure::io_before_spawn(io::Error::last_os_error()));
        }
        // PROCESS_INFORMATION handles are ours, independently of OS-owned debug
        // event handles. Use the exact primary handle, never a thread snapshot.
        let mut root_guard = SuspendedRootGuard {
            handle: owned(info.hProcess).expect("successful creation provides a process handle"),
            contained: false,
        };
        let primary_thread =
            owned(info.hThread).expect("successful creation provides a primary thread handle");
        let root_handle =
            duplicate(root_guard.handle.as_raw_handle()).map_err(|error| ToolSpawnFailure {
                error: PortcoveError::state(format!(
                    "could not retain the created native root: {error}"
                )),
                quiesced: false,
                io_kind: None,
            })?;
        let mut controller = Self {
            job,
            root: None,
            primary_thread: Some(primary_thread),
            members: BTreeMap::new(),
            live_debug_members: BTreeMap::new(),
            control,
            job_assigned: false,
            terminating: false,
            #[cfg(test)]
            options,
            #[cfg(test)]
            reserved: Vec::new(),
        };
        #[cfg(test)]
        if let Some(observation) = &controller.options.root_observation {
            // Independently retain the real suspended root for fixture closure.
            // This handle and metadata never repair Core's injected failure.
            *observation.member.lock().unwrap() = Some((
                identity(root_handle.as_raw_handle()).expect("fixture root identity"),
                duplicate(root_handle.as_raw_handle()).expect("fixture root handle"),
            ));
        }
        let identity_handle = root_handle.as_raw_handle();
        #[cfg(test)]
        let identity_handle = if controller.options.root_failure == Some(RootFailure::Identity) {
            std::ptr::null_mut()
        } else {
            identity_handle
        };
        let root_identity = identity(identity_handle);
        if let Ok(root) = root_identity {
            controller.root = Some(root);
            controller.members.insert(
                root,
                Member {
                    #[cfg(test)]
                    image: test_process_image(root_handle.as_raw_handle()),
                    handle: root_handle,
                    initial_thread: Some(info.dwThreadId),
                    creation_seen: false,
                    startup_handled: false,
                    system_module: None,
                },
            );
        } else {
            // Retain the directly owned root even if metadata cannot be read.
            let root = Identity {
                pid: info.dwProcessId,
                created: 0,
            };
            controller.root = Some(root);
            controller.members.insert(
                root,
                Member {
                    #[cfg(test)]
                    image: test_process_image(root_handle.as_raw_handle()),
                    handle: root_handle,
                    initial_thread: Some(info.dwThreadId),
                    creation_seen: false,
                    startup_handled: false,
                    system_module: None,
                },
            );
            controller.fail("root_identity", Some(unsafe { GetLastError() }));
        }
        let root = controller.root.expect("owned root retained");
        #[cfg(test)]
        if controller.options.root_failure == Some(RootFailure::PanicBeforeAssignment) {
            controller.publish_counts();
            panic!("owned fixture panic before root Job assignment");
        }
        let assignment_job = controller.job.as_raw_handle();
        #[cfg(test)]
        let assignment_job = if controller.options.root_failure == Some(RootFailure::Assignment) {
            std::ptr::null_mut()
        } else {
            assignment_job
        };
        if unsafe {
            AssignProcessToJobObject(
                assignment_job,
                controller.members[&root].handle.as_raw_handle(),
            )
        } == 0
        {
            controller.fail("job_assignment", Some(unsafe { GetLastError() }));
        } else {
            controller.job_assigned = true;
            root_guard.contained = true;
        }
        #[cfg(test)]
        if controller.options.root_failure == Some(RootFailure::PanicAfterAssignment) {
            controller.publish_counts();
            panic!("owned fixture panic after root Job assignment, before resume");
        }
        #[cfg(test)]
        for _ in 0..controller.options.reserved_slots {
            match duplicate(controller.members[&root].handle.as_raw_handle()) {
                Ok(handle) => controller.reserved.push(handle),
                Err(error) => controller.fail(
                    "capacity_fixture_capture",
                    error.raw_os_error().map(|code| code as u32),
                ),
            }
        }
        if controller.control.stop.load(Ordering::Acquire) {
            controller.fail("creation_cancelled", None);
        }
        if controller.control.lock().first_failure.is_none() {
            let resume_thread = controller.primary_thread.as_ref().unwrap().as_raw_handle();
            #[cfg(test)]
            let resume_thread = if controller.options.root_failure == Some(RootFailure::Resume) {
                std::ptr::null_mut()
            } else {
                resume_thread
            };
            let previous = unsafe { ResumeThread(resume_thread) };
            if previous != 1 {
                controller.fail(
                    "owned_primary_resume",
                    (previous == u32::MAX).then(|| unsafe { GetLastError() }),
                );
            }
        }
        drop(stdout_writer);
        drop(stderr_writer);
        drop(stdin);
        drop(attributes);
        controller.publish_counts();
        if controller.control.lock().first_failure.is_some() {
            controller.run();
            let group = ToolProcessGroup {
                control: controller.control.clone(),
                worker: None,
            };
            return Err(ToolSpawnFailure {
                error: group.with_proof_details(PortcoveError::state(
                    "native tool could not establish suspended creation custody",
                )),
                quiesced: false,
                io_kind: None,
            });
        }
        Ok((controller, stdout, stderr))
    }

    fn fail(&self, reason: &'static str, code: Option<u32>) {
        self.control
            .lock()
            .first_failure
            .get_or_insert((reason, code));
        self.control.request_stop();
    }

    fn slots(&self) -> usize {
        let count = self.members.len();
        #[cfg(test)]
        let count = count + self.reserved.len();
        count
    }

    fn publish_counts(&self) {
        let mut proof = self.control.lock();
        proof.publish_members(self.slots(), self.members.keys().copied());
        #[cfg(test)]
        {
            proof.images = self
                .members
                .iter()
                .filter_map(|(identity, member)| {
                    member
                        .image
                        .as_ref()
                        .map(|image| (*identity, image.clone()))
                })
                .collect();
        }
    }

    fn retain(
        &mut self,
        raw: HANDLE,
        pid: u32,
        initial_thread: Option<u32>,
    ) -> io::Result<Identity> {
        let key = identity(raw)?;
        if key.pid != pid {
            return Err(io::Error::other(
                "creation PID differs from retained identity",
            ));
        }
        if self
            .root
            .is_some_and(|root| root.created != 0 && key.created < root.created)
        {
            return Err(io::Error::other("native member predates the owned root"));
        }
        let mut in_job = 0;
        if unsafe { IsProcessInJob(raw, self.job.as_raw_handle(), &mut in_job) } == 0 || in_job == 0
        {
            return Err(io::Error::other("creation is outside the owned job"));
        }
        #[cfg(test)]
        if self.options.fail_capture && initial_thread.is_some() && Some(key) != self.root {
            if let Some(observation) = &self.options.refused_member {
                *observation.member.lock().unwrap() = Some((key, duplicate(raw)?));
            }
            self.fail("creation_capture", None);
            return Err(io::Error::other("injected creation capture refusal"));
        }
        if let Some(member) = self.members.get_mut(&key) {
            if initial_thread.is_some() {
                if member.creation_seen {
                    return Err(io::Error::other("duplicate process creation event"));
                }
                if member.initial_thread.is_some() && member.initial_thread != initial_thread {
                    return Err(io::Error::other(
                        "creation event differs from the owned primary thread",
                    ));
                }
                member.creation_seen = true;
                member.initial_thread = initial_thread;
            }
            return Ok(key);
        }
        if self.slots() >= MEMBER_LIMIT {
            self.fail("retained_handle_capacity", None);
            #[cfg(test)]
            if let Some(observation) = &self.options.refused_member {
                // Validated actual lifetime handle, from either CREATE or the
                // supplemental Job snapshot. Never repair Core's missing slot.
                *observation.member.lock().unwrap() = Some((key, duplicate(raw)?));
            }
            return Err(io::Error::other("native lifetime capacity exhausted"));
        }
        let handle = duplicate(raw)?;
        self.members.insert(
            key,
            Member {
                #[cfg(test)]
                image: test_process_image(handle.as_raw_handle()),
                handle,
                initial_thread,
                creation_seen: initial_thread.is_some(),
                startup_handled: false,
                system_module: None,
            },
        );
        self.publish_counts();
        Ok(key)
    }

    fn observe_non_debug_members(&mut self) {
        // Descendants that themselves become debuggers do not inherit our debug
        // port. Retain any observed exact Job identity in the SAME store. Missing
        // short lifetimes still fail the terminal total=retained equality.
        let ids = match membership_snapshot(self.job.as_raw_handle()) {
            Ok(ids) => ids,
            Err((reason, code)) => {
                self.fail(reason, code);
                return;
            }
        };
        for pid in ids {
            // A retained live handle, rather than numeric PID, establishes reuse safety.
            if self.members.iter().any(|(key, member)| {
                key.pid == pid
                    && unsafe { WaitForSingleObject(member.handle.as_raw_handle(), 0) }
                        != WAIT_OBJECT_0
            }) {
                continue;
            }
            let raw = unsafe {
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                    0,
                    pid,
                )
            };
            let Ok(handle) = owned(raw) else {
                // Snapshot races are not repaired by absence. Accounting will
                // refuse any missing lifetime; direct creation events capture it.
                continue;
            };
            if let Err(error) = self.retain(handle.as_raw_handle(), pid, None) {
                self.fail(
                    "member_capture",
                    error.raw_os_error().map(|code| code as u32),
                );
                return;
            }
        }
    }

    fn event(&mut self, event: &DEBUG_EVENT) -> i32 {
        let within_budget = self.control.lock().record_event();
        if !within_budget {
            self.fail("event_capacity", None);
        }
        // SAFETY: the event code selects the initialized union member. Debug
        // hProcess/hThread are OS-owned and auto-close after EXIT continuation;
        // image hFile handles belong to the debugger and close here exactly once.
        unsafe {
            match event.dwDebugEventCode {
                CREATE_PROCESS_DEBUG_EVENT => {
                    let info = event.u.CreateProcessInfo;
                    let image = owned(info.hFile).ok();
                    match self.retain(info.hProcess, event.dwProcessId, Some(event.dwThreadId)) {
                        Ok(key) => {
                            self.live_debug_members.insert(event.dwProcessId, key);
                            let (mut machine, mut native) = (0, 0);
                            if IsWow64Process2(info.hProcess, &mut machine, &mut native) == 0
                                || machine != IMAGE_FILE_MACHINE_UNKNOWN
                                || native != IMAGE_FILE_MACHINE_AMD64
                            {
                                self.fail("startup_architecture_unqualified", None);
                            }
                        }
                        Err(error) => self.fail(
                            "creation_capture",
                            error.raw_os_error().map(|code| code as u32),
                        ),
                    }
                    drop(image);
                }
                LOAD_DLL_DEBUG_EVENT => {
                    let info = event.u.LoadDll;
                    if let Ok(file) = owned(info.hFile)
                        && let Some(key) = self.live_debug_members.get(&event.dwProcessId).copied()
                    {
                        if self.members[&key].startup_handled
                            || self.members[&key].system_module.is_some()
                        {
                            return DBG_CONTINUE;
                        }
                        match system_module(File::from(file), info.lpBaseOfDll as usize) {
                            Ok(Some(range)) => {
                                self.members.get_mut(&key).unwrap().system_module = Some(range)
                            }
                            Ok(None) => {}
                            Err(error) => self.fail(
                                "startup_module_identity",
                                error.raw_os_error().map(|code| code as u32),
                            ),
                        }
                    }
                }
                EXCEPTION_DEBUG_EVENT => {
                    let exception = event.u.Exception;
                    if let Some(key) = self.live_debug_members.get(&event.dwProcessId).copied() {
                        let member = self.members.get_mut(&key).unwrap();
                        match member.classify_exception(
                            event.dwThreadId,
                            exception.ExceptionRecord.ExceptionCode,
                            exception.dwFirstChance,
                            exception.ExceptionRecord.ExceptionAddress as usize,
                        ) {
                            // The one-shot is limited to the positively identified
                            // initial thread and architecture-bound system image.
                            ExceptionDisposition::Startup => return DBG_CONTINUE,
                            ExceptionDisposition::Unclassified => {
                                self.fail("startup_exception_unclassified", None);
                            }
                            ExceptionDisposition::Application => {}
                        }
                    } else {
                        self.fail("exception_identity", None);
                    }
                    return DBG_EXCEPTION_NOT_HANDLED;
                }
                EXIT_PROCESS_DEBUG_EVENT => {
                    if let Some(key) = self.live_debug_members.remove(&event.dwProcessId) {
                        if Some(key) == self.root {
                            self.control.request_stop();
                        }
                    } else {
                        self.fail("exit_identity", None);
                    }
                }
                CREATE_THREAD_DEBUG_EVENT
                | EXIT_THREAD_DEBUG_EVENT
                | UNLOAD_DLL_DEBUG_EVENT
                | OUTPUT_DEBUG_STRING_EVENT => {}
                RIP_EVENT => self.fail("debug_rip", None),
                _ => self.fail("unexpected_debug_event", None),
            }
        }
        DBG_CONTINUE
    }

    fn terminate_if_requested(&mut self) {
        if self.control.stop.load(Ordering::Acquire) && !self.terminating {
            self.terminating = true;
            if self.job_assigned {
                if unsafe { TerminateJobObject(self.job.as_raw_handle(), 1) } == 0 {
                    self.fail("job_termination", Some(unsafe { GetLastError() }));
                }
            } else if let Some(root) = self.root
                && unsafe { TerminateProcess(self.members[&root].handle.as_raw_handle(), 1) } == 0
            {
                self.fail("root_termination", Some(unsafe { GetLastError() }));
            }
        }
    }

    fn run(&mut self) {
        loop {
            self.terminate_if_requested();
            let mut event = DEBUG_EVENT::default();
            #[cfg(test)]
            let mut defer_root_sample = false;
            if unsafe { WaitForDebugEventEx(&mut event, 1) } != 0 {
                let continuation = self.event(&event);
                #[cfg(test)]
                self.panic_after_owned_creation(&event);
                #[cfg(test)]
                self.observe_pending_creation(&event);
                #[cfg(test)]
                self.observe_exception(&event, continuation);
                #[cfg(test)]
                if event.dwDebugEventCode == EXIT_PROCESS_DEBUG_EVENT
                    && self.root.is_some_and(|root| root.pid == event.dwProcessId)
                    && let Some(observation) = &self.options.late_root_exit
                {
                    let root = self.root.expect("root exit has retained identity");
                    let handle = self.members[&root].handle.as_raw_handle();
                    let early = unsafe { WaitForSingleObject(handle, 0) };
                    assert_eq!(
                        early, WAIT_TIMEOUT,
                        "root signaled before exit continuation"
                    );
                    *observation.lock().unwrap() = Some((early, WAIT_TIMEOUT, root));
                    defer_root_sample = true;
                }
                self.terminate_if_requested();
                if unsafe { ContinueDebugEvent(event.dwProcessId, event.dwThreadId, continuation) }
                    == 0
                {
                    self.fail("event_continuation", Some(unsafe { GetLastError() }));
                }
                #[cfg(test)]
                if defer_root_sample {
                    let root = self.root.expect("root exit has retained identity");
                    let handle = self.members[&root].handle.as_raw_handle();
                    let late = unsafe { WaitForSingleObject(handle, 1000) };
                    if let Some(observation) = &self.options.late_root_exit {
                        observation.lock().unwrap().as_mut().unwrap().1 = late;
                    }
                    assert_eq!(
                        late, WAIT_OBJECT_0,
                        "root did not signal after exit continuation"
                    );
                }
            } else {
                let error = unsafe { GetLastError() };
                let root_creation_seen = self
                    .root
                    .is_some_and(|root| self.members[&root].creation_seen);
                let no_debuggees = self.live_debug_members.is_empty()
                    && root_creation_seen
                    && matches!(error, ERROR_INVALID_HANDLE | ERROR_INVALID_PARAMETER);
                if error != ERROR_SEM_TIMEOUT && !no_debuggees {
                    self.fail("debug_wait", Some(error));
                }
            }
            if self.job_assigned {
                self.observe_non_debug_members();
            }
            #[cfg(test)]
            if !defer_root_sample {
                self.observe_root_exit();
            }
            #[cfg(not(test))]
            self.observe_root_exit();
            let Some(deadline) = self.control.lock().deadline else {
                continue;
            };
            let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
            if unsafe {
                QueryInformationJobObject(
                    self.job.as_raw_handle(),
                    JobObjectBasicAccountingInformation,
                    (&raw mut accounting).cast(),
                    std::mem::size_of_val(&accounting) as u32,
                    std::ptr::null_mut(),
                )
            } == 0
            {
                self.fail("accounting_query", Some(unsafe { GetLastError() }));
            } else {
                self.control.lock().accounting =
                    Some((accounting.ActiveProcesses, accounting.TotalProcesses));
            }
            let mut all_signaled = true;
            for member in self.members.values() {
                let waited = unsafe { WaitForSingleObject(member.handle.as_raw_handle(), 0) };
                if waited != WAIT_OBJECT_0 {
                    all_signaled = false;
                    self.control.lock().wait_result = Some(waited);
                    if waited == WAIT_FAILED {
                        self.fail("member_wait", Some(unsafe { GetLastError() }));
                    }
                }
            }
            self.control.lock().all_retained_signaled = Some(all_signaled);
            if Instant::now() >= deadline {
                self.fail("closure_deadline", None);
                let mut proof = self.control.lock();
                proof.deadline_exhausted = true;
                proof.done = true;
                proof.quiesced = false;
                self.control.changed.notify_all();
                return;
            }
            if all_signaled
                && self.live_debug_members.is_empty()
                && self
                    .control
                    .lock()
                    .accounting
                    .is_some_and(|(active, _)| active == 0)
            {
                // The root may have signaled after the earlier root sample but
                // before this retained-member sample. Publish only after the
                // exact retained root handle supplies its real exit code.
                if self.control.lock().root_status.is_none() {
                    self.observe_root_exit();
                }
                let root_exited = self.control.lock().root_status.is_some();
                if !root_exited {
                    self.fail("root_exit_unobserved", None);
                }
                let complete = self
                    .control
                    .lock()
                    .accounting
                    .is_some_and(|(_, total)| total as usize == self.slots());
                if !complete {
                    self.fail("lifetime_count_gap", None);
                }
                let root_seen = self
                    .root
                    .is_some_and(|key| self.members[&key].creation_seen);
                if !root_seen {
                    self.fail("root_creation_event_missing", None);
                }
                let mut proof = self.control.lock();
                proof.finish(complete && root_seen && root_exited, Instant::now());
                self.control.changed.notify_all();
                return;
            }
        }
    }

    fn observe_root_exit(&mut self) {
        if let Some(root) = self.root {
            let handle = self.members[&root].handle.as_raw_handle();
            match positive_root_exit_status(handle) {
                Ok(Some(status)) => {
                    self.control.lock().root_status = Some(status);
                    self.control.request_stop();
                }
                Ok(None) => {}
                Err((reason, code)) => self.fail(reason, code),
            }
        }
    }

    #[cfg(test)]
    fn observe_exception(&mut self, event: &DEBUG_EVENT, continuation: i32) {
        if event.dwDebugEventCode != EXCEPTION_DEBUG_EVENT {
            return;
        }
        let Some(trace) = self.options.exception_trace.clone() else {
            return;
        };
        let mut trace = trace.lock().unwrap();
        if trace.len() >= 32 {
            self.fail("exception_trace_fixture_capacity", None);
            return;
        }
        // Read the actual initialized event union, after production classification.
        let exception = unsafe { event.u.Exception };
        trace.push(ExceptionObservation {
            pid: event.dwProcessId,
            code: exception.ExceptionRecord.ExceptionCode as u32,
            first_chance: exception.dwFirstChance,
            continuation,
        });
    }

    #[cfg(test)]
    fn observe_pending_creation(&mut self, event: &DEBUG_EVENT) {
        if event.dwDebugEventCode != CREATE_PROCESS_DEBUG_EVENT {
            return;
        }
        let Some(identity) = self.live_debug_members.get(&event.dwProcessId).copied() else {
            return;
        };
        if Some(identity) == self.root {
            return;
        }
        let Some(observation) = self.options.pending_creation.take() else {
            return;
        };
        // The real CREATE event has been captured and is still uncontinued.
        // This per-launch test rendezvous changes no proof or process authority.
        *observation.identity.lock().unwrap() = Some(identity);
        let deadline = Instant::now() + Duration::from_secs(1);
        while !self.control.stop.load(Ordering::Acquire) {
            if Instant::now() >= deadline {
                self.fail("pending_creation_fixture_deadline", None);
                return;
            }
            thread::sleep(Duration::from_millis(1));
        }
        observation
            .cancellation_observed
            .store(true, Ordering::Release);
    }

    #[cfg(test)]
    fn panic_after_owned_creation(&self, event: &DEBUG_EVENT) {
        let Some(observation) = &self.options.panic_tree else {
            return;
        };
        if event.dwDebugEventCode != CREATE_PROCESS_DEBUG_EVENT
            || self.root.is_none_or(|root| root.pid == event.dwProcessId)
            || self.control.lock().first_failure.is_some()
            || !self
                .members
                .iter()
                .any(|(key, member)| key.pid == event.dwProcessId && member.creation_seen)
        {
            return;
        }
        // Capture independent fixture handles after real Core CREATE capture,
        // before continuation. They never repair the controller's proof.
        let members = self
            .members
            .iter()
            .map(|(identity, member)| {
                (
                    *identity,
                    duplicate(member.handle.as_raw_handle()).expect("owned panic fixture handle"),
                )
            })
            .collect();
        *observation.captured.lock().unwrap() = Some(PanickedTree {
            root_pid: self.root.unwrap().pid,
            event_pid: event.dwProcessId,
            event_thread: event.dwThreadId,
            members,
        });
        panic!("owned fixture live controller panic before descendant CREATE continuation");
    }
}

// JOBOBJECT_BASIC_PROCESS_ID_LIST with fixed, bounded trailing storage.
#[repr(C)]
struct JobProcessIds {
    assigned: u32,
    returned: u32,
    ids: [usize; MEMBER_LIMIT],
}

impl JobProcessIds {
    fn observed_ids(&self) -> Result<Vec<u32>, (&'static str, Option<u32>)> {
        if self.assigned as usize > MEMBER_LIMIT || self.returned as usize > MEMBER_LIMIT {
            return Err(("membership_capacity", None));
        }
        if self.returned > self.assigned {
            return Err(("membership_counts", None));
        }
        // A successful query can return fewer PIDs while nested jobs change.
        // Windows guarantees these returned entries are valid observations;
        // they are not a complete lifetime inventory. Terminal Job accounting
        // must still equal the exact retained identities before closure succeeds.
        self.ids[..self.returned as usize]
            .iter()
            .map(|&pid| u32::try_from(pid).map_err(|_| ("member_id_range", None)))
            .collect()
    }
}

fn membership_snapshot(job: HANDLE) -> Result<Vec<u32>, (&'static str, Option<u32>)> {
    let mut buffer = JobProcessIds {
        assigned: 0,
        returned: 0,
        ids: [0; MEMBER_LIMIT],
    };
    if unsafe {
        QueryInformationJobObject(
            job,
            JobObjectBasicProcessIdList,
            (&raw mut buffer).cast(),
            std::mem::size_of_val(&buffer) as u32,
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(("membership_query", Some(unsafe { GetLastError() })));
    }
    buffer.observed_ids()
}

fn system_directory() -> io::Result<PathBuf> {
    let mut buffer = [0_u16; 32768];
    let count = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) } as usize;
    if count == 0 || count >= buffer.len() {
        return Err(io::Error::last_os_error());
    }
    use std::os::windows::ffi::OsStringExt;
    Ok(PathBuf::from(OsString::from_wide(&buffer[..count])))
}

fn system_module(mut file: File, base: usize) -> io::Result<Option<(usize, usize)>> {
    let mut path = [0_u16; 32768];
    let count = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            path.as_mut_ptr(),
            path.len() as u32,
            0,
        )
    } as usize;
    if count == 0 || count >= path.len() {
        return Err(io::Error::last_os_error());
    }
    use std::os::windows::ffi::OsStringExt;
    let actual = OsString::from_wide(&path[..count]);
    let expected = std::fs::canonicalize(system_directory()?.join("ntdll.dll"))?;
    if !crate::process::environment_names_equal(&actual, expected.as_os_str()) {
        return Ok(None);
    }
    // Bounded reads of the actual loaded system image, not local ASLR guesses,
    // remote application memory or undocumented loader-function offsets.
    let mut dos = [0_u8; 64];
    file.seek(SeekFrom::Start(0))?;
    file.read_exact(&mut dos)?;
    if &dos[..2] != b"MZ" {
        return Err(io::Error::other("system module DOS identity is invalid"));
    }
    let offset = u32::from_le_bytes(dos[60..64].try_into().unwrap());
    if offset > 65536 {
        return Err(io::Error::other(
            "system module PE header exceeds its bound",
        ));
    }
    file.seek(SeekFrom::Start(u64::from(offset)))?;
    let mut pe = [0_u8; 84];
    file.read_exact(&mut pe)?;
    if &pe[..4] != b"PE\0\0"
        || u16::from_le_bytes(pe[4..6].try_into().unwrap()) != IMAGE_FILE_MACHINE_AMD64
        || u16::from_le_bytes(pe[24..26].try_into().unwrap()) != 0x20b
    {
        return Err(io::Error::other(
            "system module architecture is unqualified",
        ));
    }
    let size = u32::from_le_bytes(pe[80..84].try_into().unwrap()) as usize;
    if base == 0 || !(4096..=128 * 1024 * 1024).contains(&size) || base.checked_add(size).is_none()
    {
        return Err(io::Error::other("system module image range is invalid"));
    }
    Ok(Some((base, size)))
}

#[cfg(test)]
mod native_control_tests {
    use super::*;
    use crate::{ChildProcessClass, ChildProcessPolicy};

    #[test]
    fn actual_event_exhaustion_stops_both_classes_without_cleanup_authority() {
        let native = tempfile::tempdir().unwrap();
        let program = crate::test_fixture::build_probe(native.path());
        for (class, limit) in [
            (ChildProcessClass::HostTool, 4096),
            (ChildProcessClass::ManagedBuilder, 32768),
        ] {
            let working = tempfile::tempdir().unwrap();
            let mut spec = ChildProcessPolicy::native_tool_spec(class, &program).unwrap();
            spec.arg("--success").current_dir(working.path());
            let (mut child, group) = spawn_with_options(
                &spec,
                TestOptions {
                    prime_event_capacity: true,
                    ..Default::default()
                },
            )
            .map_err(|failure| failure.error)
            .unwrap();
            // The fixture must not request stop: a real event triggers production
            // exhaustion, failure latching, stop and positive closure collection.
            let deadline = Instant::now() + Duration::from_secs(4);
            while !group.control.lock().done && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(1));
            }
            let stopped_without_fixture_request = group.control.lock().done;
            let status = group.terminate_and_wait(&mut child).unwrap();
            assert!(stopped_without_fixture_request);
            assert_eq!(status.code(), Some(1));
            assert!(!group.proves_tree_quiescence());
            let error = group.with_proof_details(PortcoveError::state("retained exhaustion"));
            let details = crate::tool_process::copy_proof_details(&error);
            assert_eq!(details["process_tree_first_failure"], "event_capacity");
            assert_eq!(details["process_tree_membership_complete"], "false");
            assert_eq!(details["process_tree_event_limit"], limit.to_string());
            assert!(
                details["process_tree_observed_events"]
                    .parse::<usize>()
                    .unwrap()
                    > limit
            );
            assert_eq!(details["process_tree_active"], "0");
            assert_eq!(details["process_tree_all_retained_signaled"], "true");
            assert_eq!(details["process_tree_deadline_exhausted"], "false");
        }
    }

    #[test]
    fn ordinary_and_managed_builder_tools_retain_complete_closure() {
        let native = tempfile::tempdir().unwrap();
        let program = crate::test_fixture::build_probe(native.path());
        for (class, limit) in [
            (ChildProcessClass::HostTool, 4096),
            (ChildProcessClass::ManagedBuilder, 32768),
        ] {
            let working = tempfile::tempdir().unwrap();
            let mut spec = ChildProcessPolicy::native_tool_spec(class, &program).unwrap();
            spec.arg("--success").current_dir(working.path());
            let (mut child, group) = spawn_with_options(&spec, TestOptions::default())
                .map_err(|failure| failure.error)
                .unwrap();
            let deadline = Instant::now() + Duration::from_secs(4);
            let status = loop {
                match child.try_wait() {
                    Ok(Some(status)) => break status,
                    Ok(None) if Instant::now() < deadline => {
                        thread::sleep(Duration::from_millis(1))
                    }
                    other => panic!("root exit was not positively captured: {other:?}"),
                }
            };
            assert!(status.success());
            assert!(group.proves_tree_quiescence());
            let proof = group.control.lock();
            assert_eq!(proof.event_budget.limit(), limit);
            assert!(proof.observed_events > 0 && proof.observed_events <= limit);
            assert!(proof.first_failure.is_none());
        }
    }

    #[test]
    fn root_signaling_between_samples_retains_positive_exit_proof() {
        let native = tempfile::tempdir().unwrap();
        let program = crate::test_fixture::build_probe(native.path());
        let working = tempfile::tempdir().unwrap();
        let mut spec =
            ChildProcessPolicy::native_tool_spec(ChildProcessClass::UpstreamSetup, &program)
                .unwrap();
        spec.arg("--success").current_dir(working.path());
        let observation = Arc::new(Mutex::new(None));
        let (mut child, group) = spawn_with_options(
            &spec,
            TestOptions {
                late_root_exit: Some(observation.clone()),
                ..Default::default()
            },
        )
        .map_err(|failure| failure.error)
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(4);
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(1)),
                other => panic!("root status was not positively captured: {other:?}"),
            }
        };
        assert!(status.success());
        assert_eq!(group.terminate_and_wait(&mut child).unwrap(), status);
        assert!(group.proves_tree_quiescence());
        let (early, late, root) = observation.lock().unwrap().expect("root exit seam ran");
        assert_eq!(early, WAIT_TIMEOUT);
        assert_eq!(late, WAIT_OBJECT_0);
        let proof = group.control.lock();
        assert_eq!(proof.identities, [root]);
        assert_eq!(proof.root_status, Some(status));
        assert_eq!(proof.accounting, Some((0, 1)));
        assert_eq!(proof.all_retained_signaled, Some(true));
        assert!(proof.first_failure.is_none() && !proof.deadline_exhausted);
    }

    #[test]
    #[ignore = "requires separately admitted prepared live event-pump panic packet"]
    fn live_controller_panic_keeps_captured_tree_cleanup_unknown() {
        let native = tempfile::tempdir().unwrap();
        let program = crate::test_fixture::build_probe(native.path());
        let working = tempfile::tempdir().unwrap();
        let output = working.path().join("orphan-output");
        let mut spec =
            ChildProcessPolicy::native_tool_spec(ChildProcessClass::UpstreamSetup, &program)
                .unwrap();
        spec.args([
            "--setup-tree",
            &output.display().to_string(),
            "observed-wait",
        ])
        .current_dir(working.path());
        let observation = Arc::new(PanicTreeObservation::default());
        let (mut child, group) = spawn_with_options(
            &spec,
            TestOptions {
                panic_tree: Some(observation.clone()),
                ..Default::default()
            },
        )
        .map_err(|failure| failure.error)
        .unwrap();
        // Do not request stop before the real event-pump panic has occurred.
        let deadline = Instant::now() + Duration::from_secs(4);
        while !group.control.lock().done && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(1));
        }
        let done = group.control.lock().done;
        if !done {
            let _ = group.terminate_and_wait(&mut child);
        }
        let proof = crate::tool_process::copy_proof_details(
            &group.with_proof_details(PortcoveError::state("live event-pump panic control")),
        );
        let quiesced = group.proves_tree_quiescence();
        let root_wait_error = child.try_wait().err().map(|error| error.to_string());
        let captured = observation.captured.lock().unwrap().take();
        // One shared two-second fixture observation deadline across all handles.
        let closure_deadline = Instant::now() + CLOSURE_BOUND;
        let actual = captured.as_ref().map(|tree| {
            let members: Vec<_> = tree.members.iter().map(|(identity, handle)| {
                let remaining = closure_deadline.saturating_duration_since(Instant::now());
                let waited = unsafe { WaitForSingleObject(handle.as_raw_handle(),
                    remaining.as_millis().min(2000) as u32) };
                let mut code = 0;
                let queried = unsafe { GetExitCodeProcess(handle.as_raw_handle(), &mut code) };
                serde_json::json!({"pid":identity.pid,"created_filetime":identity.created.to_string(),
                    "wait_result":waited,"exit_query":queried,"exit_code":code})
            }).collect();
            serde_json::json!({"root_pid":tree.root_pid,"event_pid":tree.event_pid,"event_thread":tree.event_thread,
                "members":members})
        });
        let closure_timely = Instant::now() < closure_deadline;
        eprintln!(
            "native_live_panic_proof:{}",
            serde_json::json!({
                "done":done,"quiesced":quiesced,"proof":proof,"observed_tree":actual,
                "fixture_closure_timely":closure_timely,
                "root_wait_error":root_wait_error,"orphan_output":output.exists(),
            })
        );
        assert!(done && captured.is_some());
        assert!(
            closure_timely,
            "positive fixture closure must fit the shared deadline"
        );
        assert!(!quiesced);
        assert!(
            root_wait_error.is_some(),
            "Core cannot invent a positive root exit after panic"
        );
        assert_eq!(proof["process_tree_first_failure"], "controller_panic");
        assert_eq!(proof["process_tree_membership_complete"], "false");
        assert_eq!(proof["process_tree_retained_members"], "2");
        let tree = captured.as_ref().unwrap();
        assert_eq!(tree.members.len(), 2);
        assert_ne!(tree.root_pid, tree.event_pid);
        assert!(
            tree.members
                .iter()
                .any(|(identity, _)| identity.pid == tree.root_pid)
        );
        assert!(
            tree.members
                .iter()
                .any(|(identity, _)| identity.pid == tree.event_pid)
        );
        for member in actual.as_ref().unwrap()["members"].as_array().unwrap() {
            assert_eq!(member["wait_result"], WAIT_OBJECT_0);
            assert_ne!(member["exit_query"], 0);
        }
        for absent in [
            "process_tree_active",
            "process_tree_total",
            "process_tree_root_exit",
            "process_tree_all_retained_signaled",
        ] {
            assert!(
                !proof.contains_key(absent),
                "panic cannot fabricate {absent}"
            );
        }
        assert!(!output.exists());
    }

    #[test]
    #[ignore = "requires separately admitted prepared controller-panic packet"]
    fn controller_panics_preserve_failure_without_fabricating_cleanup() {
        let native = tempfile::tempdir().unwrap();
        let program = crate::test_fixture::build_probe(native.path());
        for fault in [
            RootFailure::PanicBeforeAssignment,
            RootFailure::PanicAfterAssignment,
        ] {
            let working = tempfile::tempdir().unwrap();
            let output = working.path().join("orphan-output");
            let mut spec =
                ChildProcessPolicy::native_tool_spec(ChildProcessClass::UpstreamSetup, &program)
                    .unwrap();
            spec.args([
                "--setup-tree",
                &output.display().to_string(),
                "observed-wait",
            ])
            .current_dir(working.path());
            let observed = Arc::new(RefusedMember::default());
            let failure = match spawn_with_options(
                &spec,
                TestOptions {
                    root_failure: Some(fault),
                    root_observation: Some(observed.clone()),
                    ..Default::default()
                },
            ) {
                Err(failure) => failure,
                Ok((mut child, group)) => {
                    let _ = group.terminate_and_wait(&mut child);
                    panic!("injected controller panic unexpectedly launched");
                }
            };
            let proof = crate::tool_process::copy_proof_details(&failure.error);
            let actual = observed.member.lock().unwrap().take();
            let observation = actual.as_ref().map(|(identity, handle)| {
                // Positive closure of this independent fixture handle only.
                // Core lost its controller and must retain incomplete proof.
                let waited = unsafe { WaitForSingleObject(handle.as_raw_handle(), 2000) };
                let mut exit_code = 0;
                let queried = unsafe { GetExitCodeProcess(handle.as_raw_handle(), &mut exit_code) };
                serde_json::json!({"pid":identity.pid,
                    "created_filetime":identity.created.to_string(),"wait_result":waited,
                    "exit_query":queried,"exit_code":exit_code})
            });
            eprintln!(
                "native_controller_panic_proof:{}",
                serde_json::json!({
                    "fault":format!("{fault:?}"),"quiesced":failure.quiesced,
                    "proof":proof,"observed_root":observation,"orphan_output":output.exists(),
                })
            );
            assert!(actual.is_some());
            let observation = observation.as_ref().unwrap();
            assert_eq!(observation["wait_result"], WAIT_OBJECT_0);
            assert_ne!(observation["exit_query"], 0);
            assert!(!failure.quiesced);
            assert_eq!(proof["process_tree_first_failure"], "controller_panic");
            assert_eq!(proof["process_tree_membership_complete"], "false");
            assert_eq!(proof["process_tree_retained_members"], "1");
            for absent in [
                "process_tree_active",
                "process_tree_total",
                "process_tree_root_exit",
                "process_tree_all_retained_signaled",
            ] {
                assert!(
                    !proof.contains_key(absent),
                    "panic cannot fabricate {absent}"
                );
            }
            assert!(!output.exists());
        }
    }

    #[test]
    #[ignore = "requires separately admitted prepared root-failure packet"]
    fn suspended_root_api_refusals_preserve_failed_custody() {
        let native = tempfile::tempdir().unwrap();
        let program = crate::test_fixture::build_probe(native.path());
        for (fault, reason) in [
            (RootFailure::Identity, "root_identity"),
            (RootFailure::Assignment, "job_assignment"),
            (RootFailure::Resume, "owned_primary_resume"),
        ] {
            let working = tempfile::tempdir().unwrap();
            let output = working.path().join("orphan-output");
            let mut spec =
                ChildProcessPolicy::native_tool_spec(ChildProcessClass::UpstreamSetup, &program)
                    .unwrap();
            spec.args([
                "--setup-tree",
                &output.display().to_string(),
                "observed-wait",
            ])
            .current_dir(working.path());
            let observed = Arc::new(RefusedMember::default());
            let failure = match spawn_with_options(
                &spec,
                TestOptions {
                    root_failure: Some(fault),
                    root_observation: Some(observed.clone()),
                    ..Default::default()
                },
            ) {
                Err(failure) => failure,
                Ok((mut child, group)) => {
                    let _ = group.terminate_and_wait(&mut child);
                    panic!("injected root API refusal unexpectedly launched");
                }
            };
            let proof = crate::tool_process::copy_proof_details(&failure.error);
            let actual = observed.member.lock().unwrap().take();
            let observation = actual.as_ref().map(|(identity, handle)| {
                serde_json::json!({
                    "pid":identity.pid, "created_filetime":identity.created.to_string(),
                    "wait_result":unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) },
                })
            });
            eprintln!(
                "native_root_refusal_proof:{}",
                serde_json::json!({
                    "fault":format!("{fault:?}"), "quiesced":failure.quiesced,
                    "proof":proof, "observed_root":observation, "orphan_output":output.exists(),
                    "injection":"one actual Win32 call with a null handle; real root remains suspended",
                })
            );
            assert!(actual.is_some());
            assert_eq!(observation.as_ref().unwrap()["wait_result"], WAIT_OBJECT_0);
            assert!(!failure.quiesced);
            assert_eq!(proof["process_tree_first_failure"], reason);
            assert_eq!(proof["process_tree_all_retained_signaled"], "true");
            assert_eq!(proof["process_tree_deadline_exhausted"], "false");
            let identities: Vec<serde_json::Value> =
                serde_json::from_str(&proof["process_tree_identities"]).unwrap();
            let (actual_identity, _) = actual.as_ref().unwrap();
            assert!(
                identities
                    .iter()
                    .all(|identity| identity["pid"] == actual_identity.pid)
            );
            let retained: usize = proof["process_tree_retained_members"].parse().unwrap();
            assert_eq!(retained, identities.len());
            if fault == RootFailure::Identity {
                // Failed root metadata remains zero. A real CREATE event may
                // retain a second handle with the actual FILETIME; neither the
                // zero entry nor these two handles establishes two lifetimes.
                assert!((1..=2).contains(&retained));
                assert_eq!(
                    identities
                        .iter()
                        .filter(|identity| identity["created_filetime"] == "0")
                        .count(),
                    1
                );
                let expected_created = actual_identity.created.to_string();
                assert!(
                    identities
                        .iter()
                        .all(|identity| identity["created_filetime"] == "0"
                            || identity["created_filetime"] == expected_created.as_str())
                );
            } else {
                assert_eq!(retained, 1);
                assert_eq!(
                    identities[0]["created_filetime"],
                    actual_identity.created.to_string()
                );
            }
            assert!(
                !output.exists(),
                "suspended root must not execute user code"
            );
        }
    }

    #[test]
    #[ignore = "requires separately admitted prepared first-party DLL packet"]
    fn dll_initialization_exceptions_reach_the_phase_bound_application_handler() {
        let native = tempfile::tempdir().unwrap();
        let program = crate::test_fixture::build_probe(native.path());
        let working = tempfile::tempdir().unwrap();
        let mut spec =
            ChildProcessPolicy::native_tool_spec(ChildProcessClass::UpstreamSetup, &program)
                .unwrap();
        let dll = std::path::PathBuf::from(
            std::env::var_os("PORTCOVE_HOST_TOOL_DLL_FIXTURE")
                .expect("prepared owned DLL required"),
        );
        assert!(dll.is_absolute() && dll.is_file());
        spec.arg("--owned-dll-exceptions")
            .arg(&dll)
            .current_dir(working.path());
        let trace = Arc::new(Mutex::new(Vec::new()));
        let (mut child, group) = spawn_with_options(
            &spec,
            TestOptions {
                exception_trace: Some(trace.clone()),
                ..Default::default()
            },
        )
        .map_err(|failure| failure.error)
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(4);
        let observed = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Ok(status),
                Err(error) => break Err(error.to_string()),
                Ok(None) if Instant::now() >= deadline => {
                    break Err("DLL exception control deadline".into());
                }
                Ok(None) => thread::sleep(Duration::from_millis(1)),
            }
        };
        let stopped = group.terminate_and_wait(&mut child);
        let quiesced = group.proves_tree_quiescence();
        let proof = crate::tool_process::copy_proof_details(
            &group.with_proof_details(PortcoveError::state("DLL exception control")),
        );
        let events = trace.lock().unwrap().clone();
        let marker = working.path().join("dll-exceptions-handled").is_file();
        eprintln!(
            "native_dll_exception_proof:{}",
            serde_json::json!({
                "quiesced":quiesced,"proof":proof,"dll_completion_marker":marker,
                "observation_error":observed.as_ref().err(),
                "termination_error":stopped.as_ref().err().map(ToString::to_string),
                "events":events.iter().map(|event|serde_json::json!({
                    "pid":event.pid,"code":event.code,"first_chance":event.first_chance,
                    "continuation":event.continuation,
                })).collect::<Vec<_>>(),
            })
        );
        assert!(observed.is_ok());
        assert!(quiesced);
        assert_eq!(stopped.unwrap().code(), Some(0));
        assert!(marker);
        assert_eq!(proof["process_tree_total"], "1");
        assert_eq!(proof["process_tree_retained_members"], "1");
        assert_eq!(proof["process_tree_all_retained_signaled"], "true");
        assert_eq!(proof["process_tree_active"], "0");
        assert!(!proof.contains_key("process_tree_first_failure"));
        assert_eq!(
            events
                .iter()
                .filter(|event| event.continuation == DBG_CONTINUE)
                .count(),
            1
        );
        let forwarded = events
            .iter()
            .filter(|event| event.continuation == DBG_EXCEPTION_NOT_HANDLED)
            .map(|event| (event.code, event.first_chance))
            .collect::<Vec<_>>();
        assert_eq!(forwarded, [(0xe042_6666, 1), (0x8000_0003, 1)]);
    }

    #[test]
    fn tls_initialization_exceptions_reach_the_phase_bound_application_handler() {
        let native = tempfile::tempdir().unwrap();
        let program = crate::test_fixture::build_probe(native.path());
        let working = tempfile::tempdir().unwrap();
        let mut spec =
            ChildProcessPolicy::native_tool_spec(ChildProcessClass::UpstreamSetup, &program)
                .unwrap();
        spec.arg("--owned-tls-exceptions")
            .current_dir(working.path());
        let trace = Arc::new(Mutex::new(Vec::new()));
        let (mut child, group) = spawn_with_options(
            &spec,
            TestOptions {
                exception_trace: Some(trace.clone()),
                ..Default::default()
            },
        )
        .map_err(|failure| failure.error)
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(4);
        let observed = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Ok(status),
                Err(error) => break Err(error.to_string()),
                Ok(None) if Instant::now() >= deadline => {
                    break Err("TLS exception control deadline".into());
                }
                Ok(None) => thread::sleep(Duration::from_millis(1)),
            }
        };
        let stopped = group.terminate_and_wait(&mut child);
        let quiesced = group.proves_tree_quiescence();
        let proof = crate::tool_process::copy_proof_details(
            &group.with_proof_details(PortcoveError::state("TLS exception control")),
        );
        let events = trace.lock().unwrap().clone();
        let marker = working.path().join("tls-exceptions-handled").is_file();
        eprintln!(
            "native_tls_exception_proof:{}",
            serde_json::json!({
                "quiesced":quiesced,"proof":proof,"tls_completion_marker":marker,
                "observation_error":observed.as_ref().err(),
                "termination_error":stopped.as_ref().err().map(ToString::to_string),
                "events":events.iter().map(|event|serde_json::json!({
                    "pid":event.pid,"code":event.code,"first_chance":event.first_chance,
                    "continuation":event.continuation,
                })).collect::<Vec<_>>(),
            })
        );
        assert!(observed.is_ok());
        assert!(quiesced);
        assert_eq!(stopped.unwrap().code(), Some(0));
        assert!(marker);
        assert_eq!(proof["process_tree_total"], "1");
        assert_eq!(proof["process_tree_retained_members"], "1");
        assert_eq!(proof["process_tree_all_retained_signaled"], "true");
        assert_eq!(proof["process_tree_active"], "0");
        assert!(!proof.contains_key("process_tree_first_failure"));
        assert_eq!(
            events
                .iter()
                .filter(|event| event.continuation == DBG_CONTINUE)
                .count(),
            1
        );
        let forwarded = events
            .iter()
            .filter(|event| event.continuation == DBG_EXCEPTION_NOT_HANDLED)
            .map(|event| (event.code, event.first_chance))
            .collect::<Vec<_>>();
        assert_eq!(forwarded, [(0xe042_5555, 1), (0x8000_0003, 1)]);
    }

    #[test]
    fn application_handlers_and_second_chance_failure_receive_forwarded_exceptions() {
        let native = tempfile::tempdir().unwrap();
        let program = crate::test_fixture::build_probe(native.path());
        for mode in ["handled", "unhandled"] {
            let working = tempfile::tempdir().unwrap();
            let mut spec =
                ChildProcessPolicy::native_tool_spec(ChildProcessClass::UpstreamSetup, &program)
                    .unwrap();
            spec.args(["--owned-exceptions", mode])
                .current_dir(working.path());
            let trace = Arc::new(Mutex::new(Vec::new()));
            let (mut child, group) = spawn_with_options(
                &spec,
                TestOptions {
                    exception_trace: Some(trace.clone()),
                    ..Default::default()
                },
            )
            .map_err(|failure| failure.error)
            .unwrap();
            let deadline = Instant::now() + Duration::from_secs(4);
            let observed = loop {
                match child.try_wait() {
                    Ok(Some(status)) => break Ok(status),
                    Err(error) => break Err(error.to_string()),
                    Ok(None) if Instant::now() >= deadline => {
                        break Err("application exception control deadline".into());
                    }
                    Ok(None) => thread::sleep(Duration::from_millis(1)),
                }
            };
            let stopped = group.terminate_and_wait(&mut child);
            let quiesced = group.proves_tree_quiescence();
            let proof = crate::tool_process::copy_proof_details(
                &group.with_proof_details(PortcoveError::state("application exception control")),
            );
            let events = trace.lock().unwrap().clone();
            eprintln!(
                "native_exception_proof:{}",
                serde_json::json!({
                    "mode":mode,"quiesced":quiesced,"proof":proof,
                    "observation_error":observed.as_ref().err(),
                    "termination_error":stopped.as_ref().err().map(ToString::to_string),
                    "events":events.iter().map(|event|serde_json::json!({
                        "pid":event.pid,"code":event.code,"first_chance":event.first_chance,
                        "continuation":event.continuation,
                    })).collect::<Vec<_>>(),
                })
            );
            assert!(observed.is_ok());
            assert!(quiesced);
            let expected = if mode == "handled" { 0 } else { 0xe042_4444 };
            assert_eq!(stopped.unwrap().code().unwrap() as u32, expected);
            assert_eq!(proof["process_tree_total"], "1");
            assert_eq!(proof["process_tree_retained_members"], "1");
            assert_eq!(proof["process_tree_all_retained_signaled"], "true");
            assert_eq!(proof["process_tree_active"], "0");
            assert!(!proof.contains_key("process_tree_first_failure"));
            let startup = events
                .iter()
                .filter(|event| event.continuation == DBG_CONTINUE)
                .count();
            assert_eq!(startup, 1);
            let forwarded = events
                .iter()
                .filter(|event| event.continuation == DBG_EXCEPTION_NOT_HANDLED)
                .map(|event| (event.code, event.first_chance))
                .collect::<Vec<_>>();
            if mode == "handled" {
                assert_eq!(
                    forwarded,
                    [(0xe042_3333, 1), (0x8000_0003, 1), (0x8000_0003, 1)]
                );
                assert!(
                    working
                        .path()
                        .join("application-exceptions-handled")
                        .is_file()
                );
            } else {
                assert_eq!(forwarded, [(0xe042_4444, 1), (0xe042_4444, 0)]);
                assert!(working.path().join("application-unhandled-ready").is_file());
            }
        }
    }

    #[test]
    #[ignore = "requires separately admitted prepared first-party capacity-refusal packet"]
    fn handle_slot_capacity_refusal_never_promotes_duplicate_lifetimes() {
        let native = tempfile::tempdir().unwrap();
        let program = crate::test_fixture::build_probe(native.path());
        let working = tempfile::tempdir().unwrap();
        let mut spec =
            ChildProcessPolicy::native_tool_spec(ChildProcessClass::UpstreamSetup, &program)
                .unwrap();
        spec.args([
            "--setup-tree",
            &working.path().join("orphan-output").display().to_string(),
            "observed-wait",
        ])
        .current_dir(working.path());
        let refused = Arc::new(RefusedMember::default());
        let (mut child, group) = spawn_with_options(
            &spec,
            TestOptions {
                // Actual duplicate HANDLE storage fills the 512-slot bound.
                // These represent one root lifetime, never 512 lifetimes.
                reserved_slots: MEMBER_LIMIT - 1,
                refused_member: Some(refused.clone()),
                ..Default::default()
            },
        )
        .map_err(|failure| failure.error)
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(4);
        while refused.member.lock().unwrap().is_none() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(1));
        }
        let stopped = group.terminate_and_wait(&mut child);
        let quiesced = group.proves_tree_quiescence();
        let proof = crate::tool_process::copy_proof_details(
            &group.with_proof_details(PortcoveError::state("handle slot capacity refusal control")),
        );
        let observed = refused.member.lock().unwrap().take();
        let observation = observed.as_ref().map(|(identity, handle)| {
            serde_json::json!({
                "pid":identity.pid,"created_filetime":identity.created.to_string(),
                "wait_result":unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) },
            })
        });
        eprintln!(
            "native_capacity_refusal_proof:{}",
            serde_json::json!({
                "quiesced":quiesced,"proof":proof,"refused_member":observation,
                "duplicate_root_slots":MEMBER_LIMIT-1,
                "termination_error":stopped.as_ref().err().map(ToString::to_string),
                "root_status":stopped.as_ref().ok().and_then(ExitStatus::code),
                "orphan_output":working.path().join("orphan-output").exists(),
            })
        );
        assert!(observed.is_some(), "real refused member was observed");
        assert_eq!(observation.as_ref().unwrap()["wait_result"], WAIT_OBJECT_0);
        assert!(
            !quiesced,
            "duplicate handles cannot supply lifetime coverage"
        );
        assert_eq!(stopped.unwrap().code(), Some(1));
        assert_eq!(
            proof["process_tree_first_failure"],
            "retained_handle_capacity"
        );
        assert_eq!(
            proof["process_tree_retained_members"],
            MEMBER_LIMIT.to_string()
        );
        assert_eq!(proof["process_tree_total"], "2");
        assert_eq!(proof["process_tree_active"], "0");
        assert_eq!(proof["process_tree_all_retained_signaled"], "true");
        assert_eq!(proof["process_tree_membership_complete"], "false");
        assert_eq!(proof["process_tree_deadline_exhausted"], "false");
        let identities: Vec<serde_json::Value> =
            serde_json::from_str(&proof["process_tree_identities"]).unwrap();
        assert_eq!(identities.len(), 1, "only the root lifetime fits");
        assert!(!working.path().join("orphan-output").exists());
    }

    #[test]
    #[ignore = "requires separately admitted prepared first-party capture-refusal packet"]
    fn creation_capture_refusal_stays_failed_after_owned_handles_close() {
        let native = tempfile::tempdir().unwrap();
        let program = crate::test_fixture::build_probe(native.path());
        let working = tempfile::tempdir().unwrap();
        let mut spec =
            ChildProcessPolicy::native_tool_spec(ChildProcessClass::UpstreamSetup, &program)
                .unwrap();
        spec.args([
            "--setup-tree",
            &working.path().join("orphan-output").display().to_string(),
            "observed-wait",
        ])
        .current_dir(working.path());
        let refused = Arc::new(RefusedMember::default());
        let (mut child, group) = spawn_with_options(
            &spec,
            TestOptions {
                fail_capture: true,
                refused_member: Some(refused.clone()),
                ..Default::default()
            },
        )
        .map_err(|failure| failure.error)
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(4);
        while refused.member.lock().unwrap().is_none() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(1));
        }
        let stopped = group.terminate_and_wait(&mut child);
        let quiesced = group.proves_tree_quiescence();
        let proof = crate::tool_process::copy_proof_details(
            &group.with_proof_details(PortcoveError::state("creation capture refusal control")),
        );
        let observed = refused.member.lock().unwrap().take();
        let observation = observed.as_ref().map(|(identity, handle)| {
            serde_json::json!({
                "pid":identity.pid,"created_filetime":identity.created.to_string(),
                "wait_result":unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) },
                "image":test_process_image(handle.as_raw_handle()),
            })
        });
        // Publish real closure observations before any acceptance assertion.
        // The refused handle is fixture evidence, not reconstructed Core custody.
        eprintln!(
            "native_capture_refusal_proof:{}",
            serde_json::json!({
                "quiesced":quiesced,"proof":proof,"refused_creation":observation,
                "termination_error":stopped.as_ref().err().map(ToString::to_string),
                "root_status":stopped.as_ref().ok().and_then(ExitStatus::code),
                "orphan_output":working.path().join("orphan-output").exists(),
            })
        );
        assert!(
            observed.is_some(),
            "actual descendant CREATE refusal was observed"
        );
        assert_eq!(observation.as_ref().unwrap()["wait_result"], WAIT_OBJECT_0);
        assert!(
            !quiesced,
            "positive exits cannot clear the sticky capture refusal"
        );
        assert_eq!(stopped.unwrap().code(), Some(1));
        assert_eq!(proof["process_tree_first_failure"], "creation_capture");
        assert_eq!(proof["process_tree_total"], "2");
        assert_eq!(proof["process_tree_active"], "0");
        assert_eq!(proof["process_tree_all_retained_signaled"], "true");
        assert_eq!(proof["process_tree_deadline_exhausted"], "false");
        assert!(!working.path().join("orphan-output").exists());
    }

    #[test]
    fn cancellation_closes_a_captured_uncontinued_descendant_creation_event() {
        let native = tempfile::tempdir().unwrap();
        let program = crate::test_fixture::build_probe(native.path());
        let working = tempfile::tempdir().unwrap();
        let mut spec =
            ChildProcessPolicy::native_tool_spec(ChildProcessClass::UpstreamSetup, &program)
                .unwrap();
        spec.args([
            "--setup-tree",
            &working.path().join("orphan-output").display().to_string(),
            "observed-wait",
        ])
        .current_dir(working.path());
        let pending = Arc::new(PendingCreation::default());
        let (mut child, group) = spawn_with_options(
            &spec,
            TestOptions {
                pending_creation: Some(pending.clone()),
                ..Default::default()
            },
        )
        .map_err(|failure| failure.error)
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(4);
        let captured = loop {
            let captured = *pending.identity.lock().unwrap();
            if captured.is_some() || Instant::now() >= deadline {
                break captured;
            }
            thread::sleep(Duration::from_millis(1));
        };
        // Request cancellation only after the controller publishes the real
        // captured CREATE identity, before it continues that debug event.
        let stopped = group.terminate_and_wait(&mut child);
        let quiesced = group.proves_tree_quiescence();
        let proof = crate::tool_process::copy_proof_details(
            &group.with_proof_details(PortcoveError::state("pending creation control")),
        );
        let cancellation_observed = pending.cancellation_observed.load(Ordering::Acquire);
        eprintln!(
            "native_pending_creation_proof:{}",
            serde_json::json!({
                "quiesced":quiesced,"proof":proof,
                "pending_identity":captured.map(|identity|serde_json::json!({
                    "pid":identity.pid,"created_filetime":identity.created.to_string(),
                })),
                "cancellation_observed_before_continue":cancellation_observed,
                "termination_error":stopped.as_ref().err().map(ToString::to_string),
            })
        );
        assert!(captured.is_some());
        assert!(cancellation_observed);
        assert!(quiesced);
        assert_eq!(stopped.unwrap().code(), Some(1));
        assert_eq!(proof["process_tree_total"], "2");
        assert_eq!(proof["process_tree_retained_members"], "2");
        assert_eq!(proof["process_tree_all_retained_signaled"], "true");
        assert_eq!(proof["process_tree_active"], "0");
        assert!(!proof.contains_key("process_tree_first_failure"));
        let identities: Vec<serde_json::Value> =
            serde_json::from_str(&proof["process_tree_identities"]).unwrap();
        let captured = captured.unwrap();
        let expected_created = captured.created.to_string();
        assert!(identities.iter().any(|identity| {
            identity["pid"] == captured.pid
                && identity["created_filetime"] == expected_created.as_str()
        }));
        assert!(!working.path().join("orphan-output").exists());
    }

    #[test]
    fn child_observes_exact_unicode_argv_filtered_environment_and_cwd() {
        let native = tempfile::tempdir().unwrap();
        let program = crate::test_fixture::build_probe(native.path());
        let working = tempfile::tempdir().unwrap();
        let mut spec =
            ChildProcessPolicy::native_tool_spec(ChildProcessClass::UpstreamSetup, &program)
                .unwrap();
        // A finite complete environment makes ambient additions observable.
        // Preserve only the host's SystemRoot needed by Windows runtime loading.
        let system_root = spec
            .environment
            .iter()
            .find(|(key, _)| crate::process::environment_names_equal(key, OsStr::new("SystemRoot")))
            .map(|(_, value)| value.clone())
            .unwrap();
        spec.environment.clear();
        spec.env("SystemRoot", system_root);
        spec.env("PORTCOVE_PARITY_TEXT", "雪 café=literal");
        spec.env("PORTCOVE_PARITY_EMPTY", "");
        spec.env("Path", "controlled empty discovery");
        spec.env_remove("path");
        let arguments = ["", "雪 café", "a\"b", "a\\", "\twith space", "x\\\"y"];
        spec.arg("--observe-launch")
            .args(arguments)
            .current_dir(working.path());
        let expected_environment: Vec<_> = spec
            .environment
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        let mut quiesced = false;
        let execution_deadline = Instant::now() + Duration::from_secs(10);
        let result = crate::tool_process::run_tool(
            &mut spec,
            &|| {
                if Instant::now() >= execution_deadline {
                    return Err(crate::PortcoveError::state(
                        "first-party launch control exceeded its execution bound",
                    ));
                }
                Ok(())
            },
            crate::tool_process::ToolProcessObserver {
                diagnostics: None,
                quiesced: Some(&mut || {
                    quiesced = true;
                    Ok(())
                }),
            },
        );
        let proof = match &result {
            Ok(output) => output.process_tree_proof.clone(),
            Err(error) => crate::tool_process::copy_proof_details(error),
        };
        eprintln!(
            "native_launch_proof:{}",
            serde_json::json!({
                "quiesced": quiesced,
                "proof": proof,
            })
        );
        let result = result.unwrap();
        assert!(result.status.success());
        assert!(quiesced);
        assert_eq!(result.process_tree_proof["process_tree_active"], "0");
        assert_eq!(result.process_tree_proof["process_tree_total"], "1");
        assert_eq!(
            result.process_tree_proof["process_tree_retained_members"],
            "1"
        );
        assert_eq!(
            std::fs::read_to_string(working.path().join("launch-arguments")).unwrap(),
            format!("{arguments:?}")
        );
        assert_eq!(
            std::fs::read_to_string(working.path().join("launch-environment")).unwrap(),
            format!("{expected_environment:?}")
        );
        assert_eq!(
            std::fs::read_to_string(working.path().join("launch-directory")).unwrap(),
            format!("{:?}", working.path())
        );
    }
}

#[cfg(test)]
mod launch_tests {
    use super::*;
    use crate::{ChildProcessClass, ChildProcessPolicy};

    fn spec() -> NativeToolLaunchSpec {
        let mut spec = ChildProcessPolicy::native_tool_spec(
            ChildProcessClass::UpstreamSetup,
            std::env::temp_dir().join("owned fixture").join("probe.exe"),
        )
        .unwrap();
        spec.environment.clear();
        spec
    }

    #[test]
    fn literal_argv_uses_crt_escaping_for_empty_unicode_quotes_and_trailing_slashes() {
        // Independent expected encodings follow Microsoft's CRT argument rules.
        for (literal, encoded) in [
            ("", "\"\""),
            ("雪 café", "\"雪 café\""),
            ("a\"b", "\"a\\\"b\""),
            ("a\\\"b", "\"a\\\\\\\"b\""),
            ("a\\", "\"a\\\\\""),
            ("\twith space", "\"\twith space\""),
        ] {
            let argument: Vec<_> = literal.encode_utf16().collect();
            assert_eq!(
                String::from_utf16(&quote_argument(&argument)).unwrap(),
                encoded
            );
        }
        let mut spec = spec();
        spec.args(["", "雪 café", "a\"b", "a\\"]);
        let directory = std::env::temp_dir().join("isolated 雪");
        spec.current_dir(&directory);
        let launch = EncodedLaunch::new(&spec).unwrap();
        assert_eq!(
            String::from_utf16(&launch.command[..launch.command.len() - 1]).unwrap(),
            format!(
                "\"{}\" \"\" \"雪 café\" \"a\\\"b\" \"a\\\\\"",
                spec.program.display()
            )
        );
        assert_eq!(
            launch.directory.unwrap(),
            wide(directory.as_os_str()).unwrap()
        );
    }

    #[test]
    fn environment_is_complete_sorted_unicode_and_double_nul_terminated() {
        let mut spec = spec();
        assert_eq!(EncodedLaunch::new(&spec).unwrap().environment, vec![0, 0]);
        spec.env("zeta", "雪=café");
        spec.env("Alpha", "");
        spec.env("Path", "controlled");
        spec.env("PATH", "replacement");
        let launch = EncodedLaunch::new(&spec).unwrap();
        assert_eq!(
            String::from_utf16(&launch.environment).unwrap(),
            "Alpha=\0PATH=replacement\0zeta=雪=café\0\0"
        );
        assert_eq!(spec.environment.len(), 3);
        assert_eq!(launch.application, wide(spec.program.as_os_str()).unwrap());
    }

    #[test]
    fn invalid_or_unbounded_input_is_refused_before_native_creation() {
        for argument in [
            OsString::from("has\0nul"),
            OsString::from("x".repeat(32767)),
        ] {
            let mut spec = spec();
            spec.arg(argument);
            assert!(EncodedLaunch::new(&spec).is_err());
        }
        let mut relative = spec();
        relative.program = "relative.exe".into();
        assert!(EncodedLaunch::new(&relative).is_err());
        for name in ["", "bad=name", "bad\0name", "SERVICE_TOKEN"] {
            let mut spec = spec();
            spec.environment.insert(name.into(), "value".into());
            assert!(EncodedLaunch::new(&spec).is_err());
        }
        let mut spec = spec();
        spec.environment
            .insert("oversized".into(), "x".repeat(32767).into());
        assert!(EncodedLaunch::new(&spec).is_err());
    }

    fn member() -> Member {
        Member {
            image: None,
            // Open only this test's process; the pseudo-handle value -1 is
            // deliberately refused by the production duplication boundary.
            handle: owned(unsafe {
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                    0,
                    windows_sys::Win32::System::Threading::GetCurrentProcessId(),
                )
            })
            .unwrap(),
            initial_thread: Some(7),
            creation_seen: true,
            startup_handled: false,
            system_module: Some((0x1000, 0x100)),
        }
    }

    #[test]
    fn startup_is_one_shot_and_later_first_and_second_chance_exceptions_are_forwarded() {
        let mut member = member();
        assert_eq!(
            member.classify_exception(7, STATUS_BREAKPOINT, 1, 0x1010),
            ExceptionDisposition::Startup
        );
        for (thread, code, chance, address) in [
            (7, STATUS_BREAKPOINT, 1, 0x1010),
            (7, STATUS_BREAKPOINT, 2, 0x1010),
            (8, STATUS_BREAKPOINT, 1, 0x2010),
            (7, 0x1234, 1, 0x1010),
            (7, 0x1234, 2, 0x1010),
        ] {
            assert_eq!(
                member.classify_exception(thread, code, chance, address),
                ExceptionDisposition::Application
            );
        }
    }

    #[test]
    fn unknown_initial_events_do_not_consume_the_startup_gate() {
        for (thread, code, chance, address) in [
            (8, STATUS_BREAKPOINT, 1, 0x1010),
            (7, STATUS_BREAKPOINT, 2, 0x1010),
            (7, 0x1234, 1, 0x1010),
            (7, STATUS_BREAKPOINT, 1, 0x0fff),
            (7, STATUS_BREAKPOINT, 1, 0x1100),
        ] {
            let mut member = member();
            assert_eq!(
                member.classify_exception(thread, code, chance, address),
                ExceptionDisposition::Unclassified
            );
            assert!(!member.startup_handled);
        }
        for missing_creation in [false, true] {
            let mut member = member();
            if missing_creation {
                member.creation_seen = false;
            } else {
                member.system_module = None;
            }
            assert_eq!(
                member.classify_exception(7, STATUS_BREAKPOINT, 1, 0x1010),
                ExceptionDisposition::Unclassified
            );
            assert!(!member.startup_handled);
        }
    }

    #[test]
    fn retained_identity_distinguishes_reused_pid_lifetimes() {
        let old = Identity {
            pid: 42,
            created: 100,
        };
        let new = Identity {
            pid: 42,
            created: 101,
        };
        let mut store = BTreeMap::new();
        store.insert(old, "old retained identity");
        store.insert(new, "new retained identity");
        assert_eq!(store.len(), 2);
        assert_eq!(store[&old], "old retained identity");
        assert_eq!(store[&new], "new retained identity");
    }
}

#[cfg(test)]
mod proof_tests {
    use super::*;

    #[test]
    fn encoded_decoder_keeps_ordinary_budget_even_for_a_builder_class() {
        let program = system_directory().unwrap().join("cmd.exe");
        let mut spec = crate::ChildProcessPolicy::native_tool_spec(
            crate::ChildProcessClass::ManagedBuilder,
            program,
        )
        .unwrap();
        assert_eq!(
            EncodedLaunch::new(&spec).unwrap().event_budget.limit(),
            32768
        );
        spec.decoder_limits = Some(crate::process::DecoderLimits {
            memory_bytes: 1024,
            file_bytes: 1024,
        });
        assert_eq!(
            EncodedLaunch::new(&spec).unwrap().event_budget.limit(),
            4096
        );
    }

    #[test]
    fn event_budget_boundary_and_exhaustion_preserve_failure() {
        for (event_budget, limit) in [
            (NativeToolEventBudget::Ordinary, 4096),
            (NativeToolEventBudget::ManagedBuilder, 32768),
        ] {
            let mut proof = Proof {
                event_budget,
                ..Default::default()
            };
            for _ in 0..limit {
                assert!(proof.record_event());
            }
            assert_eq!(proof.observed_events, limit);
            assert!(proof.first_failure.is_none());
            let mut at_limit = proof.clone();
            at_limit.finish(true, Instant::now());
            assert!(at_limit.quiesced);
            assert!(!proof.record_event());
            assert_eq!(proof.observed_events, limit + 1);
            proof.accounting = Some((0, 1));
            proof.all_retained_signaled = Some(true);
            proof.root_status = Some(ExitStatus::from_raw(0));
            proof.finish(true, Instant::now());
            assert!(!proof.quiesced);
            assert_eq!(proof.first_failure, Some(("event_capacity", None)));
            let control = Control {
                proof: Mutex::new(proof),
                ..Default::default()
            };
            let error = with_control_proof(&control, PortcoveError::state("retained failure"));
            let details = crate::tool_process::copy_proof_details(&error);
            assert_eq!(details["process_tree_event_limit"], limit.to_string());
            assert_eq!(
                details["process_tree_observed_events"],
                (limit + 1).to_string()
            );
            assert_eq!(details["process_tree_membership_complete"], "false");
        }
    }

    #[test]
    fn event_exhaustion_does_not_replace_an_earlier_failure() {
        let mut proof = Proof {
            observed_events: 4096,
            first_failure: Some(("creation_capture", Some(5))),
            ..Default::default()
        };
        assert!(!proof.record_event());
        proof.finish(true, Instant::now());
        assert_eq!(proof.first_failure, Some(("creation_capture", Some(5))));
        assert!(!proof.quiesced);
    }

    #[test]
    fn enlarged_member_set_invalidates_prior_positive_wait_observation() {
        let old = Identity {
            pid: 42,
            created: 100,
        };
        let new = Identity {
            pid: 43,
            created: 101,
        };
        let mut proof = Proof {
            retained: 1,
            identities: vec![old],
            all_retained_signaled: Some(true),
            ..Default::default()
        };
        proof.publish_members(2, [old, new].into_iter());
        assert_eq!(proof.retained, 2);
        assert_eq!(proof.identities, vec![old, new]);
        assert_eq!(proof.all_retained_signaled, None);
    }

    #[test]
    fn positive_handle_observations_do_not_promote_a_lifetime_gap() {
        let created = 1_234_567_890_123_456_789_u64;
        let group = ToolProcessGroup {
            control: Arc::new(Control {
                proof: Mutex::new(Proof {
                    first_failure: Some(("lifetime_count_gap", None)),
                    retained: 1,
                    identities: vec![Identity { pid: 42, created }],
                    accounting: Some((0, 2)),
                    all_retained_signaled: Some(true),
                    root_status: Some(ExitStatus::from_raw(0)),
                    done: true,
                    quiesced: false,
                    ..Default::default()
                }),
                ..Default::default()
            }),
            worker: None,
        };
        assert!(!group.proves_tree_quiescence());
        let error = group.with_proof_details(crate::PortcoveError::state("retained failure"));
        let copied = crate::tool_process::copy_proof_details(&error);
        assert_eq!(copied["process_tree_first_failure"], "lifetime_count_gap");
        assert_eq!(copied["process_tree_all_retained_signaled"], "true");
        assert_eq!(copied["process_tree_retained_members"], "1");
        assert_eq!(copied["process_tree_total"], "2");
        assert_eq!(copied["process_tree_root_exit"], "0");
        let identities: serde_json::Value =
            serde_json::from_str(&copied["process_tree_identities"]).unwrap();
        assert_eq!(identities[0]["created_filetime"], created.to_string());
        assert_eq!(identities[0]["pid"], 42);
    }

    #[test]
    fn successful_partial_job_snapshot_retains_only_returned_ids() {
        assert_eq!(
            std::mem::offset_of!(JobProcessIds, ids),
            std::mem::offset_of!(
                windows_sys::Win32::System::JobObjects::JOBOBJECT_BASIC_PROCESS_ID_LIST,
                ProcessIdList
            ),
        );
        let mut snapshot = JobProcessIds {
            assigned: 2,
            returned: 1,
            ids: [0; MEMBER_LIMIT],
        };
        snapshot.ids[0] = 42;
        snapshot.ids[1] = usize::MAX;
        assert_eq!(snapshot.observed_ids().unwrap(), vec![42]);
        snapshot.returned = 0;
        assert!(snapshot.observed_ids().unwrap().is_empty());
        snapshot.returned = 2;
        assert_eq!(snapshot.observed_ids().unwrap_err().0, "member_id_range");
    }

    #[test]
    fn malformed_or_oversized_job_snapshots_are_refused() {
        for (assigned, returned, reason) in [
            (1, 2, "membership_counts"),
            (513, 1, "membership_capacity"),
            (513, 513, "membership_capacity"),
            (2, 513, "membership_capacity"),
        ] {
            let snapshot = JobProcessIds {
                assigned,
                returned,
                ids: [0; MEMBER_LIMIT],
            };
            assert_eq!(snapshot.observed_ids().unwrap_err().0, reason);
        }
    }

    #[test]
    fn invalid_job_observation_never_grants_cleanup_proof() {
        let failure =
            membership_snapshot(windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE).unwrap_err();
        assert_eq!(failure.0, "membership_query");
        assert!(failure.1.is_some());
        let mut proof = Proof {
            first_failure: Some(failure),
            ..Default::default()
        };
        proof.finish(true, Instant::now());
        assert!(!proof.quiesced);
        assert!(proof.accounting.is_none());
    }

    #[test]
    fn late_publication_cannot_replace_an_expired_observation() {
        let deadline = Instant::now();
        let mut proof = Proof {
            deadline: Some(deadline),
            ..Default::default()
        };
        proof.latch_deadline(deadline);
        assert!(!proof.done);
        assert!(proof.deadline_exhausted);
        proof.finish(true, deadline + Duration::from_nanos(1));
        assert!(proof.done);
        assert!(!proof.quiesced);
        assert_eq!(proof.first_failure, Some(("closure_deadline", None)));
    }

    #[test]
    fn final_publication_checks_deadline_without_an_observer() {
        let deadline = Instant::now();
        let mut proof = Proof {
            deadline: Some(deadline),
            first_failure: Some(("earlier_failure", Some(5))),
            ..Default::default()
        };
        proof.finish(true, deadline);
        assert!(proof.deadline_exhausted);
        assert!(!proof.quiesced);
        assert_eq!(proof.first_failure, Some(("earlier_failure", Some(5))));
    }

    #[test]
    fn completed_proof_does_not_expire_retroactively() {
        let deadline = Instant::now() + CLOSURE_BOUND;
        let mut proof = Proof {
            deadline: Some(deadline),
            ..Default::default()
        };
        proof.finish(true, deadline - Duration::from_nanos(1));
        proof.latch_deadline(deadline + Duration::from_secs(1));
        assert!(proof.done);
        assert!(proof.quiesced);
        assert!(!proof.deadline_exhausted);
    }
}
