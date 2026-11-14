//! One bounded release transfer that can continue after a dropped body.
//!
//! A resume is only a transport optimization: callers still verify the whole
//! file's size and SHA-256 before accepting it. Resume is limited to this
//! transfer; durable cross-restart continuation belongs to the job authority.

use std::{io::SeekFrom, path::Path, time::Duration};

use futures_util::StreamExt;
use reqwest::{
    StatusCode,
    header::{CONTENT_RANGE, ETAG, HeaderValue, IF_RANGE, RANGE},
};
use tokio::io::{AsyncSeekExt, AsyncWriteExt, BufWriter};

use crate::{
    OperationCoordinator, OperationEvent, PortcoveError, ReleaseAsset, Result,
    archive::{validate_download_progress, validate_download_size},
    failure::UpstreamObservation,
};

/// Bounds how often one transfer may reconnect after an interrupted body.
#[derive(Clone, Copy, Debug)]
pub(crate) struct ResumePolicy {
    pub(crate) attempts: u32,
    pub(crate) first_delay: Duration,
    pub(crate) max_delay: Duration,
}

pub(crate) const RESUME_POLICY: ResumePolicy = ResumePolicy {
    attempts: 5,
    first_delay: Duration::from_millis(500),
    max_delay: Duration::from_secs(8),
};

impl ResumePolicy {
    fn delay(&self, attempt: u32) -> Duration {
        let doublings = attempt.saturating_sub(1).min(16);
        self.first_delay
            .saturating_mul(1 << doublings)
            .min(self.max_delay)
    }
}

enum Step {
    /// A transport interruption or unusable partial answer; another attempt may help.
    Retry(PortcoveError),
    Fatal(PortcoveError),
}

impl From<PortcoveError> for Step {
    fn from(error: PortcoveError) -> Self {
        Self::Fatal(error)
    }
}

impl From<std::io::Error> for Step {
    fn from(error: std::io::Error) -> Self {
        Self::Fatal(error.into())
    }
}

fn transport(error: &reqwest::Error) -> PortcoveError {
    PortcoveError::network(error.to_string())
        .with_upstream(UpstreamObservation::from_reqwest(error))
}

/// Read-idle stalls keep their existing terminal failure; only resets, early
/// closes and similar transport interruptions are worth another attempt.
fn interrupted(error: &reqwest::Error) -> bool {
    !(error.is_timeout() || error.is_builder() || error.is_redirect() || error.is_status())
}

/// Only a strong entity tag identifies exact bytes well enough for `If-Range`.
fn strong_validator(response: &reqwest::Response) -> Option<HeaderValue> {
    response
        .headers()
        .get(ETAG)
        .filter(|value| {
            let bytes = value.as_bytes();
            bytes.len() >= 2 && bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"'
        })
        .cloned()
}

fn decimal(value: &str) -> Option<u64> {
    (!value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
        .then(|| value.parse().ok())
        .flatten()
}

/// Parses `bytes <first>-<last>/<complete>`; an unknown complete length is refused.
fn content_range(value: &str) -> Option<(u64, u64, u64)> {
    let (unit, rest) = value.split_once(' ')?;
    if !unit.eq_ignore_ascii_case("bytes") {
        return None;
    }
    let (range, complete) = rest.split_once('/')?;
    let (first, last) = range.split_once('-')?;
    let (first, last, complete) = (decimal(first)?, decimal(last)?, decimal(complete)?);
    (first <= last && last < complete).then_some((first, last, complete))
}

/// A partial answer may only continue the exact representation already on disk.
fn continuation_problem(
    response: &reqwest::Response,
    offset: u64,
    validator: &HeaderValue,
    length: Option<u64>,
    declared: u64,
) -> Option<&'static str> {
    // Require the same strong validator on the partial answer itself, so
    // continuation never rests on a caller digest alone.
    if response.headers().get(ETAG) != Some(validator) {
        return Some("the partial response does not carry the original validator");
    }
    let Some((first, last, complete)) = response
        .headers()
        .get(CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(content_range)
    else {
        return Some("the partial response has no usable Content-Range");
    };
    let consistent = first == offset
        && last + 1 == complete
        && length.is_none_or(|length| length == complete)
        && (declared == 0 || declared == complete)
        && response
            .content_length()
            .is_none_or(|remaining| remaining == complete - first);
    (!consistent).then_some("the partial response does not continue the received bytes")
}

struct Transfer<'a> {
    asset: &'a ReleaseAsset,
    destination: &'a Path,
    file: Option<BufWriter<tokio::fs::File>>,
    completed: u64,
    reported: u64,
    /// Strong validator and complete length of the representation on disk.
    validator: Option<HeaderValue>,
    length: Option<u64>,
}

impl Transfer<'_> {
    /// Range continuation needs received bytes, a strong validator and an
    /// expected digest the caller will verify; otherwise a retry starts over.
    fn resumable(&self) -> bool {
        self.completed > 0 && self.validator.is_some() && !self.asset.sha256.is_empty()
    }

    /// Discards received bytes so a different representation is never spliced in.
    async fn restart<F>(&mut self, operation: &OperationCoordinator, emit: &mut F) -> Result<()>
    where
        F: FnMut(OperationEvent),
    {
        if let Some(file) = &mut self.file {
            file.flush().await?;
            file.get_mut().set_len(0).await?;
            file.get_mut().seek(SeekFrom::Start(0)).await?;
        }
        let shown = self.reported > 0;
        self.completed = 0;
        self.reported = 0;
        self.validator = None;
        self.length = None;
        if shown {
            emit(operation.progress_with_unit(
                "download",
                crate::ProgressUnit::Bytes,
                0,
                Some(self.asset.size).filter(|size| *size > 0),
            ));
        }
        Ok(())
    }

    async fn attempt<F>(
        &mut self,
        client: &reqwest::Client,
        operation: &OperationCoordinator,
        emit: &mut F,
        retrying: bool,
    ) -> std::result::Result<(), Step>
    where
        F: FnMut(OperationEvent),
    {
        let range = self
            .resumable()
            .then(|| {
                self.validator
                    .clone()
                    .map(|validator| (self.completed, validator))
            })
            .flatten();
        if range.is_none() && self.completed > 0 {
            self.restart(operation, emit).await?;
        }
        let mut request = client.get(&self.asset.url);
        if let Some((offset, validator)) = &range {
            request = request
                .header(RANGE, format!("bytes={offset}-"))
                .header(IF_RANGE, validator.clone());
        }
        let response = match operation
            .interruptible(async { Ok(request.send().await) })
            .await?
        {
            Ok(response) => response,
            Err(error) if retrying && interrupted(&error) => {
                return Err(Step::Retry(transport(&error)));
            }
            Err(error) => return Err(Step::Fatal(transport(&error))),
        };
        let status = response.status();
        if range.is_some() && status == StatusCode::RANGE_NOT_SATISFIABLE {
            self.restart(operation, emit).await?;
            return Err(Step::Retry(
                PortcoveError::network("the server could not continue the download")
                    .with_upstream(Some(UpstreamObservation::Status(status.as_u16()))),
            ));
        }
        let response = response.error_for_status().map_err(|error| {
            PortcoveError::network(error.to_string())
                .with_upstream(Some(UpstreamObservation::Status(status.as_u16())))
        })?;
        match &range {
            Some((offset, validator)) if status == StatusCode::PARTIAL_CONTENT => {
                if let Some(problem) = continuation_problem(
                    &response,
                    *offset,
                    validator,
                    self.length,
                    self.asset.size,
                ) {
                    self.restart(operation, emit).await?;
                    return Err(Step::Retry(
                        PortcoveError::network("the server could not continue the download")
                            .detail("download_resume_refused", problem),
                    ));
                }
            }
            _ => {
                // A whole representation: the first answer, or the server
                // ignored Range or reported that the file changed.
                if self.completed > 0 {
                    self.restart(operation, emit).await?;
                }
                self.validator = strong_validator(&response);
                self.length = response.content_length();
            }
        }
        if self.file.is_none() {
            // Network chunks are small; batch them so each write is not its own
            // blocking-pool dispatch. The caller drains the buffer and the file.
            self.file = Some(BufWriter::with_capacity(
                1024 * 1024,
                tokio::fs::File::create(self.destination).await?,
            ));
        }
        let file = self.file.as_mut().expect("download file was just opened");
        let total = self
            .length
            .or(Some(self.asset.size))
            .filter(|value| *value > 0);
        let mut stream = response.bytes_stream();
        while let Some(chunk) = operation
            .interruptible(async { Ok(stream.next().await) })
            .await?
        {
            let chunk = match chunk {
                Ok(chunk) => chunk,
                Err(error) if interrupted(&error) => return Err(Step::Retry(transport(&error))),
                Err(error) => return Err(Step::Fatal(transport(&error))),
            };
            let next = self
                .completed
                .checked_add(chunk.len() as u64)
                .ok_or_else(|| PortcoveError::verification("download byte count overflowed"))?;
            validate_download_progress(next, self.asset.size)?;
            file.write_all(&chunk).await?;
            self.completed = next;
            if total.is_some_and(|total| self.completed == total)
                || self.completed.saturating_sub(self.reported) >= 1024 * 1024
            {
                emit(operation.progress_with_unit(
                    "download",
                    crate::ProgressUnit::Bytes,
                    self.completed,
                    total,
                ));
                self.reported = self.completed;
            }
        }
        if self.completed != self.reported {
            emit(operation.progress_with_unit(
                "download",
                crate::ProgressUnit::Bytes,
                self.completed,
                total,
            ));
            self.reported = self.completed;
        }
        // A cleanly ended (for example chunked) body that stops short of the
        // known complete length is an interruption, not a finished file.
        if self.length.is_some_and(|length| self.completed < length) {
            return Err(Step::Retry(
                PortcoveError::network("the download ended before the complete file arrived")
                    .detail("expected", self.length.unwrap_or_default().to_string())
                    .detail("actual", self.completed.to_string()),
            ));
        }
        Ok(())
    }
}

/// Shared bounded byte transfer; callers supply a provider-constrained client
/// and still own checksum verification and publication policy.
pub(crate) async fn download<F>(
    client: &reqwest::Client,
    asset: &ReleaseAsset,
    destination: &Path,
    operation: &OperationCoordinator,
    emit: &mut F,
    policy: ResumePolicy,
) -> Result<()>
where
    F: FnMut(OperationEvent),
{
    validate_download_progress(0, asset.size)?;
    let mut transfer = Transfer {
        asset,
        destination,
        file: None,
        completed: 0,
        reported: 0,
        validator: None,
        length: None,
    };
    let mut resumes = 0_u32;
    // Exhaustion reports the original interruption, so its upstream
    // classification (and preserved-location failover) does not depend on
    // which reconnect happened to fail last.
    let mut interruption: Option<PortcoveError> = None;
    let transfer_result: Result<()> = loop {
        match transfer.attempt(client, operation, emit, resumes > 0).await {
            Ok(()) => break Ok(()),
            Err(Step::Fatal(error)) if resumes > 0 => {
                break Err(error.detail("download_resume_attempts", resumes.to_string()));
            }
            Err(Step::Fatal(error)) => break Err(error),
            Err(Step::Retry(error)) if resumes >= policy.attempts => {
                let last = error.to_string();
                break Err(interruption
                    .take()
                    .unwrap_or(error)
                    .detail("download_resume_attempts", resumes.to_string())
                    .detail("download_resume_last_error", last));
            }
            Err(Step::Retry(error)) => {
                if interruption.is_none() {
                    interruption = Some(error);
                }
                resumes += 1;
                emit(operation.message(
                    "info",
                    if transfer.resumable() {
                        format!(
                            "The download of {} was interrupted. Continuing from the bytes already received (retry {resumes} of {}).",
                            asset.name, policy.attempts
                        )
                    } else {
                        format!(
                            "The download of {} could not continue. Starting it again from the beginning (retry {resumes} of {}).",
                            asset.name, policy.attempts
                        )
                    },
                ));
                let delay = policy.delay(resumes);
                if let Err(error) = operation
                    .interruptible(async {
                        tokio::time::sleep(delay).await;
                        Ok(())
                    })
                    .await
                {
                    break Err(error);
                }
            }
        }
    };
    // Tokio write_all can return with a blocking file write still queued.
    // Drain even on cancellation/network/size/write errors before callers
    // may clean private staging or publish the terminal transfer result.
    // This await is deliberately outside cooperative interruption.
    let drain_result = match &mut transfer.file {
        Some(file) => file.flush().await,
        None => Ok(()),
    };
    if let Err(error) = transfer_result {
        return Err(match drain_result {
            Ok(()) => error,
            Err(drain) => error.detail("download_write_drain_error", drain.to_string()),
        });
    }
    drain_result?;
    validate_download_size(transfer.completed, asset.size)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_range_requires_a_complete_strict_decimal_range() {
        assert_eq!(content_range("bytes 4-9/10"), Some((4, 9, 10)));
        assert_eq!(content_range("bytes 4-9/*"), None);
        assert_eq!(content_range("bytes +4-9/10"), None);
        assert_eq!(content_range("bytes 9-4/10"), None);
        assert_eq!(content_range("bytes 4-10/10"), None);
        assert_eq!(content_range("items 4-9/10"), None);
        assert_eq!(content_range("Bytes 4-9/10"), Some((4, 9, 10)));
        assert_eq!(content_range("bytes 4-9"), None);
    }

    #[test]
    fn back_off_doubles_up_to_its_ceiling() {
        let delays: Vec<_> = (1..=6)
            .map(|attempt| RESUME_POLICY.delay(attempt))
            .collect();
        assert_eq!(
            delays,
            [500, 1000, 2000, 4000, 8000, 8000].map(Duration::from_millis)
        );
    }
}
