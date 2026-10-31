use std::net::Ipv4Addr;

use super::error::{WebAccessError, WebAccessResult};

/// Maximum number of IPv4 SANs the CA accepts per leaf.
const MAX_SAN_IPS: usize = 8;

/// A LAN SAN must be a usable RFC 1918 IPv4 address. Loopback, link-local,
/// unspecified, broadcast, multicast and public addresses are rejected.
pub fn is_private_lan_ipv4(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    !ip.is_loopback()
        && !ip.is_link_local()
        && !ip.is_unspecified()
        && !ip.is_broadcast()
        && !ip.is_multicast()
        && (octets[0] == 10
            || (octets[0] == 172 && (16..=31).contains(&octets[1]))
            || (octets[0] == 192 && octets[1] == 168))
}

/// Enumerate the current non-loopback RFC 1918 IPv4 addresses. The caller is
/// responsible for enforcing the leaf SAN cap when using this directly;
/// [`select_san_ips`] does so.
pub fn local_private_ipv4s() -> WebAccessResult<Vec<Ipv4Addr>> {
    let interfaces = if_addrs::get_if_addrs().map_err(WebAccessError::Io)?;
    let mut ips = interfaces
        .into_iter()
        .filter_map(|interface| match interface.addr {
            if_addrs::IfAddr::V4(v4) if is_private_lan_ipv4(v4.ip) => Some(v4.ip),
            _ => None,
        })
        .collect::<Vec<_>>();
    ips.sort();
    ips.dedup();
    if ips.is_empty() {
        return Err(WebAccessError::NoLanAddress);
    }
    Ok(ips)
}

/// Resolve the SAN list used for a leaf. `None` enumerates the current LAN
/// addresses; `Some` is an explicit list (used by tests and future callers).
/// The result is sorted, deduplicated and limited to 1..=8 addresses.
pub fn select_san_ips(provided: Option<Vec<Ipv4Addr>>) -> WebAccessResult<Vec<Ipv4Addr>> {
    let mut ips = match provided {
        Some(ips) => ips,
        None => local_private_ipv4s()?,
    };
    if let Some(invalid) = ips.iter().find(|ip| !is_private_lan_ipv4(**ip)) {
        return Err(WebAccessError::InvalidSan(*invalid));
    }
    ips.sort();
    ips.dedup();
    if ips.is_empty() {
        return Err(WebAccessError::NoLanAddress);
    }
    if ips.len() > MAX_SAN_IPS {
        return Err(WebAccessError::TooManyLanAddresses);
    }
    Ok(ips)
}
