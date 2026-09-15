//! Shared public-network resolution for application-update transports.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use reqwest::StatusCode;
use reqwest::header::{HeaderMap, RETRY_AFTER};

const DNS_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, thiserror::Error)]
pub(crate) enum PublicDnsError {
    #[error("{0}")]
    InvalidDestination(String),
    #[error("{0}")]
    Network(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ProviderRateLimit {
    pub(crate) retry_at_unix_seconds: Option<u64>,
}

pub(crate) fn provider_rate_limit(
    status: StatusCode,
    headers: &HeaderMap,
    now_unix_seconds: Option<u64>,
) -> Option<ProviderRateLimit> {
    let exhausted = headers
        .get("x-ratelimit-remaining")
        .and_then(|value| value.to_str().ok())
        == Some("0");
    if status != StatusCode::TOO_MANY_REQUESTS && !(status == StatusCode::FORBIDDEN && exhausted) {
        return None;
    }
    Some(ProviderRateLimit {
        retry_at_unix_seconds: now_unix_seconds.and_then(|now| provider_retry_at(headers, now)),
    })
}

fn provider_retry_at(headers: &HeaderMap, now_unix_seconds: u64) -> Option<u64> {
    let retry_after = headers
        .get(RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .map(|seconds| now_unix_seconds.saturating_add(seconds));
    let reset = headers
        .get("x-ratelimit-reset")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|reset| *reset > now_unix_seconds);
    match (retry_after, reset) {
        (Some(left), Some(right)) => Some(left.max(right)),
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    }
}

pub(crate) fn current_unix_seconds() -> Option<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_secs())
}

pub(crate) async fn resolve_public_https_host(
    host: &str,
    deadline: Instant,
    label: &str,
) -> Result<Vec<SocketAddr>, PublicDnsError> {
    let remaining = deadline
        .checked_duration_since(Instant::now())
        .ok_or_else(|| {
            PublicDnsError::Network(format!("{label} deadline expired during DNS lookup"))
        })?;
    let lookup = tokio::time::timeout(
        remaining.min(DNS_TIMEOUT),
        tokio::net::lookup_host((host, 443)),
    )
    .await
    .map_err(|_| PublicDnsError::Network(format!("{label} DNS lookup timed out")))?
    .map_err(|_| PublicDnsError::Network(format!("{label} DNS lookup failed")))?;
    let mut addresses: Vec<_> = lookup.collect();
    addresses.sort_unstable();
    addresses.dedup();
    if addresses.is_empty() {
        return Err(PublicDnsError::Network(format!(
            "{label} DNS lookup returned no addresses"
        )));
    }
    if addresses
        .iter()
        .any(|address| !is_public_address(address.ip()))
    {
        return Err(PublicDnsError::InvalidDestination(format!(
            "{label} resolved to a non-public address"
        )));
    }
    Ok(addresses)
}

pub(crate) fn is_public_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => is_public_ipv4(address),
        IpAddr::V6(address) => is_public_ipv6(address),
    }
}

fn is_public_ipv4(address: Ipv4Addr) -> bool {
    let [a, b, c, ..] = address.octets();
    !(a == 0
        || a == 10
        || a == 127
        || a >= 224
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 192 && b == 168)
        || (a == 192 && b == 88 && c == 99)
        || (a == 198 && (18..=19).contains(&b))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113))
}

fn is_public_ipv6(address: Ipv6Addr) -> bool {
    // Restrict to current global unicast allocation, then fail closed for the
    // broad IETF special-use block, documentation, deprecated 6to4 and 6bone.
    let [first, second, ..] = address.segments();
    (0x2000..=0x3fff).contains(&first)
        && !(first == 0x2001 && second <= 0x01ff)
        && !(first == 0x2001 && second == 0x0db8)
        && first != 0x2002
        && first != 0x3ffe
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_special_use_addresses() {
        for refused in [
            "0.0.0.0",
            "10.0.0.1",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.1.1",
            "172.16.0.1",
            "192.0.2.1",
            "192.168.1.1",
            "198.18.0.1",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "::1",
            "fc00::1",
            "fe80::1",
            "2001::1",
            "2001:db8::1",
            "2002::1",
            "3ffe::1",
        ] {
            assert!(!is_public_address(refused.parse().unwrap()), "{refused}");
        }
        assert!(is_public_address("8.8.8.8".parse().unwrap()));
        assert!(is_public_address("2606:4700:4700::1111".parse().unwrap()));
    }
}
