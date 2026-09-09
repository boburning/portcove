use crate::{ChildProcessClass, ChildProcessPolicy};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub(crate) fn build_probe(directory: &Path) -> PathBuf {
    let executable = directory.join(if cfg!(windows) {
        "host_tool_probe.exe"
    } else {
        "host_tool_probe"
    });
    if let Some(prepared) = std::env::var_os("PORTCOVE_HOST_TOOL_FIXTURE") {
        fs::copy(prepared, &executable).unwrap();
        crate::permissions::normalize_archive_entry(&executable, false, true).unwrap();
        return executable;
    }
    let source = directory.join("host_tool_probe.rs");
    fs::write(&source, include_str!("testdata/host_tool_probe.rs.txt")).unwrap();
    let mut rustc =
        ChildProcessPolicy::native_command(ChildProcessClass::ManagedBuilder, "rustc").unwrap();
    assert!(
        rustc
            .arg(&source)
            .arg("-o")
            .arg(&executable)
            .status()
            .unwrap()
            .success()
    );
    crate::permissions::normalize_archive_entry(&executable, false, true).unwrap();
    executable
}
