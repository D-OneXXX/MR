use std::net::{IpAddr, Ipv4Addr};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rustls_pki_types::ServerName;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::ca::CaManager;

use super::*;

#[test]
fn private_ipv4_filter_accepts_rfc1918_and_rejects_other_ranges() {
    for ip in [
        Ipv4Addr::new(10, 0, 0, 1),
        Ipv4Addr::new(10, 255, 255, 254),
        Ipv4Addr::new(172, 16, 0, 1),
        Ipv4Addr::new(172, 31, 255, 254),
        Ipv4Addr::new(192, 168, 1, 10),
    ] {
        assert!(is_private_lan_ipv4(ip), "{ip} must be accepted");
    }

    for ip in [
        Ipv4Addr::new(127, 0, 0, 1),
        Ipv4Addr::new(169, 254, 1, 1),
        Ipv4Addr::new(8, 8, 8, 8),
        Ipv4Addr::new(172, 15, 0, 1),
        Ipv4Addr::new(172, 32, 0, 1),
        Ipv4Addr::new(224, 0, 0, 1),
        Ipv4Addr::new(255, 255, 255, 255),
        Ipv4Addr::new(0, 0, 0, 0),
        Ipv4Addr::new(192, 169, 1, 1),
    ] {
        assert!(!is_private_lan_ipv4(ip), "{ip} must be rejected");
    }
}

#[test]
fn select_san_ips_deduplicates_sorts_and_enforces_the_ca_limit() {
    let selected = select_san_ips(Some(vec![
        Ipv4Addr::new(192, 168, 1, 10),
        Ipv4Addr::new(10, 0, 0, 2),
        Ipv4Addr::new(10, 0, 0, 2),
    ]))
    .unwrap();
    assert_eq!(
        selected,
        vec![Ipv4Addr::new(10, 0, 0, 2), Ipv4Addr::new(192, 168, 1, 10)]
    );

    assert_eq!(
        select_san_ips(Some(Vec::new())).unwrap_err().code(),
        "web-access-no-lan-address"
    );
    assert_eq!(
        select_san_ips(Some(vec![Ipv4Addr::new(8, 8, 8, 8)]))
            .unwrap_err()
            .code(),
        "web-access-invalid-san"
    );

    let too_many = (1..=9)
        .map(|n| Ipv4Addr::new(10, 0, 0, n))
        .collect::<Vec<_>>();
    assert_eq!(
        select_san_ips(Some(too_many)).unwrap_err().code(),
        "web-access-too-many-lan-addresses"
    );
}

struct TestCa {
    root: PathBuf,
    wrapper: PathBuf,
}

impl TestCa {
    fn new(tag: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let wrapper = std::env::temp_dir().join(format!(
            "mr-web-access-{tag}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&wrapper).unwrap();
        Self {
            root: wrapper.join("ca"),
            wrapper,
        }
    }

    fn manager(&self) -> CaManager {
        CaManager::new(self.root.clone())
    }

    fn initialize(&self) {
        self.manager().initialize().unwrap();
    }

    fn root_cert_der(&self) -> Vec<u8> {
        let pem = std::fs::read_to_string(self.root.join("roots/0001/root.crt")).unwrap();
        pem::parse(pem).unwrap().contents().to_vec()
    }
}

impl Drop for TestCa {
    fn drop(&mut self) {
        if let Ok(status) = self.manager().status() {
            let _ = self.manager().destroy(&status.root_fingerprint_sha256);
        }
        let _ = std::fs::remove_dir_all(&self.wrapper);
    }
}

fn client_config(root_der: Vec<u8>) -> Arc<rustls::ClientConfig> {
    let mut roots = rustls::RootCertStore::empty();
    roots
        .add(rustls_pki_types::CertificateDer::from(root_der))
        .unwrap();
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    Arc::new(
        rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(roots)
            .with_no_client_auth(),
    )
}

async fn connect_tls(
    addr: std::net::SocketAddr,
    config: Arc<rustls::ClientConfig>,
    name: ServerName<'static>,
) -> std::io::Result<tokio_rustls::client::TlsStream<TcpStream>> {
    let stream = TcpStream::connect(addr).await?;
    tokio_rustls::TlsConnector::from(config)
        .connect(name, stream)
        .await
}

async fn http_request<S>(stream: &mut S, method: &str, path: &str) -> String
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    stream
        .write_all(
            format!("{method} {path} HTTP/1.1\r\nHost: moyu.local\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .await
        .unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await.unwrap();
    String::from_utf8_lossy(&response).into_owned()
}

fn test_server_config(ca: &TestCa) -> TlsServerConfig {
    TlsServerConfig {
        bind_addr: "127.0.0.1:0".parse().unwrap(),
        san_ips: Some(vec![Ipv4Addr::new(192, 168, 1, 10)]),
        ..TlsServerConfig::new(ca.root.clone())
    }
}

#[tokio::test]
async fn tls_server_serves_only_health_and_verifies_chain_and_san() {
    let ca = TestCa::new("tls-health");
    ca.initialize();
    let handle = start_tls_server(test_server_config(&ca)).await.unwrap();
    let addr = handle.local_addr();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    assert_eq!(handle.san_ips(), &[Ipv4Addr::new(192, 168, 1, 10)]);
    assert!(
        handle.leaf_not_after() > now,
        "served leaf is already expired"
    );
    assert!(!handle.leaf_fingerprint_sha256().is_empty());
    assert_eq!(
        handle.root_fingerprint_sha256(),
        ca.manager().status().unwrap().root_fingerprint_sha256
    );

    let root_der = ca.root_cert_der();
    let config = client_config(root_der.clone());

    // IP SAN: the client verifies the leaf against the CA root and the
    // configured private IPv4, while the TCP connection stays on loopback.
    let mut stream = connect_tls(
        addr,
        config.clone(),
        ServerName::IpAddress(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 10)).into()),
    )
    .await
    .unwrap();
    // The served chain must be exactly leaf + intermediate; the root is a
    // local trust anchor and must not be sent.
    let peer = stream
        .get_ref()
        .1
        .peer_certificates()
        .expect("server must send a peer chain")
        .to_vec();
    assert_eq!(peer.len(), 2, "server must send leaf + intermediate only");
    assert!(
        peer.iter().all(|cert| cert.as_ref() != root_der.as_slice()),
        "server sent the root certificate"
    );
    let response = http_request(&mut stream, "GET", "/api/health").await;
    assert!(
        response.starts_with("HTTP/1.1 204"),
        "unexpected health response: {response:?}"
    );

    // DNS SAN.
    let mut stream = connect_tls(
        addr,
        config.clone(),
        ServerName::try_from("moyu.local").unwrap(),
    )
    .await
    .unwrap();
    let response = http_request(&mut stream, "GET", "/api/health").await;
    assert!(
        response.starts_with("HTTP/1.1 204"),
        "unexpected DNS-SAN response: {response:?}"
    );

    // Only the health route exists, and only for GET.
    let mut stream = connect_tls(
        addr,
        config.clone(),
        ServerName::try_from("moyu.local").unwrap(),
    )
    .await
    .unwrap();
    let response = http_request(&mut stream, "GET", "/api/unknown").await;
    assert!(
        response.starts_with("HTTP/1.1 404"),
        "unexpected unknown-route response: {response:?}"
    );
    for method in ["POST", "HEAD"] {
        let mut stream = connect_tls(
            addr,
            config.clone(),
            ServerName::try_from("moyu.local").unwrap(),
        )
        .await
        .unwrap();
        let response = http_request(&mut stream, method, "/api/health").await;
        assert!(
            response.starts_with("HTTP/1.1 404"),
            "{method} /api/health must be 404, got: {response:?}"
        );
    }

    // A name or IP outside the leaf SAN must fail the TLS handshake.
    let err = connect_tls(
        addr,
        config.clone(),
        ServerName::IpAddress(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 11)).into()),
    )
    .await
    .unwrap_err();
    assert!(
        format!("{err:?}").contains("NotValidForName"),
        "unexpected wrong-IP error: {err:?}"
    );
    let err = connect_tls(addr, config, ServerName::try_from("evil.local").unwrap())
        .await
        .unwrap_err();
    assert!(
        format!("{err:?}").contains("NotValidForName"),
        "unexpected wrong-name error: {err:?}"
    );

    // The listener is TLS-only: a plaintext HTTP request must not produce an
    // HTTP response and must not leave the connection hanging.
    let mut plain = TcpStream::connect(addr).await.unwrap();
    plain
        .write_all(b"GET /api/health HTTP/1.1\r\nHost: moyu.local\r\n\r\n")
        .await
        .unwrap();
    let mut buf = [0u8; 64];
    match tokio::time::timeout(Duration::from_secs(2), plain.read(&mut buf)).await {
        Ok(Ok(n)) => assert!(
            !buf[..n].starts_with(b"HTTP/"),
            "plaintext request was served: {:?}",
            &buf[..n]
        ),
        Ok(Err(_)) => {}
        Err(_) => panic!("TLS listener left a plaintext connection open"),
    }

    handle.shutdown().await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(2), TcpStream::connect(addr))
            .await
            .map(|result| result.is_err())
            .unwrap_or(true),
        "listener still accepts connections after shutdown"
    );
}

#[tokio::test]
async fn start_rejects_uninitialized_ca_and_no_san() {
    let ca = TestCa::new("tls-no-ca");
    let err = start_tls_server(test_server_config(&ca))
        .await
        .err()
        .expect("uninitialized CA must fail");
    assert_eq!(err.code(), "ca-not-initialized");

    ca.initialize();
    let err = start_tls_server(TlsServerConfig {
        san_ips: Some(Vec::new()),
        ..TlsServerConfig::new(ca.root.clone())
    })
    .await
    .err()
    .expect("empty SAN list must fail");
    assert_eq!(err.code(), "web-access-no-lan-address");
}

#[tokio::test]
async fn start_rejects_relative_ca_root_and_ipv6_bind() {
    let err = start_tls_server(TlsServerConfig {
        ca_root: PathBuf::from("relative-ca"),
        bind_addr: "127.0.0.1:0".parse().unwrap(),
        san_ips: Some(vec![Ipv4Addr::new(192, 168, 1, 10)]),
    })
    .await
    .err()
    .expect("relative CA root must fail");
    assert_eq!(err.code(), "ca-root-relative");

    let ca = TestCa::new("tls-v6");
    ca.initialize();
    let err = start_tls_server(TlsServerConfig {
        bind_addr: "[::1]:0".parse().unwrap(),
        ..test_server_config(&ca)
    })
    .await
    .err()
    .expect("IPv6 bind must fail");
    assert_eq!(err.code(), "web-access-invalid-bind");
}

#[tokio::test]
async fn start_rejects_a_damaged_ca_before_spawning() {
    let ca = TestCa::new("tls-damaged");
    ca.initialize();
    let state = ca.root.join("state.json");
    let original = std::fs::read(&state).unwrap();
    std::fs::write(&state, b"{").unwrap();
    let err = start_tls_server(test_server_config(&ca))
        .await
        .err()
        .expect("damaged CA must fail");
    assert_eq!(err.code(), "ca-state-corrupt");
    // Restore the state so TestCa::drop can destroy the CA and remove the
    // private tree.
    std::fs::write(&state, original).unwrap();
}

#[tokio::test]
async fn bind_failure_returns_io_error() {
    let ca = TestCa::new("tls-bind-fail");
    ca.initialize();
    let occupied = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = occupied.local_addr().unwrap();
    let err = start_tls_server(TlsServerConfig {
        bind_addr: addr,
        ..test_server_config(&ca)
    })
    .await
    .err()
    .expect("occupied port must fail");
    assert_eq!(err.code(), "web-access-io");
    drop(occupied);
}
