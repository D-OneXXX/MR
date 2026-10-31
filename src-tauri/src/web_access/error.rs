use std::net::Ipv4Addr;

use thiserror::Error;

use crate::ca::CaError;

#[derive(Debug, Error)]
pub enum WebAccessError {
    #[error("CA error: {0}")]
    Ca(#[from] CaError),
    #[error("no private LAN IPv4 address available")]
    NoLanAddress,
    #[error("too many private LAN IPv4 addresses (maximum 8)")]
    TooManyLanAddresses,
    #[error("invalid private LAN IPv4 SAN: {0}")]
    InvalidSan(Ipv4Addr),
    #[error("TLS bind address must be IPv4")]
    InvalidBindAddress,
    #[error("TLS configuration failed: {0}")]
    TlsConfig(String),
    #[error("TLS server I/O failed")]
    Io(#[from] std::io::Error),
    #[error("TLS server task failed")]
    ServerJoin,
}

impl WebAccessError {
    /// Stable code for future command/UI localization. CA failures keep the
    /// underlying CA code so callers do not lose the precise cause.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Ca(err) => err.code(),
            Self::NoLanAddress => "web-access-no-lan-address",
            Self::TooManyLanAddresses => "web-access-too-many-lan-addresses",
            Self::InvalidSan(_) => "web-access-invalid-san",
            Self::InvalidBindAddress => "web-access-invalid-bind",
            Self::TlsConfig(_) => "web-access-tls-config",
            Self::Io(_) => "web-access-io",
            Self::ServerJoin => "web-access-server-join",
        }
    }
}

pub type WebAccessResult<T> = Result<T, WebAccessError>;
