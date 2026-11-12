//! TAR.GZ download extraction through the production reader and its limits.
#![no_main]

use libfuzzer_sys::fuzz_target;
use portcove_core::archive_fuzzing::{ArchiveFormat, extract_download_archive};

fuzz_target!(|data: &[u8]| {
    // A refusal is the expected outcome for most inputs. Panics and contract
    // violations inside the entry are the findings.
    let _ = extract_download_archive(ArchiveFormat::TarGz, data);
});
