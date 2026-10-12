//! Pending work is a fresh observation, not a durable compile/retry grant.
use crate::{ActivityDiagnostic, PortcoveError, Result};

// Console-pool edges print at start; ordinary edges print at completion. The
// finished-edge ordinal therefore cannot identify each printed command.
pub(super) const STATUS: &str = "[portcove:%t] ";
const MAX_COMMANDS: usize = 64;

pub(super) struct PendingCommands {
    pub(super) count: usize,
}

pub(super) fn inspect(capture: &ActivityDiagnostic, quiesced: bool) -> Result<PendingCommands> {
    let refused = || {
        PortcoveError::verification(
            "PS1 pending-command observation is incomplete or exceeds its command budget",
        )
    };
    if !quiesced
        || !capture.complete
        || capture.stdout.truncated
        || capture.stderr.truncated
        || capture.stdout.observed_bytes != capture.stdout.text.len() as u64
    {
        return Err(refused());
    }
    if capture.stdout.text.trim_end_matches(['\n', '\r']) == "ninja: no work to do." {
        return Ok(PendingCommands { count: 0 });
    }
    let mut expected_total = None;
    let mut completed = 0;
    for line in capture.stdout.text.lines() {
        let prefix = line.strip_prefix("[portcove:").ok_or_else(refused)?;
        let (total, _) = prefix.split_once("] ").ok_or_else(refused)?;
        if total.is_empty() || !total.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(refused());
        }
        let total = total.parse::<usize>().map_err(|_| refused())?;
        if total == 0
            || total > MAX_COMMANDS
            || completed >= total
            || expected_total.is_some_and(|expected| expected != total)
        {
            return Err(refused());
        }
        expected_total = Some(total);
        completed += 1;
    }
    if expected_total != Some(completed) || completed == 0 {
        return Err(refused());
    }
    Ok(PendingCommands { count: completed })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn capture(text: &str) -> ActivityDiagnostic {
        ActivityDiagnostic {
            activity_id: "inert-pending".into(),
            phase: "install.ps1.builder".into(),
            stdout: crate::DiagnosticStream {
                text: text.into(),
                observed_bytes: text.len() as u64,
                truncated: false,
            },
            stderr: crate::DiagnosticStream {
                text: String::new(),
                observed_bytes: 0,
                truncated: false,
            },
            complete: true,
            updated_at: 0,
            stream_limit_bytes: 2 * 1024 * 1024,
        }
    }
    #[test]
    fn ninja_pending_observation_requires_complete_positive_closure_and_fixed_totals() {
        assert_eq!(
            inspect(&capture("[portcove:2] compile\n[portcove:2] link\n"), true)
                .unwrap()
                .count,
            2
        );
        assert_eq!(
            inspect(&capture("ninja: no work to do.\n"), true)
                .unwrap()
                .count,
            0
        );
        let text = "[portcove:1] compile\n";
        assert!(inspect(&capture(text), false).is_err());
        let mut partial = capture(text);
        partial.complete = false;
        assert!(inspect(&partial, true).is_err());
        partial = capture(text);
        partial.stdout.truncated = true;
        assert!(inspect(&partial, true).is_err());
        partial = capture(text);
        partial.stdout.observed_bytes += 1;
        assert!(inspect(&partial, true).is_err());
        for invalid in [
            "",
            "[portcove:2] incomplete\n",
            "[portcove:1] done\n[portcove:1] again\n",
            "[portcove:2] one\n[portcove:3] changed total\n",
            "ninja: no work to do.\n[portcove:1] contradictory\n",
            "[portcove:65] oversized\n",
            "[portcove:1] description\nunknown extra output\n",
            "[portcove:] missing total\n",
            "[portcove:0] impossible\n",
            "[portcove:0/1] obsolete finished ordinal\n",
        ] {
            assert!(inspect(&capture(invalid), true).is_err(), "{invalid}");
        }
    }
    #[test]
    fn ninja_pending_observation_counts_console_start_and_ordinary_finish_statuses() {
        // The owned total-only prefix is identical at console start (%f=0)
        // and ordinary completion. Console completion prints no second line.
        assert_eq!(
            inspect(&capture("[portcove:1] console command\n"), true)
                .unwrap()
                .count,
            1
        );
        assert_eq!(inspect(&capture("[portcove:3] console start\n[portcove:3] ordinary finish\n[portcove:3] final console start\n"), true).unwrap().count, 3);
        assert!(
            inspect(
                &capture("[portcove:3] console start\n[portcove:3] ordinary finish\n"),
                true
            )
            .is_err()
        );
    }
    #[test]
    fn ninja_pending_observation_accepts_exact_budget_without_widening_process_caps() {
        let text = (1..=MAX_COMMANDS)
            .map(|_| format!("[portcove:{MAX_COMMANDS}] command\n"))
            .collect::<String>();
        assert_eq!(inspect(&capture(&text), true).unwrap().count, MAX_COMMANDS);
    }
}
