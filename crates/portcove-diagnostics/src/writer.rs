//! Bounded, best-effort runtime file writing. The producer accepts only already
//! redacted, serialized records; it never opens, rotates, writes or syncs files.
//! The shared crate exercises this writer on Windows and Linux.

use std::{
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering},
        mpsc::{self, Receiver, SyncSender, TryRecvError, TrySendError},
    },
    thread::{self, JoinHandle, Thread},
    time::{Duration, Instant, SystemTime},
};

pub const LOG_FILE_NAME: &str = "portcove-desktop.jsonl";
pub const WRITER_LOCK_NAME: &str = ".portcove-desktop-writer.lock";
pub const DEFAULT_QUEUE_CAPACITY: usize = 256;
pub const DEFAULT_MAX_RECORD_BYTES: usize = 32 * 1024;
pub const DEFAULT_MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
pub const DEFAULT_RETAINED_FILES: usize = 5;
pub const DEFAULT_MAX_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
pub const DEFAULT_IDLE_FLUSH: Duration = Duration::from_secs(1);
const DROP_FLUSH_TIMEOUT: Duration = Duration::from_millis(100);
const RETENTION_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub queue_capacity: usize,
    pub max_record_bytes: usize,
    pub max_file_bytes: u64,
    pub retained_files: usize,
    pub max_age: Duration,
    pub idle_flush: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            queue_capacity: DEFAULT_QUEUE_CAPACITY,
            max_record_bytes: DEFAULT_MAX_RECORD_BYTES,
            max_file_bytes: DEFAULT_MAX_FILE_BYTES,
            retained_files: DEFAULT_RETAINED_FILES,
            max_age: DEFAULT_MAX_AGE,
            idle_flush: DEFAULT_IDLE_FLUSH,
        }
    }
}

impl Limits {
    fn validate(self) -> io::Result<Self> {
        if self.queue_capacity == 0
            || self.queue_capacity > DEFAULT_QUEUE_CAPACITY
            || self.max_record_bytes == 0
            || self.max_record_bytes > DEFAULT_MAX_RECORD_BYTES
            || self.max_file_bytes < self.max_record_bytes as u64
            || self.max_file_bytes > DEFAULT_MAX_FILE_BYTES
            || self.retained_files > DEFAULT_RETAINED_FILES
            || self.max_age.is_zero()
            || self.max_age > DEFAULT_MAX_AGE
            || self.idle_flush.is_zero()
            || self.idle_flush > DEFAULT_IDLE_FLUSH
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "runtime diagnostic limits exceed the bounded policy",
            ));
        }
        Ok(self)
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[repr(u8)]
pub enum FlushState {
    #[default]
    Running,
    Flushing,
    Complete,
    Failed,
    TimedOut,
    Unavailable,
}

impl FlushState {
    fn from_byte(value: u8) -> Self {
        match value {
            0 => Self::Running,
            1 => Self::Flushing,
            2 => Self::Complete,
            3 => Self::Failed,
            4 => Self::TimedOut,
            _ => Self::Unavailable,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct HealthSnapshot {
    pub admitted: u64,
    pub written: u64,
    pub dropped: u64,
    pub dropped_full: u64,
    pub dropped_closed: u64,
    pub dropped_formatting: u64,
    pub dropped_oversized: u64,
    pub truncated_fields: u64,
    pub opaque_fields: u64,
    pub open_errors: u64,
    pub write_errors: u64,
    pub rotation_errors: u64,
    pub retention_errors: u64,
    pub lease_errors: u64,
    pub flush_errors: u64,
    pub permission_errors: u64,
    pub disk_full_errors: u64,
    pub queue_depth: u64,
    pub queue_high_water: u64,
    pub flush_state: FlushState,
}

#[derive(Default)]
struct Health {
    admitted: AtomicU64,
    written: AtomicU64,
    dropped: AtomicU64,
    dropped_full: AtomicU64,
    dropped_closed: AtomicU64,
    dropped_formatting: AtomicU64,
    dropped_oversized: AtomicU64,
    truncated_fields: AtomicU64,
    opaque_fields: AtomicU64,
    open_errors: AtomicU64,
    write_errors: AtomicU64,
    rotation_errors: AtomicU64,
    retention_errors: AtomicU64,
    lease_errors: AtomicU64,
    flush_errors: AtomicU64,
    permission_errors: AtomicU64,
    disk_full_errors: AtomicU64,
    queue_depth: AtomicU64,
    queue_high_water: AtomicU64,
    flush_state: AtomicU8,
}

impl Health {
    fn snapshot(&self) -> HealthSnapshot {
        let read = |value: &AtomicU64| value.load(Ordering::Relaxed);
        HealthSnapshot {
            admitted: read(&self.admitted),
            written: read(&self.written),
            dropped: read(&self.dropped),
            dropped_full: read(&self.dropped_full),
            dropped_closed: read(&self.dropped_closed),
            dropped_formatting: read(&self.dropped_formatting),
            dropped_oversized: read(&self.dropped_oversized),
            truncated_fields: read(&self.truncated_fields),
            opaque_fields: read(&self.opaque_fields),
            open_errors: read(&self.open_errors),
            write_errors: read(&self.write_errors),
            rotation_errors: read(&self.rotation_errors),
            retention_errors: read(&self.retention_errors),
            lease_errors: read(&self.lease_errors),
            flush_errors: read(&self.flush_errors),
            permission_errors: read(&self.permission_errors),
            disk_full_errors: read(&self.disk_full_errors),
            queue_depth: read(&self.queue_depth),
            queue_high_water: read(&self.queue_high_water),
            flush_state: FlushState::from_byte(self.flush_state.load(Ordering::Acquire)),
        }
    }

    fn error(&self, error: SinkError) {
        let counter = match error.stage {
            FailureStage::Open => &self.open_errors,
            FailureStage::Write => &self.write_errors,
            FailureStage::Rotation => &self.rotation_errors,
            FailureStage::Retention => &self.retention_errors,
            FailureStage::Lease => &self.lease_errors,
            FailureStage::Flush => &self.flush_errors,
        };
        counter.fetch_add(1, Ordering::Relaxed);
        if error.kind == io::ErrorKind::PermissionDenied {
            self.permission_errors.fetch_add(1, Ordering::Relaxed);
        }
        if error.kind == io::ErrorKind::StorageFull {
            self.disk_full_errors.fetch_add(1, Ordering::Relaxed);
        }
    }

    fn terminal(&self, state: FlushState) {
        // A worker completing after the caller's deadline cannot retroactively
        // turn a timed-out flush into successful normal-shutdown evidence.
        let _ = self
            .flush_state
            .try_update(Ordering::AcqRel, Ordering::Acquire, |old| {
                (!matches!(
                    FlushState::from_byte(old),
                    FlushState::TimedOut | FlushState::Unavailable
                ))
                .then_some(state as u8)
            });
    }
}

#[derive(Default)]
struct Shared {
    health: Health,
    closed: AtomicBool,
    abandon: AtomicBool,
    producers_in_flight: AtomicU64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnqueueOutcome {
    Accepted,
    DroppedFull,
    DroppedClosed,
    DroppedOversized,
}

#[derive(Clone)]
pub struct Producer {
    sender: SyncSender<Box<[u8]>>,
    shared: Arc<Shared>,
    worker: Option<Thread>,
    max_record_bytes: usize,
    queue_capacity: usize,
}

impl Producer {
    /// Input must be a complete redacted JSONL record. The boxed slice removes
    /// spare Vec capacity before enqueue, so retained allocation is bounded by
    /// queue_capacity * max_record_bytes, plus one worker record.
    pub fn try_record(&self, record: Vec<u8>) -> EnqueueOutcome {
        if record.is_empty() || record.len() > self.max_record_bytes {
            self.shared.health.dropped.fetch_add(1, Ordering::Relaxed);
            self.shared
                .health
                .dropped_oversized
                .fetch_add(1, Ordering::Relaxed);
            return EnqueueOutcome::DroppedOversized;
        }
        // The paired count/closed protocol needs one total order across both
        // atomics: shutdown must not miss a producer which observed admission.
        self.shared
            .producers_in_flight
            .fetch_add(1, Ordering::SeqCst);
        let result = self.try_record_admitted(record);
        self.shared
            .producers_in_flight
            .fetch_sub(1, Ordering::SeqCst);
        if let Some(worker) = &self.worker {
            worker.unpark();
        }
        result
    }

    fn try_record_admitted(&self, record: Vec<u8>) -> EnqueueOutcome {
        if self.shared.closed.load(Ordering::SeqCst) {
            self.shared.health.dropped.fetch_add(1, Ordering::Relaxed);
            self.shared
                .health
                .dropped_closed
                .fetch_add(1, Ordering::Relaxed);
            return EnqueueOutcome::DroppedClosed;
        }
        // Reserve accounting before try_send so a fast receiver cannot
        // decrement before this producer has accounted for its record.
        self.shared
            .health
            .queue_depth
            .fetch_add(1, Ordering::Relaxed);
        match self.sender.try_send(record.into_boxed_slice()) {
            Ok(()) => {
                self.shared.health.admitted.fetch_add(1, Ordering::Relaxed);
                let depth = self
                    .shared
                    .health
                    .queue_depth
                    .load(Ordering::Relaxed)
                    .min(self.queue_capacity as u64);
                self.shared
                    .health
                    .queue_high_water
                    .fetch_max(depth, Ordering::Relaxed);
                EnqueueOutcome::Accepted
            }
            Err(error) => {
                self.shared
                    .health
                    .queue_depth
                    .fetch_sub(1, Ordering::Relaxed);
                self.shared.health.dropped.fetch_add(1, Ordering::Relaxed);
                match error {
                    TrySendError::Full(_) => {
                        self.shared
                            .health
                            .dropped_full
                            .fetch_add(1, Ordering::Relaxed);
                        EnqueueOutcome::DroppedFull
                    }
                    TrySendError::Disconnected(_) => {
                        self.shared
                            .health
                            .dropped_closed
                            .fetch_add(1, Ordering::Relaxed);
                        EnqueueOutcome::DroppedClosed
                    }
                }
            }
        }
    }

    pub fn note_dropped(&self) {
        self.shared.health.dropped.fetch_add(1, Ordering::Relaxed);
        self.shared
            .health
            .dropped_formatting
            .fetch_add(1, Ordering::Relaxed);
    }

    pub fn note_truncated(&self, fields: u64) {
        self.shared
            .health
            .truncated_fields
            .fetch_add(fields, Ordering::Relaxed);
    }

    pub fn note_opaque_omitted(&self, fields: u64) {
        self.shared
            .health
            .opaque_fields
            .fetch_add(fields, Ordering::Relaxed);
    }

    /// Counters are independently sampled observations, not an atomic ledger.
    pub fn health(&self) -> HealthSnapshot {
        let mut health = self.shared.health.snapshot();
        // In-flight producer reservations may temporarily exceed actual queue
        // occupancy. Report the finite queue's upper bound, never that scratch.
        health.queue_depth = health.queue_depth.min(self.queue_capacity as u64);
        health
    }

    pub fn disabled(kind: io::ErrorKind) -> Self {
        let (sender, receiver) = mpsc::sync_channel(1);
        drop(receiver);
        let shared = Arc::new(Shared::default());
        shared.closed.store(true, Ordering::SeqCst);
        shared.health.error(SinkError {
            stage: FailureStage::Open,
            kind,
        });
        shared
            .health
            .flush_state
            .store(FlushState::Unavailable as u8, Ordering::Release);
        Self {
            sender,
            shared,
            worker: None,
            max_record_bytes: DEFAULT_MAX_RECORD_BYTES,
            queue_capacity: 1,
        }
    }
}

pub struct Guard {
    shared: Arc<Shared>,
    completion: Receiver<()>,
    worker: Option<JoinHandle<()>>,
    shutdown_started: bool,
    queue_capacity: usize,
}

impl Guard {
    pub fn shutdown(&mut self, timeout: Duration) -> HealthSnapshot {
        if !self.shutdown_started {
            self.shutdown_started = true;
            self.shared.closed.store(true, Ordering::SeqCst);
            let _ = self.shared.health.flush_state.compare_exchange(
                FlushState::Running as u8,
                FlushState::Flushing as u8,
                Ordering::AcqRel,
                Ordering::Acquire,
            );
            if let Some(worker) = &self.worker {
                worker.thread().unpark();
            }
            match self.completion.recv_timeout(timeout) {
                Ok(()) => {}
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    self.shared.abandon.store(true, Ordering::Release);
                    self.shared.health.terminal(FlushState::TimedOut);
                    if let Some(worker) = &self.worker {
                        worker.thread().unpark();
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    self.shared.health.terminal(FlushState::Failed);
                }
            }
        }
        // Acknowledgement alone is not sufficient: thread-local destruction may
        // remain. Never join a worker that could still block past our deadline.
        if self.worker.as_ref().is_some_and(JoinHandle::is_finished) {
            if let Some(worker) = self.worker.take() {
                let _ = worker.join();
            }
        }
        let mut health = self.shared.health.snapshot();
        health.queue_depth = health.queue_depth.min(self.queue_capacity as u64);
        health
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        if !self.shutdown_started {
            let _ = self.shutdown(DROP_FLUSH_TIMEOUT);
        }
        // Dropping a remaining JoinHandle detaches it. A blocked OS call cannot
        // be cancelled; normal process exit may lose its pending diagnostics.
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureStage {
    Open,
    Write,
    Rotation,
    Retention,
    Lease,
    Flush,
}

#[derive(Debug, Clone, Copy)]
pub struct SinkError {
    pub stage: FailureStage,
    pub kind: io::ErrorKind,
}

impl SinkError {
    pub(crate) fn from_io(stage: FailureStage, error: io::Error) -> Self {
        Self {
            stage,
            kind: error.kind(),
        }
    }
}

pub trait DiagnosticSink: Send + 'static {
    fn initialize(&mut self) -> Result<(), SinkError> {
        Ok(())
    }

    fn write_record(&mut self, record: &[u8]) -> Result<(), SinkError>;
    fn flush(&mut self) -> Result<(), SinkError>;

    /// Called after the final drain and flush, while the sink still owns its lease.
    fn finish(&mut self, _successful: bool) -> Result<(), SinkError> {
        Ok(())
    }
}

pub struct RuntimeWriter;

impl RuntimeWriter {
    /// The parent must already exist. Its alias checks and canonicalization run
    /// only on the worker. Unavailable file storage is reported through health
    /// and never changes a domain outcome.
    pub fn start(path: PathBuf, limits: Limits) -> io::Result<(Producer, Guard)> {
        let limits = limits.validate()?;
        if !path.is_absolute() || path.file_name() != Some(std::ffi::OsStr::new(LOG_FILE_NAME)) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "runtime diagnostics require the fixed absolute log namespace",
            ));
        }
        Self::spawn(limits, FileSink::new(path, limits))
    }

    #[doc(hidden)]
    pub fn start_with_sink(
        limits: Limits,
        sink: impl DiagnosticSink,
    ) -> io::Result<(Producer, Guard)> {
        Self::spawn(limits.validate()?, sink)
    }

    pub(crate) fn spawn(
        limits: Limits,
        sink: impl DiagnosticSink,
    ) -> io::Result<(Producer, Guard)> {
        let shared = Arc::new(Shared::default());
        let (sender, receiver) = mpsc::sync_channel(limits.queue_capacity);
        let (complete, completion) = mpsc::sync_channel(1);
        let worker_shared = Arc::clone(&shared);
        let worker = thread::Builder::new()
            .name("portcove-diagnostics".into())
            .spawn(move || {
                run_worker(receiver, sink, &worker_shared, limits);
                let _ = complete.try_send(());
            })?;
        let producer = Producer {
            sender,
            shared: Arc::clone(&shared),
            worker: Some(worker.thread().clone()),
            max_record_bytes: limits.max_record_bytes,
            queue_capacity: limits.queue_capacity,
        };
        Ok((
            producer,
            Guard {
                shared,
                completion,
                worker: Some(worker),
                shutdown_started: false,
                queue_capacity: limits.queue_capacity,
            },
        ))
    }
}

fn run_worker(
    receiver: Receiver<Box<[u8]>>,
    mut sink: impl DiagnosticSink,
    shared: &Shared,
    limits: Limits,
) {
    if let Err(error) = sink.initialize() {
        shared.health.error(error);
        shared.closed.store(true, Ordering::SeqCst);
        shared.health.terminal(FlushState::Unavailable);
        discard_queue(&receiver, shared);
        return;
    }
    let mut dirty = false;
    let mut failed = false;
    let mut last_flush = Instant::now();
    loop {
        if shared.abandon.load(Ordering::Acquire) {
            discard_queue(&receiver, shared);
            return;
        }
        // Once admission is closed and all its in-flight calls have finished,
        // the subsequent empty receive is a complete drain observation.
        let draining = shared.closed.load(Ordering::SeqCst)
            && shared.producers_in_flight.load(Ordering::SeqCst) == 0;
        match receiver.try_recv() {
            Ok(record) => {
                shared.health.queue_depth.fetch_sub(1, Ordering::Relaxed);
                match sink.write_record(&record) {
                    Ok(()) => {
                        shared.health.written.fetch_add(1, Ordering::Relaxed);
                        dirty = true;
                    }
                    Err(error) => {
                        shared.health.error(error);
                        shared.health.dropped.fetch_add(1, Ordering::Relaxed);
                        failed = true;
                        if error.stage == FailureStage::Lease {
                            shared.closed.store(true, Ordering::SeqCst);
                            shared.health.terminal(FlushState::Unavailable);
                            discard_queue(&receiver, shared);
                            return;
                        }
                    }
                }
            }
            Err(error) => {
                if draining || error == TryRecvError::Disconnected {
                    shared.closed.store(true, Ordering::SeqCst);
                    if let Err(error) = sink.flush() {
                        shared.health.error(error);
                        failed = true;
                    }
                    if !shared.abandon.load(Ordering::Acquire) {
                        if let Err(error) = sink.finish(!failed) {
                            shared.health.error(error);
                            failed = true;
                        }
                    }
                    shared.health.terminal(if failed {
                        FlushState::Failed
                    } else {
                        FlushState::Complete
                    });
                    return;
                }
                thread::park_timeout(limits.idle_flush.saturating_sub(last_flush.elapsed()));
            }
        }
        if dirty && last_flush.elapsed() >= limits.idle_flush {
            if let Err(error) = sink.flush() {
                shared.health.error(error);
                failed = true;
            }
            dirty = false;
            last_flush = Instant::now();
        } else if !dirty && last_flush.elapsed() >= limits.idle_flush {
            last_flush = Instant::now();
        }
    }
}

fn discard_queue(receiver: &Receiver<Box<[u8]>>, shared: &Shared) {
    // Closed admission prevents new work. Already-running producers complete
    // without waiting for the sink; drain their finite sends before dropping the
    // receiver so the health totals do not silently lose accepted records.
    loop {
        while receiver.try_recv().is_ok() {
            shared.health.queue_depth.fetch_sub(1, Ordering::Relaxed);
            shared.health.dropped.fetch_add(1, Ordering::Relaxed);
        }
        if shared.producers_in_flight.load(Ordering::SeqCst) == 0 {
            // A producer may have completed between the first empty receive
            // and the zero observation. Its last admitted record is now visible.
            while receiver.try_recv().is_ok() {
                shared.health.queue_depth.fetch_sub(1, Ordering::Relaxed);
                shared.health.dropped.fetch_add(1, Ordering::Relaxed);
            }
            return;
        }
        thread::park_timeout(Duration::from_millis(1));
    }
}

pub(crate) struct FileSink {
    path: PathBuf,
    limits: Limits,
    lease: Option<File>,
    active: Option<File>,
    last_retention: Instant,
}

impl FileSink {
    pub(crate) fn new(path: PathBuf, limits: Limits) -> Self {
        Self {
            path,
            limits,
            lease: None,
            active: None,
            last_retention: Instant::now(),
        }
    }

    pub(crate) fn with_lease(path: PathBuf, limits: Limits, lease: File) -> Self {
        Self {
            lease: Some(lease),
            ..Self::new(path, limits)
        }
    }

    fn lease_path(&self) -> PathBuf {
        self.path.with_file_name(WRITER_LOCK_NAME)
    }

    fn normalize_namespace(&mut self) -> io::Result<()> {
        // Canonicalizing first would silently accept an aliased ancestor. Check
        // the original spelling both before and after resolving its directory,
        // then reconstruct only our fixed leaf (never canonicalize through it).
        refuse_alias_ancestors(&self.path)?;
        let parent = self.path.parent().ok_or_else(unsafe_file)?;
        let directory = fs::canonicalize(parent)?;
        if !fs::metadata(&directory)?.is_dir() {
            return Err(unsafe_file());
        }
        refuse_alias_ancestors(&self.path)?;
        self.path = directory.join(LOG_FILE_NAME);
        refuse_alias_ancestors(&self.path)
    }

    pub(crate) fn verify_lease(&self) -> io::Result<()> {
        let lease = self.lease.as_ref().ok_or_else(unsafe_file)?;
        validate_held(&self.lease_path(), lease)
    }

    fn clean_retention(&mut self) -> io::Result<()> {
        drop(self.active.take());
        let now = SystemTime::now();
        for index in 0..=self.limits.retained_files {
            let path = rotated_path(&self.path, index);
            let Some(file) = inspect_optional(&path)? else {
                continue;
            };
            let metadata = file.metadata()?;
            let expired = now
                .duration_since(metadata.modified()?)
                .is_ok_and(|age| age > self.limits.max_age);
            if expired || metadata.len() > self.limits.max_file_bytes {
                validate_held(&path, &file)?;
                drop(file);
                safe_remove(&path)?;
            }
        }
        self.last_retention = Instant::now();
        Ok(())
    }

    fn rotate(&mut self) -> Result<(), SinkError> {
        self.flush()?;
        drop(self.active.take());
        if self.limits.retained_files == 0 {
            return safe_remove(&self.path)
                .map_err(|error| SinkError::from_io(FailureStage::Rotation, error));
        }
        let rotate = || -> io::Result<()> {
            // Validate the complete fixed namespace before any rotation edit;
            // a replaced alias cannot cause partial cleanup of other segments.
            for index in 0..=self.limits.retained_files {
                let _ = inspect_optional(&rotated_path(&self.path, index))?;
            }
            for index in (1..=self.limits.retained_files).rev() {
                let destination = rotated_path(&self.path, index);
                safe_remove(&destination)?;
                let source = rotated_path(&self.path, index - 1);
                if let Some(file) = inspect_optional(&source)? {
                    validate_held(&source, &file)?;
                    drop(file);
                    refuse_alias_ancestors(&source)?;
                    refuse_alias_ancestors(&destination)?;
                    fs::rename(source, destination)?;
                }
            }
            Ok(())
        };
        rotate().map_err(|error| SinkError::from_io(FailureStage::Rotation, error))
    }

    fn append(&mut self, record: &[u8]) -> Result<(), SinkError> {
        self.verify_lease()
            .map_err(|error| SinkError::from_io(FailureStage::Lease, error))?;
        if self.last_retention.elapsed() >= RETENTION_INTERVAL {
            self.flush()?;
            self.clean_retention()
                .map_err(|error| SinkError::from_io(FailureStage::Retention, error))?;
        }
        if self.active.is_none() {
            self.active = Some(
                open_owned(&self.path, true)
                    .map_err(|error| SinkError::from_io(FailureStage::Open, error))?,
            );
        }
        let active = self.active.as_ref().ok_or(SinkError {
            stage: FailureStage::Open,
            kind: io::ErrorKind::NotFound,
        })?;
        validate_held(&self.path, active)
            .map_err(|error| SinkError::from_io(FailureStage::Open, error))?;
        // Read the actual size every time, including after a previous partial
        // write failure. No stale cached length can grow a segment past its cap.
        let size = active
            .metadata()
            .map_err(|error| SinkError::from_io(FailureStage::Open, error))?
            .len();
        if size.saturating_add(record.len() as u64) > self.limits.max_file_bytes {
            self.rotate()?;
            self.active = Some(
                open_owned(&self.path, true)
                    .map_err(|error| SinkError::from_io(FailureStage::Open, error))?,
            );
        }
        let file = self.active.as_mut().ok_or(SinkError {
            stage: FailureStage::Open,
            kind: io::ErrorKind::NotFound,
        })?;
        validate_held(&self.path, file)
            .map_err(|error| SinkError::from_io(FailureStage::Open, error))?;
        file.write_all(record)
            .map_err(|error| SinkError::from_io(FailureStage::Write, error))
    }
}

impl DiagnosticSink for FileSink {
    fn initialize(&mut self) -> Result<(), SinkError> {
        self.normalize_namespace()
            .map_err(|error| SinkError::from_io(FailureStage::Open, error))?;
        if self.lease.is_none() {
            let lease = open_owned(&self.lease_path(), false)
                .map_err(|error| SinkError::from_io(FailureStage::Lease, error))?;
            lease
                .try_lock()
                .map_err(|error| SinkError::from_io(FailureStage::Lease, error.into()))?;
            self.lease = Some(lease);
        }
        self.verify_lease()
            .map_err(|error| SinkError::from_io(FailureStage::Lease, error))?;
        self.clean_retention()
            .map_err(|error| SinkError::from_io(FailureStage::Retention, error))
    }

    fn write_record(&mut self, record: &[u8]) -> Result<(), SinkError> {
        let result = self.append(record);
        if result.is_err() {
            drop(self.active.take());
        }
        result
    }

    fn flush(&mut self) -> Result<(), SinkError> {
        if let Some(file) = &self.active {
            validate_held(&self.path, file)
                .and_then(|()| file.sync_data())
                .map_err(|error| SinkError::from_io(FailureStage::Flush, error))?;
        }
        Ok(())
    }
}

pub(crate) fn rotated_path(path: &Path, index: usize) -> PathBuf {
    if index == 0 {
        return path.to_owned();
    }
    let mut name = OsString::from(path.as_os_str());
    name.push(format!(".{index}"));
    PathBuf::from(name)
}

fn unsafe_file() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "runtime diagnostic namespace is not a regular single-link owned path",
    )
}

pub(crate) fn refuse_alias_ancestors(path: &Path) -> io::Result<()> {
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || is_reparse(&metadata) {
                    return Err(unsafe_file());
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

#[cfg(windows)]
fn is_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_reparse(_metadata: &fs::Metadata) -> bool {
    false
}

fn nofollow_options(write: bool, create_new: bool, append: bool) -> OpenOptions {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(write)
        .create_new(create_new)
        .append(append);
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // Linux O_NOFOLLOW | O_NONBLOCK: do not follow a replaced final link or
        // block opening a FIFO that replaced an inspected regular file.
        options.custom_flags(0x20000 | 0x800).mode(0o600);
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // Darwin O_NOFOLLOW | O_NONBLOCK.
        options.custom_flags(0x100 | 0x4).mode(0o600);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_FLAG_OPEN_REPARSE_POINT. Reparse metadata is then rejected.
        options.custom_flags(0x0020_0000);
    }
    options
}

fn checked_file(file: &File) -> io::Result<FileIdentity> {
    let metadata = file.metadata()?;
    if !metadata.is_file() || is_reparse(&metadata) {
        return Err(unsafe_file());
    }
    let (identity, links) = file_identity(file)?;
    if links != 1 {
        return Err(unsafe_file());
    }
    Ok(identity)
}

pub(crate) fn validate_held(path: &Path, held: &File) -> io::Result<()> {
    refuse_alias_ancestors(path)?;
    let named = nofollow_options(false, false, false).open(path)?;
    if checked_file(held)? != checked_file(&named)? || fs::canonicalize(path)? != path {
        return Err(unsafe_file());
    }
    refuse_alias_ancestors(path)
}

pub(crate) fn inspect_optional(path: &Path) -> io::Result<Option<File>> {
    refuse_alias_ancestors(path)?;
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.is_file() || metadata.file_type().is_symlink() || is_reparse(&metadata) {
                return Err(unsafe_file());
            }
            let file = nofollow_options(false, false, false).open(path)?;
            validate_held(path, &file)?;
            Ok(Some(file))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

pub(crate) fn open_owned(path: &Path, append: bool) -> io::Result<File> {
    refuse_alias_ancestors(path)?;
    let file = match nofollow_options(true, true, append).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            let existing = inspect_optional(path)?.ok_or_else(unsafe_file)?;
            let file = nofollow_options(true, false, append).open(path)?;
            if checked_file(&existing)? != checked_file(&file)? {
                return Err(unsafe_file());
            }
            file
        }
        Err(error) => return Err(error),
    };
    validate_held(path, &file)?;
    Ok(file)
}

pub(crate) fn safe_remove(path: &Path) -> io::Result<()> {
    if let Some(file) = inspect_optional(path)? {
        validate_held(path, &file)?;
        drop(file);
        fs::remove_file(path)?;
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileIdentity {
    volume: u64,
    file: u64,
}

#[cfg(unix)]
fn file_identity(file: &File) -> io::Result<(FileIdentity, u64)> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata()?;
    Ok((
        FileIdentity {
            volume: metadata.dev(),
            file: metadata.ino(),
        },
        metadata.nlink(),
    ))
}

#[cfg(windows)]
fn file_identity(file: &File) -> io::Result<(FileIdentity, u64)> {
    use std::os::windows::io::AsRawHandle;

    // The stable std API exposes a raw handle but not its link count. This small
    // platform query keeps the production module and its Linux tests std-only.
    #[repr(C)]
    #[derive(Default)]
    struct FileTime {
        low: u32,
        high: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct FileInformation {
        attributes: u32,
        created: FileTime,
        accessed: FileTime,
        modified: FileTime,
        volume: u32,
        size_high: u32,
        size_low: u32,
        links: u32,
        index_high: u32,
        index_low: u32,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetFileInformationByHandle(
            handle: *mut std::ffi::c_void,
            information: *mut FileInformation,
        ) -> i32;
    }
    let mut information = FileInformation::default();
    // SAFETY: the repr(C) output matches BY_HANDLE_FILE_INFORMATION; its storage
    // is initialized and valid, and the borrowed file handle remains alive.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let identity = (u64::from(information.index_high) << 32) | u64::from(information.index_low);
    if identity == 0 || identity == u64::MAX || information.attributes & 0x400 != 0 {
        return Err(unsafe_file());
    }
    Ok((
        FileIdentity {
            volume: u64::from(information.volume),
            file: identity,
        },
        u64::from(information.links),
    ))
}

#[cfg(not(any(unix, windows)))]
fn file_identity(_file: &File) -> io::Result<(FileIdentity, u64)> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "runtime diagnostic file identity is unavailable on this platform",
    ))
}

#[cfg(test)]
#[path = "writer_tests.rs"]
mod tests;
