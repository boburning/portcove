//! Bounded diagnostic context; these observations confer no output authority.
use crate::Result;
use serde::Serialize;
use std::time::Instant;

#[derive(Clone, Copy)]
pub(super) enum PostLinkStage {
    GeneratedSourceIntegrity,
    InputIntegrityBeforePackage,
    PackagePreparation,
    ImportInspection,
    FinalInputIntegrity,
    OutputInventory,
    ReceiptAndActivation,
}

impl PostLinkStage {
    fn name(self) -> &'static str {
        match self {
            Self::GeneratedSourceIntegrity => "generated_source_integrity",
            Self::InputIntegrityBeforePackage => "input_integrity_before_package",
            Self::PackagePreparation => "package_preparation",
            Self::ImportInspection => "import_inspection",
            Self::FinalInputIntegrity => "final_input_integrity",
            Self::OutputInventory => "output_inventory",
            Self::ReceiptAndActivation => "receipt_and_activation",
        }
    }
}

#[derive(Clone, Copy, Serialize)]
pub(super) struct StageTiming {
    stage: &'static str,
    elapsed_ms: u64,
}

#[derive(Default)]
pub(super) struct PostLinkTimings {
    completed: [Option<StageTiming>; 7],
}

impl PostLinkTimings {
    pub(super) fn completed(&self) -> Vec<StageTiming> {
        self.completed.iter().flatten().copied().collect()
    }

    pub(super) fn run<T>(
        &mut self,
        stage: PostLinkStage,
        action: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        let started = Instant::now();
        let result = action();
        let elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        match result {
            Ok(value) => {
                self.completed[stage as usize] = Some(StageTiming {
                    stage: stage.name(),
                    elapsed_ms,
                });
                Ok(value)
            }
            Err(mut error) => {
                // Preserve existing (including nested) context, code, message and
                // failure presentation. Diagnostic serialization cannot mask it.
                error
                    .details
                    .entry("cvlod_stage".into())
                    .or_insert_with(|| stage.name().into());
                error
                    .details
                    .entry("cvlod_stage_elapsed_ms".into())
                    .or_insert_with(|| elapsed_ms.to_string());
                if let Ok(completed) = serde_json::to_string(&self.completed())
                    && completed.len() <= 1024
                {
                    error
                        .details
                        .entry("cvlod_completed_stage_timings".into())
                        .or_insert(completed);
                }
                Err(error)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ErrorCode, PortcoveError};
    use std::cell::Cell;

    #[test]
    fn cvlod_post_link_timing_preserves_failures_and_distinguishes_completed_stages() {
        let mut timings = PostLinkTimings::default();
        assert_eq!(
            timings
                .run(PostLinkStage::GeneratedSourceIntegrity, || Ok(42))
                .unwrap(),
            42
        );
        let calls = Cell::new(0);
        let original = PortcoveError::new(ErrorCode::Cancelled, "original cancellation")
            .detail("original", "retained");
        let failure_pointer = std::ptr::from_ref(original.failure.as_ref());
        let error = timings
            .run(PostLinkStage::PackagePreparation, || {
                calls.set(calls.get() + 1);
                Err::<(), _>(original)
            })
            .unwrap_err();
        assert_eq!(calls.get(), 1);
        assert_eq!(error.code, ErrorCode::Cancelled);
        assert_eq!(error.message, "original cancellation");
        assert_eq!(error.details["original"], "retained");
        assert_eq!(std::ptr::from_ref(error.failure.as_ref()), failure_pointer);
        assert_eq!(error.details["cvlod_stage"], "package_preparation");
        error.details["cvlod_stage_elapsed_ms"]
            .parse::<u64>()
            .unwrap();
        let completed: serde_json::Value =
            serde_json::from_str(&error.details["cvlod_completed_stage_timings"]).unwrap();
        assert_eq!(completed.as_array().unwrap().len(), 1);
        assert_eq!(completed[0]["stage"], "generated_source_integrity");
        assert_eq!(timings.completed().len(), 1);
    }

    #[test]
    fn cvlod_post_link_timing_never_overwrites_existing_error_context() {
        let mut timings = PostLinkTimings::default();
        let original = PortcoveError::verification("prior failure")
            .detail("cvlod_stage", "inner_stage")
            .detail("cvlod_stage_elapsed_ms", "12")
            .detail("cvlod_completed_stage_timings", "prior timings");
        let expected = original.details.clone();
        let error = timings
            .run(PostLinkStage::FinalInputIntegrity, || {
                Err::<(), _>(original)
            })
            .unwrap_err();
        assert_eq!(error.details, expected);
        assert!(timings.completed().is_empty());
    }

    #[test]
    fn cvlod_post_link_timing_has_a_fixed_bounded_stage_set() {
        let mut timings = PostLinkTimings::default();
        for stage in [
            PostLinkStage::GeneratedSourceIntegrity,
            PostLinkStage::InputIntegrityBeforePackage,
            PostLinkStage::PackagePreparation,
            PostLinkStage::ImportInspection,
            PostLinkStage::FinalInputIntegrity,
            PostLinkStage::OutputInventory,
            PostLinkStage::ReceiptAndActivation,
        ] {
            timings.run(stage, || Ok(())).unwrap();
        }
        assert_eq!(timings.completed().len(), 7);
        assert!(serde_json::to_string(&timings.completed()).unwrap().len() <= 1024);
    }
}
