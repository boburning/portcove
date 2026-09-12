//! Host connectivity observation for automatic application updates.
//!
//! Automatic transfers fail closed when the operating system cannot classify
//! the preferred internet connection. Manual checks retain their existing
//! explicit override for unknown or metered cost.

use crate::application_update_schedule::{MeteredConnection, NetworkAvailability};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ApplicationUpdateConnectivity {
    pub network: NetworkAvailability,
    pub metered: MeteredConnection,
}

impl ApplicationUpdateConnectivity {
    const UNKNOWN: Self = Self {
        network: NetworkAvailability::Unknown,
        metered: MeteredConnection::Unknown,
    };
}

pub(crate) fn observe_application_update_connectivity() -> ApplicationUpdateConnectivity {
    #[cfg(windows)]
    {
        observe_windows_connectivity().unwrap_or(ApplicationUpdateConnectivity::UNKNOWN)
    }
    #[cfg(not(windows))]
    {
        ApplicationUpdateConnectivity::UNKNOWN
    }
}

#[cfg(windows)]
fn observe_windows_connectivity() -> windows::core::Result<ApplicationUpdateConnectivity> {
    use windows::Win32::Networking::NetworkListManager::{
        INetworkCostManager, INetworkListManager, NetworkListManager,
    };
    use windows::Win32::System::Com::{
        CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize,
    };
    use windows::core::Interface;

    struct ApartmentGuard(bool);

    impl Drop for ApartmentGuard {
        fn drop(&mut self) {
            if self.0 {
                // SAFETY: this balances the successful CoInitializeEx call on
                // the same short-lived blocking thread.
                unsafe { CoUninitialize() };
            }
        }
    }

    // SAFETY: observation runs synchronously on a blocking worker. Every
    // successful initialization is balanced before that worker returns.
    let initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    let _apartment = ApartmentGuard(initialized.is_ok());
    if initialized.is_err() {
        return Ok(ApplicationUpdateConnectivity::UNKNOWN);
    }

    // SAFETY: NetworkListManager is the documented in-process/local COM owner
    // for machine internet connectivity and accepts no caller-provided input.
    let manager: INetworkListManager =
        unsafe { CoCreateInstance(&NetworkListManager, None, CLSCTX_ALL) }?;
    // SAFETY: the interface pointer is valid for this initialized apartment.
    let online = unsafe { manager.IsConnectedToInternet()? }.as_bool();
    if !online {
        return Ok(classify_connectivity(false, None));
    }

    let cost_manager: INetworkCostManager = manager.cast()?;
    let mut cost = 0_u32;
    // SAFETY: a null destination requests the documented machine-wide cost;
    // `cost` remains valid for the duration of the call.
    let metered = unsafe { cost_manager.GetCost(&mut cost, std::ptr::null()) }
        .ok()
        .map(|()| cost);
    Ok(classify_connectivity(true, metered))
}

fn classify_connectivity(online: bool, windows_cost: Option<u32>) -> ApplicationUpdateConnectivity {
    if !online {
        return ApplicationUpdateConnectivity {
            network: NetworkAvailability::Offline,
            metered: MeteredConnection::Unknown,
        };
    }
    let metered = match windows_cost {
        Some(cost) if windows_cost_is_unrestricted(cost) => MeteredConnection::Unmetered,
        Some(cost) if windows_cost_is_metered(cost) => MeteredConnection::Metered,
        _ => MeteredConnection::Unknown,
    };
    ApplicationUpdateConnectivity {
        network: NetworkAvailability::Online,
        metered,
    }
}

fn windows_cost_is_unrestricted(cost: u32) -> bool {
    const UNRESTRICTED: u32 = 0x1;
    cost == UNRESTRICTED
}

fn windows_cost_is_metered(cost: u32) -> bool {
    const FIXED: u32 = 0x2;
    const VARIABLE: u32 = 0x4;
    const LEVEL_MASK: u32 = 0xffff;
    matches!(cost & LEVEL_MASK, FIXED | VARIABLE) || cost & !LEVEL_MASK != 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connectivity_classification_fails_closed_for_unknown_cost() {
        assert_eq!(
            classify_connectivity(false, None),
            ApplicationUpdateConnectivity {
                network: NetworkAvailability::Offline,
                metered: MeteredConnection::Unknown,
            }
        );
        assert_eq!(
            classify_connectivity(true, None),
            ApplicationUpdateConnectivity {
                network: NetworkAvailability::Online,
                metered: MeteredConnection::Unknown,
            }
        );
        assert_eq!(
            classify_connectivity(true, Some(0)),
            ApplicationUpdateConnectivity {
                network: NetworkAvailability::Online,
                metered: MeteredConnection::Unknown,
            }
        );
        assert_eq!(
            classify_connectivity(true, Some(0x8)).metered,
            MeteredConnection::Unknown
        );
    }

    #[test]
    fn connectivity_classification_respects_windows_cost_flags() {
        assert_eq!(
            classify_connectivity(true, Some(0x1)).metered,
            MeteredConnection::Unmetered
        );
        for cost in [
            0x2,
            0x4,
            0x0001_0001,
            0x0002_0001,
            0x0004_0001,
            0x0008_0001,
            0x0010_0001,
        ] {
            assert_eq!(
                classify_connectivity(true, Some(cost)).metered,
                MeteredConnection::Metered
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_connectivity_observation_returns_a_coherent_policy_pair() {
        let observed = observe_application_update_connectivity();
        assert!(matches!(
            observed,
            ApplicationUpdateConnectivity {
                network: NetworkAvailability::Online,
                metered: MeteredConnection::Unmetered
                    | MeteredConnection::Metered
                    | MeteredConnection::Unknown,
            } | ApplicationUpdateConnectivity {
                network: NetworkAvailability::Offline | NetworkAvailability::Unknown,
                metered: MeteredConnection::Unknown,
            }
        ));
    }
}
