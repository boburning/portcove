//! Finite, exhaustive recovery command pairs; expectations do not read production state.
use super::*;
use std::collections::BTreeSet;

#[derive(Clone, Copy, Debug)]
enum Model {
    Copying,
    Verified,
    Published,
    Activated,
    Complete,
    Aborted { copied: bool },
}

#[derive(Clone, Copy, Debug)]
enum Command {
    Resume,
    Abort,
}

impl Model {
    fn transition(self, command: Command) -> (Self, bool) {
        match (self, command) {
            (Self::Aborted { .. }, Command::Resume) => (self, false),
            (_, Command::Resume) => (Self::Complete, true),
            (Self::Copying, Command::Abort) => (Self::Aborted { copied: false }, true),
            (Self::Verified, Command::Abort) => (Self::Aborted { copied: true }, true),
            (Self::Aborted { .. }, Command::Abort) => (self, true),
            (_, Command::Abort) => (self, false),
        }
    }

    fn observation(self, destination_payload: &[u8]) -> Observation {
        let copied = !matches!(self, Self::Copying | Self::Aborted { copied: false });
        let active = matches!(self, Self::Activated | Self::Complete);
        Observation {
            journal: match self {
                Self::Copying => TransferPhase::Copying,
                Self::Verified => TransferPhase::Verified,
                Self::Published | Self::Activated => TransferPhase::Published,
                Self::Complete => TransferPhase::Complete,
                Self::Aborted { .. } => TransferPhase::Aborted,
            },
            source_authority: match self {
                Self::Copying | Self::Verified => Some(AuthorityState::Pending),
                Self::Published | Self::Activated | Self::Complete => Some(AuthorityState::Moved),
                Self::Aborted { .. } => None,
            },
            destination_authority: (!active).then_some(AuthorityState::Pending),
            receipt: copied,
            writable_roots: if active {
                BTreeSet::from(["destination"])
            } else if matches!(self, Self::Aborted { .. }) {
                BTreeSet::from(["source"])
            } else {
                BTreeSet::new()
            },
            source_payload: b"save".to_vec(),
            destination_payload: copied.then(|| destination_payload.to_vec()),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Observation {
    journal: TransferPhase,
    source_authority: Option<AuthorityState>,
    destination_authority: Option<AuthorityState>,
    receipt: bool,
    writable_roots: BTreeSet<&'static str>,
    source_payload: Vec<u8>,
    destination_payload: Option<Vec<u8>>,
}

fn compare_step(
    step: usize,
    expected: &Observation,
    actual: &Observation,
) -> std::result::Result<(), (usize, &'static str)> {
    for (channel, equal) in [
        ("journal", expected.journal == actual.journal),
        (
            "source authority",
            expected.source_authority == actual.source_authority,
        ),
        (
            "destination authority",
            expected.destination_authority == actual.destination_authority,
        ),
        ("publication receipt", expected.receipt == actual.receipt),
        (
            "writable roots",
            expected.writable_roots == actual.writable_roots,
        ),
        (
            "source bytes",
            expected.source_payload == actual.source_payload,
        ),
        (
            "destination bytes",
            expected.destination_payload == actual.destination_payload,
        ),
    ] {
        if !equal {
            return Err((step, channel));
        }
    }
    Ok(())
}

fn observe(source: &Path, destination: &Path, transfer_id: &str, plan_sha256: &str) -> Observation {
    let journal = TransferJournal::read(source).unwrap();
    assert_eq!(journal.transfer_id, transfer_id);
    assert_eq!(journal.plan.plan_sha256, plan_sha256);
    let markers = [source, destination].map(|root| {
        let marker = library_authority::authority(root).unwrap();
        if let Some(marker) = &marker {
            assert_eq!(marker.transfer_id, transfer_id);
            assert_eq!(marker.source_root.as_deref(), Some(source));
            assert_eq!(marker.destination, destination);
        }
        marker.map(|marker| marker.state)
    });
    let receipt = destination.join(".portcove-transfer-receipt.json").exists();
    if receipt {
        library_authority::verify_receipt(destination, transfer_id).unwrap();
    }
    let mut writable_roots = BTreeSet::new();
    for root in [source, destination] {
        match Library::open(root) {
            Ok(library) => {
                let actual = fs::canonicalize(library.root()).unwrap();
                writable_roots.insert(if actual == source {
                    "source"
                } else {
                    assert_eq!(actual, destination);
                    "destination"
                });
            }
            Err(error) => assert_eq!(error.code, crate::ErrorCode::Conflict),
        }
    }
    let destination_file = destination.join("user/starship/data.bin");
    Observation {
        journal: journal.phase,
        source_authority: markers[0],
        destination_authority: markers[1],
        receipt,
        writable_roots,
        source_payload: fs::read(source.join("user/starship/data.bin")).unwrap(),
        destination_payload: match fs::read(destination_file) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => panic!("destination observation failed: {error}"),
        },
    }
}

fn sequence(fault: TransferPhase, initial: Model, script: u8) {
    let temporary = tempfile::tempdir().unwrap();
    let source = temporary.path().join("source");
    let destination = temporary.path().join("destination");
    let service = super::tests::fixture(&source);
    let plan = service.plan_library_move(&destination).unwrap();
    drop(service);
    let error = start_move(&source, &destination, &plan.plan_sha256, &|phase| {
        if phase == fault {
            Err(PortcoveError::state("sequence model interruption"))
        } else {
            Ok(())
        }
    })
    .unwrap_err();
    assert_eq!(error.message, "sequence model interruption");
    let source = fs::canonicalize(source).unwrap();
    let destination = fs::canonicalize(destination).unwrap();
    let id = TransferJournal::read(&source).unwrap().transfer_id;
    let mut model = initial;
    let mut payload = b"save".to_vec();
    let check = |step, model: Model, payload: &[u8]| {
        let actual = observe(&source, &destination, &id, &plan.plan_sha256);
        assert_eq!(
            compare_step(step, &model.observation(payload), &actual),
            Ok(()),
            "fault={fault:?}, script={script}, actual={actual:?}"
        );
    };
    check(0, model, &payload);
    if matches!(model, Model::Activated) {
        payload = b"new player save before first recovery".to_vec();
        fs::write(destination.join("user/starship/data.bin"), &payload).unwrap();
        check(0, model, &payload);
    }
    // Two bits enumerate all command pairs, then repeat the terminal command twice.
    for step in 0..4 {
        let command = if script & (1 << step.min(1)) == 0 {
            Command::Resume
        } else {
            Command::Abort
        };
        let (next, accepted) = model.transition(command);
        let result = match command {
            Command::Resume => PortcoveService::resume_library_move(&source),
            Command::Abort => PortcoveService::abort_library_move(&source),
        };
        assert_eq!(
            result.is_ok(),
            accepted,
            "fault={fault:?}, script={script}, step={step}, command={command:?}"
        );
        if accepted {
            let result = result.unwrap();
            let completed = matches!(command, Command::Resume);
            assert_eq!(result.completed, completed);
            assert_eq!(result.transfer_id, id);
            assert_eq!(result.source_root, source);
            assert_eq!(result.destination_root, destination);
            assert_eq!(
                &result.active_root,
                if completed { &destination } else { &source }
            );
            assert!(result.source_retained);
        } else {
            assert_eq!(result.unwrap_err().code, crate::ErrorCode::Conflict);
        }
        model = next;
        check(step * 4 + 1, model, &payload);
        if matches!(model, Model::Activated | Model::Complete) {
            payload = format!("new player save at step {step}").into_bytes();
            fs::write(destination.join("user/starship/data.bin"), &payload).unwrap();
            check(step * 4 + 2, model, &payload);
        }
        // Observe each wrong-root command separately so a later command cannot hide an effect.
        let unrelated = temporary.path().join("unrelated");
        assert!(PortcoveService::resume_library_move(&unrelated).is_err());
        assert!(!unrelated.exists());
        check(step * 4 + 3, model, &payload);
        assert!(PortcoveService::abort_library_move(&unrelated).is_err());
        assert!(!unrelated.exists());
        check(step * 4 + 4, model, &payload);
    }
}

macro_rules! sequence_case {
    ($name:ident, $fault:ident, $model:ident, $script:literal) => {
        #[test]
        fn $name() {
            sequence(TransferPhase::$fault, Model::$model, $script);
        }
    };
}
sequence_case!(copying_resume_resume, Copying, Copying, 0);
sequence_case!(copying_abort_resume, Copying, Copying, 1);
sequence_case!(copying_resume_abort, Copying, Copying, 2);
sequence_case!(copying_abort_abort, Copying, Copying, 3);
sequence_case!(verified_resume_resume, Verified, Verified, 0);
sequence_case!(verified_abort_resume, Verified, Verified, 1);
sequence_case!(verified_resume_abort, Verified, Verified, 2);
sequence_case!(verified_abort_abort, Verified, Verified, 3);
sequence_case!(published_resume_resume, Published, Published, 0);
sequence_case!(published_abort_resume, Published, Published, 1);
sequence_case!(published_resume_abort, Published, Published, 2);
sequence_case!(published_abort_abort, Published, Published, 3);
sequence_case!(activated_resume_resume, Complete, Activated, 0);
sequence_case!(activated_abort_resume, Complete, Activated, 1);
sequence_case!(activated_resume_abort, Complete, Activated, 2);
sequence_case!(activated_abort_abort, Complete, Activated, 3);

#[test]
fn model_rejects_transient_unsafe_ownership_even_when_terminal_state_matches() {
    let pending = Model::Verified.observation(b"save");
    let mut unsafe_step = pending.clone();
    unsafe_step.destination_authority = None;
    unsafe_step.writable_roots.insert("destination");
    let terminal = Model::Complete.observation(b"later save");
    assert_eq!(
        compare_step(2, &pending, &unsafe_step),
        Err((2, "destination authority"))
    );
    assert_eq!(compare_step(3, &terminal, &terminal), Ok(()));
}
