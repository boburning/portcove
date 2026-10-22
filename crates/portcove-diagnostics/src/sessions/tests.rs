use super::*;
use std::time::Duration;

fn retained(
    root: &Path,
    index: usize,
    started_at_ms: u64,
    complete: bool,
    bytes: u64,
) -> uuid::Uuid {
    let slot = lock_slot(root, SLOT_NAMES[index], true).unwrap().unwrap();
    let session_id = uuid::Uuid::new_v4();
    write_marker(
        &slot.directory,
        &Marker {
            schema_version: 1,
            session_id,
            surface: Surface::Desktop,
            process_id: 1,
            started_at_ms,
            complete,
        },
    )
    .unwrap();
    for rotation in 0..=writer::DEFAULT_RETAINED_FILES {
        let file = open_owned(
            &rotated_path(&slot.directory.join(writer::LOG_FILE_NAME), rotation),
            false,
        )
        .unwrap();
        file.set_len(bytes).unwrap();
    }
    session_id
}

#[test]
fn unclean_age_retention_is_observed_without_inventing_a_crash_or_touching_unknown_files() {
    let temp = tempfile::tempdir().unwrap();
    let now = UNIX_EPOCH + Duration::from_secs(20 * 24 * 60 * 60);
    let identity = retained(temp.path(), 0, 1, false, 32);
    let unknown = temp.path().join(SLOT_NAMES[0]).join("user-file.txt");
    fs::write(&unknown, "preserve unknown files").unwrap();
    let (allocation, report, previous) =
        allocate_at(temp.path(), uuid::Uuid::new_v4(), Surface::Cli, now);
    assert!(allocation.is_some());
    assert_eq!(report.previous_unclean_sessions, 1);
    assert_eq!(previous, vec![identity.to_string()]);
    assert_eq!(report.pruned_sessions, 1);
    assert_eq!(
        fs::read_to_string(unknown).unwrap(),
        "preserve unknown files"
    );
    let allocation = allocation.unwrap();
    assert!(!allocation.directory.join(writer::LOG_FILE_NAME).exists());
    assert!(
        !read_marker(&allocation.directory)
            .unwrap()
            .unwrap()
            .complete
    );
}

#[test]
fn inactive_byte_target_prunes_oldest_sessions_and_preserves_active_old_session() {
    let temp = tempfile::tempdir().unwrap();
    let now = UNIX_EPOCH + Duration::from_secs(10_000);
    for index in 0..4 {
        retained(
            temp.path(),
            index,
            1_000 + index as u64,
            true,
            writer::DEFAULT_MAX_FILE_BYTES,
        );
    }
    let active = lock_slot(temp.path(), SLOT_NAMES[0], false)
        .unwrap()
        .unwrap();
    let active_bytes = fs::metadata(active.directory.join(writer::LOG_FILE_NAME))
        .unwrap()
        .len();
    let (allocation, report, _) = allocate_at(temp.path(), uuid::Uuid::new_v4(), Surface::Cli, now);
    assert!(allocation.is_some());
    assert_eq!(report.active_sessions, 1);
    assert!(report.pruned_sessions >= 1);
    assert!(report.retained_inactive_bytes <= INACTIVE_BYTE_TARGET);
    assert_eq!(
        fs::metadata(active.directory.join(writer::LOG_FILE_NAME))
            .unwrap()
            .len(),
        active_bytes
    );
    assert!(read_marker(&active.directory).unwrap().unwrap().complete);
}

#[test]
fn unmarked_malformed_and_hardlinked_slots_are_preserved_and_not_adopted() {
    let temp = tempfile::tempdir().unwrap();
    let unmarked = temp.path().join(SLOT_NAMES[0]);
    fs::create_dir(&unmarked).unwrap();
    fs::write(unmarked.join(writer::LOG_FILE_NAME), "unowned data").unwrap();
    let malformed = temp.path().join(SLOT_NAMES[1]);
    fs::create_dir(&malformed).unwrap();
    fs::write(malformed.join(SESSION_MARKER), "invalid-marker").unwrap();
    let linked = temp.path().join(SLOT_NAMES[2]);
    fs::create_dir(&linked).unwrap();
    let original = temp.path().join("user-file");
    fs::write(&original, "preserved user bytes").unwrap();
    fs::hard_link(&original, linked.join(SESSION_MARKER)).unwrap();
    let (allocation, report, _) = allocate(temp.path(), uuid::Uuid::new_v4(), Surface::Cli);
    assert_eq!(
        allocation.unwrap().directory.file_name().unwrap(),
        SLOT_NAMES[3]
    );
    assert_eq!(report.unavailable_sessions, 3);
    assert_eq!(
        fs::read_to_string(unmarked.join(writer::LOG_FILE_NAME)).unwrap(),
        "unowned data"
    );
    assert_eq!(
        fs::read_to_string(malformed.join(SESSION_MARKER)).unwrap(),
        "invalid-marker"
    );
    assert_eq!(
        fs::read_to_string(original).unwrap(),
        "preserved user bytes"
    );
}

#[test]
fn held_session_lease_outlives_a_timed_out_guard() {
    use std::sync::mpsc;
    struct BlockedSession {
        _allocation: Allocation,
        entered: mpsc::SyncSender<()>,
        release: mpsc::Receiver<()>,
    }
    impl DiagnosticSink for BlockedSession {
        fn write_record(&mut self, _: &[u8]) -> Result<(), SinkError> {
            self.entered.send(()).unwrap();
            self.release.recv().unwrap();
            Ok(())
        }
        fn flush(&mut self) -> Result<(), SinkError> {
            Ok(())
        }
    }
    let temp = tempfile::tempdir().unwrap();
    let (allocation, _, _) = allocate(temp.path(), uuid::Uuid::new_v4(), Surface::Desktop);
    let allocation = allocation.unwrap();
    // Strict readers need the allocator's canonical path, including the Windows prefix.
    let session_directory = allocation.directory.clone();
    let slot = allocation
        .directory
        .file_name()
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    let (entered, observe) = mpsc::sync_channel(1);
    let (release, wait) = mpsc::sync_channel(1);
    let (producer, mut guard) = writer::RuntimeWriter::start_with_sink(
        Limits::default(),
        BlockedSession {
            _allocation: allocation,
            entered,
            release: wait,
        },
    )
    .unwrap();
    producer.try_record(b"{}\n".to_vec());
    observe.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(
        guard.shutdown(Duration::from_millis(10)).flush_state,
        writer::FlushState::TimedOut
    );
    drop(guard);
    assert_eq!(
        lock_slot(temp.path(), &slot, false).err().unwrap().kind(),
        io::ErrorKind::WouldBlock
    );
    release.send(()).unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        match lock_slot(temp.path(), &slot, false) {
            Ok(Some(_)) => break,
            _ => {
                assert!(std::time::Instant::now() < deadline);
                std::thread::yield_now();
            }
        }
    }
    let marker = read_marker(&session_directory).unwrap().unwrap();
    assert!(!marker.complete);
}

#[test]
fn age_retention_preserves_a_leased_session_and_marks_only_observed_inactive_sessions_unclean() {
    let temp = tempfile::tempdir().unwrap();
    let active_id = retained(temp.path(), 0, 1, false, 32);
    let stale_id = retained(temp.path(), 1, 1, false, 32);
    let active = lock_slot(temp.path(), SLOT_NAMES[0], false)
        .unwrap()
        .unwrap();
    let now = UNIX_EPOCH + Duration::from_secs(20 * 24 * 60 * 60);
    let (allocation, report, previous) =
        allocate_at(temp.path(), uuid::Uuid::new_v4(), Surface::Cli, now);
    assert!(allocation.is_some());
    assert_eq!(report.active_sessions, 1);
    assert_eq!(report.previous_unclean_sessions, 1);
    assert_eq!(previous, vec![stale_id.to_string()]);
    assert_eq!(report.pruned_sessions, 1);
    assert_eq!(
        read_marker(&active.directory).unwrap().unwrap().session_id,
        active_id
    );
    assert_eq!(
        fs::metadata(active.directory.join(writer::LOG_FILE_NAME))
            .unwrap()
            .len(),
        32
    );
}
