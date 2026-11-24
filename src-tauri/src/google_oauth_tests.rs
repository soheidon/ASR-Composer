use crate::google_cloud::{
    check_speech_api_state_with_auth, classify_google_cloud_api_error,
    classify_service_usage_error, enable_speech_api_with_auth,
    execute_speech_v2_recognize_with_snapshot, list_projects_with_auth,
    validate_allowed_enable_service,
};
use crate::google_oauth::{
    build_google_auth_url, canonicalize_scopes, compute_client_id_fingerprint,
    compute_pkce_s256_challenge, constant_time_eq, credential_target_name,
    credential_target_name_for_channel, generate_pkce_pair,
    generate_random_urlsafe, load_metadata_raw, logout_pending_marker_path, map_oauth_callback_error,
    metadata_file_path, metadata_file_path_for_channel,
    parse_loopback_request_line, resolve_client_config_for_build, resolve_client_id_for_build,
    save_metadata_atomic, verify_id_token, AuthMetadata, BuildChannel, CredentialPayload,
    CredentialStore,
    GoogleApiErrorKind, GoogleAuthConnectionState, GoogleAuthManager, GoogleHttpTransport,
    GoogleOAuthConfig, HttpRequest, HttpResponse, InMemoryCredentialStore, JwksCache,
    LoopbackCallbackOutcome, OAuthClientCredentials, OAuthClientSecretMode,
    OnboardingAcquireOutcome, PkcePair, ProjectSource, SlotMetadata, APP_IDENTIFIER,
};
use crate::parse_google_stt_response;
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

// Test-only RSA-2048 keypair (never used in production)
const TEST_RSA_N: &str = "3wtZ0XJVInIECPzKHobb1aEFZ2gdHAco2cZzmb9xqywTtziY6-KAFwf-DX1THlTV3OJqfDMxaGA9lWwOWMR8MwYcHvh0V1VZS4PEakfYOvRA35xlwCPBzaExHL-ayxQEnk_U87vjajp4qVVqZjBO2yGLRNVu-tNp6MPK6f0OlPjzTjXgosp2SJFfVW9V-sWActIiEEeJxLfnnqrtYwtXn5xAics4mspG0WMcVAt6oZwRWAfH9qyGxwP5vFFPoFZyL2hPeA4m7syK-p4JjaXya-5X1LtjIdee9S_SXbiStzC2w-6k3VSVi_cOH_l6LL79LzAvynfwxrZw6fT-khjcsQ";
const TEST_RSA_E: &str = "AQAB";
const TEST_RSA_PEM: &str = "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDfC1nRclUicgQI\n/MoehtvVoQVnaB0cByjZxnOZv3GrLBO3OJjr4oAXB/4NfVMeVNXc4mp8MzFoYD2V\nbA5YxHwzBhwe+HRXVVlLg8RqR9g69EDfnGXAI8HNoTEcv5rLFASeT9Tzu+NqOnip\nVWpmME7bIYtE1W7602now8rp/Q6U+PNONeCiynZIkV9Vb1X6xYBy0iIQR4nEt+ee\nqu1jC1efnECJyziaykbRYxxUC3qhnBFYB8f2rIbHA/m8UU+gVnIvaE94DibuzIr6\nngmNpfJr7lfUu2Mh1571L9JduJK3MLbD7qTdVJWL9w4f+Xosvv0vMC/Kd/DGtnDp\n9P6SGNyxAgMBAAECggEADCBG2s83d67xLzfnGS/FxeCCNbQAWSS+gNB8OnChEmhM\nDhsCnVhsFFR36G3W1gBQvDiHB4eU+RK6ZmRAh2zvP6rmXnytfo4CU8uvIwQS6mmb\nGU0cbwzCnZZU4DY+iSnmcmDut+2QGJdjNfmR1kpsDxfMxYpBBVv3FxOF9aCvaUPh\nmdq22kkowSa8AgIi/SdJNvpieDgT1U+cq8Rwl5qrIjb29x0kJaeP6yxVoM9POaQZ\n+Klf6HZ2rBTGJCYRqcExLuRQdAd/NEOQscyn08F3Ct72JvwhcNXTyUwRTH0xJSkr\nfWn9FUKeSJmdkFwSJRzyb7aSGgWogvOtp5VvOJUHDQKBgQD7wKMibhe976aZufbj\nA3/0eQEfOF07KRekxCtvTqjtK+QRo9taAWoWjfdgalT181a0qmGzLNUY7KcV9ntl\n+upI4CtUfCin9IeINQdU+w+LwZZ3y6H8RaPzW5Q7Y7NKTDlc5OM99+8KTLSZnCLE\nFu9ybVTmxEx8FHtGs1HA+YZVNwKBgQDizrfWonvAlnT/wIjUu3kbulSJFj3K4Tdc\nsS0y6/x66foOaqKvMW4oc2Xtsb8jQZxmUrv0UvnDdWHU1Wlu8JZp0wvh4j/wFgUj\nuX4o3hSVV+54XEfbnj+NfHKFVWDGDrBRIrFEUY081/J5i9cbKhDQVQEFAwaPBWtV\nFrrkpSDRVwKBgQCzrzLAiEN51WrbndeRABZ7r0IVvm0MpK+zcjBuKX54iTMnRARz\noT7PClTeBAbP5PalzFYfRIh0WbSIAHzitMwzZ4yFqHh8KBP0K6UoCml2Hp3+suDS\n5gG22E5cdTSqeu0WWGe4+xUqDMV6Pe6ydoxA57gJXWIZzaSPOb3INlCi0QKBgQC/\nSi4PHpdVRRCEq/Q7x6pLUon93P5c4Dp7OQuwCQy29iPqiNGRBRWtlDaBlQpqR+oK\n+vh/BoSU76mFgkEcSlnyAwfgiZv3d/r5uHbJLRUbKEB+zwXkGsHrKOzFu86U/MqE\ng8gSoN2IVXGyRdk0lfP8YdUsTvL3KVDvQO577TGSnQKBgHdCqVdOYmoCX8QOQOtL\nUo1fKXwxurDkR2t02JwBtcfYJ3KeFfcrKkB0crJhoYuGfgtZ4LwD4X/nBDgeYGd7\nAxsxA5Gxpf/9XqH7eDdoDVn32moK+WY+X1SgiIUVCoobWKBH1vBSmCcRU7q+2JFo\nRnyuwKoUZo+e8bVIibIiB2im\n-----END PRIVATE KEY-----\n";

#[derive(Serialize)]
struct TestJwtClaims<'a> {
    iss: &'a str,
    aud: &'a str,
    exp: u64,
    nonce: &'a str,
    sub: &'a str,
    email: &'a str,
    email_verified: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    hd: Option<&'a str>,
}

fn sign_test_id_token(kid: &str, claims: &TestJwtClaims<'_>) -> String {
    let mut header = Header::new(Algorithm::RS256);
    header.kid = Some(kid.to_string());
    let key = EncodingKey::from_rsa_pem(TEST_RSA_PEM.as_bytes()).expect("valid test RSA PEM");
    encode(&header, claims, &key).expect("encode jwt")
}

fn jwks_json(kid: &str) -> String {
    serde_json::json!({
        "keys": [{
            "kid": kid,
            "kty": "RSA",
            "alg": "RS256",
            "use": "sig",
            "n": TEST_RSA_N,
            "e": TEST_RSA_E
        }]
    })
    .to_string()
}

struct MockTransport {
    routes: Mutex<HashMap<String, VecDeque<Result<HttpResponse, String>>>>,
    calls: Mutex<Vec<(String, String)>>,
    bodies: Mutex<Vec<(String, Option<String>)>>,
}

impl MockTransport {
    fn new() -> Self {
        Self {
            routes: Mutex::new(HashMap::new()),
            calls: Mutex::new(Vec::new()),
            bodies: Mutex::new(Vec::new()),
        }
    }

    fn push_ok(&self, url_prefix: &str, status: u16, headers: Vec<(&str, &str)>, body: String) {
        let mut hmap = HashMap::new();
        for (k, v) in headers {
            hmap.insert(k.to_ascii_lowercase(), v.to_string());
        }
        let mut map = self.routes.lock().unwrap();
        map.entry(url_prefix.to_string())
            .or_default()
            .push_back(Ok(HttpResponse {
                status,
                headers: hmap,
                body,
            }));
    }

    fn push_err(&self, url_prefix: &str, err: &str) {
        let mut map = self.routes.lock().unwrap();
        map.entry(url_prefix.to_string())
            .or_default()
            .push_back(Err(err.to_string()));
    }

    fn call_count(&self, url_prefix: &str) -> usize {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, u)| u.starts_with(url_prefix))
            .count()
    }
}

impl GoogleHttpTransport for MockTransport {
    async fn send(&self, req: HttpRequest) -> Result<HttpResponse, String> {
        self.calls
            .lock()
            .unwrap()
            .push((req.method.clone(), req.url.clone()));
        self.bodies
            .lock()
            .unwrap()
            .push((req.url.clone(), req.body.clone()));
        let mut map = self.routes.lock().unwrap();
        // Match longest prefix first
        let mut matched_key: Option<String> = None;
        for key in map.keys() {
            if req.url.starts_with(key) {
                if matched_key
                    .as_ref()
                    .map(|m| key.len() > m.len())
                    .unwrap_or(true)
                {
                    matched_key = Some(key.clone());
                }
            }
        }
        if let Some(key) = matched_key {
            if let Some(q) = map.get_mut(&key) {
                if let Some(next) = q.pop_front() {
                    return next;
                }
            }
        }
        Err(format!("No mock response for {} {}", req.method, req.url))
    }
}

struct FaultyCredentialStore {
    inner: InMemoryCredentialStore,
    fail_save: Mutex<bool>,
    fail_load: Mutex<bool>,
    fail_delete: Mutex<bool>,
}

impl FaultyCredentialStore {
    fn new() -> Self {
        Self {
            inner: InMemoryCredentialStore::new(),
            fail_save: Mutex::new(false),
            fail_load: Mutex::new(false),
            fail_delete: Mutex::new(false),
        }
    }
}

impl CredentialStore for FaultyCredentialStore {
    fn save(&self, target: &str, payload: &CredentialPayload) -> Result<(), String> {
        if *self.fail_save.lock().unwrap() {
            return Err("simulated save failure".to_string());
        }
        self.inner.save(target, payload)
    }

    fn load(&self, target: &str) -> Result<Option<CredentialPayload>, String> {
        if *self.fail_load.lock().unwrap() {
            return Err("simulated reload failure".to_string());
        }
        self.inner.load(target)
    }

    fn delete(&self, target: &str) -> Result<(), String> {
        if *self.fail_delete.lock().unwrap() {
            return Err("simulated delete failure".to_string());
        }
        self.inner.delete(target)
    }
}

fn test_config(client_id: &str) -> GoogleOAuthConfig {
    GoogleOAuthConfig {
        client_id: client_id.to_string(),
        client_secret: Some(format!("secret-for-{}", client_id)),
        secret_mode: OAuthClientSecretMode::Required,
        default_project_id: Some("amed-512123".to_string()),
        build_channel: BuildChannel::Dev,
        auth_endpoint: "https://mock.google.local/auth".to_string(),
        token_endpoint: "https://mock.google.local/token".to_string(),
        revoke_endpoint: "https://mock.google.local/revoke".to_string(),
        discovery_url: "https://mock.google.local/discovery".to_string(),
        jwks_uri_override: Some("https://mock.google.local/jwks".to_string()),
        callback_timeout: Duration::from_secs(5),
    }
}

#[test]
fn test_pkce_state_nonce_and_secrets_redacted_in_debug() {
    let pkce: PkcePair = generate_pkce_pair();
    assert!(pkce.code_verifier.len() >= 43);
    assert_eq!(
        pkce.code_challenge,
        compute_pkce_s256_challenge(&pkce.code_verifier)
    );
    let pkce_dbg = format!("{:?}", pkce);
    assert!(!pkce_dbg.contains(&pkce.code_verifier));
    assert!(pkce_dbg.contains("[REDACTED]"));

    let s1 = generate_random_urlsafe(32);
    let s2 = generate_random_urlsafe(32);
    assert!(constant_time_eq(s1.as_bytes(), s1.as_bytes()));
    assert!(!constant_time_eq(s1.as_bytes(), s2.as_bytes()));

    let payload = CredentialPayload {
        oauth_client_id_fingerprint: "fp".to_string(),
        sub: "sub-1".to_string(),
        refresh_token: "1//super-secret-refresh-token".to_string(),
    };
    let payload_dbg = format!("{:?}", payload);
    assert!(!payload_dbg.contains("1//super-secret-refresh-token"));
    assert!(payload_dbg.contains("[REDACTED]"));
}

#[test]
fn test_http_request_and_response_debug_redact_auth_material() {
    let request = HttpRequest {
        method: "POST".to_string(),
        url: "https://oauth2.googleapis.com/token".to_string(),
        headers: vec![
            ("Authorization".to_string(), "Bearer fake-access-token".to_string()),
            ("Content-Type".to_string(), "application/x-www-form-urlencoded".to_string()),
        ],
        body: Some("client_secret=fake-client-secret&code=fake-auth-code&code_verifier=fake-verifier&refresh_token=fake-refresh-token".to_string()),
    };
    let request_debug = format!("{request:?}");
    for secret in [
        "fake-access-token",
        "fake-client-secret",
        "fake-auth-code",
        "fake-verifier",
        "fake-refresh-token",
    ] {
        assert!(!request_debug.contains(secret));
    }
    assert!(request_debug.contains("[REDACTED]"));

    let response = HttpResponse {
        status: 200,
        headers: HashMap::from([("set-cookie".to_string(), "fake-cookie-token".to_string())]),
        body: "{\"access_token\":\"fake-response-access-token\",\"refresh_token\":\"fake-response-refresh-token\"}".to_string(),
    };
    let response_debug = format!("{response:?}");
    for secret in [
        "fake-cookie-token",
        "fake-response-access-token",
        "fake-response-refresh-token",
    ] {
        assert!(!response_debug.contains(secret));
    }
    assert!(response_debug.contains("[REDACTED]"));
}

#[test]
fn test_loopback_callback_parsing_and_error_mapping() {
    let ok = parse_loopback_request_line("GET /?code=abc123&state=xyz789 HTTP/1.1").unwrap();
    assert_eq!(
        ok,
        LoopbackCallbackOutcome::Code {
            code: "abc123".to_string(),
            state: "xyz789".to_string()
        }
    );

    let denied =
        parse_loopback_request_line("GET /?error=access_denied&state=xyz789 HTTP/1.1").unwrap();
    assert_eq!(
        denied,
        LoopbackCallbackOutcome::OAuthError {
            error: "access_denied".to_string(),
            state: Some("xyz789".to_string())
        }
    );
    assert_eq!(
        map_oauth_callback_error("access_denied").kind,
        GoogleApiErrorKind::OauthConsentDenied
    );
    assert_eq!(
        map_oauth_callback_error("admin_policy_enforced").kind,
        GoogleApiErrorKind::OauthAdminPolicyEnforced
    );
}

#[test]
fn test_scope_canonicalization_aliases_order_extra_and_missing() {
    let c1 = canonicalize_scopes("openid email https://www.googleapis.com/auth/cloud-platform")
        .unwrap();
    let c2 = canonicalize_scopes(
        "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email openid openid https://www.googleapis.com/auth/drive.readonly",
    )
    .unwrap();
    assert_eq!(c1, c2);
    assert_eq!(
        c1,
        vec![
            "google_cloud_api".to_string(),
            "identity:email".to_string(),
            "identity:openid".to_string(),
        ]
    );

    // Missing cloud-platform
    let err1 = canonicalize_scopes("openid email").unwrap_err();
    assert_eq!(err1.kind, GoogleApiErrorKind::OauthScopeNotGranted);

    // Missing email equivalent
    let err2 =
        canonicalize_scopes("openid https://www.googleapis.com/auth/cloud-platform").unwrap_err();
    assert_eq!(err2.kind, GoogleApiErrorKind::OauthScopeNotGranted);

    // Empty / missing scope
    let err3 = canonicalize_scopes("").unwrap_err();
    assert_eq!(err3.kind, GoogleApiErrorKind::OauthScopeNotGranted);
}

#[test]
fn test_id_token_verification_claims_and_jwks_cache_and_unknown_kid() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let transport = MockTransport::new();
        let client_id = "client-a.apps.googleusercontent.com";
        let now = 1_700_000_000u64;

        // Cache-Control: max-age=300
        transport.push_ok(
            "https://mock.google.local/jwks",
            200,
            vec![("Cache-Control", "public, max-age=300")],
            jwks_json("kid-1"),
        );

        let mut cache = JwksCache::new(Some("https://mock.google.local/jwks".to_string()));
        let valid_tok = sign_test_id_token(
            "kid-1",
            &TestJwtClaims {
                iss: "https://accounts.google.com",
                aud: client_id,
                exp: now + 3600,
                nonce: "nonce-123",
                sub: "sub-001",
                email: "u@example.com",
                email_verified: true,
                hd: Some("example.com"),
            },
        );

        let verified = verify_id_token(
            &valid_tok,
            client_id,
            "nonce-123",
            &mut cache,
            &transport,
            "https://mock.google.local/discovery",
            Some(now),
        )
        .await
        .unwrap();
        assert_eq!(verified.sub, "sub-001");
        assert_eq!(verified.email, "u@example.com");
        assert_eq!(transport.call_count("https://mock.google.local/jwks"), 1);

        // Second call reuses cached JWKS (no extra HTTP call)
        let _ = verify_id_token(
            &valid_tok,
            client_id,
            "nonce-123",
            &mut cache,
            &transport,
            "https://mock.google.local/discovery",
            Some(now),
        )
        .await
        .unwrap();
        assert_eq!(transport.call_count("https://mock.google.local/jwks"), 1);

        // Unknown kid triggers exactly 1 refresh, succeeds if new kid is returned
        transport.push_ok(
            "https://mock.google.local/jwks",
            200,
            vec![("Cache-Control", "max-age=300")],
            jwks_json("kid-2"),
        );
        let tok_kid2 = sign_test_id_token(
            "kid-2",
            &TestJwtClaims {
                iss: "https://accounts.google.com",
                aud: client_id,
                exp: now + 3600,
                nonce: "nonce-123",
                sub: "sub-001",
                email: "u@example.com",
                email_verified: true,
                hd: None,
            },
        );
        verify_id_token(
            &tok_kid2,
            client_id,
            "nonce-123",
            &mut cache,
            &transport,
            "https://mock.google.local/discovery",
            Some(now),
        )
        .await
        .unwrap();
        assert_eq!(transport.call_count("https://mock.google.local/jwks"), 2);

        // Still unknown kid -> fails closed after 1 retry
        transport.push_ok(
            "https://mock.google.local/jwks",
            200,
            vec![("Cache-Control", "max-age=300")],
            jwks_json("kid-2"),
        );
        let tok_kid3 = sign_test_id_token(
            "kid-3",
            &TestJwtClaims {
                iss: "https://accounts.google.com",
                aud: client_id,
                exp: now + 3600,
                nonce: "nonce-123",
                sub: "sub-001",
                email: "u@example.com",
                email_verified: true,
                hd: None,
            },
        );
        assert!(verify_id_token(
            &tok_kid3,
            client_id,
            "nonce-123",
            &mut cache,
            &transport,
            "https://mock.google.local/discovery",
            Some(now),
        )
        .await
        .is_err());

        // Claim failures: wrong nonce, wrong aud, wrong iss, expired, email_verified=false, empty sub
        for bad_claims in [
            TestJwtClaims {
                iss: "https://evil.example.com",
                aud: client_id,
                exp: now + 3600,
                nonce: "nonce-123",
                sub: "sub-001",
                email: "u@example.com",
                email_verified: true,
                hd: None,
            },
            TestJwtClaims {
                iss: "https://accounts.google.com",
                aud: "other-client",
                exp: now + 3600,
                nonce: "nonce-123",
                sub: "sub-001",
                email: "u@example.com",
                email_verified: true,
                hd: None,
            },
            TestJwtClaims {
                iss: "https://accounts.google.com",
                aud: client_id,
                exp: now - 1000,
                nonce: "nonce-123",
                sub: "sub-001",
                email: "u@example.com",
                email_verified: true,
                hd: None,
            },
            TestJwtClaims {
                iss: "https://accounts.google.com",
                aud: client_id,
                exp: now + 3600,
                nonce: "wrong-nonce",
                sub: "sub-001",
                email: "u@example.com",
                email_verified: true,
                hd: None,
            },
            TestJwtClaims {
                iss: "https://accounts.google.com",
                aud: client_id,
                exp: now + 3600,
                nonce: "nonce-123",
                sub: "sub-001",
                email: "u@example.com",
                email_verified: false,
                hd: None,
            },
            TestJwtClaims {
                iss: "https://accounts.google.com",
                aud: client_id,
                exp: now + 3600,
                nonce: "nonce-123",
                sub: "",
                email: "u@example.com",
                email_verified: true,
                hd: None,
            },
        ] {
            let bad_tok = sign_test_id_token("kid-2", &bad_claims);
            assert!(verify_id_token(
                &bad_tok,
                client_id,
                "nonce-123",
                &mut cache,
                &transport,
                "https://mock.google.local/discovery",
                Some(now),
            )
            .await
            .is_err());
        }
    });
}

#[test]
fn test_client_id_namespace_isolation_and_no_refresh_on_mismatch() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let dir = std::env::temp_dir().join(format!("asrc_ns_{}", uuid::Uuid::new_v4()));
        let fp_a = compute_client_id_fingerprint("client-dev-A");
        let fp_b = compute_client_id_fingerprint("client-prod-B");
        assert_ne!(fp_a, fp_b);
        assert_ne!(
            credential_target_name(APP_IDENTIFIER, &fp_a, 0),
            credential_target_name(APP_IDENTIFIER, &fp_b, 0)
        );
        assert_ne!(
            metadata_file_path(&dir, &fp_a),
            metadata_file_path(&dir, &fp_b)
        );

        let cred_store = Arc::new(InMemoryCredentialStore::new());
        let transport = Arc::new(MockTransport::new());
        let now = 1_700_000_000u64;

        // Login with Client ID A
        transport.push_ok(
            "https://mock.google.local/jwks",
            200,
            vec![("Cache-Control", "max-age=300")],
            jwks_json("kid-1"),
        );
        let id_tok_a = sign_test_id_token(
            "kid-1",
            &TestJwtClaims {
                iss: "https://accounts.google.com",
                aud: "client-dev-A",
                exp: now + 3600,
                nonce: "n1",
                sub: "sub-A",
                email: "a@example.com",
                email_verified: true,
                hd: None,
            },
        );
        transport.push_ok(
            "https://mock.google.local/token",
            200,
            vec![],
            serde_json::json!({
                "access_token": "ya29.token-A",
                "refresh_token": "1//refresh-A",
                "expires_in": 3600,
                "scope": "openid email https://www.googleapis.com/auth/cloud-platform",
                "id_token": id_tok_a
            })
            .to_string(),
        );

        let mgr_a = GoogleAuthManager::new(
            test_config("client-dev-A"),
            &dir,
            cred_store.clone(),
            transport.clone(),
            None,
        );
        let st_a = mgr_a
            .complete_authorization_code_exchange(
                &test_config("client-dev-A"),
                "code-1",
                "verifier-1",
                "http://127.0.0.1:1234",
                "n1",
                Some(now),
            )
            .await
            .unwrap();
        assert_eq!(st_a.state, GoogleAuthConnectionState::Connected);
        mgr_a.confirm_project("proj-a-123").await.unwrap();

        // Restart with Client ID A -> restores A + proj-a-123
        let mgr_a2 = GoogleAuthManager::new(
            test_config("client-dev-A"),
            &dir,
            cred_store.clone(),
            transport.clone(),
            None,
        );
        let st_a2 = mgr_a2.get_status().await;
        assert_eq!(st_a2.state, GoogleAuthConnectionState::Connected);
        assert_eq!(st_a2.sub.as_deref(), Some("sub-A"));
        assert_eq!(st_a2.project_id.as_deref(), Some("proj-a-123"));

        // Start with Client ID B -> must NOT restore A, must NOT call refresh
        let calls_before = transport.call_count("https://mock.google.local/token");
        let mgr_b = GoogleAuthManager::new(
            test_config("client-prod-B"),
            &dir,
            cred_store.clone(),
            transport.clone(),
            None,
        );
        let st_b = mgr_b.get_status().await;
        assert_eq!(st_b.state, GoogleAuthConnectionState::Disconnected);
        assert!(st_b.sub.is_none());
        assert!(st_b.project_id.is_none());
        assert_eq!(
            transport.call_count("https://mock.google.local/token"),
            calls_before
        );

        let _ = std::fs::remove_dir_all(&dir);
    });
}

#[test]
fn test_transactional_switch_reauth_project_lifecycle_and_crash_recovery() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let dir = std::env::temp_dir().join(format!("asrc_sw_{}", uuid::Uuid::new_v4()));
        let cred_store = Arc::new(FaultyCredentialStore::new());
        let transport = Arc::new(MockTransport::new());
        let cfg = test_config("client-sw");
        let now = 1_700_000_000u64;

        transport.push_ok(
            "https://mock.google.local/jwks",
            200,
            vec![("Cache-Control", "max-age=300")],
            jwks_json("kid-1"),
        );

        let mgr = GoogleAuthManager::new(
            cfg.clone(),
            &dir,
            cred_store.clone(),
            transport.clone(),
            Some("legacy-proj-001".to_string()),
        );

        // 1. Initial login as sub-A -> lands in slot0, legacy candidate not auto-selected
        let tok_a = sign_test_id_token(
            "kid-1",
            &TestJwtClaims {
                iss: "https://accounts.google.com",
                aud: "client-sw",
                exp: now + 3600,
                nonce: "na",
                sub: "sub-A",
                email: "a@example.com",
                email_verified: true,
                hd: None,
            },
        );
        transport.push_ok(
            "https://mock.google.local/token",
            200,
            vec![],
            serde_json::json!({
                "access_token": "ya29.A1",
                "refresh_token": "1//rt-A1",
                "expires_in": 3600,
                "scope": "openid email https://www.googleapis.com/auth/cloud-platform",
                "id_token": tok_a
            })
            .to_string(),
        );
        let st1 = mgr
            .complete_authorization_code_exchange(
                &cfg,
                "c1",
                "v1",
                "http://127.0.0.1:1000",
                "na",
                Some(now),
            )
            .await
            .unwrap();
        assert_eq!(st1.state, GoogleAuthConnectionState::Connected);
        assert!(st1.project_id.is_none());
        assert_eq!(st1.legacy_project_candidate.as_deref(), Some("legacy-proj-001"));

        // A delayed confirmation must not change the active account's metadata.
        let sub = st1.sub.as_deref().unwrap();
        assert!(mgr.confirm_project_guarded("proj-stale", st1.auth_generation, "other-sub", &st1.oauth_client_id_fingerprint, &st1.auth_session_id).await.is_err());
        assert!(mgr.confirm_project_guarded("proj-stale", st1.auth_generation + 1, sub, &st1.oauth_client_id_fingerprint, &st1.auth_session_id).await.is_err());
        assert!(mgr.confirm_project_guarded("proj-stale", st1.auth_generation, sub, &st1.oauth_client_id_fingerprint, "old-session").await.is_err());
        assert!(mgr.get_status().await.project_id.is_none());
        let guarded = mgr.confirm_project_guarded("proj-guarded", st1.auth_generation, sub, &st1.oauth_client_id_fingerprint, &st1.auth_session_id).await.unwrap();
        assert_eq!(guarded.auth_generation, st1.auth_generation + 1);
        assert_eq!(guarded.auth_session_id, st1.auth_session_id);
        assert_eq!(guarded.project_id.as_deref(), Some("proj-guarded"));
        assert!(mgr.confirm_project_guarded("proj-stale", st1.auth_generation, sub, &st1.oauth_client_id_fingerprint, &st1.auth_session_id).await.is_err());
        assert_eq!(mgr.get_status().await.project_id.as_deref(), Some("proj-guarded"));

        // Confirm project X for A and mark verified
        let st_proj = mgr.confirm_project("proj-x-123").await.unwrap();
        assert_eq!(st_proj.project_id.as_deref(), Some("proj-x-123"));
        assert!(!st_proj.project_verified);
        transport.push_ok(
            "https://mock.google.local/token",
            200,
            vec![],
            serde_json::json!({
                "access_token": "ya29.A1-after-proj",
                "expires_in": 3600
            })
            .to_string(),
        );
        let snap_a = mgr.acquire_snapshot(true).await.unwrap();
        mgr.mark_project_verified_if_current(&snap_a).await.unwrap();
        assert!(mgr.get_status().await.project_verified);

        // 2. Switch to B fails during Credential Manager reload -> A & proj-x-123 remain intact!
        let tok_b = sign_test_id_token(
            "kid-1",
            &TestJwtClaims {
                iss: "https://accounts.google.com",
                aud: "client-sw",
                exp: now + 3600,
                nonce: "nb",
                sub: "sub-B",
                email: "b@example.com",
                email_verified: true,
                hd: None,
            },
        );
        transport.push_ok(
            "https://mock.google.local/token",
            200,
            vec![],
            serde_json::json!({
                "access_token": "ya29.B1",
                "refresh_token": "1//rt-B1",
                "expires_in": 3600,
                "scope": "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/cloud-platform",
                "id_token": tok_b
            })
            .to_string(),
        );
        *cred_store.fail_load.lock().unwrap() = true;
        let sw_err = mgr
            .complete_authorization_code_exchange(
                &cfg,
                "c2",
                "v2",
                "http://127.0.0.1:1000",
                "nb",
                Some(now),
            )
            .await
            .unwrap_err();
        *cred_store.fail_load.lock().unwrap() = false;
        assert_eq!(sw_err.kind, GoogleApiErrorKind::InvalidConfig);
        let st_after_fail = mgr.get_status().await;
        assert_eq!(st_after_fail.sub.as_deref(), Some("sub-A"));
        assert_eq!(st_after_fail.project_id.as_deref(), Some("proj-x-123"));
        assert!(st_after_fail.project_verified);

        // 3. Re-auth same sub-A -> preserves proj-x-123 & verified=true, increments generation
        let gen_before_reauth = st_after_fail.auth_generation;
        transport.push_ok(
            "https://mock.google.local/token",
            200,
            vec![],
            serde_json::json!({
                "access_token": "ya29.A2",
                "refresh_token": "1//rt-A2",
                "expires_in": 3600,
                "scope": "openid email https://www.googleapis.com/auth/cloud-platform",
                "id_token": tok_a
            })
            .to_string(),
        );
        let st_reauth = mgr
            .complete_authorization_code_exchange(
                &cfg,
                "c3",
                "v3",
                "http://127.0.0.1:1000",
                "na",
                Some(now),
            )
            .await
            .unwrap();
        assert_eq!(st_reauth.sub.as_deref(), Some("sub-A"));
        assert_eq!(st_reauth.project_id.as_deref(), Some("proj-x-123"));
        assert!(st_reauth.project_verified);
        assert!(st_reauth.auth_generation > gen_before_reauth);

        // 4. Switch to sub-B (even if old slot delete fails) -> B committed, proj cleared!
        *cred_store.fail_delete.lock().unwrap() = true;
        transport.push_ok(
            "https://mock.google.local/token",
            200,
            vec![],
            serde_json::json!({
                "access_token": "ya29.B2",
                "refresh_token": "1//rt-B2",
                "expires_in": 3600,
                "scope": "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/cloud-platform",
                "id_token": tok_b
            })
            .to_string(),
        );
        let st_b = mgr
            .complete_authorization_code_exchange(
                &cfg,
                "c4",
                "v4",
                "http://127.0.0.1:1000",
                "nb",
                Some(now),
            )
            .await
            .unwrap();
        *cred_store.fail_delete.lock().unwrap() = false;
        assert_eq!(st_b.sub.as_deref(), Some("sub-B"));
        assert!(st_b.project_id.is_none());
        assert!(!st_b.project_verified);
        assert!(mgr.confirm_project_guarded("proj-x-123", st_reauth.auth_generation, st_reauth.sub.as_deref().unwrap(), &st_reauth.oauth_client_id_fingerprint, &st_reauth.auth_session_id).await.is_err());
        assert!(mgr.get_status().await.project_id.is_none());

        // Next startup cleans up orphan non-active slot while keeping B active
        let mgr_restart = GoogleAuthManager::new(
            cfg.clone(),
            &dir,
            cred_store.clone(),
            transport.clone(),
            None,
        );
        assert_eq!(mgr_restart.get_status().await.sub.as_deref(), Some("sub-B"));
        let fp = cfg.fingerprint();
        // B is in slot0 (because re-auth put A in slot1, so B went to slot0), so slot1 must be cleaned
        assert!(cred_store
            .load(&credential_target_name(APP_IDENTIFIER, &fp, 1))
            .unwrap()
            .is_none());

        // 5. Corrupted active_slot pointer -> never guesses, requires reauth
        let meta_path = metadata_file_path(&dir, &fp);
        let corrupt = AuthMetadata {
            schema_version: 1,
            oauth_client_id_fingerprint: fp.clone(),
            active_slot: Some(9),
            auth_generation: 99,
            auth_session_id: "corrupt-session".to_string(),
            slots: [
                Some(SlotMetadata {
                    sub: "sub-B".to_string(),
                    email: "b@example.com".to_string(),
                    hosted_domain: None,
                    canonical_scopes: vec![],
                }),
                None,
            ],
            project_id: Some("proj-x-123".to_string()),
            project_verified: true,
            project_source: None,
        };
        save_metadata_atomic(&meta_path, &corrupt).unwrap();
        let mgr_corrupt = GoogleAuthManager::new(
            cfg.clone(),
            &dir,
            cred_store.clone(),
            transport.clone(),
            None,
        );
        let st_corrupt = mgr_corrupt.get_status().await;
        assert_eq!(st_corrupt.state, GoogleAuthConnectionState::ReauthRequired);
        assert!(st_corrupt.project_id.is_none());

        let _ = std::fs::remove_dir_all(&dir);
    });
}

#[test]
fn test_project_list_recognize_refresh_401_logout_and_revoke() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let dir = std::env::temp_dir().join(format!("asrc_api_{}", uuid::Uuid::new_v4()));
        let cred_store = Arc::new(InMemoryCredentialStore::new());
        let transport = Arc::new(MockTransport::new());
        let cfg = test_config("client-api");
        let now = 1_700_000_000u64;

        transport.push_ok(
            "https://mock.google.local/jwks",
            200,
            vec![("Cache-Control", "max-age=300")],
            jwks_json("kid-1"),
        );
        let tok = sign_test_id_token(
            "kid-1",
            &TestJwtClaims {
                iss: "https://accounts.google.com",
                aud: "client-api",
                exp: now + 3600,
                nonce: "n1",
                sub: "sub-1",
                email: "u@example.com",
                email_verified: true,
                hd: None,
            },
        );
        transport.push_ok(
            "https://mock.google.local/token",
            200,
            vec![],
            serde_json::json!({
                "access_token": "ya29.initial",
                "refresh_token": "1//rt-1",
                "expires_in": 3600,
                "scope": "openid email https://www.googleapis.com/auth/cloud-platform",
                "id_token": tok
            })
            .to_string(),
        );

        let mgr = Arc::new(GoogleAuthManager::new(
            cfg.clone(),
            &dir,
            cred_store.clone(),
            transport.clone(),
            None,
        ));
        mgr.complete_authorization_code_exchange(
            &cfg,
            "c1",
            "v1",
            "http://127.0.0.1:1000",
            "n1",
            Some(now),
        )
        .await
        .unwrap();

        // Project list pagination + 401 -> refresh (scope omitted preserves initial scopes) -> 1 retry
        transport.push_ok(
            "https://cloudresourcemanager.googleapis.com/v3/projects:search",
            401,
            vec![],
            r#"{"error":{"status":"UNAUTHENTICATED","message":"expired"}}"#.to_string(),
        );
        transport.push_ok(
            "https://mock.google.local/token",
            200,
            vec![],
            serde_json::json!({
                "access_token": "ya29.refreshed",
                "expires_in": 3600
            })
            .to_string(),
        );
        transport.push_ok(
            "https://cloudresourcemanager.googleapis.com/v3/projects:search",
            200,
            vec![],
            serde_json::json!({
                "projects": [{"projectId": "proj-b", "displayName": "B", "state": "ACTIVE"}],
                "nextPageToken": "page2"
            })
            .to_string(),
        );
        transport.push_ok(
            "https://cloudresourcemanager.googleapis.com/v3/projects:search",
            200,
            vec![],
            serde_json::json!({
                "projects": [{"projectId": "proj-a", "displayName": "A", "state": "ACTIVE"}]
            })
            .to_string(),
        );

        let list = list_projects_with_auth(&mgr, transport.as_ref(), None)
            .await
            .unwrap();
        assert_eq!(list.projects.len(), 2);
        assert_eq!(list.projects[0].project_id, "proj-a");
        assert_eq!(list.projects[1].project_id, "proj-b");

        // Confirm project & run Speech V2 recognize via snapshot
        mgr.confirm_project("proj-a").await.unwrap();
        transport.push_ok(
            "https://mock.google.local/token",
            200,
            vec![],
            serde_json::json!({
                "access_token": "ya29.refreshed-for-rec",
                "expires_in": 3600
            })
            .to_string(),
        );
        transport.push_ok(
            "https://us-central1-speech.googleapis.com/v2/projects/proj-a",
            200,
            vec![],
            serde_json::json!({
                "results": [{
                    "alternatives": [{
                        "transcript": "こんにちは",
                        "confidence": 0.95,
                        "words": [{"word": "こんにちは", "startOffset": "0s", "endOffset": "1s"}]
                    }]
                }]
            })
            .to_string(),
        );
        let rec = execute_speech_v2_recognize_with_snapshot(
            &mgr,
            transport.as_ref(),
            Some("proj-a"),
            |pid| format!(
                "https://us-central1-speech.googleapis.com/v2/projects/{}/locations/us-central1/recognizers/_:recognize",
                pid
            ),
            &serde_json::json!({"content": "dGVzdA=="}),
            parse_google_stt_response,
            true,
        )
        .await
        .unwrap();
        assert_eq!(rec.transcript, "こんにちは");
        assert!(mgr.get_status().await.project_verified);

        // Normal logout: does NOT call revoke endpoint, clears metadata and deletes slots
        let revoke_calls_before = transport.call_count("https://mock.google.local/revoke");
        let st_out = mgr.logout().await.unwrap();
        assert_eq!(st_out.state, GoogleAuthConnectionState::Disconnected);
        assert_eq!(
            transport.call_count("https://mock.google.local/revoke"),
            revoke_calls_before
        );
        let fp = cfg.fingerprint();
        assert!(cred_store
            .load(&credential_target_name(APP_IDENTIFIER, &fp, 0))
            .unwrap()
            .is_none());

        // Re-login & explicit revoke when revoke endpoint fails -> still commits local logout & increments generation!
        transport.push_ok(
            "https://mock.google.local/token",
            200,
            vec![],
            serde_json::json!({
                "access_token": "ya29.r2",
                "refresh_token": "1//rt-2",
                "expires_in": 3600,
                "scope": "openid email https://www.googleapis.com/auth/cloud-platform",
                "id_token": tok
            })
            .to_string(),
        );
        let st_in2 = mgr
            .complete_authorization_code_exchange(
                &cfg,
                "c2",
                "v2",
                "http://127.0.0.1:1000",
                "n1",
                Some(now),
            )
            .await
            .unwrap();
        let gen_before_revoke = st_in2.auth_generation;
        transport.push_err("https://mock.google.local/revoke", "network down");
        let rev_res = mgr.revoke().await.unwrap();
        assert!(rev_res.logged_out);
        assert!(!rev_res.revoked_on_google);
        assert_eq!(rev_res.status.state, GoogleAuthConnectionState::Disconnected);
        assert!(rev_res.status.auth_generation > gen_before_revoke);
        assert_eq!(
            transport.call_count("https://mock.google.local/revoke"),
            revoke_calls_before + 1
        );

        let _ = std::fs::remove_dir_all(&dir);
    });
}

#[test]
fn test_google_api_error_classification() {
    let disabled = classify_google_cloud_api_error(
        403,
        r#"{"error":{"status":"PERMISSION_DENIED","message":"Speech API has not been used in project","details":[{"reason":"SERVICE_DISABLED"}]}}"#,
        false,
    );
    assert_eq!(disabled.kind, GoogleApiErrorKind::SpeechApiDisabled);

    let billing = classify_google_cloud_api_error(
        403,
        r#"{"error":{"status":"PERMISSION_DENIED","message":"Billing account not enabled","details":[{"reason":"BILLING_DISABLED"}]}}"#,
        false,
    );
    assert_eq!(billing.kind, GoogleApiErrorKind::BillingDisabled);

    let rec_not_found = classify_google_cloud_api_error(
        404,
        r#"{"error":{"status":"NOT_FOUND","message":"Recognizer not found"}}"#,
        false,
    );
    assert_eq!(rec_not_found.kind, GoogleApiErrorKind::RecognizerNotFound);

    let quota = classify_google_cloud_api_error(
        429,
        r#"{"error":{"status":"RESOURCE_EXHAUSTED","message":"Quota exceeded"}}"#,
        false,
    );
    assert_eq!(quota.kind, GoogleApiErrorKind::QuotaOrResourceExhausted);

    let proj_denied = classify_google_cloud_api_error(
        403,
        r#"{"error":{"status":"PERMISSION_DENIED","message":"Caller does not have resourcemanager.projects.search"}}"#,
        true,
    );
    assert_eq!(
        proj_denied.kind,
        GoogleApiErrorKind::ProjectListPermissionDenied
    );
}

#[test]
fn test_save_metadata_atomic_replaces_existing_without_losing_previous() {
    let dir = std::env::temp_dir().join(format!("asrc_atomic_{}", uuid::Uuid::new_v4()));
    let path = dir.join("auth-metadata.json");
    let fp = compute_client_id_fingerprint("client-atomic");

    let m1 = AuthMetadata {
        schema_version: 1,
        oauth_client_id_fingerprint: fp.clone(),
        active_slot: Some(0),
        auth_generation: 1,
        auth_session_id: "session-1".to_string(),
        slots: [
            Some(SlotMetadata {
                sub: "sub-1".to_string(),
                email: "one@example.com".to_string(),
                hosted_domain: None,
                canonical_scopes: vec!["identity:openid".to_string()],
            }),
            None,
        ],
        project_id: Some("proj-one".to_string()),
        project_verified: true,
        project_source: None,
    };
    save_metadata_atomic(&path, &m1).unwrap();

    let m2 = AuthMetadata {
        auth_generation: 2,
        project_id: Some("proj-two".to_string()),
        ..m1.clone()
    };
    save_metadata_atomic(&path, &m2).unwrap();

    let loaded: AuthMetadata =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(loaded.auth_generation, 2);
    assert_eq!(loaded.project_id.as_deref(), Some("proj-two"));
    assert!(!path.with_extension("json.tmp").exists());

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_recognize_single_snapshot_binds_url_project_and_token_against_concurrent_switch_and_project_change() {
    struct HookedTransport {
        inner: MockTransport,
        on_speech_post: Mutex<Option<Box<dyn FnOnce() -> tokio::sync::oneshot::Receiver<()> + Send>>>,
        captured_speech_reqs: Mutex<Vec<(String, Vec<(String, String)>)>>,
    }

    impl GoogleHttpTransport for HookedTransport {
        async fn send(&self, req: HttpRequest) -> Result<HttpResponse, String> {
            let wait_rx = if req.url.contains(":recognize") {
                self.captured_speech_reqs
                    .lock()
                    .unwrap()
                    .push((req.url.clone(), req.headers.clone()));
                self.on_speech_post.lock().unwrap().take().map(|hook| hook())
            } else {
                None
            };
            if let Some(rx) = wait_rx {
                let _ = rx.await;
            }
            self.inner.send(req).await
        }
    }

    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let dir = std::env::temp_dir().join(format!("asrc_race_{}", uuid::Uuid::new_v4()));
        let cred_store = Arc::new(InMemoryCredentialStore::new());
        let inner = MockTransport::new();
        let cfg = test_config("client-race");
        let now = 1_700_000_000u64;

        inner.push_ok(
            "https://mock.google.local/jwks",
            200,
            vec![("Cache-Control", "max-age=300")],
            jwks_json("kid-1"),
        );
        let tok_a = sign_test_id_token(
            "kid-1",
            &TestJwtClaims {
                iss: "https://accounts.google.com",
                aud: "client-race",
                exp: now + 3600,
                nonce: "na",
                sub: "sub-A",
                email: "a@example.com",
                email_verified: true,
                hd: None,
            },
        );
        inner.push_ok(
            "https://mock.google.local/token",
            200,
            vec![],
            serde_json::json!({
                "access_token": "ya29.A-token",
                "refresh_token": "1//rt-A",
                "expires_in": 3600,
                "scope": "openid email https://www.googleapis.com/auth/cloud-platform",
                "id_token": tok_a
            })
            .to_string(),
        );

        let transport = Arc::new(HookedTransport {
            inner,
            on_speech_post: Mutex::new(None),
            captured_speech_reqs: Mutex::new(Vec::new()),
        });
        let mgr = Arc::new(GoogleAuthManager::new(
            cfg.clone(),
            &dir,
            cred_store.clone(),
            transport.clone(),
            None,
        ));

        mgr.complete_authorization_code_exchange(
            &cfg,
            "c1",
            "v1",
            "http://127.0.0.1:1000",
            "na",
            Some(now),
        )
        .await
        .unwrap();
        mgr.confirm_project("proj-old-111").await.unwrap();

        // Prepare token refresh for snapshot A and Speech API response
        transport.inner.push_ok(
            "https://mock.google.local/token",
            200,
            vec![],
            serde_json::json!({
                "access_token": "ya29.A-refreshed",
                "expires_in": 3600
            })
            .to_string(),
        );
        transport.inner.push_ok(
            "https://us-central1-speech.googleapis.com/v2/projects/proj-old-111",
            200,
            vec![],
            serde_json::json!({
                "results": [{"alternatives": [{"transcript": "stale result"}]}]
            })
            .to_string(),
        );

        // Create a dummy wav file
        let wav_path = dir.join("dummy.wav");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&wav_path, b"RIFF0000WAVE").unwrap();

        // While Speech POST is in-flight, change Project ID to proj-new-222 (simulating concurrent change)
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let (done_tx, done_rx) = tokio::sync::oneshot::channel::<()>();
        *transport.on_speech_post.lock().unwrap() = Some(Box::new(move || {
            let _ = tx.send(());
            done_rx
        }));

        let mgr_clone = mgr.clone();
        let switcher = tokio::spawn(async move {
            let _ = rx.await;
            mgr_clone.confirm_project("proj-new-222").await.unwrap();
            let _ = done_tx.send(());
        });

        let res = crate::recognize_google_stt_audio_with_auth(
            &mgr,
            transport.as_ref(),
            None, // caller did not pass expected_project_id
            "us-central1",
            "_",
            "ja-JP",
            "chirp_2",
            &wav_path,
            None,
            true,
        )
        .await;

        switcher.await.unwrap();

        // 1. Outgoing request must have URL project == x-goog-user-project == proj-old-111 and token == ya29.A-refreshed (all from one snapshot)
        let reqs = transport.captured_speech_reqs.lock().unwrap();
        assert_eq!(reqs.len(), 1);
        assert!(reqs[0].0.contains("/projects/proj-old-111/"));
        let auth_hdr = reqs[0]
            .1
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("Authorization"))
            .unwrap();
        assert_eq!(auth_hdr.1, "Bearer ya29.A-refreshed");
        let proj_hdr = reqs[0]
            .1
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("x-goog-user-project"))
            .unwrap();
        assert_eq!(proj_hdr.1, "proj-old-111");

        // 2. Result must be discarded as stale and must NOT mark proj-new-222 verified
        assert!(res.is_err());
        let status = mgr.get_status().await;
        assert_eq!(status.project_id.as_deref(), Some("proj-new-222"));
        assert!(!status.project_verified);

        let _ = std::fs::remove_dir_all(&dir);
    });
}

#[test]
fn test_logout_and_revoke_invalidate_inflight_login_and_preserve_subsequent_login() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let dir = std::env::temp_dir().join(format!("asrc_logout_race_{}", uuid::Uuid::new_v4()));
        let cred_store = Arc::new(InMemoryCredentialStore::new());
        let transport = Arc::new(MockTransport::new());
        let cfg = test_config("client-logout-race");
        let now = 1_700_000_000u64;

        transport.push_ok(
            "https://mock.google.local/jwks",
            200,
            vec![("Cache-Control", "max-age=300")],
            jwks_json("kid-1"),
        );
        let tok_a = sign_test_id_token(
            "kid-1",
            &TestJwtClaims {
                iss: "https://accounts.google.com",
                aud: "client-logout-race",
                exp: now + 3600,
                nonce: "na",
                sub: "sub-A",
                email: "a@example.com",
                email_verified: true,
                hd: None,
            },
        );

        let mgr = Arc::new(GoogleAuthManager::new(
            cfg.clone(),
            &dir,
            cred_store.clone(),
            transport.clone(),
            None,
        ));

        // 1. Login starts (capture epoch), then logout happens before exchange finishes
        let epoch_1 = mgr.current_login_epoch().await;
        mgr.logout().await.unwrap();

        transport.push_ok(
            "https://mock.google.local/token",
            200,
            vec![],
            serde_json::json!({
                "access_token": "ya29.delayed-1",
                "refresh_token": "1//delayed-1",
                "expires_in": 3600,
                "scope": "openid email https://www.googleapis.com/auth/cloud-platform",
                "id_token": tok_a
            })
            .to_string(),
        );
        let delayed_1 = mgr
            .complete_authorization_code_exchange_with_epoch(
                &cfg,
                "c1",
                "v1",
                "http://127.0.0.1:1000",
                "na",
                Some(now),
                Some(epoch_1),
            )
            .await;
        assert_eq!(
            delayed_1.unwrap_err().kind,
            GoogleApiErrorKind::OauthUserCancelled
        );
        assert_eq!(
            mgr.get_status().await.state,
            GoogleAuthConnectionState::Disconnected
        );
        let fp = cfg.fingerprint();
        assert!(cred_store
            .load(&credential_target_name(APP_IDENTIFIER, &fp, 0))
            .unwrap()
            .is_none());

        // 2. Login starts, then explicit revoke happens before exchange finishes
        let epoch_2 = mgr.current_login_epoch().await;
        mgr.revoke().await.unwrap();
        transport.push_ok(
            "https://mock.google.local/token",
            200,
            vec![],
            serde_json::json!({
                "access_token": "ya29.delayed-2",
                "refresh_token": "1//delayed-2",
                "expires_in": 3600,
                "scope": "openid email https://www.googleapis.com/auth/cloud-platform",
                "id_token": tok_a
            })
            .to_string(),
        );
        let delayed_2 = mgr
            .complete_authorization_code_exchange_with_epoch(
                &cfg,
                "c2",
                "v2",
                "http://127.0.0.1:1000",
                "na",
                Some(now),
                Some(epoch_2),
            )
            .await;
        assert_eq!(
            delayed_2.unwrap_err().kind,
            GoogleApiErrorKind::OauthUserCancelled
        );
        assert_eq!(
            mgr.get_status().await.state,
            GoogleAuthConnectionState::Disconnected
        );

        // 3. Subsequent fresh login after logout/revoke succeeds and its credential is intact
        transport.push_ok(
            "https://mock.google.local/token",
            200,
            vec![],
            serde_json::json!({
                "access_token": "ya29.fresh",
                "refresh_token": "1//fresh",
                "expires_in": 3600,
                "scope": "openid email https://www.googleapis.com/auth/cloud-platform",
                "id_token": tok_a
            })
            .to_string(),
        );
        let fresh = mgr
            .complete_authorization_code_exchange(
                &cfg,
                "c3",
                "v3",
                "http://127.0.0.1:1000",
                "na",
                Some(now),
            )
            .await
            .unwrap();
        assert_eq!(fresh.state, GoogleAuthConnectionState::Connected);
        let snap = mgr.acquire_snapshot(false).await.unwrap();
        assert_eq!(snap.access_token, "ya29.fresh");

        let _ = std::fs::remove_dir_all(&dir);
    });
}

#[test]
fn test_refresh_token_missing_recovery_prompt_consent_and_same_sub_vs_different_sub() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let dir = std::env::temp_dir().join(format!("asrc_consent_{}", uuid::Uuid::new_v4()));
        let cred_store = Arc::new(InMemoryCredentialStore::new());
        let transport = Arc::new(MockTransport::new());
        let cfg = test_config("client-consent");
        let now = 1_700_000_000u64;

        // Verify auth URL prompt parameter for normal vs force_consent
        let url_normal =
            build_google_auth_url(&cfg, "http://127.0.0.1:1000", "ch", "st", "nc", false).unwrap();
        assert!(url_normal.contains("prompt=select_account"));
        assert!(!url_normal.contains("prompt=select_account+consent"));
        assert!(!url_normal.contains("prompt=select_account%20consent"));
        let url_consent =
            build_google_auth_url(&cfg, "http://127.0.0.1:1000", "ch", "st", "nc", true).unwrap();
        assert!(url_consent.contains("select_account+consent") || url_consent.contains("select_account%20consent"));

        transport.push_ok(
            "https://mock.google.local/jwks",
            200,
            vec![("Cache-Control", "max-age=300")],
            jwks_json("kid-1"),
        );
        let tok_a = sign_test_id_token(
            "kid-1",
            &TestJwtClaims {
                iss: "https://accounts.google.com",
                aud: "client-consent",
                exp: now + 3600,
                nonce: "na",
                sub: "sub-A",
                email: "a@example.com",
                email_verified: true,
                hd: None,
            },
        );
        let tok_b = sign_test_id_token(
            "kid-1",
            &TestJwtClaims {
                iss: "https://accounts.google.com",
                aud: "client-consent",
                exp: now + 3600,
                nonce: "nb",
                sub: "sub-B",
                email: "b@example.com",
                email_verified: true,
                hd: None,
            },
        );

        let mgr = Arc::new(GoogleAuthManager::new(
            cfg.clone(),
            &dir,
            cred_store.clone(),
            transport.clone(),
            None,
        ));

        // 1. Initial login without refresh_token -> OauthRefreshTokenMissing, remains Disconnected
        transport.push_ok(
            "https://mock.google.local/token",
            200,
            vec![],
            serde_json::json!({
                "access_token": "ya29.no-rt",
                "expires_in": 3600,
                "scope": "openid email https://www.googleapis.com/auth/cloud-platform",
                "id_token": tok_a
            })
            .to_string(),
        );
        let err1 = mgr
            .complete_authorization_code_exchange(
                &cfg,
                "c1",
                "v1",
                "http://127.0.0.1:1000",
                "na",
                Some(now),
            )
            .await
            .unwrap_err();
        assert_eq!(err1.kind, GoogleApiErrorKind::OauthRefreshTokenMissing);
        assert_eq!(
            mgr.get_status().await.state,
            GoogleAuthConnectionState::Disconnected
        );

        // 2. Explicit consent retry succeeds with refresh_token
        transport.push_ok(
            "https://mock.google.local/token",
            200,
            vec![],
            serde_json::json!({
                "access_token": "ya29.A-with-rt",
                "refresh_token": "1//rt-A",
                "expires_in": 3600,
                "scope": "openid email https://www.googleapis.com/auth/cloud-platform",
                "id_token": tok_a
            })
            .to_string(),
        );
        let st_a = mgr
            .complete_authorization_code_exchange(
                &cfg,
                "c2",
                "v2",
                "http://127.0.0.1:1000",
                "na",
                Some(now),
            )
            .await
            .unwrap();
        assert_eq!(st_a.state, GoogleAuthConnectionState::Connected);
        mgr.confirm_project("proj-a-123").await.unwrap();

        // 3. Re-auth same sub-A without refresh_token -> safely reuses sub-A's existing refresh_token and preserves Project ID
        transport.push_ok(
            "https://mock.google.local/token",
            200,
            vec![],
            serde_json::json!({
                "access_token": "ya29.A-reauth",
                "expires_in": 3600,
                "scope": "openid email https://www.googleapis.com/auth/cloud-platform",
                "id_token": tok_a
            })
            .to_string(),
        );
        let st_a_reauth = mgr
            .complete_authorization_code_exchange(
                &cfg,
                "c3",
                "v3",
                "http://127.0.0.1:1000",
                "na",
                Some(now),
            )
            .await
            .unwrap();
        assert_eq!(st_a_reauth.sub.as_deref(), Some("sub-A"));
        assert_eq!(st_a_reauth.project_id.as_deref(), Some("proj-a-123"));

        // 4. Switch to different sub-B without refresh_token -> must NOT reuse sub-A's refresh_token, preserves sub-A!
        transport.push_ok(
            "https://mock.google.local/token",
            200,
            vec![],
            serde_json::json!({
                "access_token": "ya29.B-no-rt",
                "expires_in": 3600,
                "scope": "openid email https://www.googleapis.com/auth/cloud-platform",
                "id_token": tok_b
            })
            .to_string(),
        );
        let err_b = mgr
            .complete_authorization_code_exchange(
                &cfg,
                "c4",
                "v4",
                "http://127.0.0.1:1000",
                "nb",
                Some(now),
            )
            .await
            .unwrap_err();
        assert_eq!(err_b.kind, GoogleApiErrorKind::OauthRefreshTokenMissing);
        let st_after = mgr.get_status().await;
        assert_eq!(st_after.sub.as_deref(), Some("sub-A"));
        assert_eq!(st_after.project_id.as_deref(), Some("proj-a-123"));

        let _ = std::fs::remove_dir_all(&dir);
    });
}

#[test]
fn test_revoke_metadata_save_failure_still_deletes_credentials_and_prevents_restart_restore() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        for google_revoke_succeeds in [true, false] {
            let dir = std::env::temp_dir().join(format!(
                "asrc_rev_fail_{}_{}",
                google_revoke_succeeds,
                uuid::Uuid::new_v4()
            ));
            let cred_store = Arc::new(InMemoryCredentialStore::new());
            let transport = Arc::new(MockTransport::new());
            let cfg = test_config("client-rev-fail");
            let now = 1_700_000_000u64;

            transport.push_ok(
                "https://mock.google.local/jwks",
                200,
                vec![("Cache-Control", "max-age=300")],
                jwks_json("kid-1"),
            );
            let tok = sign_test_id_token(
                "kid-1",
                &TestJwtClaims {
                    iss: "https://accounts.google.com",
                    aud: "client-rev-fail",
                    exp: now + 3600,
                    nonce: "n1",
                    sub: "sub-rev",
                    email: "rev@example.com",
                    email_verified: true,
                    hd: None,
                },
            );
            transport.push_ok(
                "https://mock.google.local/token",
                200,
                vec![],
                serde_json::json!({
                    "access_token": "ya29.rev",
                    "refresh_token": "1//rt-rev",
                    "expires_in": 3600,
                    "scope": "openid email https://www.googleapis.com/auth/cloud-platform",
                    "id_token": tok
                })
                .to_string(),
            );

            let mgr = GoogleAuthManager::new(
                cfg.clone(),
                &dir,
                cred_store.clone(),
                transport.clone(),
                None,
            );
            mgr.complete_authorization_code_exchange(
                &cfg,
                "c1",
                "v1",
                "http://127.0.0.1:1000",
                "n1",
                Some(now),
            )
            .await
            .unwrap();
            mgr.confirm_project("proj-rev-123").await.unwrap();

            // Inject metadata persistence failure by blocking json.tmp creation with a directory
            let fp = cfg.fingerprint();
            let meta_path = metadata_file_path(&dir, &fp);
            let tmp_blocker = meta_path.with_extension("json.tmp");
            std::fs::create_dir_all(&tmp_blocker).unwrap();

            if google_revoke_succeeds {
                transport.push_ok("https://mock.google.local/revoke", 200, vec![], String::new());
            } else {
                transport.push_err("https://mock.google.local/revoke", "network error");
            }

            let rev_res = mgr.revoke().await;
            assert!(rev_res.is_err(), "expected metadata save failure error");

            // Credentials must be deleted regardless of metadata save failure
            assert!(cred_store
                .load(&credential_target_name(APP_IDENTIFIER, &fp, 0))
                .unwrap()
                .is_none());
            assert!(cred_store
                .load(&credential_target_name(APP_IDENTIFIER, &fp, 1))
                .unwrap()
                .is_none());

            // Simulate app restart -> must NOT restore old account or project
            let _ = std::fs::remove_dir_all(&tmp_blocker);
            let mgr_restarted = GoogleAuthManager::new(
                cfg.clone(),
                &dir,
                cred_store.clone(),
                transport.clone(),
                None,
            );
            let st_restarted = mgr_restarted.get_status().await;
            assert_ne!(st_restarted.state, GoogleAuthConnectionState::Connected);
            assert!(st_restarted.sub.is_none());
            assert!(st_restarted.project_id.is_none());

            let _ = std::fs::remove_dir_all(&dir);
        }

        // Verify marker write failure itself is explicitly reported instead of ignored
        let dir = std::env::temp_dir().join(format!("asrc_marker_fail_{}", uuid::Uuid::new_v4()));
        let cred_store = Arc::new(FailingDeleteCredentialStore::new(false));
        let transport = Arc::new(MockTransport::new());
        let cfg = test_config("client-marker-fail");
        let now = 1_700_000_000u64;
        transport.push_ok(
            "https://mock.google.local/jwks",
            200,
            vec![("Cache-Control", "max-age=300")],
            jwks_json("kid-1"),
        );
        let tok = sign_test_id_token(
            "kid-1",
            &TestJwtClaims {
                iss: "https://accounts.google.com",
                aud: "client-marker-fail",
                exp: now + 3600,
                nonce: "nm",
                sub: "sub-marker",
                email: "marker@example.com",
                email_verified: true,
                hd: None,
            },
        );
        transport.push_ok(
            "https://mock.google.local/token",
            200,
            vec![],
            serde_json::json!({
                "access_token": "ya29.m1",
                "refresh_token": "1//m1",
                "expires_in": 3600,
                "scope": "openid email https://www.googleapis.com/auth/cloud-platform",
                "id_token": tok
            })
            .to_string(),
        );
        let mgr = Arc::new(GoogleAuthManager::new(
            cfg.clone(),
            &dir,
            cred_store.clone(),
            transport.clone(),
            None,
        ));
        mgr.complete_authorization_code_exchange(
            &cfg,
            "code",
            "ver",
            "http://127.0.0.1:1000",
            "nm",
            Some(now),
        )
        .await
        .unwrap();

        let meta_path = metadata_file_path(&dir, &cfg.fingerprint());
        let marker_blocker = logout_pending_marker_path(&meta_path);
        std::fs::create_dir_all(&marker_blocker).unwrap();
        cred_store.set_fail_delete(true);
        let err = mgr.logout().await.unwrap_err();
        assert!(err.message.contains("logout-pendingマーカー書込失敗"));
        let _ = std::fs::remove_dir_all(&dir);

        // Simulate crash right after write-ahead logout-pending marker is written
        // (old metadata and old Credential Manager token still intact): restart must NOT restore old auth.
        let dir_crash = std::env::temp_dir().join(format!("asrc_crash_marker_{}", uuid::Uuid::new_v4()));
        let cred_crash = Arc::new(FailingDeleteCredentialStore::new(false));
        let transport_crash = Arc::new(MockTransport::new());
        let cfg_crash = test_config("client-crash-marker");
        transport_crash.push_ok(
            "https://mock.google.local/jwks",
            200,
            vec![("Cache-Control", "max-age=300")],
            jwks_json("kid-1"),
        );
        let tok_crash = sign_test_id_token(
            "kid-1",
            &TestJwtClaims {
                iss: "https://accounts.google.com",
                aud: "client-crash-marker",
                exp: now + 3600,
                nonce: "nc",
                sub: "sub-crash",
                email: "crash@example.com",
                email_verified: true,
                hd: None,
            },
        );
        transport_crash.push_ok(
            "https://mock.google.local/token",
            200,
            vec![],
            serde_json::json!({
                "access_token": "ya29.crash",
                "refresh_token": "1//crash",
                "expires_in": 3600,
                "scope": "openid email https://www.googleapis.com/auth/cloud-platform",
                "id_token": tok_crash
            })
            .to_string(),
        );
        let mgr_crash = GoogleAuthManager::new(
            cfg_crash.clone(),
            &dir_crash,
            cred_crash.clone(),
            transport_crash.clone(),
            None,
        );
        mgr_crash
            .complete_authorization_code_exchange(
                &cfg_crash,
                "code",
                "ver",
                "http://127.0.0.1:1000",
                "nc",
                Some(now),
            )
            .await
            .unwrap();
        let fp_crash = cfg_crash.fingerprint();
        let meta_crash = metadata_file_path(&dir_crash, &fp_crash);
        std::fs::write(logout_pending_marker_path(&meta_crash), b"1").unwrap();

        let mgr_restarted = GoogleAuthManager::new(
            cfg_crash.clone(),
            &dir_crash,
            cred_crash.clone(),
            transport_crash.clone(),
            None,
        );
        let st = mgr_restarted.get_status().await;
        assert_eq!(st.state, GoogleAuthConnectionState::Disconnected);
        assert!(st.sub.is_none());
        assert!(!logout_pending_marker_path(&meta_crash).exists());
        assert!(cred_crash
            .load(&credential_target_name(APP_IDENTIFIER, &fp_crash, 0))
            .unwrap()
            .is_none());
        let _ = std::fs::remove_dir_all(&dir_crash);

        // If slot deletion fails while logout-pending marker exists, marker MUST be kept so restart
        // cannot restore old metadata/credential.
        let dir_slot_fail = std::env::temp_dir().join(format!("asrc_slot_fail_{}", uuid::Uuid::new_v4()));
        let cred_slot_fail = Arc::new(FailingDeleteCredentialStore::new(false));
        let transport_slot_fail = Arc::new(MockTransport::new());
        let cfg_slot_fail = test_config("client-slot-fail");
        let fp_slot_fail = cfg_slot_fail.fingerprint();
        let meta_slot_fail = metadata_file_path(&dir_slot_fail, &fp_slot_fail);
        let marker_slot_fail = logout_pending_marker_path(&meta_slot_fail);

        transport_slot_fail.push_ok(
            "https://mock.google.local/jwks",
            200,
            vec![("Cache-Control", "max-age=300")],
            jwks_json("kid-1"),
        );
        let tok_old = sign_test_id_token(
            "kid-1",
            &TestJwtClaims {
                iss: "https://accounts.google.com",
                aud: "client-slot-fail",
                exp: now + 3600,
                nonce: "ns1",
                sub: "sub-old",
                email: "old@example.com",
                email_verified: true,
                hd: None,
            },
        );
        transport_slot_fail.push_ok(
            "https://mock.google.local/token",
            200,
            vec![],
            serde_json::json!({
                "access_token": "ya29.old",
                "refresh_token": "1//old",
                "expires_in": 3600,
                "scope": "openid email https://www.googleapis.com/auth/cloud-platform",
                "id_token": tok_old
            })
            .to_string(),
        );
        let mgr_slot_fail = GoogleAuthManager::new(
            cfg_slot_fail.clone(),
            &dir_slot_fail,
            cred_slot_fail.clone(),
            transport_slot_fail.clone(),
            None,
        );
        mgr_slot_fail
            .complete_authorization_code_exchange(
                &cfg_slot_fail,
                "code-old",
                "ver-old",
                "http://127.0.0.1:1000",
                "ns1",
                Some(now),
            )
            .await
            .unwrap();
        let old_snapshot = mgr_slot_fail.acquire_snapshot(false).await.unwrap();

        // Simulate pending logout marker + failing slot delete on re-login
        std::fs::write(&marker_slot_fail, b"1").unwrap();
        cred_slot_fail.set_fail_delete(true);
        transport_slot_fail.push_ok(
            "https://mock.google.local/token",
            200,
            vec![],
            serde_json::json!({
                "access_token": "ya29.new",
                "refresh_token": "1//new",
                "expires_in": 3600,
                "scope": "openid email https://www.googleapis.com/auth/cloud-platform",
                "id_token": tok_old
            })
            .to_string(),
        );
        let slot_fail_err = mgr_slot_fail
            .complete_authorization_code_exchange(
                &cfg_slot_fail,
                "code-new",
                "ver-new",
                "http://127.0.0.1:1000",
                "ns1",
                Some(now),
            )
            .await
            .unwrap_err();
        assert!(slot_fail_err.message.contains("mock Credential Manager delete failure"));
        assert!(marker_slot_fail.exists(), "marker must remain when slot deletion fails");
        let in_process_status = mgr_slot_fail.get_status().await;
        assert_eq!(in_process_status.state, GoogleAuthConnectionState::ReauthRequired);
        assert!(in_process_status.sub.is_none());
        assert!(!mgr_slot_fail.is_snapshot_current(&old_snapshot).await);
        assert!(mgr_slot_fail.acquire_snapshot(false).await.is_err());

        // Restarting while delete still fails must NOT restore old account
        let mgr_slot_restarted = GoogleAuthManager::new(
            cfg_slot_fail.clone(),
            &dir_slot_fail,
            cred_slot_fail.clone(),
            transport_slot_fail.clone(),
            None,
        );
        let st_slot_restarted = mgr_slot_restarted.get_status().await;
        assert_eq!(st_slot_restarted.state, GoogleAuthConnectionState::ReauthRequired);
        assert!(st_slot_restarted.sub.is_none());
        let _ = std::fs::remove_dir_all(&dir_slot_fail);

        // 1) If logout-pending marker removal fails, re-login MUST fail with reauth_required (never report success)
        //    and MUST NOT save/then-delete new credentials;
        // 2) Once marker is removable, re-login cleans up marker BEFORE saving new credential and survives restart.
        let dir_relogin = std::env::temp_dir().join(format!("asrc_marker_relogin_{}", uuid::Uuid::new_v4()));
        let cred_relogin = Arc::new(FailingDeleteCredentialStore::new(false));
        let transport_relogin = Arc::new(MockTransport::new());
        let cfg_relogin = test_config("client-marker-relogin");
        let fp_relogin = cfg_relogin.fingerprint();
        let meta_relogin = metadata_file_path(&dir_relogin, &fp_relogin);
        let marker_relogin = logout_pending_marker_path(&meta_relogin);

        transport_relogin.push_ok(
            "https://mock.google.local/jwks",
            200,
            vec![("Cache-Control", "max-age=300")],
            jwks_json("kid-1"),
        );
        let tok_relogin = sign_test_id_token(
            "kid-1",
            &TestJwtClaims {
                iss: "https://accounts.google.com",
                aud: "client-marker-relogin",
                exp: now + 3600,
                nonce: "nr1",
                sub: "sub-new",
                email: "new@example.com",
                email_verified: true,
                hd: None,
            },
        );
        transport_relogin.push_ok(
            "https://mock.google.local/token",
            200,
            vec![],
            serde_json::json!({
                "access_token": "ya29.new1",
                "refresh_token": "1//new1",
                "expires_in": 3600,
                "scope": "openid email https://www.googleapis.com/auth/cloud-platform",
                "id_token": tok_relogin
            })
            .to_string(),
        );

        let mgr_relogin = GoogleAuthManager::new(
            cfg_relogin.clone(),
            &dir_relogin,
            cred_relogin.clone(),
            transport_relogin.clone(),
            None,
        );
        // Block marker removal by making it a non-empty directory
        std::fs::create_dir_all(marker_relogin.join("lock")).unwrap();
        let fail_res = mgr_relogin
            .complete_authorization_code_exchange(
                &cfg_relogin,
                "code1",
                "ver1",
                "http://127.0.0.1:1000",
                "nr1",
                Some(now),
            )
            .await;
        let fail_err = fail_res.unwrap_err();
        assert!(fail_err.message.contains("logout-pendingマーカー削除失敗"));
        assert_eq!(
            mgr_relogin.get_status().await.state,
            GoogleAuthConnectionState::ReauthRequired
        );
        // New credential was not written/orphaned
        assert!(cred_relogin
            .load(&credential_target_name(APP_IDENTIFIER, &fp_relogin, 0))
            .unwrap()
            .is_none());

        // Now replace directory blocker with a regular file marker -> re-login cleans it up BEFORE committing
        std::fs::remove_dir_all(&marker_relogin).unwrap();
        std::fs::write(&marker_relogin, b"1").unwrap();
        transport_relogin.push_ok(
            "https://mock.google.local/token",
            200,
            vec![],
            serde_json::json!({
                "access_token": "ya29.new2",
                "refresh_token": "1//new2",
                "expires_in": 3600,
                "scope": "openid email https://www.googleapis.com/auth/cloud-platform",
                "id_token": tok_relogin
            })
            .to_string(),
        );
        let ok_status = mgr_relogin
            .complete_authorization_code_exchange(
                &cfg_relogin,
                "code2",
                "ver2",
                "http://127.0.0.1:1000",
                "nr1",
                Some(now),
            )
            .await
            .unwrap();
        assert_eq!(ok_status.state, GoogleAuthConnectionState::Connected);
        assert!(!marker_relogin.exists());

        // Restarting app must restore the new account (not wipe it)
        let mgr_restarted_new = GoogleAuthManager::new(
            cfg_relogin.clone(),
            &dir_relogin,
            cred_relogin.clone(),
            transport_relogin.clone(),
            None,
        );
        let st_restored = mgr_restarted_new.get_status().await;
        assert_eq!(st_restored.state, GoogleAuthConnectionState::Connected);
        assert_eq!(st_restored.sub.as_deref(), Some("sub-new"));
        let _ = std::fs::remove_dir_all(&dir_relogin);
    });
}

#[test]
fn test_oauth_client_secret_modes_required_vs_none_and_missing_config() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let now = 1_700_000_000u64;

        // 1) secret_mode=Required sends matching client_id + client_secret in BOTH code exchange and refresh
        for mode in [OAuthClientSecretMode::Required, OAuthClientSecretMode::None] {
            let dir = std::env::temp_dir().join(format!(
                "asrc_secret_mode_{:?}_{}",
                mode,
                uuid::Uuid::new_v4()
            ));
            let cred_store = Arc::new(InMemoryCredentialStore::new());
            let transport = Arc::new(MockTransport::new());
            let mut cfg = test_config("client-mode-test");
            cfg.secret_mode = mode;
            cfg.client_secret = match mode {
                OAuthClientSecretMode::Required => Some("fake-secret-xyz".to_string()),
                OAuthClientSecretMode::None => Some("ignored-secret-xyz".to_string()),
            };

            transport.push_ok(
                "https://mock.google.local/jwks",
                200,
                vec![("Cache-Control", "max-age=300")],
                jwks_json("kid-1"),
            );
            let id_tok = sign_test_id_token(
                "kid-1",
                &TestJwtClaims {
                    iss: "https://accounts.google.com",
                    aud: "client-mode-test",
                    exp: now + 3600,
                    nonce: "n-mode",
                    sub: "sub-mode",
                    email: "mode@example.com",
                    email_verified: true,
                    hd: None,
                },
            );
            transport.push_ok(
                "https://mock.google.local/token",
                200,
                vec![],
                serde_json::json!({
                    "access_token": "ya29.initial",
                    "refresh_token": "1//mode-rt",
                    "expires_in": 3600,
                    "scope": "openid email https://www.googleapis.com/auth/cloud-platform",
                    "id_token": id_tok
                })
                .to_string(),
            );
            transport.push_ok(
                "https://mock.google.local/token",
                200,
                vec![],
                serde_json::json!({
                    "access_token": "ya29.refreshed",
                    "expires_in": 3600
                })
                .to_string(),
            );

            let mgr = GoogleAuthManager::new(
                cfg.clone(),
                &dir,
                cred_store.clone(),
                transport.clone(),
                None,
            );
            assert!(mgr.get_status().await.oauth_client_configured);

            mgr.complete_authorization_code_exchange(
                &cfg,
                "auth-code-1",
                "verifier-1",
                "http://127.0.0.1:4321",
                "n-mode",
                Some(now),
            )
            .await
            .unwrap();

            // Force refresh
            let snap = mgr.acquire_snapshot(false).await.unwrap();
            assert_eq!(snap.access_token, "ya29.initial");
            let snap_refreshed = mgr.acquire_snapshot(false).await;
            // Clear cache by calling acquire_snapshot after manually testing refresh? Let's test via a fresh manager restart!
            drop(snap_refreshed);
            let mgr_restarted = GoogleAuthManager::new(
                cfg.clone(),
                &dir,
                cred_store.clone(),
                transport.clone(),
                None,
            );
            let snap_after_restart = mgr_restarted.acquire_snapshot(false).await.unwrap();
            assert_eq!(snap_after_restart.access_token, "ya29.refreshed");

            let sent = transport.bodies.lock().unwrap();
            let token_reqs: Vec<&(String, Option<String>)> = sent
                .iter()
                .filter(|(u, _)| u == "https://mock.google.local/token")
                .collect();
            assert_eq!(token_reqs.len(), 2);
            for (_, body_opt) in token_reqs {
                let body = body_opt.as_deref().unwrap_or("");
                assert!(body.contains("client_id=client-mode-test"));
                if mode == OAuthClientSecretMode::Required {
                    assert!(body.contains("client_secret=fake-secret-xyz"));
                } else {
                    assert!(!body.contains("client_secret="));
                    assert!(!body.contains("ignored-secret-xyz"));
                }
            }
            let _ = std::fs::remove_dir_all(&dir);
        }

        // 2) secret_mode=Required with missing client_secret -> unconfigured, refuses browser launch
        let dir_missing = std::env::temp_dir().join(format!("asrc_missing_sec_{}", uuid::Uuid::new_v4()));
        let mut cfg_missing = test_config("client-missing-secret");
        cfg_missing.secret_mode = OAuthClientSecretMode::Required;
        cfg_missing.client_secret = None;
        let mgr_missing = GoogleAuthManager::new(
            cfg_missing,
            &dir_missing,
            Arc::new(InMemoryCredentialStore::new()),
            Arc::new(MockTransport::new()),
            None,
        );
        assert!(!mgr_missing.get_status().await.oauth_client_configured);
        let mut browser_opened = false;
        let login_err = mgr_missing
            .start_login_flow(|_| {
                browser_opened = true;
                Ok(())
            })
            .await
            .unwrap_err();
        assert!(!browser_opened);
        assert_eq!(login_err.kind, crate::google_oauth::GoogleApiErrorKind::InvalidConfig);
        assert!(login_err.message.contains("Client Secretが未設定"));
        let _ = std::fs::remove_dir_all(&dir_missing);
    });
}

#[test]
fn test_oauth_secrets_and_raw_google_errors_never_leak() {
    let fake_secret = "GOCSPX-FAKE-SECRET-DO-NOT-LEAK";
    let mut cfg = test_config("client-leak-test");
    cfg.client_secret = Some(fake_secret.to_string());

    // Debug output of GoogleOAuthConfig and OAuthClientCredentials must redact client_secret
    let cfg_dbg = format!("{:?}", cfg);
    assert!(!cfg_dbg.contains(fake_secret));
    assert!(cfg_dbg.contains("[REDACTED]"));

    let creds = OAuthClientCredentials {
        client_id: "client-leak-test".to_string(),
        client_secret: Some(fake_secret.to_string()),
        secret_mode: OAuthClientSecretMode::Required,
        default_project_id: Some("amed-512123".to_string()),
    };
    let creds_dbg = format!("{:?}", creds);
    assert!(!creds_dbg.contains(fake_secret));
    assert!(creds_dbg.contains("[REDACTED]"));

    // Dev and prod config selection never fall back or mix ID/Secret across sources
    let dev_only = resolve_client_config_for_build(
        true,
        Some(OAuthClientCredentials {
            client_id: "dev-id".to_string(),
            client_secret: Some("dev-secret".to_string()),
            secret_mode: OAuthClientSecretMode::Required,
            default_project_id: Some("amed-512123".to_string()),
        }),
        Some(OAuthClientCredentials {
            client_id: "prod-id".to_string(),
            client_secret: Some("prod-secret".to_string()),
            secret_mode: OAuthClientSecretMode::Required,
            default_project_id: Some("prod-proj-123".to_string()),
        }),
    );
    assert_eq!(dev_only.client_id, "dev-id");
    assert_eq!(dev_only.client_secret.as_deref(), Some("dev-secret"));
    assert_eq!(dev_only.default_project_id.as_deref(), Some("amed-512123"));
    let missing_prod = resolve_client_config_for_build(
        false,
        Some(OAuthClientCredentials {
            client_id: "dev-id".to_string(),
            client_secret: Some("dev-secret".to_string()),
            secret_mode: OAuthClientSecretMode::Required,
            default_project_id: Some("amed-512123".to_string()),
        }),
        None,
    );
    assert!(missing_prod.client_id.is_empty());
    assert!(missing_prod.client_secret.is_none());
    assert!(missing_prod.default_project_id.is_none());

    // HTTP error responses with raw error_description / fake secrets must be sanitized and never leaked
    let raw_invalid_client = serde_json::json!({
        "error": "invalid_client",
        "error_description": format!("bad secret {} and raw token ya29.fake", fake_secret)
    })
    .to_string();
    let classified = crate::google_oauth::classify_token_error_response(401, &raw_invalid_client);
    assert_eq!(classified.kind, GoogleApiErrorKind::InvalidConfig);
    assert!(!classified.message.contains(fake_secret));
    assert!(!classified.message.contains("ya29.fake"));
    assert!(classified.message.contains("Google Cloud Console"));

    let raw_other = serde_json::json!({
        "error": "server_error",
        "error_description": format!("internal secret {}", fake_secret)
    })
    .to_string();
    let classified_other = crate::google_oauth::classify_token_error_response(500, &raw_other);
    assert!(!classified_other.message.contains(fake_secret));
    assert!(!classified_other.message.contains("internal secret"));
}

#[test]
fn test_speech_api_disabled_structured_classification_and_service_allowlist() {
    // Allowlist strictly permits only speech.googleapis.com
    assert!(validate_allowed_enable_service("speech.googleapis.com").is_ok());
    assert!(validate_allowed_enable_service("cloudresourcemanager.googleapis.com").is_err());
    assert!(validate_allowed_enable_service("iam.googleapis.com").is_err());
    assert!(validate_allowed_enable_service("").is_err());

    // Structured SERVICE_DISABLED with speech.googleapis.com and consumer project
    let body = serde_json::json!({
        "error": {
            "code": 403,
            "message": "Cloud Speech-to-Text API has not been used in project amed-512123 before or it is disabled.",
            "status": "PERMISSION_DENIED",
            "details": [{
                "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                "reason": "SERVICE_DISABLED",
                "metadata": {
                    "service": "speech.googleapis.com",
                    "consumer": "projects/amed-512123"
                }
            }]
        }
    })
    .to_string();
    let err = classify_google_cloud_api_error(403, &body, false);
    assert_eq!(err.kind, GoogleApiErrorKind::SpeechApiDisabled);
    assert_eq!(err.target_service.as_deref(), Some("speech.googleapis.com"));
    assert_eq!(err.consumer_project.as_deref(), Some("amed-512123"));

    // Non-speech service disabled must NOT classify as SpeechApiDisabled
    let other_svc_body = serde_json::json!({
        "error": {
            "code": 403,
            "message": "Other service disabled",
            "status": "PERMISSION_DENIED",
            "details": [{
                "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                "reason": "SERVICE_DISABLED",
                "metadata": {
                    "service": "storage.googleapis.com",
                    "consumer": "projects/amed-512123"
                }
            }]
        }
    })
    .to_string();
    let other_err = classify_google_cloud_api_error(403, &other_svc_body, false);
    assert_ne!(other_err.kind, GoogleApiErrorKind::SpeechApiDisabled);

    // HTTP 403 without billing reason must NOT guess BillingDisabled
    let perm_only = serde_json::json!({
        "error": { "code": 403, "message": "Permission denied", "status": "PERMISSION_DENIED" }
    })
    .to_string();
    let perm_err = classify_google_cloud_api_error(403, &perm_only, false);
    assert_eq!(perm_err.kind, GoogleApiErrorKind::SpeechPermissionDenied);
}

#[test]
fn test_service_usage_enable_and_check_lifecycle_and_stale_guards() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let now = 1_700_000_000u64;
        let dir = std::env::temp_dir().join(format!("asrc_su_{}", uuid::Uuid::new_v4()));
        let cred_store = Arc::new(InMemoryCredentialStore::new());
        let transport = Arc::new(MockTransport::new());
        let cfg = test_config("client-su");

        transport.push_ok(
            "https://mock.google.local/jwks",
            200,
            vec![("Cache-Control", "max-age=300")],
            jwks_json("kid-1"),
        );
        let tok_a = sign_test_id_token(
            "kid-1",
            &TestJwtClaims {
                iss: "https://accounts.google.com",
                aud: "client-su",
                exp: now + 3600,
                nonce: "nsu1",
                sub: "sub-su-A",
                email: "sua@example.com",
                email_verified: true,
                hd: None,
            },
        );
        transport.push_ok(
            "https://mock.google.local/token",
            200,
            vec![],
            serde_json::json!({
                "access_token": "ya29.su1",
                "refresh_token": "1//su1",
                "expires_in": 3600,
                "scope": "openid email https://www.googleapis.com/auth/cloud-platform",
                "id_token": tok_a
            })
            .to_string(),
        );

        let mgr = Arc::new(GoogleAuthManager::new(
            cfg.clone(),
            &dir,
            cred_store.clone(),
            transport.clone(),
            None,
        ));
        mgr.complete_authorization_code_exchange(
            &cfg,
            "c1",
            "v1",
            "http://127.0.0.1:1000",
            "nsu1",
            Some(now),
        )
        .await
        .unwrap();
        mgr.confirm_project("proj-su-1").await.unwrap();

        // Refresh token response for the post-confirm_project snapshot
        transport.push_ok(
            "https://mock.google.local/token",
            200,
            vec![],
            serde_json::json!({
                "access_token": "ya29.su2",
                "expires_in": 3600
            })
            .to_string(),
        );

        // 1) confirmed_by_user=false must fail without calling HTTP
        let unconfirmed = enable_speech_api_with_auth(
            &mgr,
            transport.as_ref(),
            Some("proj-su-1"),
            false,
            Some("https://mock.google.local/su"),
            Duration::from_millis(1),
            2,
        )
        .await
        .unwrap_err();
        assert_eq!(unconfirmed.kind, GoogleApiErrorKind::InvalidConfig);

        // 2) check_speech_api_state returns ENABLED / DISABLED and distinguishes permission denied
        transport.push_ok(
            "https://mock.google.local/su/projects/proj-su-1/services/speech.googleapis.com",
            200,
            vec![],
            serde_json::json!({ "state": "DISABLED" }).to_string(),
        );
        let st_dis = check_speech_api_state_with_auth(
            &mgr,
            transport.as_ref(),
            Some("proj-su-1"),
            Some("https://mock.google.local/su"),
        )
        .await
        .unwrap();
        assert_eq!(st_dis.state, "DISABLED");

        transport.push_ok(
            "https://mock.google.local/su/projects/proj-su-1/services/speech.googleapis.com",
            403,
            vec![],
            serde_json::json!({
                "error": { "code": 403, "message": "Permission denied", "status": "PERMISSION_DENIED" }
            })
            .to_string(),
        );
        let st_perm_err = check_speech_api_state_with_auth(
            &mgr,
            transport.as_ref(),
            Some("proj-su-1"),
            Some("https://mock.google.local/su"),
        )
        .await
        .unwrap_err();
        assert_eq!(st_perm_err.kind, GoogleApiErrorKind::ServiceUsagePermissionDenied);

        // 3) Async operation polling -> done: true succeeds
        transport.push_ok(
            "https://mock.google.local/su/projects/proj-su-1/services/speech.googleapis.com:enable",
            200,
            vec![],
            serde_json::json!({ "name": "operations/op-1", "done": false }).to_string(),
        );
        transport.push_ok(
            "https://mock.google.local/su/operations/op-1",
            200,
            vec![],
            serde_json::json!({ "name": "operations/op-1", "done": false }).to_string(),
        );
        transport.push_ok(
            "https://mock.google.local/su/operations/op-1",
            200,
            vec![],
            serde_json::json!({ "name": "operations/op-1", "done": true }).to_string(),
        );
        let enabled = enable_speech_api_with_auth(
            &mgr,
            transport.as_ref(),
            Some("proj-su-1"),
            true,
            Some("https://mock.google.local/su"),
            Duration::from_millis(1),
            3,
        )
        .await
        .unwrap();
        assert_eq!(enabled.status, "enabled");
        assert_eq!(enabled.project_id, "proj-su-1");

        // 4) Operation failure & timeout
        transport.push_ok(
            "https://mock.google.local/su/projects/proj-su-1/services/speech.googleapis.com:enable",
            200,
            vec![],
            serde_json::json!({
                "name": "operations/op-fail",
                "done": true,
                "error": { "code": 7, "message": "enable failed" }
            })
            .to_string(),
        );
        let op_fail = enable_speech_api_with_auth(
            &mgr,
            transport.as_ref(),
            Some("proj-su-1"),
            true,
            Some("https://mock.google.local/su"),
            Duration::from_millis(1),
            2,
        )
        .await
        .unwrap_err();
        assert_eq!(op_fail.kind, GoogleApiErrorKind::ServiceUsageOperationFailed);

        transport.push_ok(
            "https://mock.google.local/su/projects/proj-su-1/services/speech.googleapis.com:enable",
            200,
            vec![],
            serde_json::json!({ "name": "operations/op-timeout", "done": false }).to_string(),
        );
        transport.push_ok(
            "https://mock.google.local/su/operations/op-timeout",
            200,
            vec![],
            serde_json::json!({ "name": "operations/op-timeout", "done": false }).to_string(),
        );
        let op_timeout = enable_speech_api_with_auth(
            &mgr,
            transport.as_ref(),
            Some("proj-su-1"),
            true,
            Some("https://mock.google.local/su"),
            Duration::from_millis(1),
            1,
        )
        .await
        .unwrap_err();
        assert_eq!(op_timeout.kind, GoogleApiErrorKind::ServiceUsageOperationTimeout);

        // 5) Distinguish ServiceUsageApiDisabled, OauthScopeNotGranted, OauthAdminPolicyEnforced
        let su_disabled = classify_service_usage_error(
            403,
            &serde_json::json!({
                "error": {
                    "status": "PERMISSION_DENIED",
                    "details": [{ "reason": "SERVICE_DISABLED", "metadata": { "service": "serviceusage.googleapis.com" } }]
                }
            }).to_string(),
            "proj-su-1",
        );
        assert_eq!(su_disabled.kind, GoogleApiErrorKind::ServiceUsageApiDisabled);

        let scope_err = classify_service_usage_error(
            403,
            &serde_json::json!({
                "error": { "details": [{ "reason": "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] }
            }).to_string(),
            "proj-su-1",
        );
        assert_eq!(scope_err.kind, GoogleApiErrorKind::OauthScopeNotGranted);

        let admin_err = classify_service_usage_error(
            403,
            &serde_json::json!({
                "error": { "details": [{ "reason": "ADMIN_POLICY_ENFORCED" }] }
            }).to_string(),
            "proj-su-1",
        );
        assert_eq!(admin_err.kind, GoogleApiErrorKind::OauthAdminPolicyEnforced);

        // 6) Project change while operation polling is in flight aborts stale response
        transport.push_ok(
            "https://mock.google.local/su/projects/proj-su-1/services/speech.googleapis.com:enable",
            200,
            vec![],
            serde_json::json!({ "name": "operations/op-race", "done": false }).to_string(),
        );
        let mgr_clone = mgr.clone();
        let switch_task = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            mgr_clone.confirm_project("proj-su-2").await.unwrap();
        });
        let race_res = enable_speech_api_with_auth(
            &mgr,
            transport.as_ref(),
            Some("proj-su-1"),
            true,
            Some("https://mock.google.local/su"),
            Duration::from_millis(30),
            2,
        )
        .await;
        switch_task.await.unwrap();
        assert_eq!(race_res.unwrap_err().kind, GoogleApiErrorKind::NotAuthenticated);

        let _ = std::fs::remove_dir_all(&dir);
    });
}

#[test]
fn test_dev_and_prod_client_ids_never_share_fallback() {
    assert_eq!(
        resolve_client_id_for_build(true, Some("dev-client-1"), Some("prod-client-1")),
        "dev-client-1"
    );
    assert_eq!(
        resolve_client_id_for_build(false, Some("dev-client-1"), Some("prod-client-1")),
        "prod-client-1"
    );
    // Missing dev ID must NOT fall back to prod ID, and vice versa
    assert_eq!(
        resolve_client_id_for_build(true, None, Some("prod-client-1")),
        ""
    );
    assert_eq!(
        resolve_client_id_for_build(false, Some("dev-client-1"), None),
        ""
    );

    // Setting only the legacy shared ASR_COMPOSER_GOOGLE_OAUTH_CLIENT_ID env var must NOT populate dev config
    let prev_shared = std::env::var("ASR_COMPOSER_GOOGLE_OAUTH_CLIENT_ID").ok();
    let prev_dev = std::env::var("ASR_COMPOSER_GOOGLE_OAUTH_CLIENT_ID_DEV").ok();
    std::env::set_var("ASR_COMPOSER_GOOGLE_OAUTH_CLIENT_ID", "shared-forbidden-id");
    std::env::remove_var("ASR_COMPOSER_GOOGLE_OAUTH_CLIENT_ID_DEV");
    let cfg = GoogleOAuthConfig::from_env();
    assert_ne!(cfg.client_id, "shared-forbidden-id");
    match prev_shared {
        Some(v) => std::env::set_var("ASR_COMPOSER_GOOGLE_OAUTH_CLIENT_ID", v),
        None => std::env::remove_var("ASR_COMPOSER_GOOGLE_OAUTH_CLIENT_ID"),
    }
    if let Some(v) = prev_dev {
        std::env::set_var("ASR_COMPOSER_GOOGLE_OAUTH_CLIENT_ID_DEV", v);
    }
}

struct FailingDeleteCredentialStore {
    inner: InMemoryCredentialStore,
    fail_delete: std::sync::atomic::AtomicBool,
}

impl FailingDeleteCredentialStore {
    fn new(fail_delete: bool) -> Self {
        Self {
            inner: InMemoryCredentialStore::new(),
            fail_delete: std::sync::atomic::AtomicBool::new(fail_delete),
        }
    }

    fn set_fail_delete(&self, fail: bool) {
        self.fail_delete
            .store(fail, std::sync::atomic::Ordering::SeqCst);
    }
}

impl CredentialStore for FailingDeleteCredentialStore {
    fn save(&self, target: &str, payload: &CredentialPayload) -> Result<(), String> {
        self.inner.save(target, payload)
    }

    fn load(&self, target: &str) -> Result<Option<CredentialPayload>, String> {
        self.inner.load(target)
    }

    fn delete(&self, target: &str) -> Result<(), String> {
        if self.fail_delete.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("mock Credential Manager delete failure".to_string());
        }
        self.inner.delete(target)
    }
}

struct FailAfterSaveCredentialStore {
    inner: InMemoryCredentialStore,
    fail_after_write: std::sync::atomic::AtomicBool,
}

impl FailAfterSaveCredentialStore {
    fn new() -> Self {
        Self {
            inner: InMemoryCredentialStore::new(),
            fail_after_write: std::sync::atomic::AtomicBool::new(false),
        }
    }

    fn fail_next_save_after_write(&self) {
        self.fail_after_write
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

impl CredentialStore for FailAfterSaveCredentialStore {
    fn save(&self, target: &str, payload: &CredentialPayload) -> Result<(), String> {
        self.inner.save(target, payload)?;
        if self
            .fail_after_write
            .swap(false, std::sync::atomic::Ordering::SeqCst)
        {
            return Err("simulated process interruption after credential write".to_string());
        }
        Ok(())
    }

    fn load(&self, target: &str) -> Result<Option<CredentialPayload>, String> {
        self.inner.load(target)
    }

    fn delete(&self, target: &str) -> Result<(), String> {
        self.inner.delete(target)
    }
}

#[test]
fn test_pending_logout_relogin_persists_inactive_metadata_before_reusing_slot() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let dir = std::env::temp_dir().join(format!("asrc_relogin_crash_{}", uuid::Uuid::new_v4()));
        let cred_store = Arc::new(FailAfterSaveCredentialStore::new());
        let transport = Arc::new(MockTransport::new());
        let cfg = test_config("client-relogin-crash");
        let now = 1_700_000_000u64;
        transport.push_ok(
            "https://mock.google.local/jwks",
            200,
            vec![("Cache-Control", "max-age=300")],
            jwks_json("kid-1"),
        );
        let first_id_token = sign_test_id_token(
            "kid-1",
            &TestJwtClaims {
                iss: "https://accounts.google.com",
                aud: "client-relogin-crash",
                exp: now + 3600,
                nonce: "first",
                sub: "same-sub",
                email: "same@example.com",
                email_verified: true,
                hd: None,
            },
        );
        transport.push_ok(
            "https://mock.google.local/token",
            200,
            vec![],
            serde_json::json!({
                "access_token": "ya29.first",
                "refresh_token": "1//first",
                "expires_in": 3600,
                "scope": "openid email https://www.googleapis.com/auth/cloud-platform",
                "id_token": first_id_token
            })
            .to_string(),
        );
        let mgr = Arc::new(GoogleAuthManager::new(
            cfg.clone(),
            &dir,
            cred_store.clone(),
            transport.clone(),
            None,
        ));
        mgr.complete_authorization_code_exchange(
            &cfg,
            "first-code",
            "verifier",
            "http://127.0.0.1:1000",
            "first",
            Some(now),
        )
        .await
        .unwrap();
        mgr.confirm_project("old-project").await.unwrap();

        let metadata_path = metadata_file_path(&dir, &cfg.fingerprint());
        let marker_path = logout_pending_marker_path(&metadata_path);
        std::fs::write(&marker_path, b"1").unwrap();

        let no_refresh_id_token = sign_test_id_token(
            "kid-1",
            &TestJwtClaims {
                iss: "https://accounts.google.com",
                aud: "client-relogin-crash",
                exp: now + 3600,
                nonce: "no-refresh",
                sub: "same-sub",
                email: "same@example.com",
                email_verified: true,
                hd: None,
            },
        );
        transport.push_ok(
            "https://mock.google.local/token",
            200,
            vec![],
            serde_json::json!({
                "access_token": "ya29.no-refresh",
                "expires_in": 3600,
                "scope": "openid email https://www.googleapis.com/auth/cloud-platform",
                "id_token": no_refresh_id_token
            })
            .to_string(),
        );

        // A pending logout forbids reusing the previous same-sub refresh token.
        let missing_refresh = mgr
            .complete_authorization_code_exchange(
                &cfg,
                "no-refresh-code",
                "verifier",
                "http://127.0.0.1:1000",
                "no-refresh",
                Some(now),
            )
            .await
            .unwrap_err();
        assert!(missing_refresh.message.contains("refresh tokenが返却されませんでした"));
        assert!(marker_path.exists());
        assert_eq!(load_metadata_raw(&metadata_path).unwrap().project_id.as_deref(), Some("old-project"));

        let third_id_token = sign_test_id_token(
            "kid-1",
            &TestJwtClaims {
                iss: "https://accounts.google.com",
                aud: "client-relogin-crash",
                exp: now + 3600,
                nonce: "third",
                sub: "same-sub",
                email: "same@example.com",
                email_verified: true,
                hd: None,
            },
        );
        transport.push_ok(
            "https://mock.google.local/token",
            200,
            vec![],
            serde_json::json!({
                "access_token": "ya29.third",
                "refresh_token": "1//third",
                "expires_in": 3600,
                "scope": "openid email https://www.googleapis.com/auth/cloud-platform",
                "id_token": third_id_token
            })
            .to_string(),
        );

        // Simulate a process interruption after the new credential is persisted but before
        // metadata commit. The durable metadata must already be inactive and marker cleared.
        cred_store.fail_next_save_after_write();
        let err = mgr
            .complete_authorization_code_exchange(
                &cfg,
                "third-code",
                "verifier",
                "http://127.0.0.1:1000",
                "third",
                Some(now),
            )
            .await
            .unwrap_err();
        assert!(err.message.contains("simulated process interruption"));
        assert!(!marker_path.exists());
        let persisted = load_metadata_raw(&metadata_path).expect("inactive metadata persisted");
        assert!(persisted.active_slot.is_none());
        assert!(persisted.project_id.is_none());

        let restarted = GoogleAuthManager::new(
            cfg.clone(),
            &dir,
            cred_store,
            transport,
            None,
        );
        let status = restarted.get_status().await;
        assert_eq!(status.state, GoogleAuthConnectionState::Disconnected);
        assert!(status.sub.is_none());
        assert!(status.project_id.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    });
}

#[test]
fn test_logout_and_revoke_compound_failure_explicit_error_and_restart_never_restores_old_auth() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        for (is_revoke, google_revoke_succeeds) in [(false, false), (true, true), (true, false)] {
            let dir = std::env::temp_dir().join(format!(
                "asrc_compound_fail_{}_{}",
                is_revoke,
                uuid::Uuid::new_v4()
            ));
            let cred_store = Arc::new(FailingDeleteCredentialStore::new(false));
            let transport = Arc::new(MockTransport::new());
            let cfg = test_config("client-compound");
            let now = 1_700_000_000u64;

            transport.push_ok(
                "https://mock.google.local/jwks",
                200,
                vec![("Cache-Control", "max-age=300")],
                jwks_json("kid-1"),
            );
            let tok = sign_test_id_token(
                "kid-1",
                &TestJwtClaims {
                    iss: "https://accounts.google.com",
                    aud: "client-compound",
                    exp: now + 3600,
                    nonce: "n1",
                    sub: "sub-compound",
                    email: "compound@example.com",
                    email_verified: true,
                    hd: None,
                },
            );
            transport.push_ok(
                "https://mock.google.local/token",
                200,
                vec![],
                serde_json::json!({
                    "access_token": "ya29.c1",
                    "refresh_token": "1//c1",
                    "expires_in": 3600,
                    "scope": "openid email https://www.googleapis.com/auth/cloud-platform",
                    "id_token": tok
                })
                .to_string(),
            );

            let mgr = GoogleAuthManager::new(
                cfg.clone(),
                &dir,
                cred_store.clone(),
                transport.clone(),
                None,
            );
            mgr.complete_authorization_code_exchange(
                &cfg,
                "code",
                "ver",
                "http://127.0.0.1:1000",
                "n1",
                Some(now),
            )
            .await
            .unwrap();
            mgr.confirm_project("proj-compound").await.unwrap();
            transport.push_ok(
                "https://mock.google.local/token",
                200,
                vec![],
                serde_json::json!({
                    "access_token": "ya29.c1-refreshed",
                    "expires_in": 3600,
                    "scope": "openid email https://www.googleapis.com/auth/cloud-platform"
                })
                .to_string(),
            );
            let old_snapshot = mgr.acquire_snapshot(true).await.unwrap();

            // Inject compound failure: metadata persistence failure + Credential Manager delete failure
            let fp = cfg.fingerprint();
            let meta_path = metadata_file_path(&dir, &fp);
            let tmp_blocker = meta_path.with_extension("json.tmp");
            std::fs::create_dir_all(&tmp_blocker).unwrap();
            cred_store.set_fail_delete(true);

            let err = if is_revoke {
                if google_revoke_succeeds {
                    transport.push_ok("https://mock.google.local/revoke", 200, vec![], String::new());
                } else {
                    transport.push_err("https://mock.google.local/revoke", "network error");
                }
                mgr.revoke().await.unwrap_err()
            } else {
                mgr.logout().await.unwrap_err()
            };

            assert!(
                err.message.contains("ローカル認証情報を完全に消去できませんでした"),
                "expected explicit local wipe failure message, got: {}",
                err.message
            );
            assert!(err.message.contains("metadata保存失敗"));
            assert!(err.message.contains("Credential Manager削除失敗"));
            assert_eq!(
                mgr.get_status().await.state,
                GoogleAuthConnectionState::ReauthRequired
            );
            assert!(mgr.get_status().await.sub.is_none());
            assert!(mgr.get_status().await.project_id.is_none());
            assert!(!mgr.is_snapshot_current(&old_snapshot).await);
            assert!(mgr.acquire_snapshot(false).await.is_err());
            assert!(logout_pending_marker_path(&meta_path).exists());

            // Simulate restart while Credential Manager delete STILL fails: must NOT restore old account
            let _ = std::fs::remove_dir_all(&tmp_blocker);
            let mgr_restarted = GoogleAuthManager::new(
                cfg.clone(),
                &dir,
                cred_store.clone(),
                transport.clone(),
                None,
            );
            let st_restarted = mgr_restarted.get_status().await;
            assert_eq!(st_restarted.state, GoogleAuthConnectionState::ReauthRequired);
            assert!(st_restarted.sub.is_none());
            assert!(st_restarted.project_id.is_none());

            // Once Credential Manager delete recovers on next restart, cleanup completes cleanly
            cred_store.set_fail_delete(false);
            let mgr_recovered = GoogleAuthManager::new(
                cfg.clone(),
                &dir,
                cred_store.clone(),
                transport.clone(),
                None,
            );
            let st_recovered = mgr_recovered.get_status().await;
            assert_eq!(st_recovered.state, GoogleAuthConnectionState::Disconnected);
            assert!(!logout_pending_marker_path(&meta_path).exists());

            let _ = std::fs::remove_dir_all(&dir);
        }

        // Verify marker write failure itself is explicitly reported instead of ignored
        let dir = std::env::temp_dir().join(format!("asrc_marker_fail_{}", uuid::Uuid::new_v4()));
        let cred_store = Arc::new(FailingDeleteCredentialStore::new(false));
        let transport = Arc::new(MockTransport::new());
        let cfg = test_config("client-marker-fail");
        let now = 1_700_000_000u64;
        transport.push_ok(
            "https://mock.google.local/jwks",
            200,
            vec![("Cache-Control", "max-age=300")],
            jwks_json("kid-1"),
        );
        let tok = sign_test_id_token(
            "kid-1",
            &TestJwtClaims {
                iss: "https://accounts.google.com",
                aud: "client-marker-fail",
                exp: now + 3600,
                nonce: "nm",
                sub: "sub-marker",
                email: "marker@example.com",
                email_verified: true,
                hd: None,
            },
        );
        transport.push_ok(
            "https://mock.google.local/token",
            200,
            vec![],
            serde_json::json!({
                "access_token": "ya29.m1",
                "refresh_token": "1//m1",
                "expires_in": 3600,
                "scope": "openid email https://www.googleapis.com/auth/cloud-platform",
                "id_token": tok
            })
            .to_string(),
        );
        let mgr = Arc::new(GoogleAuthManager::new(
            cfg.clone(),
            &dir,
            cred_store.clone(),
            transport.clone(),
            None,
        ));
        mgr.complete_authorization_code_exchange(
            &cfg,
            "code",
            "ver",
            "http://127.0.0.1:1000",
            "nm",
            Some(now),
        )
        .await
        .unwrap();

        let meta_path = metadata_file_path(&dir, &cfg.fingerprint());
        let marker_blocker = logout_pending_marker_path(&meta_path);
        std::fs::create_dir_all(&marker_blocker).unwrap();
        cred_store.set_fail_delete(true);
        let err = mgr.logout().await.unwrap_err();
        assert!(err.message.contains("logout-pendingマーカー書込失敗"));
        let persisted = load_metadata_raw(&meta_path).expect("inactive metadata committed as fallback");
        assert!(persisted.active_slot.is_none());
        assert!(persisted.project_id.is_none());
        let _ = std::fs::remove_dir_all(&dir);

        // Simulate crash right after write-ahead logout-pending marker is written
        // (old metadata and old Credential Manager token still intact): restart must NOT restore old auth.
        let dir_crash = std::env::temp_dir().join(format!("asrc_crash_marker_{}", uuid::Uuid::new_v4()));
        let cred_crash = Arc::new(FailingDeleteCredentialStore::new(false));
        let transport_crash = Arc::new(MockTransport::new());
        let cfg_crash = test_config("client-crash-marker");
        transport_crash.push_ok(
            "https://mock.google.local/jwks",
            200,
            vec![("Cache-Control", "max-age=300")],
            jwks_json("kid-1"),
        );
        let tok_crash = sign_test_id_token(
            "kid-1",
            &TestJwtClaims {
                iss: "https://accounts.google.com",
                aud: "client-crash-marker",
                exp: now + 3600,
                nonce: "nc",
                sub: "sub-crash",
                email: "crash@example.com",
                email_verified: true,
                hd: None,
            },
        );
        transport_crash.push_ok(
            "https://mock.google.local/token",
            200,
            vec![],
            serde_json::json!({
                "access_token": "ya29.crash",
                "refresh_token": "1//crash",
                "expires_in": 3600,
                "scope": "openid email https://www.googleapis.com/auth/cloud-platform",
                "id_token": tok_crash
            })
            .to_string(),
        );
        let mgr_crash = GoogleAuthManager::new(
            cfg_crash.clone(),
            &dir_crash,
            cred_crash.clone(),
            transport_crash.clone(),
            None,
        );
        mgr_crash
            .complete_authorization_code_exchange(
                &cfg_crash,
                "code",
                "ver",
                "http://127.0.0.1:1000",
                "nc",
                Some(now),
            )
            .await
            .unwrap();
        let fp_crash = cfg_crash.fingerprint();
        let meta_crash = metadata_file_path(&dir_crash, &fp_crash);
        std::fs::write(logout_pending_marker_path(&meta_crash), b"1").unwrap();

        let mgr_restarted = GoogleAuthManager::new(
            cfg_crash.clone(),
            &dir_crash,
            cred_crash.clone(),
            transport_crash.clone(),
            None,
        );
        let st = mgr_restarted.get_status().await;
        assert_eq!(st.state, GoogleAuthConnectionState::Disconnected);
        assert!(st.sub.is_none());
        assert!(!logout_pending_marker_path(&meta_crash).exists());
        assert!(cred_crash
            .load(&credential_target_name(APP_IDENTIFIER, &fp_crash, 0))
            .unwrap()
            .is_none());
        let _ = std::fs::remove_dir_all(&dir_crash);

        // If slot deletion fails while logout-pending marker exists, marker MUST be kept so restart
        // cannot restore old metadata/credential.
        let dir_slot_fail = std::env::temp_dir().join(format!("asrc_slot_fail_{}", uuid::Uuid::new_v4()));
        let cred_slot_fail = Arc::new(FailingDeleteCredentialStore::new(false));
        let transport_slot_fail = Arc::new(MockTransport::new());
        let cfg_slot_fail = test_config("client-slot-fail");
        let fp_slot_fail = cfg_slot_fail.fingerprint();
        let meta_slot_fail = metadata_file_path(&dir_slot_fail, &fp_slot_fail);
        let marker_slot_fail = logout_pending_marker_path(&meta_slot_fail);

        transport_slot_fail.push_ok(
            "https://mock.google.local/jwks",
            200,
            vec![("Cache-Control", "max-age=300")],
            jwks_json("kid-1"),
        );
        let tok_old = sign_test_id_token(
            "kid-1",
            &TestJwtClaims {
                iss: "https://accounts.google.com",
                aud: "client-slot-fail",
                exp: now + 3600,
                nonce: "ns1",
                sub: "sub-old",
                email: "old@example.com",
                email_verified: true,
                hd: None,
            },
        );
        transport_slot_fail.push_ok(
            "https://mock.google.local/token",
            200,
            vec![],
            serde_json::json!({
                "access_token": "ya29.old",
                "refresh_token": "1//old",
                "expires_in": 3600,
                "scope": "openid email https://www.googleapis.com/auth/cloud-platform",
                "id_token": tok_old
            })
            .to_string(),
        );
        let mgr_slot_fail = GoogleAuthManager::new(
            cfg_slot_fail.clone(),
            &dir_slot_fail,
            cred_slot_fail.clone(),
            transport_slot_fail.clone(),
            None,
        );
        mgr_slot_fail
            .complete_authorization_code_exchange(
                &cfg_slot_fail,
                "code-old",
                "ver-old",
                "http://127.0.0.1:1000",
                "ns1",
                Some(now),
            )
            .await
            .unwrap();

        // Simulate pending logout marker + failing slot delete on re-login
        std::fs::write(&marker_slot_fail, b"1").unwrap();
        cred_slot_fail.set_fail_delete(true);
        transport_slot_fail.push_ok(
            "https://mock.google.local/token",
            200,
            vec![],
            serde_json::json!({
                "access_token": "ya29.new",
                "refresh_token": "1//new",
                "expires_in": 3600,
                "scope": "openid email https://www.googleapis.com/auth/cloud-platform",
                "id_token": tok_old
            })
            .to_string(),
        );
        let slot_fail_err = mgr_slot_fail
            .complete_authorization_code_exchange(
                &cfg_slot_fail,
                "code-new",
                "ver-new",
                "http://127.0.0.1:1000",
                "ns1",
                Some(now),
            )
            .await
            .unwrap_err();
        assert!(slot_fail_err.message.contains("mock Credential Manager delete failure"));
        assert!(marker_slot_fail.exists(), "marker must remain when slot deletion fails");

        // Restarting while delete still fails must NOT restore old account
        let mgr_slot_restarted = GoogleAuthManager::new(
            cfg_slot_fail.clone(),
            &dir_slot_fail,
            cred_slot_fail.clone(),
            transport_slot_fail.clone(),
            None,
        );
        let st_slot_restarted = mgr_slot_restarted.get_status().await;
        assert_eq!(st_slot_restarted.state, GoogleAuthConnectionState::ReauthRequired);
        assert!(st_slot_restarted.sub.is_none());
        let _ = std::fs::remove_dir_all(&dir_slot_fail);

        // 1) If logout-pending marker removal fails, re-login MUST fail with reauth_required (never report success)
        //    and MUST NOT save/then-delete new credentials;
        // 2) Once marker is removable, re-login cleans up marker BEFORE saving new credential and survives restart.
        let dir_relogin = std::env::temp_dir().join(format!("asrc_marker_relogin_{}", uuid::Uuid::new_v4()));
        let cred_relogin = Arc::new(FailingDeleteCredentialStore::new(false));
        let transport_relogin = Arc::new(MockTransport::new());
        let cfg_relogin = test_config("client-marker-relogin");
        let fp_relogin = cfg_relogin.fingerprint();
        let meta_relogin = metadata_file_path(&dir_relogin, &fp_relogin);
        let marker_relogin = logout_pending_marker_path(&meta_relogin);

        transport_relogin.push_ok(
            "https://mock.google.local/jwks",
            200,
            vec![("Cache-Control", "max-age=300")],
            jwks_json("kid-1"),
        );
        let tok_relogin = sign_test_id_token(
            "kid-1",
            &TestJwtClaims {
                iss: "https://accounts.google.com",
                aud: "client-marker-relogin",
                exp: now + 3600,
                nonce: "nr1",
                sub: "sub-new",
                email: "new@example.com",
                email_verified: true,
                hd: None,
            },
        );
        transport_relogin.push_ok(
            "https://mock.google.local/token",
            200,
            vec![],
            serde_json::json!({
                "access_token": "ya29.new1",
                "refresh_token": "1//new1",
                "expires_in": 3600,
                "scope": "openid email https://www.googleapis.com/auth/cloud-platform",
                "id_token": tok_relogin
            })
            .to_string(),
        );

        let mgr_relogin = GoogleAuthManager::new(
            cfg_relogin.clone(),
            &dir_relogin,
            cred_relogin.clone(),
            transport_relogin.clone(),
            None,
        );
        // Block marker removal by making it a non-empty directory
        std::fs::create_dir_all(marker_relogin.join("lock")).unwrap();
        let fail_res = mgr_relogin
            .complete_authorization_code_exchange(
                &cfg_relogin,
                "code1",
                "ver1",
                "http://127.0.0.1:1000",
                "nr1",
                Some(now),
            )
            .await;
        let fail_err = fail_res.unwrap_err();
        assert!(fail_err.message.contains("logout-pendingマーカー削除失敗"));
        assert_eq!(
            mgr_relogin.get_status().await.state,
            GoogleAuthConnectionState::ReauthRequired
        );
        // New credential was not written/orphaned
        assert!(cred_relogin
            .load(&credential_target_name(APP_IDENTIFIER, &fp_relogin, 0))
            .unwrap()
            .is_none());

        // Now replace directory blocker with a regular file marker -> re-login cleans it up BEFORE committing
        std::fs::remove_dir_all(&marker_relogin).unwrap();
        std::fs::write(&marker_relogin, b"1").unwrap();
        transport_relogin.push_ok(
            "https://mock.google.local/token",
            200,
            vec![],
            serde_json::json!({
                "access_token": "ya29.new2",
                "refresh_token": "1//new2",
                "expires_in": 3600,
                "scope": "openid email https://www.googleapis.com/auth/cloud-platform",
                "id_token": tok_relogin
            })
            .to_string(),
        );
        let ok_status = mgr_relogin
            .complete_authorization_code_exchange(
                &cfg_relogin,
                "code2",
                "ver2",
                "http://127.0.0.1:1000",
                "nr1",
                Some(now),
            )
            .await
            .unwrap();
        assert_eq!(ok_status.state, GoogleAuthConnectionState::Connected);
        assert!(!marker_relogin.exists());

        // Restarting app must restore the new account (not wipe it)
        let mgr_restarted_new = GoogleAuthManager::new(
            cfg_relogin.clone(),
            &dir_relogin,
            cred_relogin.clone(),
            transport_relogin.clone(),
            None,
        );
        let st_restored = mgr_restarted_new.get_status().await;
        assert_eq!(st_restored.state, GoogleAuthConnectionState::Connected);
        assert_eq!(st_restored.sub.as_deref(), Some("sub-new"));
        let _ = std::fs::remove_dir_all(&dir_relogin);
    });
}

#[test]
fn test_onboarding_single_snapshot_and_non_persistence_before_recognize_success() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let dir = std::env::temp_dir().join(format!("asrc_onboard_1_{}", uuid::Uuid::new_v4()));
        let cfg = test_config("client-onboard-1");
        let cred = Arc::new(InMemoryCredentialStore::new());
        let transport = Arc::new(MockTransport::new());
        let mgr = GoogleAuthManager::new(cfg.clone(), &dir, cred, transport.clone(), None);

        let now = 1_750_000_000u64;
        let id_token = sign_test_id_token(
            "kid-1",
            &TestJwtClaims {
                iss: "https://accounts.google.com",
                aud: &cfg.client_id,
                exp: now + 3600,
                nonce: "nonce-1",
                sub: "sub-onb-1",
                email: "onb1@example.com",
                email_verified: true,
                hd: Some("example.com"),
            },
        );
        transport.push_ok("https://mock.google.local/jwks", 200, vec![], jwks_json("kid-1"));
        transport.push_ok(
            "https://mock.google.local/token",
            200,
            vec![],
            serde_json::json!({
                "access_token": "ya29.onb1",
                "refresh_token": "1//onb1",
                "expires_in": 3600,
                "scope": "openid email https://www.googleapis.com/auth/cloud-platform",
                "id_token": id_token
            })
            .to_string(),
        );
        let login_status = mgr
            .complete_authorization_code_exchange(
                &cfg,
                "code1",
                "ver1",
                "http://127.0.0.1:1000",
                "nonce-1",
                Some(now),
            )
            .await
            .unwrap();
        assert_eq!(login_status.state, GoogleAuthConnectionState::Connected);
        assert!(login_status.project_id.is_none());
        assert!(!login_status.project_verified);

        // 1) Recognize fails (PERMISSION_DENIED) -> project_id must NOT be persisted as verified
        transport.push_ok(
            "https://us-central1-speech.googleapis.com/v2/projects/amed-512123/locations/us-central1/recognizers/_:recognize",
            403,
            vec![],
            serde_json::json!({
                "error": {
                    "code": 403,
                    "status": "PERMISSION_DENIED",
                    "message": "Permission denied on project amed-512123"
                }
            })
            .to_string(),
        );
        let fail_res = crate::google_cloud::complete_onboarding_with_auth(
            &mgr,
            transport.as_ref(),
            crate::google_cloud::CompleteOnboardingRequest::default(),
            |pid| format!("https://us-central1-speech.googleapis.com/v2/projects/{pid}/locations/us-central1/recognizers/_:recognize"),
            &serde_json::json!({ "config": {}, "content": "dGVzdA==" }),
            |_json| Ok(crate::google_cloud::GoogleSpeechRecognizeResult {
                transcript: "テスト".to_string(),
                segments: vec![],
                raw_response: serde_json::json!({}),
                auth_generation: None,
                sub: None,
                oauth_client_id_fingerprint: None,
            }),
            None,
            Duration::from_millis(1),
            2,
        )
        .await
        .unwrap();
        assert_eq!(
            fail_res.outcome,
            crate::google_cloud::GoogleOnboardingOutcome::ProjectAccessDenied
        );
        assert!(fail_res.status.project_id.is_none());
        assert!(!fail_res.status.project_verified);

        // 2) Recognize succeeds -> commits amed-512123 + verified=true + project_source=Default
        transport.push_ok(
            "https://us-central1-speech.googleapis.com/v2/projects/amed-512123/locations/us-central1/recognizers/_:recognize",
            200,
            vec![],
            serde_json::json!({ "results": [] }).to_string(),
        );
        let ok_res = crate::google_cloud::complete_onboarding_with_auth(
            &mgr,
            transport.as_ref(),
            crate::google_cloud::CompleteOnboardingRequest::default(),
            |pid| format!("https://us-central1-speech.googleapis.com/v2/projects/{pid}/locations/us-central1/recognizers/_:recognize"),
            &serde_json::json!({ "config": {}, "content": "dGVzdA==" }),
            |_json| Ok(crate::google_cloud::GoogleSpeechRecognizeResult {
                transcript: "こんにちは".to_string(),
                segments: vec![],
                raw_response: serde_json::json!({}),
                auth_generation: None,
                sub: None,
                oauth_client_id_fingerprint: None,
            }),
            None,
            Duration::from_millis(1),
            2,
        )
        .await
        .unwrap();
        assert_eq!(ok_res.outcome, crate::google_cloud::GoogleOnboardingOutcome::Ready);
        assert_eq!(ok_res.status.project_id.as_deref(), Some("amed-512123"));
        assert!(ok_res.status.project_verified);
        assert_eq!(ok_res.status.project_source, Some(ProjectSource::Default));

        let _ = std::fs::remove_dir_all(&dir);
    });
}

#[test]
fn test_onboarding_api_disabled_consent_stale_guard_and_enable_continuation() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let dir = std::env::temp_dir().join(format!("asrc_onboard_2_{}", uuid::Uuid::new_v4()));
        let cfg = test_config("client-onboard-2");
        let cred = Arc::new(InMemoryCredentialStore::new());
        let transport = Arc::new(MockTransport::new());
        let mgr = GoogleAuthManager::new(cfg.clone(), &dir, cred, transport.clone(), None);

        let now = 1_750_000_000u64;
        let id_token = sign_test_id_token(
            "kid-1",
            &TestJwtClaims {
                iss: "https://accounts.google.com",
                aud: &cfg.client_id,
                exp: now + 3600,
                nonce: "n2",
                sub: "sub-onb-2",
                email: "onb2@example.com",
                email_verified: true,
                hd: None,
            },
        );
        transport.push_ok("https://mock.google.local/jwks", 200, vec![], jwks_json("kid-1"));
        transport.push_ok(
            "https://mock.google.local/token",
            200,
            vec![],
            serde_json::json!({
                "access_token": "ya29.onb2",
                "refresh_token": "1//onb2",
                "expires_in": 3600,
                "scope": "openid email https://www.googleapis.com/auth/cloud-platform",
                "id_token": id_token
            })
            .to_string(),
        );
        let st = mgr
            .complete_authorization_code_exchange(
                &cfg,
                "c2",
                "v2",
                "http://127.0.0.1:1000",
                "n2",
                Some(now),
            )
            .await
            .unwrap();

        // 1) Speech API disabled -> NeedsApiEnableConsent (never auto-enables without consent)
        transport.push_ok(
            "https://us-central1-speech.googleapis.com/v2/projects/amed-512123/locations/us-central1/recognizers/_:recognize",
            403,
            vec![],
            serde_json::json!({
                "error": {
                    "code": 403,
                    "status": "PERMISSION_DENIED",
                    "message": "Cloud Speech-to-Text API has not been used in project amed-512123",
                    "details": [{
                        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                        "reason": "SERVICE_DISABLED",
                        "metadata": {
                            "service": "speech.googleapis.com",
                            "consumer": "projects/amed-512123"
                        }
                    }]
                }
            })
            .to_string(),
        );
        let consent_res = crate::google_cloud::complete_onboarding_with_auth(
            &mgr,
            transport.as_ref(),
            crate::google_cloud::CompleteOnboardingRequest::default(),
            |pid| format!("https://us-central1-speech.googleapis.com/v2/projects/{pid}/locations/us-central1/recognizers/_:recognize"),
            &serde_json::json!({}),
            |_| unreachable!(),
            Some("https://serviceusage.mock.local/v1"),
            Duration::from_millis(1),
            2,
        )
        .await
        .unwrap();
        assert_eq!(
            consent_res.outcome,
            crate::google_cloud::GoogleOnboardingOutcome::NeedsApiEnableConsent
        );
        assert!(!consent_res.status.project_verified);

        // 2) Mismatched expected_auth_session_id -> CancelledOrStale (no HTTP call)
        let stale_res = crate::google_cloud::complete_onboarding_with_auth(
            &mgr,
            transport.as_ref(),
            crate::google_cloud::CompleteOnboardingRequest {
                enable_speech_api_if_needed: true,
                expected_auth_session_id: Some("wrong-session".to_string()),
                expected_auth_generation: Some(st.auth_generation),
                expected_sub: Some("sub-onb-2".to_string()),
                expected_oauth_client_id_fingerprint: Some(st.oauth_client_id_fingerprint.clone()),
                expected_project_id: Some("amed-512123".to_string()),
            },
            |pid| format!("https://us-central1-speech.googleapis.com/v2/projects/{pid}/locations/us-central1/recognizers/_:recognize"),
            &serde_json::json!({}),
            |_| unreachable!(),
            Some("https://serviceusage.mock.local/v1"),
            Duration::from_millis(1),
            2,
        )
        .await
        .unwrap();
        assert_eq!(
            stale_res.outcome,
            crate::google_cloud::GoogleOnboardingOutcome::CancelledOrStale
        );

        // 3) Matching consent -> enables speech.googleapis.com -> runs recognize -> commits Ready
        transport.push_ok(
            "https://serviceusage.mock.local/v1/projects/amed-512123/services/speech.googleapis.com:enable",
            200,
            vec![],
            serde_json::json!({ "name": "operations/op-1", "done": true }).to_string(),
        );
        transport.push_ok(
            "https://us-central1-speech.googleapis.com/v2/projects/amed-512123/locations/us-central1/recognizers/_:recognize",
            200,
            vec![],
            serde_json::json!({ "results": [] }).to_string(),
        );
        let ready_res = crate::google_cloud::complete_onboarding_with_auth(
            &mgr,
            transport.as_ref(),
            crate::google_cloud::CompleteOnboardingRequest {
                enable_speech_api_if_needed: true,
                expected_auth_session_id: Some(st.auth_session_id.clone()),
                expected_auth_generation: Some(st.auth_generation),
                expected_sub: Some("sub-onb-2".to_string()),
                expected_oauth_client_id_fingerprint: Some(st.oauth_client_id_fingerprint.clone()),
                expected_project_id: Some("amed-512123".to_string()),
            },
            |pid| format!("https://us-central1-speech.googleapis.com/v2/projects/{pid}/locations/us-central1/recognizers/_:recognize"),
            &serde_json::json!({}),
            |_| Ok(crate::google_cloud::GoogleSpeechRecognizeResult {
                transcript: "OK".to_string(),
                segments: vec![],
                raw_response: serde_json::json!({}),
                auth_generation: None,
                sub: None,
                oauth_client_id_fingerprint: None,
            }),
            Some("https://serviceusage.mock.local/v1"),
            Duration::from_millis(1),
            2,
        )
        .await
        .unwrap();
        assert_eq!(ready_res.outcome, crate::google_cloud::GoogleOnboardingOutcome::Ready);
        assert!(ready_res.status.project_verified);
        assert_eq!(ready_res.status.project_source, Some(ProjectSource::Default));

        let _ = std::fs::remove_dir_all(&dir);
    });
}

#[test]
fn test_onboarding_migration_user_selected_and_account_switch_non_rollback_and_manual_override() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let dir = std::env::temp_dir().join(format!("asrc_onboard_3_{}", uuid::Uuid::new_v4()));
        let cfg = test_config("client-onboard-3");
        let fp = cfg.fingerprint();
        let cred = Arc::new(InMemoryCredentialStore::new());
        let transport = Arc::new(MockTransport::new());

        // Pre-seed legacy verified metadata without project_source
        let meta_path = metadata_file_path(&dir, &fp);
        save_metadata_atomic(
            &meta_path,
            &AuthMetadata {
                schema_version: 1,
                oauth_client_id_fingerprint: fp.clone(),
                active_slot: Some(0),
                auth_generation: 3,
                auth_session_id: "sess-a".to_string(),
                slots: [
                    Some(SlotMetadata {
                        sub: "sub-A".to_string(),
                        email: "a@example.com".to_string(),
                        hosted_domain: None,
                        canonical_scopes: vec![
                            "identity:openid".to_string(),
                            "identity:email".to_string(),
                            "google_cloud_api".to_string(),
                        ],
                    }),
                    None,
                ],
                project_id: Some("user-proj-123".to_string()),
                project_verified: true,
                project_source: None,
            },
        )
        .unwrap();
        cred.save(
            &credential_target_name(APP_IDENTIFIER, &fp, 0),
            &CredentialPayload {
                oauth_client_id_fingerprint: fp.clone(),
                sub: "sub-A".to_string(),
                refresh_token: "1//sub-A".to_string(),
            },
        )
        .unwrap();

        let mgr = GoogleAuthManager::new(cfg.clone(), &dir, cred, transport.clone(), None);
        let st_migrated = mgr.get_status().await;
        assert_eq!(st_migrated.project_id.as_deref(), Some("user-proj-123"));
        assert!(st_migrated.project_verified);
        assert_eq!(st_migrated.project_source, Some(ProjectSource::UserSelected));

        // Onboarding must NOT overwrite user-proj-123 with amed-512123
        let keep_res = crate::google_cloud::complete_onboarding_with_auth(
            &mgr,
            transport.as_ref(),
            crate::google_cloud::CompleteOnboardingRequest::default(),
            |_| unreachable!(),
            &serde_json::json!({}),
            |_| unreachable!(),
            None,
            Duration::from_millis(1),
            1,
        )
        .await
        .unwrap();
        assert_eq!(
            keep_res.outcome,
            crate::google_cloud::GoogleOnboardingOutcome::AlreadyReadyUserProject
        );
        assert_eq!(keep_res.status.project_id.as_deref(), Some("user-proj-123"));

        // Account switch to sub-B: clears project_id/verified/source; if B's onboarding fails,
        // B stays connected & unready and NEVER rolls back to A or inherits user-proj-123.
        let now = 1_750_000_000u64;
        let tok_b = sign_test_id_token(
            "kid-1",
            &TestJwtClaims {
                iss: "https://accounts.google.com",
                aud: &cfg.client_id,
                exp: now + 3600,
                nonce: "nb",
                sub: "sub-B",
                email: "b@example.com",
                email_verified: true,
                hd: None,
            },
        );
        transport.push_ok("https://mock.google.local/jwks", 200, vec![], jwks_json("kid-1"));
        transport.push_ok(
            "https://mock.google.local/token",
            200,
            vec![],
            serde_json::json!({
                "access_token": "ya29.subB",
                "refresh_token": "1//subB",
                "expires_in": 3600,
                "scope": "openid email https://www.googleapis.com/auth/cloud-platform",
                "id_token": tok_b
            })
            .to_string(),
        );
        let st_b = mgr
            .complete_authorization_code_exchange(
                &cfg,
                "cb",
                "vb",
                "http://127.0.0.1:1000",
                "nb",
                Some(now),
            )
            .await
            .unwrap();
        assert_eq!(st_b.sub.as_deref(), Some("sub-B"));
        assert!(st_b.project_id.is_none());
        assert!(!st_b.project_verified);
        assert!(st_b.project_source.is_none());

        // Acquire onboarding snapshot for B, then simulate user confirming manual Project before commit
        let OnboardingAcquireOutcome::ReadyForOnboarding(onb_snap) =
            mgr.acquire_onboarding_snapshot().await.unwrap()
        else {
            panic!("expected ReadyForOnboarding");
        };
        let st_manual = mgr
            .confirm_project_guarded(
                "manual-proj-999",
                st_b.auth_generation,
                "sub-B",
                &fp,
                &st_b.auth_session_id,
            )
            .await
            .unwrap();
        assert_eq!(st_manual.project_id.as_deref(), Some("manual-proj-999"));
        assert_eq!(st_manual.project_source, Some(ProjectSource::UserSelected));

        // Stale onboarding commit must return None and leave manual-proj-999 intact
        assert!(mgr
            .complete_default_onboarding_commit_if_current(&onb_snap)
            .await
            .unwrap()
            .is_none());
        let st_after = mgr.get_status().await;
        assert_eq!(st_after.project_id.as_deref(), Some("manual-proj-999"));
        assert_eq!(st_after.project_source, Some(ProjectSource::UserSelected));

        let _ = std::fs::remove_dir_all(&dir);
    });
}

#[test]
fn test_dev_and_release_channels_isolate_credentials_and_metadata_with_same_client_id() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let dir = std::env::temp_dir().join(format!("asrc_chan_iso_{}", uuid::Uuid::new_v4()));
        let shared_cred_store = Arc::new(InMemoryCredentialStore::new());
        let transport = Arc::new(MockTransport::new());

        let mut dev_cfg = test_config("shared-desktop-client-id");
        dev_cfg.build_channel = BuildChannel::Dev;
        let mut rel_cfg = test_config("shared-desktop-client-id");
        rel_cfg.build_channel = BuildChannel::Release;

        let fp = dev_cfg.fingerprint();
        assert_eq!(fp, rel_cfg.fingerprint());

        // Dev keeps the existing namespace; Release uses an isolated namespace.
        assert_eq!(
            credential_target_name_for_channel(APP_IDENTIFIER, &fp, 0, BuildChannel::Dev),
            credential_target_name(APP_IDENTIFIER, &fp, 0)
        );
        assert_ne!(
            credential_target_name_for_channel(APP_IDENTIFIER, &fp, 0, BuildChannel::Dev),
            credential_target_name_for_channel(APP_IDENTIFIER, &fp, 0, BuildChannel::Release)
        );
        assert_eq!(
            metadata_file_path_for_channel(&dir, &fp, BuildChannel::Dev),
            metadata_file_path(&dir, &fp)
        );
        assert_ne!(
            metadata_file_path_for_channel(&dir, &fp, BuildChannel::Dev),
            metadata_file_path_for_channel(&dir, &fp, BuildChannel::Release)
        );

        let dev_mgr = GoogleAuthManager::new(
            dev_cfg.clone(),
            &dir,
            shared_cred_store.clone(),
            transport.clone(),
            None,
        );
        let now = 1_750_000_000u64;
        let dev_tok = sign_test_id_token(
            "kid-1",
            &TestJwtClaims {
                iss: "https://accounts.google.com",
                aud: &dev_cfg.client_id,
                exp: now + 3600,
                nonce: "ndev",
                sub: "sub-dev",
                email: "dev@example.com",
                email_verified: true,
                hd: None,
            },
        );
        transport.push_ok("https://mock.google.local/jwks", 200, vec![], jwks_json("kid-1"));
        transport.push_ok(
            "https://mock.google.local/token",
            200,
            vec![],
            serde_json::json!({
                "access_token": "ya29.dev",
                "refresh_token": "1//dev",
                "expires_in": 3600,
                "scope": "openid email https://www.googleapis.com/auth/cloud-platform",
                "id_token": dev_tok
            })
            .to_string(),
        );
        let dev_status = dev_mgr
            .complete_authorization_code_exchange(
                &dev_cfg,
                "cdev",
                "vdev",
                "http://127.0.0.1:1000",
                "ndev",
                Some(now),
            )
            .await
            .unwrap();
        assert_eq!(dev_status.state, GoogleAuthConnectionState::Connected);
        let dev_confirmed = dev_mgr
            .confirm_project_guarded(
                "amed-512123",
                dev_status.auth_generation,
                "sub-dev",
                &fp,
                &dev_status.auth_session_id,
            )
            .await
            .unwrap();
        assert_eq!(dev_confirmed.project_id.as_deref(), Some("amed-512123"));

        // Release manager sharing the same app_data_dir and CredentialStore must start Disconnected
        // and must NOT inherit dev's token or project state.
        let rel_mgr = GoogleAuthManager::new(
            rel_cfg.clone(),
            &dir,
            shared_cred_store.clone(),
            transport.clone(),
            None,
        );
        let rel_status = rel_mgr.get_status().await;
        assert_eq!(rel_status.state, GoogleAuthConnectionState::Disconnected);
        assert!(rel_status.project_id.is_none());
        assert!(!rel_status.project_verified);

        // Logging out Release never affects Dev, and vice-versa.
        let _ = rel_mgr.logout().await.unwrap();
        let dev_reloaded = GoogleAuthManager::new(
            dev_cfg,
            &dir,
            shared_cred_store,
            transport,
            None,
        );
        let dev_after = dev_reloaded.get_status().await;
        assert_eq!(dev_after.state, GoogleAuthConnectionState::Connected);
        assert_eq!(dev_after.sub.as_deref(), Some("sub-dev"));
        assert_eq!(dev_after.project_id.as_deref(), Some("amed-512123"));

        let _ = std::fs::remove_dir_all(&dir);
    });
}

#[test]
fn test_onboarding_rejects_invalid_or_missing_default_project_id() {
    let invalid = resolve_client_config_for_build(
        true,
        Some(OAuthClientCredentials {
            client_id: "dev-id".to_string(),
            client_secret: Some("dev-secret".to_string()),
            secret_mode: OAuthClientSecretMode::Required,
            default_project_id: Some("INVALID_PROJ".to_string()),
        }),
        None,
    );
    assert!(invalid.default_project_id.is_none());
}
