use thiserror::Error;

#[derive(Debug, Error)]
pub enum CaError {
    #[error("CA data directory unavailable")]
    DataDirUnavailable,
    #[error("CA root must be an absolute path")]
    RelativeCaRoot,
    #[error("CA already initialized")]
    AlreadyInitialized,
    #[error("CA not initialized")]
    NotInitialized,
    #[error("CA state is corrupt: {0}")]
    CorruptState(&'static str),
    #[error("CA is partially initialized")]
    PartialInitialization,
    #[error("CA ACL verification failed: {0}")]
    AclVerification(&'static str),
    #[error("CA ACL operation failed")]
    Acl(#[source] std::io::Error),
    #[error("CA I/O failed")]
    Io(#[from] std::io::Error),
    #[error("CA crypto failed")]
    Crypto(#[from] rcgen::Error),
    #[error("CA certificate parse failed: {0}")]
    CertParse(String),
    #[error("CA chain verification failed")]
    ChainVerification,
    #[error("CA certificate is expired")]
    Expired,
    #[error("CA certificate has insufficient remaining validity")]
    InsufficientValidity,
    #[error("CA key does not match certificate")]
    KeyMismatch,
    #[error("invalid leaf DNS name")]
    InvalidLeafName,
    #[error("invalid leaf IP address")]
    InvalidLeafIp,
    #[error("unsupported CA algorithm")]
    UnsupportedAlgorithm,
    #[error("backup is corrupt or passphrase is wrong")]
    BackupDecrypt,
    #[error("backup fingerprint mismatch")]
    FingerprintMismatch,
    #[error("CA destroy confirmation mismatch")]
    DestroyConfirmationMismatch,
    #[error("CA generation is not active")]
    NotActive,
}

impl CaError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::DataDirUnavailable => "ca-data-dir-unavailable",
            Self::RelativeCaRoot => "ca-root-relative",
            Self::AlreadyInitialized => "ca-already-initialized",
            Self::NotInitialized => "ca-not-initialized",
            Self::CorruptState(_) => "ca-state-corrupt",
            Self::PartialInitialization => "ca-partial-initialization",
            Self::AclVerification(_) => "ca-acl-verification",
            Self::Acl(_) => "ca-acl",
            Self::Io(_) => "ca-io",
            Self::Crypto(_) => "ca-crypto",
            Self::CertParse(_) => "ca-cert-parse",
            Self::ChainVerification => "ca-chain-verification",
            Self::Expired => "ca-expired",
            Self::InsufficientValidity => "ca-insufficient-validity",
            Self::KeyMismatch => "ca-key-mismatch",
            Self::InvalidLeafName => "ca-invalid-leaf-name",
            Self::InvalidLeafIp => "ca-invalid-leaf-ip",
            Self::UnsupportedAlgorithm => "ca-unsupported-algorithm",
            Self::BackupDecrypt => "ca-backup-decrypt",
            Self::FingerprintMismatch => "ca-fingerprint-mismatch",
            Self::DestroyConfirmationMismatch => "ca-destroy-confirmation-mismatch",
            Self::NotActive => "ca-generation-not-active",
        }
    }
}

pub type CaResult<T> = Result<T, CaError>;
