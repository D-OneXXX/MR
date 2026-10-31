//! W7-TLS transport slice.
//!
//! This module provides a real TLS listener backed by the local CA. It is
//! deliberately **not** wired into Tauri startup, commands, UI, pairing,
//! sessions, or data routes: the only served endpoint is a public health
//! check. The listener is created explicitly by calling
//! [`start_tls_server`] and must be shut down explicitly.

mod addrs;
mod error;
mod tls;

pub use addrs::{is_private_lan_ipv4, local_private_ipv4s, select_san_ips};
pub use error::{WebAccessError, WebAccessResult};
pub use tls::{start_tls_server, TlsServerConfig, TlsServerHandle};

#[cfg(test)]
mod tests;
