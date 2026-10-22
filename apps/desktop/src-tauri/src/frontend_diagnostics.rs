//! The single renderer-failure reporting boundary. Renderer input is descriptive
//! only: it cannot supply operation/activity identity or authorize any command.

use serde::Deserialize;
use std::{
    cell::Cell,
    sync::Mutex,
    time::{Duration, Instant},
};

const WINDOW: Duration = Duration::from_secs(60);
const REPORTS_PER_WINDOW: usize = 4;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ErrorKind {
    Error,
    TypeError,
    RangeError,
    ReferenceError,
    SyntaxError,
    Unknown,
}
impl ErrorKind {
    fn label(self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::TypeError => "type_error",
            Self::RangeError => "range_error",
            Self::ReferenceError => "reference_error",
            Self::SyntaxError => "syntax_error",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct FrontendFailureReport {
    schema_version: u8,
    report_id: u32,
    kind: ErrorKind,
    message_bytes: u16,
    stack_bytes: u16,
    truncated: bool,
}

struct Window {
    began: Instant,
    ids: [u32; REPORTS_PER_WINDOW],
    count: usize,
}
pub(crate) struct FrontendReports(Mutex<Window>);
impl Default for FrontendReports {
    fn default() -> Self {
        Self(Mutex::new(Window {
            began: Instant::now(),
            ids: [0; REPORTS_PER_WINDOW],
            count: 0,
        }))
    }
}
thread_local! { static REPORTING: Cell<bool> = const { Cell::new(false) }; }
struct Reporting;
impl Drop for Reporting {
    fn drop(&mut self) {
        REPORTING.with(|active| active.set(false));
    }
}

impl FrontendReports {
    pub(crate) fn report(&self, report: FrontendFailureReport) {
        self.submit(report, Instant::now(), || {
            // No raw message, stack, URL, path, arguments or renderer-provided
            // operation identity crosses this boundary, even before redaction.
            tracing::error!(
                component = "frontend",
                observation = "renderer",
                phase = "render",
                command = "report_frontend_error",
                error_kind = report.kind.label(),
                report_id = report.report_id,
                message_bytes = report.message_bytes,
                stack_bytes = report.stack_bytes,
                truncated = report.truncated,
                message = "Frontend rendering failed"
            );
        });
    }

    fn submit(&self, report: FrontendFailureReport, now: Instant, emit: impl FnOnce()) -> bool {
        if report.schema_version != 1
            || report.report_id == 0
            || report.message_bytes > 1_024
            || report.stack_bytes > 4_096
        {
            return false;
        }
        if REPORTING.with(|active| active.replace(true)) {
            return false;
        }
        let _reporting = Reporting;
        let Ok(mut window) = self.0.try_lock() else {
            return false;
        };
        if now.saturating_duration_since(window.began) >= WINDOW {
            window.began = now;
            window.ids = [0; REPORTS_PER_WINDOW];
            window.count = 0;
        }
        if window.count == REPORTS_PER_WINDOW
            || window.ids[..window.count].contains(&report.report_id)
        {
            return false;
        }
        let index = window.count;
        window.ids[index] = report.report_id;
        window.count += 1;
        drop(window);
        emit();
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn report(id: u32) -> FrontendFailureReport {
        FrontendFailureReport {
            schema_version: 1,
            report_id: id,
            kind: ErrorKind::Error,
            message_bytes: 12,
            stack_bytes: 20,
            truncated: false,
        }
    }

    #[test]
    fn frontend_reports_bound_bursts_duplicates_and_window_expiry() {
        let reports = FrontendReports::default();
        let now = reports.0.lock().unwrap().began;
        let calls = Cell::new(0);
        for id in 1..=100 {
            reports.submit(report(id), now, || calls.set(calls.get() + 1));
            assert!(!reports.submit(report(id), now, || panic!("duplicate")));
        }
        assert_eq!(calls.get(), REPORTS_PER_WINDOW);
        assert!(!reports.submit(
            report(101),
            now + WINDOW - Duration::from_nanos(1),
            || panic!("before expiry")
        ));
        assert!(reports.submit(report(101), now + WINDOW, || calls.set(calls.get() + 1)));
        assert_eq!(calls.get(), 5);
    }

    #[test]
    fn frontend_reports_refuse_recursive_and_contended_reporting() {
        let reports = FrontendReports::default();
        assert!(reports.submit(report(1), Instant::now(), || {
            assert!(!reports.submit(report(2), Instant::now(), || panic!("recursion")));
        }));
        assert!(reports.submit(report(2), Instant::now(), || {}));
        let lock = reports.0.lock().unwrap();
        assert!(!reports.submit(report(3), Instant::now(), || panic!("contention")));
        drop(lock);
        assert!(reports.submit(report(3), Instant::now(), || {}));
    }

    #[test]
    fn frontend_reports_reject_unknown_fields_versions_sizes_and_private_payloads() {
        let reports = FrontendReports::default();
        let mut input = serde_json::json!({"schema_version":1,"report_id":1,"kind":"type_error","message_bytes":12,"stack_bytes":20,"truncated":false});
        for name in [
            "message",
            "component_stack",
            "operation_id",
            "activity_id",
            "url",
            "path",
        ] {
            input[name] = serde_json::json!("private-canary");
            assert!(serde_json::from_value::<FrontendFailureReport>(input.clone()).is_err());
            input.as_object_mut().unwrap().remove(name);
        }
        for (field, value) in [
            ("schema_version", 2),
            ("report_id", 0),
            ("message_bytes", 1_025),
            ("stack_bytes", 4_097),
        ] {
            let mut invalid = input.clone();
            invalid[field] = serde_json::json!(value);
            let invalid = serde_json::from_value(invalid).unwrap();
            assert!(!reports.submit(invalid, Instant::now(), || panic!("invalid input")));
        }
        input["kind"] = serde_json::json!("private-kind-canary");
        assert!(serde_json::from_value::<FrontendFailureReport>(input).is_err());
    }

    #[test]
    fn frontend_reports_stay_bounded_when_runtime_logging_is_closed() {
        use crate::diagnostics_writer::{DiagnosticSink, Limits, RuntimeWriter, SinkError};
        use tracing_subscriber::layer::SubscriberExt;
        struct Sink;
        impl DiagnosticSink for Sink {
            fn write_record(&mut self, _: &[u8]) -> Result<(), SinkError> {
                Ok(())
            }
            fn flush(&mut self) -> Result<(), SinkError> {
                Ok(())
            }
        }
        let (producer, mut writer) =
            RuntimeWriter::start_with_sink(Limits::default(), Sink).unwrap();
        writer.shutdown(Duration::from_secs(2));
        let health = producer.clone();
        let subscriber = tracing_subscriber::registry()
            .with(crate::diagnostics_events::DiagnosticLayer::new(producer));
        let reports = FrontendReports::default();
        tracing::subscriber::with_default(subscriber, || {
            for id in 1..=100 {
                reports.report(report(id));
                reports.report(report(id));
            }
        });
        assert_eq!(health.health().written, 0);
        assert_eq!(health.health().dropped_closed, REPORTS_PER_WINDOW as u64);
        assert_eq!(reports.0.lock().unwrap().count, REPORTS_PER_WINDOW);
    }
}
