use std::{
    fs::File,
    io::Write,
    path::Path,
    sync::{
        OnceLock,
        atomic::{AtomicBool, Ordering},
    },
};

use portcove_core::runtime_diagnostics::{PANIC_RECORD, PANIC_RECORD_NAME};

static INSTALLED: AtomicBool = AtomicBool::new(false);
static ATTEMPTED: AtomicBool = AtomicBool::new(false);
static RECORD: OnceLock<File> = OnceLock::new();

/// Install at executable entry. Keep the previous hook and record at most the
/// first observed Rust panic after a diagnostic session has prepared its file.
pub fn install_panic_hook() {
    if INSTALLED.swap(true, Ordering::AcqRel) {
        return;
    }
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let Some(mut file) = RECORD.get()
            && !ATTEMPTED.swap(true, Ordering::Relaxed)
        {
            // One write to an already opened file. The fixed event excludes
            // payload, location and backtrace data and needs no logger or lock.
            let _ = file.write(PANIC_RECORD);
        }
        previous(info);
    }));
}

pub(crate) fn prepare(directory: &Path) -> Option<File> {
    if INSTALLED.load(Ordering::Acquire) {
        crate::writer::open_owned(&directory.join(PANIC_RECORD_NAME), true).ok()
    } else {
        None
    }
}

pub(crate) fn publish(file: Option<File>) {
    if let Some(file) = file {
        let _ = RECORD.set(file);
    }
}
