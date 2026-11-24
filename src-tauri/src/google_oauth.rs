use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{Mutex, oneshot};

pub const APP_IDENTIFIER: &str = "com.asrcomposer.app";
pub const GOOGLE_AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
pub const GOOGLE_TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
pub const GOOGLE_REVOKE_ENDPOINT: &str = "https://oauth2.googleapis.com/revoke";
pub const GOOGLE_DISCOVERY_URL: &str = "https://accounts.google.com/.well-known/openid-configuration";
pub const REQUIRED_OAUTH_SCOPES: &str = "openid email https://www.googleapis.com/auth/cloud-platform";
pub const ALLOWED_ISSUERS: [&str; 2] = ["https://accounts.google.com", "accounts.google.com"];
pub const DEFAULT_OAUTH_TIMEOUT_SECS: u64 = 180;

// ---- Error Types ----

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GoogleApiErrorKind {
    NotAuthenticated,
    OauthUserCancelled,
    OauthConsentDenied,
    OauthStateMismatch,
    OauthCallbackTimeout,
    OauthAdminPolicyEnforced,
    OauthScopeNotGranted,
    OauthInvalidGrant,
    OauthRefreshTokenMissing,
    TokenRefreshFailed,
    NetworkError,
    ProjectListPermissionDenied,
    ProjectNotAccessible,
    SpeechApiDisabled,
    ServiceUsageApiDisabled,
    ServiceUsagePermissionDenied,
    ServiceUsageOperationFailed,
    ServiceUsageOperationTimeout,
    BillingDisabled,
    SpeechPermissionDenied,
    RecognizerNotFound,
    RecognizerPermissionDenied,
    QuotaOrResourceExhausted,
    InvalidConfig,
    HttpError,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleApiError {
    pub kind: GoogleApiErrorKind,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_service: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub consumer_project: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_generation: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sub: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oauth_client_id_fingerprint: Option<String>,
}

impl GoogleApiError {
    pub fn new(kind: GoogleApiErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            http_status: None,
            api_status: None,
            reason: None,
            target_service: None,
            consumer_project: None,
            auth_generation: None,
            sub: None,
            oauth_client_id_fingerprint: None,
        }
    }

    pub fn with_snapshot_meta(
        mut self,
        generation: u64,
        sub: &str,
        fingerprint: &str,
    ) -> Self {
        self.auth_generation = Some(generation);
        self.sub = Some(sub.to_string());
        self.oauth_client_id_fingerprint = Some(fingerprint.to_string());
        self
    }
}

impl fmt::Display for GoogleApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

// ---- Config & Namespace ----

mod bundled_oauth_config {
    include!(concat!(env!("OUT_DIR"), "/oauth_client_config.rs"));
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OAuthClientSecretMode {
    Required,
    None,
}

impl OAuthClientSecretMode {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "required" => Some(Self::Required),
            "none" => Some(Self::None),
            _ => None,
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct OAuthClientCredentials {
    pub client_id: String,
    pub client_secret: Option<String>,
    pub secret_mode: OAuthClientSecretMode,
    pub default_project_id: Option<String>,
}

impl fmt::Debug for OAuthClientCredentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OAuthClientCredentials")
            .field("client_id", &self.client_id)
            .field(
                "client_secret",
                &self.client_secret.as_ref().map(|_| "[REDACTED]"),
            )
            .field("secret_mode", &self.secret_mode)
            .field("default_project_id", &self.default_project_id)
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BuildChannel {
    Dev,
    Release,
}

impl BuildChannel {
    pub fn current() -> Self {
        if cfg!(debug_assertions) {
            Self::Dev
        } else {
            Self::Release
        }
    }
}

#[derive(Clone)]
pub struct GoogleOAuthConfig {
    pub client_id: String,
    pub client_secret: Option<String>,
    pub secret_mode: OAuthClientSecretMode,
    pub default_project_id: Option<String>,
    pub build_channel: BuildChannel,
    pub auth_endpoint: String,
    pub token_endpoint: String,
    pub revoke_endpoint: String,
    pub discovery_url: String,
    pub jwks_uri_override: Option<String>,
    pub callback_timeout: Duration,
}

impl fmt::Debug for GoogleOAuthConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GoogleOAuthConfig")
            .field("client_id", &self.client_id)
            .field(
                "client_secret",
                &self.client_secret.as_ref().map(|_| "[REDACTED]"),
            )
            .field("secret_mode", &self.secret_mode)
            .field("default_project_id", &self.default_project_id)
            .field("build_channel", &self.build_channel)
            .field("auth_endpoint", &self.auth_endpoint)
            .field("token_endpoint", &self.token_endpoint)
            .field("revoke_endpoint", &self.revoke_endpoint)
            .field("discovery_url", &self.discovery_url)
            .field("jwks_uri_override", &self.jwks_uri_override)
            .field("callback_timeout", &self.callback_timeout)
            .finish()
    }
}

pub fn resolve_client_config_for_build(
    is_debug: bool,
    dev_config: Option<OAuthClientCredentials>,
    prod_config: Option<OAuthClientCredentials>,
) -> OAuthClientCredentials {
    // Dev and release builds must never share a fallback or mix ID/Secret/Project across sources.
    let selected = if is_debug { dev_config } else { prod_config };
    match selected {
        Some(cfg) => {
            let normalized_project = cfg
                .default_project_id
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty() && validate_project_id_format(s).is_ok());
            OAuthClientCredentials {
                client_id: cfg.client_id.trim().to_string(),
                client_secret: cfg
                    .client_secret
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty()),
                secret_mode: cfg.secret_mode,
                default_project_id: normalized_project,
            }
        }
        None => OAuthClientCredentials {
            client_id: String::new(),
            client_secret: None,
            secret_mode: OAuthClientSecretMode::Required,
            default_project_id: None,
        },
    }
}

pub fn resolve_client_id_for_build(
    is_debug: bool,
    dev_client_id: Option<&str>,
    prod_client_id: Option<&str>,
) -> String {
    let dev = dev_client_id.map(|s| OAuthClientCredentials {
        client_id: s.to_string(),
        client_secret: None,
        secret_mode: OAuthClientSecretMode::None,
        default_project_id: None,
    });
    let prod = prod_client_id.map(|s| OAuthClientCredentials {
        client_id: s.to_string(),
        client_secret: None,
        secret_mode: OAuthClientSecretMode::None,
        default_project_id: None,
    });
    resolve_client_config_for_build(is_debug, dev, prod).client_id
}

impl GoogleOAuthConfig {
    pub fn from_env() -> Self {
        let default_project_id = {
            let raw = bundled_oauth_config::BUNDLED_OAUTH_DEFAULT_PROJECT_ID.trim();
            if raw.is_empty() {
                None
            } else {
                Some(raw.to_string())
            }
        };
        let bundled = OAuthClientCredentials {
            client_id: bundled_oauth_config::BUNDLED_OAUTH_CLIENT_ID.to_string(),
            client_secret: bundled_oauth_config::BUNDLED_OAUTH_CLIENT_SECRET
                .map(|s| s.to_string()),
            secret_mode: OAuthClientSecretMode::parse(
                bundled_oauth_config::BUNDLED_OAUTH_SECRET_MODE_STR,
            )
            .unwrap_or(OAuthClientSecretMode::Required),
            default_project_id,
        };
        let resolved = resolve_client_config_for_build(true, Some(bundled), None);
        Self {
            client_id: resolved.client_id,
            client_secret: resolved.client_secret,
            secret_mode: resolved.secret_mode,
            default_project_id: resolved.default_project_id,
            build_channel: BuildChannel::current(),
            auth_endpoint: GOOGLE_AUTH_ENDPOINT.to_string(),
            token_endpoint: GOOGLE_TOKEN_ENDPOINT.to_string(),
            revoke_endpoint: GOOGLE_REVOKE_ENDPOINT.to_string(),
            discovery_url: GOOGLE_DISCOVERY_URL.to_string(),
            jwks_uri_override: None,
            callback_timeout: Duration::from_secs(DEFAULT_OAUTH_TIMEOUT_SECS),
        }
    }

    pub fn validate_for_oauth(&self) -> Result<(), GoogleApiError> {
        if self.client_id.trim().is_empty() {
            return Err(GoogleApiError::new(
                GoogleApiErrorKind::InvalidConfig,
                "Google OAuth クライアント設定が未構成です。開発用設定（oauth-client.dev.json）またはビルド設定を確認してください。",
            ));
        }
        if self.secret_mode == OAuthClientSecretMode::Required
            && self
                .client_secret
                .as_deref()
                .map(str::trim)
                .unwrap_or("")
                .is_empty()
        {
            return Err(GoogleApiError::new(
                GoogleApiErrorKind::InvalidConfig,
                "Google OAuth Client Secretが未設定です。アプリのOAuthクライアント設定を確認してください。",
            ));
        }
        Ok(())
    }

    pub fn is_configured(&self) -> bool {
        self.validate_for_oauth().is_ok()
    }

    pub fn fingerprint(&self) -> String {
        compute_client_id_fingerprint(&self.client_id)
    }
}

fn append_client_credentials(
    serializer: &mut url::form_urlencoded::Serializer<String>,
    config: &GoogleOAuthConfig,
) -> Result<(), GoogleApiError> {
    config.validate_for_oauth()?;
    serializer.append_pair("client_id", config.client_id.trim());
    if config.secret_mode == OAuthClientSecretMode::Required {
        let secret = config.client_secret.as_deref().unwrap_or("").trim();
        serializer.append_pair("client_secret", secret);
    }
    Ok(())
}

pub fn compute_client_id_fingerprint(client_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(client_id.as_bytes());
    let digest = hasher.finalize();
    digest.iter().map(|b| format!("{:02x}", b)).collect()
}

pub fn credential_target_name_for_channel(
    app_id: &str,
    fingerprint: &str,
    slot: u8,
    channel: BuildChannel,
) -> String {
    match channel {
        BuildChannel::Dev => format!("{}/google-oauth/{}/slot{}", app_id, fingerprint, slot),
        BuildChannel::Release => format!("{}/google-oauth-release/{}/slot{}", app_id, fingerprint, slot),
    }
}

pub fn credential_target_name(app_id: &str, fingerprint: &str, slot: u8) -> String {
    credential_target_name_for_channel(app_id, fingerprint, slot, BuildChannel::Dev)
}

pub fn metadata_file_path_for_channel(
    app_data_dir: &Path,
    fingerprint: &str,
    channel: BuildChannel,
) -> PathBuf {
    let dir_name = match channel {
        BuildChannel::Dev => "google-oauth",
        BuildChannel::Release => "google-oauth-release",
    };
    app_data_dir
        .join(dir_name)
        .join(fingerprint)
        .join("auth-metadata.json")
}

pub fn metadata_file_path(app_data_dir: &Path, fingerprint: &str) -> PathBuf {
    metadata_file_path_for_channel(app_data_dir, fingerprint, BuildChannel::Dev)
}

// ---- Secret Wrapper (Redacted Debug) ----

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CredentialPayload {
    pub oauth_client_id_fingerprint: String,
    pub sub: String,
    pub refresh_token: String,
}

impl fmt::Debug for CredentialPayload {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CredentialPayload")
            .field("oauth_client_id_fingerprint", &self.oauth_client_id_fingerprint)
            .field("sub", &self.sub)
            .field("refresh_token", &"[REDACTED]")
            .finish()
    }
}

#[derive(Clone)]
struct AccessTokenCacheEntry {
    oauth_client_id_fingerprint: String,
    auth_generation: u64,
    active_slot: u8,
    sub: String,
    access_token: String,
    expires_at: Instant,
    canonical_scopes: Vec<String>,
}

impl fmt::Debug for AccessTokenCacheEntry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AccessTokenCacheEntry")
            .field("oauth_client_id_fingerprint", &self.oauth_client_id_fingerprint)
            .field("auth_generation", &self.auth_generation)
            .field("active_slot", &self.active_slot)
            .field("sub", &self.sub)
            .field("access_token", &"[REDACTED]")
            .field("canonical_scopes", &self.canonical_scopes)
            .finish()
    }
}

/// Internal Rust-only snapshot binding identity, slot, generation, token, scopes, and Project ID.
/// Never serialized or returned to TypeScript/WebView.
#[derive(Clone)]
pub struct GoogleAuthSnapshot {
    pub auth_generation: u64,
    pub oauth_client_id_fingerprint: String,
    pub active_slot: u8,
    pub sub: String,
    pub access_token: String,
    pub canonical_scopes: Vec<String>,
    pub project_id: Option<String>,
}

/// Dedicated onboarding snapshot that binds the build-configured default project
/// without writing an unverified project into active AuthMetadata first.
#[derive(Clone)]
pub struct GoogleOnboardingSnapshot {
    pub auth_generation: u64,
    pub auth_session_id: String,
    pub oauth_client_id_fingerprint: String,
    pub active_slot: u8,
    pub sub: String,
    pub email: String,
    pub access_token: String,
    pub canonical_scopes: Vec<String>,
    pub project_id: String,
}

impl fmt::Debug for GoogleOnboardingSnapshot {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GoogleOnboardingSnapshot")
            .field("auth_generation", &self.auth_generation)
            .field("auth_session_id", &self.auth_session_id)
            .field("oauth_client_id_fingerprint", &self.oauth_client_id_fingerprint)
            .field("active_slot", &self.active_slot)
            .field("sub", &self.sub)
            .field("email", &self.email)
            .field("access_token", &"[REDACTED]")
            .field("canonical_scopes", &self.canonical_scopes)
            .field("project_id", &self.project_id)
            .finish()
    }
}

impl GoogleOnboardingSnapshot {
    pub fn as_auth_snapshot(&self) -> GoogleAuthSnapshot {
        GoogleAuthSnapshot {
            auth_generation: self.auth_generation,
            oauth_client_id_fingerprint: self.oauth_client_id_fingerprint.clone(),
            active_slot: self.active_slot,
            sub: self.sub.clone(),
            access_token: self.access_token.clone(),
            canonical_scopes: self.canonical_scopes.clone(),
            project_id: Some(self.project_id.clone()),
        }
    }
}

pub enum OnboardingAcquireOutcome {
    ReadyForOnboarding(GoogleOnboardingSnapshot),
    AlreadyReadyUserProject(GoogleAuthStatus),
}

impl fmt::Debug for GoogleAuthSnapshot {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GoogleAuthSnapshot")
            .field("auth_generation", &self.auth_generation)
            .field("oauth_client_id_fingerprint", &self.oauth_client_id_fingerprint)
            .field("active_slot", &self.active_slot)
            .field("sub", &self.sub)
            .field("access_token", &"[REDACTED]")
            .field("canonical_scopes", &self.canonical_scopes)
            .field("project_id", &self.project_id)
            .finish()
    }
}

// ---- PKCE / State / Nonce ----

#[derive(Clone)]
pub struct PkcePair {
    pub code_verifier: String,
    pub code_challenge: String,
}

impl fmt::Debug for PkcePair {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PkcePair")
            .field("code_verifier", &"[REDACTED]")
            .field("code_challenge", &self.code_challenge)
            .finish()
    }
}

pub fn generate_random_urlsafe(num_bytes: usize) -> String {
    let mut bytes = vec![0u8; num_bytes];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(&bytes)
}

pub fn generate_pkce_pair() -> PkcePair {
    let code_verifier = generate_random_urlsafe(48); // 64 base64url chars
    let code_challenge = compute_pkce_s256_challenge(&code_verifier);
    PkcePair {
        code_verifier,
        code_challenge,
    }
}

pub fn compute_pkce_s256_challenge(verifier: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    let digest = hasher.finalize();
    URL_SAFE_NO_PAD.encode(digest)
}

pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (&x, &y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

// ---- Scope Canonicalization ----

pub const CAPABILITY_IDENTITY_OPENID: &str = "identity:openid";
pub const CAPABILITY_IDENTITY_EMAIL: &str = "identity:email";
pub const CAPABILITY_GOOGLE_CLOUD_API: &str = "google_cloud_api";

pub fn canonicalize_scopes(scope_str: &str) -> Result<Vec<String>, GoogleApiError> {
    let mut caps: BTreeSet<String> = BTreeSet::new();
    for token in scope_str.split_ascii_whitespace() {
        match token {
            "openid" => {
                caps.insert(CAPABILITY_IDENTITY_OPENID.to_string());
            }
            "email" | "https://www.googleapis.com/auth/userinfo.email" => {
                caps.insert(CAPABILITY_IDENTITY_EMAIL.to_string());
            }
            "https://www.googleapis.com/auth/cloud-platform" => {
                caps.insert(CAPABILITY_GOOGLE_CLOUD_API.to_string());
            }
            _ => {
                // Extra/unknown scopes are allowed but cannot substitute for required capabilities.
            }
        }
    }

    let required = [
        CAPABILITY_IDENTITY_OPENID,
        CAPABILITY_IDENTITY_EMAIL,
        CAPABILITY_GOOGLE_CLOUD_API,
    ];
    let missing: Vec<&str> = required
        .iter()
        .copied()
        .filter(|cap| !caps.contains(*cap))
        .collect();

    if !missing.is_empty() {
        return Err(GoogleApiError::new(
            GoogleApiErrorKind::OauthScopeNotGranted,
            format!(
                "必要なGoogle OAuthスコープが付与されていません（不足: {}）。",
                missing.join(", ")
            ),
        ));
    }

    Ok(caps.into_iter().collect())
}

pub fn has_required_capabilities(caps: &[String]) -> bool {
    caps.iter().any(|c| c == CAPABILITY_IDENTITY_OPENID)
        && caps.iter().any(|c| c == CAPABILITY_IDENTITY_EMAIL)
        && caps.iter().any(|c| c == CAPABILITY_GOOGLE_CLOUD_API)
}

// ---- HTTP Transport Abstraction ----

#[derive(Clone)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
}

impl fmt::Debug for HttpResponse {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HttpResponse")
            .field("status", &self.status)
            .field(
                "headers",
                &self.headers.keys().map(|name| (name, "[REDACTED]")).collect::<Vec<_>>(),
            )
            .field("body", &"[REDACTED]")
            .finish()
    }
}

#[derive(Clone)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

impl fmt::Debug for HttpRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HttpRequest")
            .field("method", &self.method)
            .field("url", &self.url)
            .field(
                "headers",
                &self.headers.iter().map(|(name, _)| (name, "[REDACTED]")).collect::<Vec<_>>(),
            )
            .field("body", &self.body.as_ref().map(|_| "[REDACTED]"))
            .finish()
    }
}

#[allow(async_fn_in_trait)]
pub trait GoogleHttpTransport: Send + Sync {
    async fn send(&self, req: HttpRequest) -> Result<HttpResponse, String>;
}

pub struct ReqwestGoogleHttpTransport {
    client: reqwest::Client,
}

impl ReqwestGoogleHttpTransport {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
        }
    }
}

impl GoogleHttpTransport for ReqwestGoogleHttpTransport {
    async fn send(&self, req: HttpRequest) -> Result<HttpResponse, String> {
        let method = reqwest::Method::from_bytes(req.method.as_bytes())
            .map_err(|e| format!("Invalid HTTP method: {}", e))?;
        let mut builder = self.client.request(method, &req.url);
        for (k, v) in req.headers {
            builder = builder.header(&k, &v);
        }
        if let Some(body) = req.body {
            builder = builder.body(body);
        }
        let resp = builder.send().await.map_err(|e| format!("HTTP error: {}", e))?;
        let status = resp.status().as_u16();
        let mut headers = HashMap::new();
        for (k, v) in resp.headers() {
            if let Ok(val) = v.to_str() {
                headers.insert(k.as_str().to_ascii_lowercase(), val.to_string());
            }
        }
        let body = resp
            .text()
            .await
            .map_err(|e| format!("Failed to read HTTP body: {}", e))?;
        Ok(HttpResponse {
            status,
            headers,
            body,
        })
    }
}

// ---- Credential Store Abstraction ----

pub trait CredentialStore: Send + Sync {
    fn save(&self, target: &str, payload: &CredentialPayload) -> Result<(), String>;
    fn load(&self, target: &str) -> Result<Option<CredentialPayload>, String>;
    fn delete(&self, target: &str) -> Result<(), String>;
}

pub struct InMemoryCredentialStore {
    entries: std::sync::Mutex<HashMap<String, CredentialPayload>>,
}

impl InMemoryCredentialStore {
    pub fn new() -> Self {
        Self {
            entries: std::sync::Mutex::new(HashMap::new()),
        }
    }
}

impl CredentialStore for InMemoryCredentialStore {
    fn save(&self, target: &str, payload: &CredentialPayload) -> Result<(), String> {
        let mut map = self.entries.lock().map_err(|_| "lock poisoned".to_string())?;
        map.insert(target.to_string(), payload.clone());
        Ok(())
    }

    fn load(&self, target: &str) -> Result<Option<CredentialPayload>, String> {
        let map = self.entries.lock().map_err(|_| "lock poisoned".to_string())?;
        Ok(map.get(target).cloned())
    }

    fn delete(&self, target: &str) -> Result<(), String> {
        let mut map = self.entries.lock().map_err(|_| "lock poisoned".to_string())?;
        map.remove(target);
        Ok(())
    }
}

#[cfg(windows)]
pub struct WindowsCredentialStore;

#[cfg(windows)]
impl CredentialStore for WindowsCredentialStore {
    fn save(&self, target: &str, payload: &CredentialPayload) -> Result<(), String> {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Security::Credentials::{
            CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
        };

        let json = serde_json::to_vec(payload)
            .map_err(|e| format!("資格情報のシリアライズに失敗しました: {}", e))?;
        let mut target_w: Vec<u16> = OsStr::new(target).encode_wide().chain(Some(0)).collect();
        let mut user_w: Vec<u16> = OsStr::new(&payload.sub)
            .encode_wide()
            .chain(Some(0))
            .collect();

        let cred = CREDENTIALW {
            Flags: 0,
            Type: CRED_TYPE_GENERIC,
            TargetName: target_w.as_mut_ptr(),
            Comment: std::ptr::null_mut(),
            LastWritten: windows_sys::Win32::Foundation::FILETIME {
                dwLowDateTime: 0,
                dwHighDateTime: 0,
            },
            CredentialBlobSize: json.len() as u32,
            CredentialBlob: json.as_ptr() as *mut u8,
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            AttributeCount: 0,
            Attributes: std::ptr::null_mut(),
            TargetAlias: std::ptr::null_mut(),
            UserName: user_w.as_mut_ptr(),
        };

        let ok = unsafe { CredWriteW(&cred, 0) };
        if ok == 0 {
            let err = std::io::Error::last_os_error();
            return Err(format!("Windows Credential Managerへの保存に失敗しました: {}", err));
        }
        Ok(())
    }

    fn load(&self, target: &str) -> Result<Option<CredentialPayload>, String> {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Foundation::ERROR_NOT_FOUND;
        use windows_sys::Win32::Security::Credentials::{
            CredFree, CredReadW, CREDENTIALW, CRED_TYPE_GENERIC,
        };

        let target_w: Vec<u16> = OsStr::new(target).encode_wide().chain(Some(0)).collect();
        let mut cred_ptr: *mut CREDENTIALW = std::ptr::null_mut();
        let ok = unsafe { CredReadW(target_w.as_ptr(), CRED_TYPE_GENERIC, 0, &mut cred_ptr) };
        if ok == 0 {
            let err = std::io::Error::last_os_error();
            if err.raw_os_error() == Some(ERROR_NOT_FOUND as i32) {
                return Ok(None);
            }
            return Err(format!("Windows Credential Managerからの読込に失敗しました: {}", err));
        }

        let result = unsafe {
            let cred = &*cred_ptr;
            if cred.CredentialBlob.is_null() || cred.CredentialBlobSize == 0 {
                Err("Credential Managerの資格情報データが空です".to_string())
            } else {
                let slice = std::slice::from_raw_parts(
                    cred.CredentialBlob,
                    cred.CredentialBlobSize as usize,
                );
                serde_json::from_slice::<CredentialPayload>(slice)
                    .map(Some)
                    .map_err(|e| format!("資格情報の解析に失敗しました: {}", e))
            }
        };
        unsafe {
            CredFree(cred_ptr as *const core::ffi::c_void);
        }
        result
    }

    fn delete(&self, target: &str) -> Result<(), String> {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Foundation::ERROR_NOT_FOUND;
        use windows_sys::Win32::Security::Credentials::{CredDeleteW, CRED_TYPE_GENERIC};

        let target_w: Vec<u16> = OsStr::new(target).encode_wide().chain(Some(0)).collect();
        let ok = unsafe { CredDeleteW(target_w.as_ptr(), CRED_TYPE_GENERIC, 0) };
        if ok == 0 {
            let err = std::io::Error::last_os_error();
            if err.raw_os_error() == Some(ERROR_NOT_FOUND as i32) {
                return Ok(());
            }
            return Err(format!("Windows Credential Managerからの削除に失敗しました: {}", err));
        }
        Ok(())
    }
}

// ---- Discovery & JWKS Cache + ID Token Verification ----

#[derive(Debug, Deserialize)]
struct DiscoveryDocument {
    jwks_uri: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct JwkKey {
    pub kid: Option<String>,
    pub kty: String,
    pub alg: Option<String>,
    pub n: Option<String>,
    pub e: Option<String>,
}

#[derive(Debug, Deserialize)]
struct JwksResponse {
    keys: Vec<JwkKey>,
}

#[derive(Debug, Clone)]
struct CachedJwks {
    keys: Vec<JwkKey>,
    expires_at: Instant,
}

pub struct JwksCache {
    jwks_uri: Option<String>,
    cached: Option<CachedJwks>,
}

impl JwksCache {
    pub fn new(jwks_uri_override: Option<String>) -> Self {
        Self {
            jwks_uri: jwks_uri_override,
            cached: None,
        }
    }

    fn parse_cache_ttl(headers: &HashMap<String, String>) -> Duration {
        if let Some(cc) = headers.get("cache-control") {
            let lower = cc.to_ascii_lowercase();
            if lower.contains("no-store") || lower.contains("no-cache") {
                return Duration::from_secs(0);
            }
            for part in lower.split(',') {
                let trimmed = part.trim();
                if let Some(val) = trimmed.strip_prefix("max-age=") {
                    if let Ok(secs) = val.trim().parse::<u64>() {
                        return Duration::from_secs(secs);
                    }
                }
            }
        }
        // Fallback default if no Cache-Control max-age is provided
        Duration::from_secs(300)
    }

    pub async fn get_keys<T: GoogleHttpTransport>(
        &mut self,
        transport: &T,
        discovery_url: &str,
        force_refresh: bool,
    ) -> Result<Vec<JwkKey>, GoogleApiError> {
        if !force_refresh {
            if let Some(ref cached) = self.cached {
                if Instant::now() < cached.expires_at {
                    return Ok(cached.keys.clone());
                }
            }
        }

        let jwks_uri = match &self.jwks_uri {
            Some(uri) => uri.clone(),
            None => {
                let resp = transport
                    .send(HttpRequest {
                        method: "GET".to_string(),
                        url: discovery_url.to_string(),
                        headers: vec![],
                        body: None,
                    })
                    .await
                    .map_err(|e| {
                        GoogleApiError::new(
                            GoogleApiErrorKind::NetworkError,
                            format!("OIDC Discovery取得に失敗しました: {}", e),
                        )
                    })?;
                if resp.status < 200 || resp.status >= 300 {
                    return Err(GoogleApiError::new(
                        GoogleApiErrorKind::HttpError,
                        format!("OIDC Discovery取得エラー (HTTP {})", resp.status),
                    ));
                }
                let doc: DiscoveryDocument = serde_json::from_str(&resp.body).map_err(|_| {
                    GoogleApiError::new(
                        GoogleApiErrorKind::HttpError,
                        "OIDC Discovery文書の解析に失敗しました",
                    )
                })?;
                self.jwks_uri = Some(doc.jwks_uri.clone());
                doc.jwks_uri
            }
        };

        let resp = transport
            .send(HttpRequest {
                method: "GET".to_string(),
                url: jwks_uri,
                headers: vec![],
                body: None,
            })
            .await
            .map_err(|e| {
                GoogleApiError::new(
                    GoogleApiErrorKind::NetworkError,
                    format!("Google JWK取得に失敗しました: {}", e),
                )
            })?;
        if resp.status < 200 || resp.status >= 300 {
            return Err(GoogleApiError::new(
                GoogleApiErrorKind::HttpError,
                format!("Google JWK取得エラー (HTTP {})", resp.status),
            ));
        }

        let ttl = Self::parse_cache_ttl(&resp.headers);
        let jwks: JwksResponse = serde_json::from_str(&resp.body).map_err(|_| {
            GoogleApiError::new(
                GoogleApiErrorKind::HttpError,
                "Google JWK応答の解析に失敗しました",
            )
        })?;

        if ttl > Duration::ZERO {
            self.cached = Some(CachedJwks {
                keys: jwks.keys.clone(),
                expires_at: Instant::now() + ttl,
            });
        } else {
            self.cached = None;
        }

        Ok(jwks.keys)
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct VerifiedIdToken {
    pub sub: String,
    pub email: String,
    pub hd: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawIdTokenClaims {
    iss: Option<String>,
    aud: Option<serde_json::Value>,
    exp: Option<u64>,
    nonce: Option<String>,
    sub: Option<String>,
    email: Option<String>,
    email_verified: Option<bool>,
    hd: Option<String>,
}

pub async fn verify_id_token<T: GoogleHttpTransport>(
    id_token: &str,
    expected_client_id: &str,
    expected_nonce: &str,
    jwks_cache: &mut JwksCache,
    transport: &T,
    discovery_url: &str,
    now_unix: Option<u64>,
) -> Result<VerifiedIdToken, GoogleApiError> {
    let header = decode_header(id_token).map_err(|_| {
        GoogleApiError::new(
            GoogleApiErrorKind::OauthInvalidGrant,
            "ID tokenヘッダーの検証に失敗しました",
        )
    })?;

    if header.alg != Algorithm::RS256 {
        return Err(GoogleApiError::new(
            GoogleApiErrorKind::OauthInvalidGrant,
            "ID tokenの署名アルゴリズムが不正です",
        ));
    }

    let kid = header.kid.ok_or_else(|| {
        GoogleApiError::new(
            GoogleApiErrorKind::OauthInvalidGrant,
            "ID tokenにkidが含まれていません",
        )
    })?;

    let keys = jwks_cache.get_keys(transport, discovery_url, false).await?;
    let mut matched_key = keys
        .iter()
        .find(|k| k.kid.as_deref() == Some(kid.as_str()) && k.kty == "RSA")
        .cloned();

    // Unknown kid: force refresh JWKS once, then fail closed if still unresolved.
    if matched_key.is_none() {
        let refreshed_keys = jwks_cache.get_keys(transport, discovery_url, true).await?;
        matched_key = refreshed_keys
            .iter()
            .find(|k| k.kid.as_deref() == Some(kid.as_str()) && k.kty == "RSA")
            .cloned();
    }

    let jwk = matched_key.ok_or_else(|| {
        GoogleApiError::new(
            GoogleApiErrorKind::OauthInvalidGrant,
            "ID tokenの署名鍵(kid)を解決できませんでした",
        )
    })?;

    let (Some(n), Some(e)) = (jwk.n.as_deref(), jwk.e.as_deref()) else {
        return Err(GoogleApiError::new(
            GoogleApiErrorKind::OauthInvalidGrant,
            "ID token検証用のRSA公開鍵パラメータが不足しています",
        ));
    };

    let decoding_key = DecodingKey::from_rsa_components(n, e).map_err(|_| {
        GoogleApiError::new(
            GoogleApiErrorKind::OauthInvalidGrant,
            "ID token検証用公開鍵の構築に失敗しました",
        )
    })?;

    let mut validation = Validation::new(Algorithm::RS256);
    validation.validate_exp = false; // we check exp explicitly so tests can inject now_unix
    validation.validate_aud = false; // we check aud explicitly against expected_client_id
    validation.required_spec_claims.clear();

    let token_data = decode::<RawIdTokenClaims>(id_token, &decoding_key, &validation).map_err(|_| {
        GoogleApiError::new(
            GoogleApiErrorKind::OauthInvalidGrant,
            "ID tokenの署名検証に失敗しました",
        )
    })?;

    let claims = token_data.claims;

    // 1. iss
    let iss = claims.iss.as_deref().unwrap_or("");
    if !ALLOWED_ISSUERS.contains(&iss) {
        return Err(GoogleApiError::new(
            GoogleApiErrorKind::OauthInvalidGrant,
            "ID tokenの発行元(iss)が許可されていません",
        ));
    }

    // 2. aud
    let aud_ok = match &claims.aud {
        Some(serde_json::Value::String(s)) => s == expected_client_id,
        _ => false,
    };
    if !aud_ok {
        return Err(GoogleApiError::new(
            GoogleApiErrorKind::OauthInvalidGrant,
            "ID tokenの対象(aud)がアプリのClient IDと一致しません",
        ));
    }

    // 3. exp
    let exp = claims.exp.ok_or_else(|| {
        GoogleApiError::new(
            GoogleApiErrorKind::OauthInvalidGrant,
            "ID tokenに有効期限(exp)がありません",
        )
    })?;
    let current_ts = now_unix.unwrap_or_else(|| {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    });
    if current_ts > exp.saturating_add(60) {
        return Err(GoogleApiError::new(
            GoogleApiErrorKind::OauthInvalidGrant,
            "ID tokenの有効期限が切れています",
        ));
    }

    // 4. nonce
    let nonce = claims.nonce.as_deref().unwrap_or("");
    if nonce.is_empty() || !constant_time_eq(nonce.as_bytes(), expected_nonce.as_bytes()) {
        return Err(GoogleApiError::new(
            GoogleApiErrorKind::OauthStateMismatch,
            "ID tokenのnonce検証に失敗しました",
        ));
    }

    // 5. sub
    let sub = claims
        .sub
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            GoogleApiError::new(
                GoogleApiErrorKind::OauthInvalidGrant,
                "ID tokenにアカウント識別子(sub)がありません",
            )
        })?
        .to_string();

    // 6. email & email_verified == true
    let email = claims
        .email
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            GoogleApiError::new(
                GoogleApiErrorKind::OauthInvalidGrant,
                "ID tokenにメールアドレスが含まれていません",
            )
        })?
        .to_string();

    if claims.email_verified != Some(true) {
        return Err(GoogleApiError::new(
            GoogleApiErrorKind::OauthInvalidGrant,
            "Googleアカウントのメールアドレスが未確認(email_verified != true)です",
        ));
    }

    Ok(VerifiedIdToken {
        sub,
        email,
        hd: claims.hd,
    })
}

// ---- Metadata Persistence ----

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SlotMetadata {
    pub sub: String,
    pub email: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hosted_domain: Option<String>,
    pub canonical_scopes: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProjectSource {
    Default,
    UserSelected,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuthMetadata {
    pub schema_version: u32,
    pub oauth_client_id_fingerprint: String,
    pub active_slot: Option<u8>,
    pub auth_generation: u64,
    #[serde(default)]
    pub auth_session_id: String,
    pub slots: [Option<SlotMetadata>; 2],
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default)]
    pub project_verified: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_source: Option<ProjectSource>,
}

impl AuthMetadata {
    pub fn empty(fingerprint: &str, generation: u64) -> Self {
        Self {
            schema_version: 1,
            oauth_client_id_fingerprint: fingerprint.to_string(),
            active_slot: None,
            auth_generation: generation,
            auth_session_id: String::new(),
            slots: [None, None],
            project_id: None,
            project_verified: false,
            project_source: None,
        }
    }

    pub fn active_slot_meta(&self) -> Option<(u8, &SlotMetadata)> {
        let slot = self.active_slot?;
        if slot > 1 {
            return None;
        }
        let meta = self.slots[slot as usize].as_ref()?;
        Some((slot, meta))
    }
}

pub fn logout_pending_marker_path(metadata_path: &Path) -> PathBuf {
    metadata_path.with_extension("logout-pending")
}

pub fn load_metadata_raw(path: &Path) -> Option<AuthMetadata> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str::<AuthMetadata>(&text).ok()
}

pub fn save_metadata_atomic(path: &Path, metadata: &AuthMetadata) -> Result<(), String> {
    use std::io::Write;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("認証メタデータディレクトリの作成に失敗しました: {}", e))?;
    }
    let tmp_path = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(metadata)
        .map_err(|e| format!("認証メタデータのシリアライズに失敗しました: {}", e))?;
    {
        let mut file = fs::File::create(&tmp_path)
            .map_err(|e| format!("認証メタデータ一時ファイルの作成に失敗しました: {}", e))?;
        file.write_all(json.as_bytes())
            .map_err(|e| format!("認証メタデータ一時ファイルの書込に失敗しました: {}", e))?;
        file.sync_all()
            .map_err(|e| format!("認証メタデータ一時ファイルの同期に失敗しました: {}", e))?;
    }

    #[cfg(windows)]
    {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        let src_w: Vec<u16> = OsStr::new(&tmp_path).encode_wide().chain(Some(0)).collect();
        let dst_w: Vec<u16> = OsStr::new(path).encode_wide().chain(Some(0)).collect();
        let ok = unsafe {
            MoveFileExW(
                src_w.as_ptr(),
                dst_w.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if ok == 0 {
            let err = std::io::Error::last_os_error();
            return Err(format!("認証メタデータの原子的置換に失敗しました: {}", err));
        }
    }
    #[cfg(not(windows))]
    {
        fs::rename(&tmp_path, path)
            .map_err(|e| format!("認証メタデータの原子的置換に失敗しました: {}", e))?;
    }
    Ok(())
}

// ---- Frontend-Safe Auth Status & Result DTOs ----

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GoogleAuthConnectionState {
    Disconnected,
    Connected,
    ReauthRequired,
    Revoking,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleAuthStatus {
    pub state: GoogleAuthConnectionState,
    pub auth_generation: u64,
    #[serde(default)]
    pub auth_session_id: String,
    pub oauth_client_id_fingerprint: String,
    pub oauth_client_configured: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sub: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hosted_domain: Option<String>,
    pub canonical_scopes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub project_verified: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_source: Option<ProjectSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub legacy_project_candidate: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<GoogleApiError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleAuthRevokeResult {
    pub logged_out: bool,
    pub revoked_on_google: bool,
    pub message: String,
    pub status: GoogleAuthStatus,
}

// ---- Loopback Callback Parsing & URL Building ----

pub fn build_google_auth_url(
    config: &GoogleOAuthConfig,
    redirect_uri: &str,
    code_challenge: &str,
    state: &str,
    nonce: &str,
    force_consent: bool,
) -> Result<String, GoogleApiError> {
    if config.client_id.trim().is_empty() {
        return Err(GoogleApiError::new(
            GoogleApiErrorKind::InvalidConfig,
            "Google OAuth Client IDが設定されていません。",
        ));
    }
    let mut url = url::Url::parse(&config.auth_endpoint).map_err(|_| {
        GoogleApiError::new(
            GoogleApiErrorKind::InvalidConfig,
            "OAuth認可エンドポイントURLが不正です。",
        )
    })?;
    let prompt_val = if force_consent {
        "select_account consent"
    } else {
        "select_account"
    };
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &config.client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("scope", REQUIRED_OAUTH_SCOPES)
        .append_pair("code_challenge", code_challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", state)
        .append_pair("nonce", nonce)
        .append_pair("access_type", "offline")
        .append_pair("prompt", prompt_val);
    Ok(url.to_string())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoopbackCallbackOutcome {
    Code { code: String, state: String },
    OAuthError { error: String, state: Option<String> },
}

pub fn parse_loopback_request_line(request_line: &str) -> Result<LoopbackCallbackOutcome, GoogleApiError> {
    let parts: Vec<&str> = request_line.split_whitespace().collect();
    if parts.len() < 2 {
        return Err(GoogleApiError::new(
            GoogleApiErrorKind::HttpError,
            "OAuthコールバックHTTPリクエストが不正です",
        ));
    }
    let path_and_query = parts[1];
    let full_url = format!("http://127.0.0.1{}", path_and_query);
    let parsed = url::Url::parse(&full_url).map_err(|_| {
        GoogleApiError::new(
            GoogleApiErrorKind::HttpError,
            "OAuthコールバックURLの解析に失敗しました",
        )
    })?;

    let mut code: Option<String> = None;
    let mut state: Option<String> = None;
    let mut error: Option<String> = None;

    for (k, v) in parsed.query_pairs() {
        match k.as_ref() {
            "code" => code = Some(v.into_owned()),
            "state" => state = Some(v.into_owned()),
            "error" => error = Some(v.into_owned()),
            _ => {}
        }
    }

    if let Some(err) = error {
        return Ok(LoopbackCallbackOutcome::OAuthError { error: err, state });
    }

    match (code, state) {
        (Some(c), Some(s)) if !c.is_empty() && !s.is_empty() => {
            Ok(LoopbackCallbackOutcome::Code { code: c, state: s })
        }
        _ => Err(GoogleApiError::new(
            GoogleApiErrorKind::OauthStateMismatch,
            "OAuthコールバックに必要なcodeまたはstateが含まれていません",
        )),
    }
}

pub fn map_oauth_callback_error(error_code: &str) -> GoogleApiError {
    match error_code {
        "access_denied" => GoogleApiError::new(
            GoogleApiErrorKind::OauthConsentDenied,
            "Googleアカウントの認証が拒否またはキャンセルされました。",
        ),
        "admin_policy_enforced" => GoogleApiError::new(
            GoogleApiErrorKind::OauthAdminPolicyEnforced,
            "Google Workspace管理ポリシーによりこのアプリへのアクセスが制限されています。",
        ),
        other => GoogleApiError::new(
            GoogleApiErrorKind::OauthInvalidGrant,
            format!("Google OAuth認可エラー: {}", other),
        ),
    }
}

// ---- Token Endpoint Responses ----

#[derive(Deserialize)]
struct RawTokenResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
    scope: Option<String>,
    id_token: Option<String>,
}

#[derive(Deserialize)]
struct RawTokenErrorResponse {
    error: Option<String>,
}

pub fn classify_token_error_response(status: u16, body: &str) -> GoogleApiError {
    let parsed = serde_json::from_str::<RawTokenErrorResponse>(body).ok();
    let err_code = parsed
        .as_ref()
        .and_then(|e| e.error.as_deref())
        .unwrap_or("");

    // Never forward raw error_description or HTTP body verbatim to callers/UI.
    match err_code {
        "invalid_client" => GoogleApiError::new(
            GoogleApiErrorKind::InvalidConfig,
            "Google OAuthクライアント設定（Client ID / Client Secret）がGoogle側と一致していないか無効です。アプリ設定またはGoogle Cloud Consoleの設定を確認してください。",
        ),
        "unauthorized_client" => GoogleApiError::new(
            GoogleApiErrorKind::InvalidConfig,
            "このGoogle OAuthクライアントは現在の認証方式を許可されていません。Google Cloud ConsoleのOAuthクライアント種別を確認してください。",
        ),
        "invalid_request" => GoogleApiError::new(
            GoogleApiErrorKind::InvalidConfig,
            "Googleトークン要求の形式が不正です。アプリのOAuth設定を確認してください。",
        ),
        "invalid_grant" => GoogleApiError::new(
            GoogleApiErrorKind::OauthInvalidGrant,
            "Google認証の有効期限が切れたか取り消されました。再ログインしてください。",
        ),
        "admin_policy_enforced" => GoogleApiError::new(
            GoogleApiErrorKind::OauthAdminPolicyEnforced,
            "Google Workspace管理ポリシーにより認証が拒否されました。",
        ),
        "access_denied" => GoogleApiError::new(
            GoogleApiErrorKind::OauthConsentDenied,
            "Google認証への同意が拒否されました。",
        ),
        _ => GoogleApiError::new(
            GoogleApiErrorKind::TokenRefreshFailed,
            format!("Googleトークン取得に失敗しました (HTTP {})", status),
        ),
    }
}

// ---- Auth Manager ----

struct AuthManagerInner {
    config: GoogleOAuthConfig,
    metadata_path: PathBuf,
    metadata: AuthMetadata,
    access_token_cache: Option<AccessTokenCacheEntry>,
    jwks_cache: JwksCache,
    login_in_flight: bool,
    login_epoch: u64,
    login_cancel_tx: Option<oneshot::Sender<()>>,
    revoking: bool,
    reauth_required: bool,
    legacy_project_candidate: Option<String>,
    last_error: Option<GoogleApiError>,
}

pub struct GoogleAuthManager<T: GoogleHttpTransport = ReqwestGoogleHttpTransport> {
    inner: Mutex<AuthManagerInner>,
    cred_store: Arc<dyn CredentialStore>,
    transport: Arc<T>,
}

impl<T: GoogleHttpTransport> GoogleAuthManager<T> {
    pub fn new(
        config: GoogleOAuthConfig,
        app_data_dir: &Path,
        cred_store: Arc<dyn CredentialStore>,
        transport: Arc<T>,
        legacy_project_candidate: Option<String>,
    ) -> Self {
        let fingerprint = config.fingerprint();
        let build_channel = config.build_channel;
        let metadata_path = metadata_file_path_for_channel(app_data_dir, &fingerprint, build_channel);
        let jwks_uri_override = config.jwks_uri_override.clone();

        let (metadata, reauth_required, last_error) =
            Self::reconcile_on_startup(&fingerprint, build_channel, &metadata_path, cred_store.as_ref());

        Self {
            inner: Mutex::new(AuthManagerInner {
                config,
                metadata_path,
                metadata,
                access_token_cache: None,
                jwks_cache: JwksCache::new(jwks_uri_override),
                login_in_flight: false,
                login_epoch: 1,
                login_cancel_tx: None,
                revoking: false,
                reauth_required,
                legacy_project_candidate,
                last_error,
            }),
            cred_store,
            transport,
        }
    }

    fn reconcile_on_startup(
        current_fingerprint: &str,
        build_channel: BuildChannel,
        metadata_path: &Path,
        cred_store: &dyn CredentialStore,
    ) -> (AuthMetadata, bool, Option<GoogleApiError>) {
        let marker_path = logout_pending_marker_path(metadata_path);
        if marker_path.exists() {
            // Previous logout/revoke failed to clear metadata and/or credentials: never restore old auth.
            let mut cleanup_errors = Vec::new();
            for slot in [0u8, 1u8] {
                let target = credential_target_name_for_channel(
                    APP_IDENTIFIER,
                    current_fingerprint,
                    slot,
                    build_channel,
                );
                if let Err(e) = cred_store.delete(&target) {
                    cleanup_errors.push(format!("Credential Manager slot {slot}: {e}"));
                }
            }
            if metadata_path.exists() {
                if let Err(e) = fs::remove_file(metadata_path) {
                    if e.kind() != std::io::ErrorKind::NotFound {
                        cleanup_errors.push(format!("metadata削除失敗: {e}"));
                    }
                }
            }
            if cleanup_errors.is_empty() {
                let _ = fs::remove_file(&marker_path);
                return (AuthMetadata::empty(current_fingerprint, 1), false, None);
            }
            return (
                AuthMetadata::empty(current_fingerprint, 1),
                true,
                Some(GoogleApiError::new(
                    GoogleApiErrorKind::NotAuthenticated,
                    format!(
                        "前回のログアウト時にローカル認証情報を完全に消去できなかったため再認証が必要です ({})",
                        cleanup_errors.join("; ")
                    ),
                )),
            );
        }

        let Some(mut loaded) = load_metadata_raw(metadata_path) else {
            // No metadata yet: clean up any orphaned slots in current namespace.
            for slot in [0u8, 1u8] {
                let target = credential_target_name_for_channel(
                    APP_IDENTIFIER,
                    current_fingerprint,
                    slot,
                    build_channel,
                );
                let _ = cred_store.delete(&target);
            }
            return (AuthMetadata::empty(current_fingerprint, 1), false, None);
        };

        // Fingerprint mismatch -> do NOT restore credentials, sub, project, or verified state; do NOT refresh.
        if loaded.oauth_client_id_fingerprint != current_fingerprint {
            return (
                AuthMetadata::empty(current_fingerprint, loaded.auth_generation.saturating_add(1)),
                true,
                Some(GoogleApiError::new(
                    GoogleApiErrorKind::NotAuthenticated,
                    "OAuth Client IDが変更されたため再認証が必要です。",
                )),
            );
        }

        match loaded.active_slot {
            None => {
                // Uncommitted or logged-out state: clean up any orphaned slots, never promote them.
                for slot in [0u8, 1u8] {
                    let target = credential_target_name_for_channel(
                        APP_IDENTIFIER,
                        current_fingerprint,
                        slot,
                        build_channel,
                    );
                    let _ = cred_store.delete(&target);
                }
                (loaded, false, None)
            }
            Some(slot) if slot > 1 => {
                // Corrupted active_slot pointer -> never guess a slot!
                let mut reset = AuthMetadata::empty(
                    current_fingerprint,
                    loaded.auth_generation.saturating_add(1),
                );
                reset.slots = [None, None];
                let _ = save_metadata_atomic(metadata_path, &reset);
                (
                    reset,
                    true,
                    Some(GoogleApiError::new(
                        GoogleApiErrorKind::NotAuthenticated,
                        "認証状態が破損しているため再ログインが必要です。",
                    )),
                )
            }
            Some(slot) => {
                let Some(slot_meta) = loaded.slots[slot as usize].as_ref() else {
                    // Corrupted pointer (slot metadata missing) -> never guess!
                    let reset = AuthMetadata::empty(
                        current_fingerprint,
                        loaded.auth_generation.saturating_add(1),
                    );
                    let _ = save_metadata_atomic(metadata_path, &reset);
                    return (
                        reset,
                        true,
                        Some(GoogleApiError::new(
                            GoogleApiErrorKind::NotAuthenticated,
                            "認証スロット情報が不整合のため再ログインが必要です。",
                        )),
                    );
                };

                // Older metadata predates auth-session identifiers or project_source.
                // Migrate once so queued operations distinguish fresh logins and existing
                // verified projects are preserved as user_selected.
                let mut needs_migration_save = false;
                if loaded.auth_session_id.is_empty() {
                    loaded.auth_session_id = generate_random_urlsafe(18);
                    needs_migration_save = true;
                }
                if loaded.project_id.is_some()
                    && loaded.project_verified
                    && loaded.project_source.is_none()
                {
                    loaded.project_source = Some(ProjectSource::UserSelected);
                    needs_migration_save = true;
                }
                if needs_migration_save {
                    if let Err(error) = save_metadata_atomic(metadata_path, &loaded) {
                        return (
                            AuthMetadata::empty(current_fingerprint, loaded.auth_generation),
                            true,
                            Some(GoogleApiError::new(
                                GoogleApiErrorKind::InvalidConfig,
                                format!("認証メタデータの移行に失敗しました: {error}"),
                            )),
                        );
                    }
                }

                // Clean up non-active slot best-effort
                let other_slot = 1 - slot;
                let other_target = credential_target_name_for_channel(
                    APP_IDENTIFIER,
                    current_fingerprint,
                    other_slot,
                    build_channel,
                );
                let _ = cred_store.delete(&other_target);

                // Verify active slot credential exists and matches fingerprint + sub + scopes
                let active_target = credential_target_name_for_channel(
                    APP_IDENTIFIER,
                    current_fingerprint,
                    slot,
                    build_channel,
                );
                match cred_store.load(&active_target) {
                    Ok(Some(payload))
                        if payload.oauth_client_id_fingerprint == current_fingerprint
                            && payload.sub == slot_meta.sub
                            && !payload.refresh_token.is_empty()
                            && has_required_capabilities(&slot_meta.canonical_scopes) =>
                    {
                        (loaded, false, None)
                    }
                    _ => {
                        let reset = AuthMetadata::empty(
                            current_fingerprint,
                            loaded.auth_generation.saturating_add(1),
                        );
                        let _ = save_metadata_atomic(metadata_path, &reset);
                        (
                            reset,
                            true,
                            Some(GoogleApiError::new(
                                GoogleApiErrorKind::NotAuthenticated,
                                "保存されたGoogle資格情報を検証できないため再ログインが必要です。",
                            )),
                        )
                    }
                }
            }
        }
    }

    pub async fn get_status(&self) -> GoogleAuthStatus {
        let guard = self.inner.lock().await;
        Self::build_status_locked(&guard)
    }

    fn build_status_locked(guard: &AuthManagerInner) -> GoogleAuthStatus {
        let fingerprint = guard.config.fingerprint();
        let oauth_client_configured = guard.config.is_configured();
        if guard.revoking {
            return GoogleAuthStatus {
                state: GoogleAuthConnectionState::Revoking,
                auth_generation: guard.metadata.auth_generation,
                auth_session_id: guard.metadata.auth_session_id.clone(),
                oauth_client_id_fingerprint: fingerprint,
                oauth_client_configured,
                email: None,
                sub: None,
                hosted_domain: None,
                canonical_scopes: vec![],
                project_id: None,
                project_verified: false,
                project_source: None,
                default_project_id: guard.config.default_project_id.clone(),
                legacy_project_candidate: None,
                last_error: guard.last_error.clone(),
            };
        }

        if guard.reauth_required {
            return GoogleAuthStatus {
                state: GoogleAuthConnectionState::ReauthRequired,
                auth_generation: guard.metadata.auth_generation,
                auth_session_id: guard.metadata.auth_session_id.clone(),
                oauth_client_id_fingerprint: fingerprint,
                oauth_client_configured,
                email: None,
                sub: None,
                hosted_domain: None,
                canonical_scopes: vec![],
                project_id: None,
                project_verified: false,
                project_source: None,
                default_project_id: guard.config.default_project_id.clone(),
                legacy_project_candidate: None,
                last_error: guard.last_error.clone(),
            };
        }

        if let Some((_, slot_meta)) = guard.metadata.active_slot_meta() {
            GoogleAuthStatus {
                state: GoogleAuthConnectionState::Connected,
                auth_generation: guard.metadata.auth_generation,
                auth_session_id: guard.metadata.auth_session_id.clone(),
                oauth_client_id_fingerprint: fingerprint,
                oauth_client_configured,
                email: Some(slot_meta.email.clone()),
                sub: Some(slot_meta.sub.clone()),
                hosted_domain: slot_meta.hosted_domain.clone(),
                canonical_scopes: slot_meta.canonical_scopes.clone(),
                project_id: guard.metadata.project_id.clone(),
                project_verified: guard.metadata.project_verified,
                project_source: guard.metadata.project_source,
                default_project_id: guard.config.default_project_id.clone(),
                legacy_project_candidate: if guard.metadata.project_id.is_none() {
                    guard.legacy_project_candidate.clone()
                } else {
                    None
                },
                last_error: guard.last_error.clone(),
            }
        } else {
            GoogleAuthStatus {
                state: if guard.reauth_required {
                    GoogleAuthConnectionState::ReauthRequired
                } else {
                    GoogleAuthConnectionState::Disconnected
                },
                auth_generation: guard.metadata.auth_generation,
                auth_session_id: guard.metadata.auth_session_id.clone(),
                oauth_client_id_fingerprint: fingerprint,
                oauth_client_configured,
                email: None,
                sub: None,
                hosted_domain: None,
                canonical_scopes: vec![],
                project_id: None,
                project_verified: false,
                project_source: None,
                default_project_id: guard.config.default_project_id.clone(),
                legacy_project_candidate: guard.legacy_project_candidate.clone(),
                last_error: guard.last_error.clone(),
            }
        }
    }

    pub async fn has_committed_project_id(&self) -> bool {
        let guard = self.inner.lock().await;
        guard.metadata.project_id.is_some()
    }

    pub async fn current_login_epoch(&self) -> u64 {
        let guard = self.inner.lock().await;
        guard.login_epoch
    }

    pub async fn cancel_in_flight_login(&self) -> bool {
        let mut guard = self.inner.lock().await;
        guard.login_epoch = guard.login_epoch.saturating_add(1);
        if let Some(tx) = guard.login_cancel_tx.take() {
            let _ = tx.send(());
            true
        } else {
            false
        }
    }

    pub async fn start_login_flow<F>(
        &self,
        open_browser: F,
    ) -> Result<GoogleAuthStatus, GoogleApiError>
    where
        F: FnOnce(&str) -> Result<(), String>,
    {
        self.start_login_flow_with_options(false, open_browser).await
    }

    pub async fn start_login_flow_with_options<F>(
        &self,
        force_consent: bool,
        open_browser: F,
    ) -> Result<GoogleAuthStatus, GoogleApiError>
    where
        F: FnOnce(&str) -> Result<(), String>,
    {
        let (config, pkce, state, nonce, timeout, cancel_rx, captured_login_epoch) = {
            let mut guard = self.inner.lock().await;
            if guard.revoking {
                return Err(GoogleApiError::new(
                    GoogleApiErrorKind::InvalidConfig,
                    "現在Googleアクセス権の取り消し処理中です。",
                ));
            }
            if guard.login_in_flight {
                return Err(GoogleApiError::new(
                    GoogleApiErrorKind::InvalidConfig,
                    "Googleログイン処理がすでに進行中です。",
                ));
            }
            guard.config.validate_for_oauth()?;
            let pkce = generate_pkce_pair();
            let state = generate_random_urlsafe(32);
            let nonce = generate_random_urlsafe(32);
            let (cancel_tx, cancel_rx) = oneshot::channel();
            guard.login_in_flight = true;
            guard.login_epoch = guard.login_epoch.saturating_add(1);
            let captured_login_epoch = guard.login_epoch;
            guard.login_cancel_tx = Some(cancel_tx);
            (
                guard.config.clone(),
                pkce,
                state,
                nonce,
                guard.config.callback_timeout,
                cancel_rx,
                captured_login_epoch,
            )
        };

        let result = self
            .run_login_flow_inner(
                &config,
                pkce,
                &state,
                &nonce,
                timeout,
                cancel_rx,
                force_consent,
                captured_login_epoch,
                open_browser,
            )
            .await;

        let mut guard = self.inner.lock().await;
        if guard.login_epoch == captured_login_epoch {
            guard.login_in_flight = false;
            guard.login_cancel_tx = None;
        }

        match result {
            Ok(status) => Ok(status),
            Err(err) => {
                // Only record last_error if this login wasn't superseded/invalidated by logout/revoke.
                if guard.login_epoch == captured_login_epoch && !guard.revoking {
                    guard.last_error = Some(err.clone());
                }
                Err(err)
            }
        }
    }

    async fn run_login_flow_inner<F>(
        &self,
        config: &GoogleOAuthConfig,
        pkce: PkcePair,
        expected_state: &str,
        expected_nonce: &str,
        timeout: Duration,
        cancel_rx: oneshot::Receiver<()>,
        force_consent: bool,
        captured_login_epoch: u64,
        open_browser: F,
    ) -> Result<GoogleAuthStatus, GoogleApiError>
    where
        F: FnOnce(&str) -> Result<(), String>,
    {
        let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| {
            GoogleApiError::new(
                GoogleApiErrorKind::NetworkError,
                format!("OAuthコールバック用ローカルポートの待受に失敗しました: {}", e),
            )
        })?;
        let port = listener
            .local_addr()
            .map_err(|e| {
                GoogleApiError::new(
                    GoogleApiErrorKind::NetworkError,
                    format!("ローカルポート取得に失敗しました: {}", e),
                )
            })?
            .port();
        let redirect_uri = format!("http://127.0.0.1:{}", port);
        let auth_url = build_google_auth_url(
            config,
            &redirect_uri,
            &pkce.code_challenge,
            expected_state,
            expected_nonce,
            force_consent,
        )?;

        open_browser(&auth_url).map_err(|e| {
            GoogleApiError::new(
                GoogleApiErrorKind::InvalidConfig,
                format!("ブラウザーの起動に失敗しました: {}", e),
            )
        })?;

        let callback_outcome = wait_for_loopback_callback(listener, timeout, cancel_rx).await?;
        let code = match callback_outcome {
            LoopbackCallbackOutcome::Code { code, state } => {
                if !constant_time_eq(state.as_bytes(), expected_state.as_bytes()) {
                    return Err(GoogleApiError::new(
                        GoogleApiErrorKind::OauthStateMismatch,
                        "OAuth state検証に失敗しました。ログインをやり直してください。",
                    ));
                }
                code
            }
            LoopbackCallbackOutcome::OAuthError { error, state } => {
                if let Some(st) = state {
                    if !constant_time_eq(st.as_bytes(), expected_state.as_bytes()) {
                        return Err(GoogleApiError::new(
                            GoogleApiErrorKind::OauthStateMismatch,
                            "OAuth state検証に失敗しました。",
                        ));
                    }
                }
                return Err(map_oauth_callback_error(&error));
            }
        };

        self.complete_authorization_code_exchange_with_epoch(
            config,
            &code,
            &pkce.code_verifier,
            &redirect_uri,
            expected_nonce,
            None,
            Some(captured_login_epoch),
        )
        .await
    }

    /// Completes code exchange, ID token verification, scope canonicalization, slot save/reload,
    /// and atomic metadata commit. Exposed for mock HTTP integration tests as well.
    pub async fn complete_authorization_code_exchange(
        &self,
        config: &GoogleOAuthConfig,
        code: &str,
        code_verifier: &str,
        redirect_uri: &str,
        expected_nonce: &str,
        now_unix: Option<u64>,
    ) -> Result<GoogleAuthStatus, GoogleApiError> {
        let captured_epoch = {
            let guard = self.inner.lock().await;
            guard.login_epoch
        };
        self.complete_authorization_code_exchange_with_epoch(
            config,
            code,
            code_verifier,
            redirect_uri,
            expected_nonce,
            now_unix,
            Some(captured_epoch),
        )
        .await
    }

    pub async fn complete_authorization_code_exchange_with_epoch(
        &self,
        config: &GoogleOAuthConfig,
        code: &str,
        code_verifier: &str,
        redirect_uri: &str,
        expected_nonce: &str,
        now_unix: Option<u64>,
        expected_login_epoch: Option<u64>,
    ) -> Result<GoogleAuthStatus, GoogleApiError> {
        let form = {
            let mut serializer = url::form_urlencoded::Serializer::new(String::new());
            append_client_credentials(&mut serializer, config)?;
            serializer
                .append_pair("code", code)
                .append_pair("code_verifier", code_verifier)
                .append_pair("redirect_uri", redirect_uri)
                .append_pair("grant_type", "authorization_code")
                .finish()
        };

        let resp = self
            .transport
            .send(HttpRequest {
                method: "POST".to_string(),
                url: config.token_endpoint.clone(),
                headers: vec![(
                    "Content-Type".to_string(),
                    "application/x-www-form-urlencoded".to_string(),
                )],
                body: Some(form),
            })
            .await
            .map_err(|_| {
                GoogleApiError::new(
                    GoogleApiErrorKind::NetworkError,
                    "Googleトークン交換の通信に失敗しました。ネットワーク接続を確認してください。",
                )
            })?;

        if resp.status < 200 || resp.status >= 300 {
            return Err(classify_token_error_response(resp.status, &resp.body));
        }

        let token_resp: RawTokenResponse = serde_json::from_str(&resp.body).map_err(|_| {
            GoogleApiError::new(
                GoogleApiErrorKind::HttpError,
                "Googleトークン応答の解析に失敗しました。",
            )
        })?;

        // 1. Validate granted scopes
        let scope_str = token_resp.scope.as_deref().unwrap_or("");
        let canonical_scopes = canonicalize_scopes(scope_str)?;

        let access_token = token_resp
            .access_token
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                GoogleApiError::new(
                    GoogleApiErrorKind::OauthInvalidGrant,
                    "access_tokenが応答に含まれていません。",
                )
            })?;

        let response_refresh_token = token_resp.refresh_token.filter(|s| !s.is_empty());

        let id_token = token_resp
            .id_token
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                GoogleApiError::new(
                    GoogleApiErrorKind::OauthInvalidGrant,
                    "id_tokenが応答に含まれていません。",
                )
            })?;

        let expires_in = token_resp.expires_in.unwrap_or(3600);

        // 2. Verify ID token (signature + claims + nonce + email_verified)
        let verified_id = {
            let mut guard = self.inner.lock().await;
            verify_id_token(
                &id_token,
                &config.client_id,
                expected_nonce,
                &mut guard.jwks_cache,
                self.transport.as_ref(),
                &config.discovery_url,
                now_unix,
            )
            .await?
        };

        let fingerprint = config.fingerprint();

        // 3. Synchronize slot save, reload verification, and atomic commit under a single lock
        // so logout/revoke/new login cannot interleave with Credential Manager mutations.
        let mut guard = self.inner.lock().await;
        if guard.revoking {
            return Err(GoogleApiError::new(
                GoogleApiErrorKind::OauthUserCancelled,
                "アクセス権取り消し処理中のためログインを確定できませんでした。",
            ));
        }
        if let Some(expected_epoch) = expected_login_epoch {
            if guard.login_epoch != expected_epoch {
                return Err(GoogleApiError::new(
                    GoogleApiErrorKind::OauthUserCancelled,
                    "ログアウトまたは取り消し処理により進行中のログインが無効化されました。",
                ));
            }
        }

        // Resolve refresh token: use response token, or reuse ONLY for same Client ID + same sub + valid scopes.
        let marker_path = logout_pending_marker_path(&guard.metadata_path);
        let pending_logout = marker_path.exists();
        let refresh_token = match response_refresh_token {
            Some(rt) => rt,
            None => {
                let reusable = guard
                    .metadata
                    .active_slot_meta()
                    .filter(|(_, m)| !pending_logout && {
                        guard.metadata.oauth_client_id_fingerprint == fingerprint
                            && m.sub == verified_id.sub
                            && has_required_capabilities(&m.canonical_scopes)
                    })
                    .and_then(|(active_slot, _)| {
                        let active_target = credential_target_name_for_channel(
                            APP_IDENTIFIER,
                            &fingerprint,
                            active_slot,
                            config.build_channel,
                        );
                        self.cred_store.load(&active_target).ok().flatten().and_then(|p| {
                            if p.oauth_client_id_fingerprint == fingerprint
                                && p.sub == verified_id.sub
                                && !p.refresh_token.is_empty()
                            {
                                Some(p.refresh_token)
                            } else {
                                None
                            }
                        })
                    });

                match reusable {
                    Some(existing_rt) => existing_rt,
                    None => {
                        return Err(GoogleApiError::new(
                            GoogleApiErrorKind::OauthRefreshTokenMissing,
                            "Googleからrefresh tokenが返却されませんでした。「同意を再取得してログイン」で再試行してください。",
                        ));
                    }
                }
            }
        };

        if pending_logout {
            // The tombstone means the old account is no longer usable, even if cleanup fails.
            // Invalidate snapshots and hide the old identity before the first fallible cleanup.
            guard.metadata = AuthMetadata::empty(
                &fingerprint,
                guard.metadata.auth_generation.saturating_add(1),
            );
            guard.access_token_cache = None;
            guard.reauth_required = true;

            // Finish the old logout before reusing any slot. Persist an inactive metadata state
            // before removing the tombstone, so a crash after marker removal cannot revive the
            // previous account/project from stale metadata.
            let mut cleanup_errors = Vec::new();
            for slot in [0u8, 1u8] {
                let target = credential_target_name_for_channel(
                    APP_IDENTIFIER,
                    &fingerprint,
                    slot,
                    config.build_channel,
                );
                if let Err(e) = self.cred_store.delete(&target) {
                    cleanup_errors.push(format!("slot {slot}: {e}"));
                }
            }
            if cleanup_errors.is_empty() {
                let empty = guard.metadata.clone();
                if let Err(e) = save_metadata_atomic(&guard.metadata_path, &empty) {
                    cleanup_errors.push(format!("ログイン前metadata初期化失敗: {e}"));
                } else {
                    guard.metadata = empty;
                    guard.access_token_cache = None;
                    if let Err(e) = fs::remove_file(&marker_path) {
                        if e.kind() == std::io::ErrorKind::NotFound {
                            guard.reauth_required = false;
                        } else {
                            cleanup_errors.push(format!("logout-pendingマーカー削除失敗: {e}"));
                        }
                    } else {
                        guard.reauth_required = false;
                    }
                }
            }
            if !cleanup_errors.is_empty() {
                let err = GoogleApiError::new(
                    GoogleApiErrorKind::InvalidConfig,
                    format!(
                        "前回のログアウト残存処理が完了できないため、復旧が必要です（{}）。",
                        cleanup_errors.join("; ")
                    ),
                );
                guard.reauth_required = true;
                guard.last_error = Some(err.clone());
                return Err(err);
            }
        }

        let target_slot = match guard.metadata.active_slot {
            Some(0) => 1,
            Some(1) => 0,
            _ => 0,
        };

        let target_name = credential_target_name_for_channel(
            APP_IDENTIFIER,
            &fingerprint,
            target_slot,
            config.build_channel,
        );
        let payload = CredentialPayload {
            oauth_client_id_fingerprint: fingerprint.clone(),
            sub: verified_id.sub.clone(),
            refresh_token,
        };
        self.cred_store
            .save(&target_name, &payload)
            .map_err(|e| GoogleApiError::new(GoogleApiErrorKind::InvalidConfig, e))?;

        let reloaded = self
            .cred_store
            .load(&target_name)
            .map_err(|e| GoogleApiError::new(GoogleApiErrorKind::InvalidConfig, e))?;

        let reload_ok = matches!(
            reloaded,
            Some(ref r)
                if r.oauth_client_id_fingerprint == fingerprint
                    && r.sub == verified_id.sub
                    && !r.refresh_token.is_empty()
        ) && has_required_capabilities(&canonical_scopes);

        if !reload_ok {
            let _ = self.cred_store.delete(&target_name);
            return Err(GoogleApiError::new(
                GoogleApiErrorKind::InvalidConfig,
                "保存したGoogle資格情報の再読込検証に失敗しました。既存の認証状態を維持します。",
            ));
        }

        let old_slot = guard.metadata.active_slot;
        let old_sub = guard
            .metadata
            .active_slot_meta()
            .map(|(_, m)| m.sub.clone());

        let mut next_meta = guard.metadata.clone();
        next_meta.oauth_client_id_fingerprint = fingerprint.clone();
        next_meta.active_slot = Some(target_slot);
        next_meta.auth_generation = next_meta.auth_generation.saturating_add(1);
        next_meta.auth_session_id = generate_random_urlsafe(18);
        next_meta.slots[target_slot as usize] = Some(SlotMetadata {
            sub: verified_id.sub.clone(),
            email: verified_id.email.clone(),
            hosted_domain: verified_id.hd.clone(),
            canonical_scopes: canonical_scopes.clone(),
        });

        // Same sub -> preserve Project ID, verified state, and project_source; different sub -> clear them.
        if old_sub.as_deref() != Some(verified_id.sub.as_str()) {
            next_meta.project_id = None;
            next_meta.project_verified = false;
            next_meta.project_source = None;
        } else if next_meta.project_id.is_some()
            && next_meta.project_verified
            && next_meta.project_source.is_none()
        {
            next_meta.project_source = Some(ProjectSource::UserSelected);
        }

        save_metadata_atomic(&guard.metadata_path, &next_meta)
            .map_err(|e| GoogleApiError::new(GoogleApiErrorKind::InvalidConfig, e))?;

        guard.metadata = next_meta;
        guard.reauth_required = false;
        guard.last_error = None;
        guard.access_token_cache = Some(AccessTokenCacheEntry {
            oauth_client_id_fingerprint: fingerprint.clone(),
            auth_generation: guard.metadata.auth_generation,
            active_slot: target_slot,
            sub: verified_id.sub.clone(),
            access_token,
            expires_at: Instant::now() + Duration::from_secs(expires_in),
            canonical_scopes,
        });

        // Best-effort delete old slot after commit (still synchronized under lock)
        if let Some(old) = old_slot.filter(|&s| s != target_slot) {
            let old_target = credential_target_name_for_channel(
                APP_IDENTIFIER,
                &fingerprint,
                old,
                config.build_channel,
            );
            let _ = self.cred_store.delete(&old_target);
        }

        Ok(Self::build_status_locked(&guard))
    }

    /// Acquires a consistent internal snapshot. Refreshes token if needed, bound strictly to the
    /// captured (fingerprint, generation, slot, sub).
    pub async fn acquire_snapshot(
        &self,
        require_project: bool,
    ) -> Result<GoogleAuthSnapshot, GoogleApiError> {
        let (config, fingerprint, generation, slot, sub, cached_scopes, project_id, cached_token) = {
            let guard = self.inner.lock().await;
            if guard.revoking {
                return Err(GoogleApiError::new(
                    GoogleApiErrorKind::NotAuthenticated,
                    "Googleアクセス権の取り消し処理中のためAPIを実行できません。",
                ));
            }
            if guard.reauth_required {
                return Err(GoogleApiError::new(
                    GoogleApiErrorKind::NotAuthenticated,
                    "Google認証の復旧が必要なためAPIを実行できません。再ログインしてください。",
                ));
            }
            let current_fp = guard.config.fingerprint();
            if guard.metadata.oauth_client_id_fingerprint != current_fp {
                return Err(GoogleApiError::new(
                    GoogleApiErrorKind::NotAuthenticated,
                    "OAuth Client IDが一致しないため再認証が必要です。",
                ));
            }
            let Some((slot, slot_meta)) = guard.metadata.active_slot_meta() else {
                return Err(GoogleApiError::new(
                    GoogleApiErrorKind::NotAuthenticated,
                    "Googleアカウントにログインしていません。",
                ));
            };
            if !has_required_capabilities(&slot_meta.canonical_scopes) {
                return Err(GoogleApiError::new(
                    GoogleApiErrorKind::OauthScopeNotGranted,
                    "必要なGoogle OAuthスコープが付与されていません。",
                ));
            }
            if require_project && guard.metadata.project_id.as_deref().unwrap_or("").is_empty() {
                return Err(GoogleApiError::new(
                    GoogleApiErrorKind::InvalidConfig,
                    "Google Cloud プロジェクトIDを選択または確定してください。",
                ));
            }

            let gen = guard.metadata.auth_generation;
            let cached_token = guard.access_token_cache.as_ref().and_then(|entry| {
                let valid = entry.oauth_client_id_fingerprint == current_fp
                    && entry.auth_generation == gen
                    && entry.active_slot == slot
                    && entry.sub == slot_meta.sub
                    && Instant::now() + Duration::from_secs(60) < entry.expires_at
                    && has_required_capabilities(&entry.canonical_scopes);
                if valid {
                    Some(entry.access_token.clone())
                } else {
                    None
                }
            });

            (
                guard.config.clone(),
                current_fp,
                gen,
                slot,
                slot_meta.sub.clone(),
                slot_meta.canonical_scopes.clone(),
                guard.metadata.project_id.clone(),
                cached_token,
            )
        };

        if let Some(access_token) = cached_token {
            return Ok(GoogleAuthSnapshot {
                auth_generation: generation,
                oauth_client_id_fingerprint: fingerprint,
                active_slot: slot,
                sub,
                access_token,
                canonical_scopes: cached_scopes,
                project_id,
            });
        }

        self.refresh_for_captured_identity(
            &config,
            &fingerprint,
            generation,
            slot,
            &sub,
            &cached_scopes,
            project_id,
        )
        .await
    }

    pub async fn force_refresh_snapshot(
        &self,
        snapshot: &GoogleAuthSnapshot,
    ) -> Result<GoogleAuthSnapshot, GoogleApiError> {
        let config = {
            let mut guard = self.inner.lock().await;
            if !Self::is_snapshot_current_locked(&guard, snapshot) {
                return Err(GoogleApiError::new(
                    GoogleApiErrorKind::NotAuthenticated,
                    "認証状態が変更されたため処理を中止しました。",
                ));
            }
            guard.access_token_cache = None;
            guard.config.clone()
        };

        self.refresh_for_captured_identity(
            &config,
            &snapshot.oauth_client_id_fingerprint,
            snapshot.auth_generation,
            snapshot.active_slot,
            &snapshot.sub,
            &snapshot.canonical_scopes,
            snapshot.project_id.clone(),
        )
        .await
    }

    async fn refresh_for_captured_identity(
        &self,
        config: &GoogleOAuthConfig,
        fingerprint: &str,
        captured_generation: u64,
        slot: u8,
        sub: &str,
        existing_scopes: &[String],
        project_id: Option<String>,
    ) -> Result<GoogleAuthSnapshot, GoogleApiError> {
        let target_name = credential_target_name_for_channel(
            APP_IDENTIFIER,
            fingerprint,
            slot,
            config.build_channel,
        );
        let payload = self
            .cred_store
            .load(&target_name)
            .map_err(|e| GoogleApiError::new(GoogleApiErrorKind::TokenRefreshFailed, e))?
            .ok_or_else(|| {
                GoogleApiError::new(
                    GoogleApiErrorKind::NotAuthenticated,
                    "保存されたGoogle資格情報が見つかりません。再ログインしてください。",
                )
            })?;

        if payload.oauth_client_id_fingerprint != fingerprint
            || payload.sub != sub
            || payload.refresh_token.is_empty()
        {
            return Err(GoogleApiError::new(
                GoogleApiErrorKind::NotAuthenticated,
                "資格情報の整合性検証に失敗しました。再ログインしてください。",
            ));
        }

        let form = {
            let mut serializer = url::form_urlencoded::Serializer::new(String::new());
            append_client_credentials(&mut serializer, config)?;
            serializer
                .append_pair("refresh_token", &payload.refresh_token)
                .append_pair("grant_type", "refresh_token")
                .finish()
        };

        let resp = self
            .transport
            .send(HttpRequest {
                method: "POST".to_string(),
                url: config.token_endpoint.clone(),
                headers: vec![(
                    "Content-Type".to_string(),
                    "application/x-www-form-urlencoded".to_string(),
                )],
                body: Some(form),
            })
            .await
            .map_err(|_| {
                GoogleApiError::new(
                    GoogleApiErrorKind::NetworkError,
                    "トークン更新の通信に失敗しました。ネットワーク接続を確認してください。",
                )
            })?;

        if resp.status < 200 || resp.status >= 300 {
            let err = classify_token_error_response(resp.status, &resp.body);
            let mut guard = self.inner.lock().await;
            if guard.metadata.auth_generation == captured_generation
                && guard.metadata.active_slot == Some(slot)
                && !guard.revoking
            {
                if err.kind == GoogleApiErrorKind::OauthInvalidGrant
                    || err.kind == GoogleApiErrorKind::OauthAdminPolicyEnforced
                {
                    guard.reauth_required = true;
                }
                guard.last_error = Some(err.clone());
            }
            return Err(err);
        }

        let token_resp: RawTokenResponse = serde_json::from_str(&resp.body).map_err(|_| {
            GoogleApiError::new(
                GoogleApiErrorKind::TokenRefreshFailed,
                "トークン更新応答の解析に失敗しました。",
            )
        })?;

        // Re-validate scope if present in refresh response; preserve existing verified scopes if omitted.
        let effective_scopes = if let Some(ref scope_str) = token_resp.scope {
            canonicalize_scopes(scope_str)?
        } else {
            if !has_required_capabilities(existing_scopes) {
                return Err(GoogleApiError::new(
                    GoogleApiErrorKind::OauthScopeNotGranted,
                    "必要なGoogle OAuthスコープが確認できません。",
                ));
            }
            existing_scopes.to_vec()
        };

        let access_token = token_resp
            .access_token
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                GoogleApiError::new(
                    GoogleApiErrorKind::TokenRefreshFailed,
                    "更新応答にaccess_tokenが含まれていません。",
                )
            })?;
        let expires_in = token_resp.expires_in.unwrap_or(3600);

        // Re-check generation/slot/sub/revoking before registering token into cache!
        let mut guard = self.inner.lock().await;
        let still_same = !guard.revoking
            && guard.metadata.oauth_client_id_fingerprint == fingerprint
            && guard.metadata.auth_generation == captured_generation
            && guard.metadata.active_slot == Some(slot)
            && guard
                .metadata
                .active_slot_meta()
                .map(|(_, m)| m.sub == sub)
                .unwrap_or(false);

        if !still_same {
            return Err(GoogleApiError::new(
                GoogleApiErrorKind::NotAuthenticated,
                "トークン更新中にアカウントまたは設定が変更されたため処理を中止しました。",
            ));
        }

        guard.access_token_cache = Some(AccessTokenCacheEntry {
            oauth_client_id_fingerprint: fingerprint.to_string(),
            auth_generation: captured_generation,
            active_slot: slot,
            sub: sub.to_string(),
            access_token: access_token.clone(),
            expires_at: Instant::now() + Duration::from_secs(expires_in),
            canonical_scopes: effective_scopes.clone(),
        });

        Ok(GoogleAuthSnapshot {
            auth_generation: captured_generation,
            oauth_client_id_fingerprint: fingerprint.to_string(),
            active_slot: slot,
            sub: sub.to_string(),
            access_token,
            canonical_scopes: effective_scopes,
            project_id,
        })
    }

    fn is_snapshot_current_locked(guard: &AuthManagerInner, snapshot: &GoogleAuthSnapshot) -> bool {
        !guard.revoking
            && !guard.reauth_required
            && guard.metadata.oauth_client_id_fingerprint == snapshot.oauth_client_id_fingerprint
            && guard.metadata.auth_generation == snapshot.auth_generation
            && guard.metadata.active_slot == Some(snapshot.active_slot)
            && guard
                .metadata
                .active_slot_meta()
                .map(|(_, m)| m.sub == snapshot.sub)
                .unwrap_or(false)
    }

    pub async fn is_snapshot_current(&self, snapshot: &GoogleAuthSnapshot) -> bool {
        let guard = self.inner.lock().await;
        Self::is_snapshot_current_locked(&guard, snapshot)
    }

    pub async fn mark_project_verified_if_current(
        &self,
        snapshot: &GoogleAuthSnapshot,
    ) -> Result<(), GoogleApiError> {
        let mut guard = self.inner.lock().await;
        if !Self::is_snapshot_current_locked(&guard, snapshot) {
            return Ok(());
        }
        if !guard.metadata.project_verified
            || (guard.metadata.project_id.is_some() && guard.metadata.project_source.is_none())
        {
            let mut next = guard.metadata.clone();
            next.project_verified = true;
            if next.project_id.is_some() && next.project_source.is_none() {
                next.project_source = Some(ProjectSource::UserSelected);
            }
            save_metadata_atomic(&guard.metadata_path, &next)
                .map_err(|e| GoogleApiError::new(GoogleApiErrorKind::InvalidConfig, e))?;
            guard.metadata = next;
        }
        guard.last_error = None;
        Ok(())
    }

    fn is_onboarding_snapshot_current_locked(
        guard: &AuthManagerInner,
        snapshot: &GoogleOnboardingSnapshot,
    ) -> bool {
        !guard.revoking
            && !guard.reauth_required
            && guard.metadata.oauth_client_id_fingerprint == snapshot.oauth_client_id_fingerprint
            && guard.metadata.auth_generation == snapshot.auth_generation
            && guard.metadata.auth_session_id == snapshot.auth_session_id
            && guard.metadata.active_slot == Some(snapshot.active_slot)
            && guard.metadata.project_source != Some(ProjectSource::UserSelected)
            && guard
                .metadata
                .active_slot_meta()
                .map(|(_, m)| m.sub == snapshot.sub)
                .unwrap_or(false)
    }

    pub async fn is_onboarding_snapshot_current(
        &self,
        snapshot: &GoogleOnboardingSnapshot,
    ) -> bool {
        let guard = self.inner.lock().await;
        Self::is_onboarding_snapshot_current_locked(&guard, snapshot)
    }

    pub async fn acquire_onboarding_snapshot(
        &self,
    ) -> Result<OnboardingAcquireOutcome, GoogleApiError> {
        let (
            config,
            fingerprint,
            generation,
            auth_session_id,
            slot,
            sub,
            email,
            cached_scopes,
            default_project_id,
            cached_token,
        ) = {
            let guard = self.inner.lock().await;
            if guard.revoking {
                return Err(GoogleApiError::new(
                    GoogleApiErrorKind::NotAuthenticated,
                    "Googleアクセス権の取り消し処理中のため準備を実行できません。",
                ));
            }
            if guard.reauth_required {
                return Err(GoogleApiError::new(
                    GoogleApiErrorKind::NotAuthenticated,
                    "Google認証の復旧が必要なため再ログインしてください。",
                ));
            }
            let current_fp = guard.config.fingerprint();
            if guard.metadata.oauth_client_id_fingerprint != current_fp {
                return Err(GoogleApiError::new(
                    GoogleApiErrorKind::NotAuthenticated,
                    "OAuth Client IDが一致しないため再認証が必要です。",
                ));
            }
            let Some((slot, slot_meta)) = guard.metadata.active_slot_meta() else {
                return Err(GoogleApiError::new(
                    GoogleApiErrorKind::NotAuthenticated,
                    "Googleアカウントにログインしていません。",
                ));
            };
            if !has_required_capabilities(&slot_meta.canonical_scopes) {
                return Err(GoogleApiError::new(
                    GoogleApiErrorKind::OauthScopeNotGranted,
                    "必要なGoogle OAuthスコープが付与されていません。",
                ));
            }
            if guard.metadata.project_verified
                && guard.metadata.project_source == Some(ProjectSource::UserSelected)
            {
                return Ok(OnboardingAcquireOutcome::AlreadyReadyUserProject(
                    Self::build_status_locked(&guard),
                ));
            }
            let default_project_id = guard
                .config
                .default_project_id
                .clone()
                .filter(|p| validate_project_id_format(p).is_ok())
                .ok_or_else(|| {
                    GoogleApiError::new(
                        GoogleApiErrorKind::InvalidConfig,
                        "アプリの Google Cloud 既定Project設定が不完全です。提供元の設定を確認してください。",
                    )
                })?;

            let gen = guard.metadata.auth_generation;
            let cached_token = guard.access_token_cache.as_ref().and_then(|entry| {
                let valid = entry.oauth_client_id_fingerprint == current_fp
                    && entry.auth_generation == gen
                    && entry.active_slot == slot
                    && entry.sub == slot_meta.sub
                    && Instant::now() + Duration::from_secs(60) < entry.expires_at
                    && has_required_capabilities(&entry.canonical_scopes);
                if valid {
                    Some(entry.access_token.clone())
                } else {
                    None
                }
            });

            (
                guard.config.clone(),
                current_fp,
                gen,
                guard.metadata.auth_session_id.clone(),
                slot,
                slot_meta.sub.clone(),
                slot_meta.email.clone(),
                slot_meta.canonical_scopes.clone(),
                default_project_id,
                cached_token,
            )
        };

        if let Some(access_token) = cached_token {
            return Ok(OnboardingAcquireOutcome::ReadyForOnboarding(
                GoogleOnboardingSnapshot {
                    auth_generation: generation,
                    auth_session_id,
                    oauth_client_id_fingerprint: fingerprint,
                    active_slot: slot,
                    sub,
                    email,
                    access_token,
                    canonical_scopes: cached_scopes,
                    project_id: default_project_id,
                },
            ));
        }

        let refreshed = self
            .refresh_for_captured_identity(
                &config,
                &fingerprint,
                generation,
                slot,
                &sub,
                &cached_scopes,
                Some(default_project_id.clone()),
            )
            .await?;

        let snapshot = GoogleOnboardingSnapshot {
            auth_generation: refreshed.auth_generation,
            auth_session_id,
            oauth_client_id_fingerprint: refreshed.oauth_client_id_fingerprint,
            active_slot: refreshed.active_slot,
            sub: refreshed.sub,
            email,
            access_token: refreshed.access_token,
            canonical_scopes: refreshed.canonical_scopes,
            project_id: default_project_id,
        };

        let guard = self.inner.lock().await;
        if !Self::is_onboarding_snapshot_current_locked(&guard, &snapshot) {
            return Err(GoogleApiError::new(
                GoogleApiErrorKind::NotAuthenticated,
                "準備中にアカウントまたはProject設定が変更されたため処理を中止しました。",
            ));
        }
        Ok(OnboardingAcquireOutcome::ReadyForOnboarding(snapshot))
    }

    pub async fn refresh_onboarding_snapshot_if_current(
        &self,
        snapshot: &GoogleOnboardingSnapshot,
    ) -> Result<GoogleOnboardingSnapshot, GoogleApiError> {
        let (config, cached_scopes) = {
            let mut guard = self.inner.lock().await;
            if !Self::is_onboarding_snapshot_current_locked(&guard, snapshot) {
                return Err(GoogleApiError::new(
                    GoogleApiErrorKind::NotAuthenticated,
                    "準備中にアカウントまたはProject設定が変更されたため処理を中止しました。",
                ));
            }
            if let Some(ref entry) = guard.access_token_cache {
                if entry.oauth_client_id_fingerprint == snapshot.oauth_client_id_fingerprint
                    && entry.auth_generation == snapshot.auth_generation
                    && entry.active_slot == snapshot.active_slot
                    && entry.sub == snapshot.sub
                {
                    guard.access_token_cache = None;
                }
            }
            let scopes = guard
                .metadata
                .active_slot_meta()
                .map(|(_, m)| m.canonical_scopes.clone())
                .unwrap_or_else(|| snapshot.canonical_scopes.clone());
            (guard.config.clone(), scopes)
        };

        let refreshed = self
            .refresh_for_captured_identity(
                &config,
                &snapshot.oauth_client_id_fingerprint,
                snapshot.auth_generation,
                snapshot.active_slot,
                &snapshot.sub,
                &cached_scopes,
                Some(snapshot.project_id.clone()),
            )
            .await?;

        let next = GoogleOnboardingSnapshot {
            auth_generation: refreshed.auth_generation,
            auth_session_id: snapshot.auth_session_id.clone(),
            oauth_client_id_fingerprint: refreshed.oauth_client_id_fingerprint,
            active_slot: refreshed.active_slot,
            sub: refreshed.sub,
            email: snapshot.email.clone(),
            access_token: refreshed.access_token,
            canonical_scopes: refreshed.canonical_scopes,
            project_id: snapshot.project_id.clone(),
        };

        let guard = self.inner.lock().await;
        if !Self::is_onboarding_snapshot_current_locked(&guard, &next) {
            return Err(GoogleApiError::new(
                GoogleApiErrorKind::NotAuthenticated,
                "準備中にアカウントまたはProject設定が変更されたため処理を中止しました。",
            ));
        }
        Ok(next)
    }

    pub async fn complete_default_onboarding_commit_if_current(
        &self,
        snapshot: &GoogleOnboardingSnapshot,
    ) -> Result<Option<GoogleAuthStatus>, GoogleApiError> {
        let mut guard = self.inner.lock().await;
        if !Self::is_onboarding_snapshot_current_locked(&guard, snapshot) {
            return Ok(None);
        }
        let mut next = guard.metadata.clone();
        next.project_id = Some(snapshot.project_id.clone());
        next.project_verified = true;
        next.project_source = Some(ProjectSource::Default);
        next.auth_generation = next.auth_generation.saturating_add(1);
        save_metadata_atomic(&guard.metadata_path, &next)
            .map_err(|e| GoogleApiError::new(GoogleApiErrorKind::InvalidConfig, e))?;
        guard.metadata = next;
        guard.last_error = None;
        Ok(Some(Self::build_status_locked(&guard)))
    }

    #[cfg(test)]
    pub async fn confirm_project(&self, project_id: &str) -> Result<GoogleAuthStatus, GoogleApiError> {
        self.confirm_project_inner(project_id, None).await
    }

    pub async fn confirm_project_guarded(&self, project_id: &str, generation: u64, sub: &str, fingerprint: &str, auth_session_id: &str) -> Result<GoogleAuthStatus, GoogleApiError> {
        self.confirm_project_inner(project_id, Some((generation, sub, fingerprint, auth_session_id))).await
    }

    async fn confirm_project_inner(&self, project_id: &str, expected: Option<(u64, &str, &str, &str)>) -> Result<GoogleAuthStatus, GoogleApiError> {
        let trimmed = project_id.trim();
        validate_project_id_format(trimmed)?;

        let mut guard = self.inner.lock().await;
        if guard.revoking {
            return Err(GoogleApiError::new(
                GoogleApiErrorKind::NotAuthenticated,
                "アクセス権取り消し処理中のためプロジェクトを更新できません。",
            ));
        }
        if guard.metadata.active_slot_meta().is_none() {
            return Err(GoogleApiError::new(
                GoogleApiErrorKind::NotAuthenticated,
                "Googleアカウントにログインしてからプロジェクトを確定してください。",
            ));
        }

        if let Some((generation, sub, fingerprint, auth_session_id)) = expected {
            let matches = guard.metadata.auth_generation == generation
                && guard.metadata.oauth_client_id_fingerprint== fingerprint
                && guard.metadata.auth_session_id == auth_session_id
                && guard.metadata.active_slot_meta().is_some_and(|(_, slot)| slot.sub == sub);
            if !matches {
                return Err(GoogleApiError::new(GoogleApiErrorKind::NotAuthenticated, "認証状態が変更されたためProjectの確定を中止しました。"));
            }
        }

        let mut next = guard.metadata.clone();
        next.project_id = Some(trimmed.to_string());
        next.project_verified = false;
        next.project_source = Some(ProjectSource::UserSelected);
        next.auth_generation = next.auth_generation.saturating_add(1);
        save_metadata_atomic(&guard.metadata_path, &next)
            .map_err(|e| GoogleApiError::new(GoogleApiErrorKind::InvalidConfig, e))?;

        guard.metadata = next;
        guard.access_token_cache = None;
        guard.legacy_project_candidate = None;
        guard.last_error = None;
        Ok(Self::build_status_locked(&guard))
    }

    fn clear_local_auth_locked(
        &self,
        guard: &mut AuthManagerInner,
        fp: &str,
    ) -> Result<(), GoogleApiError> {
        let marker_path = logout_pending_marker_path(&guard.metadata_path);
        if let Some(parent) = marker_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        // Write-ahead persistent tombstone BEFORE touching metadata or credentials so a crash
        // at any subsequent step never allows startup to restore old auth.
        let marker_write_error = match fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&marker_path)
            .and_then(|mut f| {
                use std::io::Write;
                f.write_all(b"1")?;
                f.sync_all()
            }) {
            Ok(()) => None,
            Err(e) => Some(e.to_string()),
        };

        let mut next = AuthMetadata::empty(fp, guard.metadata.auth_generation.saturating_add(1));
        next.slots = [None, None];
        // Invalidate in-memory identity and outstanding snapshots immediately. Durable marker or
        // metadata state below controls restart recovery, not current-process API safety.
        guard.metadata = next.clone();
        guard.access_token_cache = None;
        guard.reauth_required = true;
        let commit_res = save_metadata_atomic(&guard.metadata_path, &next);
        let mut meta_remove_error: Option<String> = None;
        let mut metadata_removed = false;
        if commit_res.is_err() {
            if let Err(rm_err) = fs::remove_file(&guard.metadata_path) {
                if rm_err.kind() != std::io::ErrorKind::NotFound {
                    meta_remove_error = Some(rm_err.to_string());
                }
            } else {
                metadata_removed = true;
            }
        }

        // Do not touch credentials unless a durable tombstone or an inactive/deleted metadata
        // state prevents startup from restoring the old active slot.
        let recovery_protected = marker_write_error.is_none() || commit_res.is_ok() || metadata_removed;
        if !recovery_protected {
            let mut details = vec![format!(
                "logout-pendingマーカー書込失敗: {}",
                marker_write_error.as_deref().unwrap_or("不明なエラー")
            )];
            if let Err(ref e) = commit_res {
                details.push(format!("metadata保存失敗: {e}"));
            }
            if let Some(ref e) = meta_remove_error {
                details.push(format!("旧metadata削除失敗: {e}"));
            }
            let err = GoogleApiError::new(
                GoogleApiErrorKind::InvalidConfig,
                format!(
                    "ログアウトを安全に完了できませんでした。認証ファイルへ書き込めないため資格情報は変更していません（{}）。",
                    details.join("; ")
                ),
            );
            guard.access_token_cache = None;
            guard.reauth_required = true;
            guard.last_error = Some(err.clone());
            return Err(err);
        }

        if commit_res.is_err() && metadata_removed {
            guard.metadata = AuthMetadata::empty(fp, next.auth_generation);
        }
        guard.access_token_cache = None;
        guard.last_error = None;

        // Credentials may be deleted only after recovery is guaranteed by the marker or metadata.
        let mut cred_delete_errors = Vec::new();
        for slot in [0u8, 1u8] {
            let target = credential_target_name_for_channel(
                APP_IDENTIFIER,
                fp,
                slot,
                guard.config.build_channel,
            );
            if let Err(e) = self.cred_store.delete(&target) {
                cred_delete_errors.push(format!("slot {slot}: {e}"));
            }
        }

        if commit_res.is_err() || !cred_delete_errors.is_empty() {
            let mut details = Vec::new();
            if let Some(ref e) = marker_write_error {
                details.push(format!("logout-pendingマーカー書込失敗: {e}"));
            }
            if let Err(ref e) = commit_res {
                details.push(format!("metadata保存失敗: {e}"));
            }
            if let Some(ref e) = meta_remove_error {
                details.push(format!("旧metadata削除失敗: {e}"));
            }
            if !cred_delete_errors.is_empty() {
                details.push(format!(
                    "Credential Manager削除失敗: {}",
                    cred_delete_errors.join(", ")
                ));
            }
            let err = GoogleApiError::new(
                GoogleApiErrorKind::InvalidConfig,
                format!(
                    "ローカル認証情報を完全に消去できませんでした（{}）。",
                    details.join("; ")
                ),
            );
            guard.reauth_required = true;
            guard.last_error = Some(err.clone());
            return Err(err);
        }

        let _ = fs::remove_file(&marker_path);
        guard.reauth_required = false;
        Ok(())
    }

    pub async fn logout(&self) -> Result<GoogleAuthStatus, GoogleApiError> {
        let mut guard = self.inner.lock().await;
        // Invalidate and cancel any in-flight login so it cannot resurrect auth after logout.
        guard.login_epoch = guard.login_epoch.saturating_add(1);
        guard.login_in_flight = false;
        if let Some(tx) = guard.login_cancel_tx.take() {
            let _ = tx.send(());
        }

        let fp = guard.config.fingerprint();
        self.clear_local_auth_locked(&mut guard, &fp)?;

        Ok(Self::build_status_locked(&guard))
    }

    pub async fn revoke(&self) -> Result<GoogleAuthRevokeResult, GoogleApiError> {
        let (config, fingerprint, active_slot, active_sub) = {
            let mut guard = self.inner.lock().await;
            if guard.revoking {
                return Err(GoogleApiError::new(
                    GoogleApiErrorKind::InvalidConfig,
                    "すでにアクセス権の取り消し処理を実行中です。",
                ));
            }
            guard.revoking = true;
            // Immediately invalidate and cancel any in-flight login when revoke starts.
            guard.login_epoch = guard.login_epoch.saturating_add(1);
            guard.login_in_flight = false;
            if let Some(tx) = guard.login_cancel_tx.take() {
                let _ = tx.send(());
            }
            let fp = guard.config.fingerprint();
            let (slot, sub) = match guard.metadata.active_slot_meta() {
                Some((s, m)) => (Some(s), Some(m.sub.clone())),
                None => (None, None),
            };
            (guard.config.clone(), fp, slot, sub)
        };

        // Temporarily load refresh token in Rust only (if active slot exists)
        let refresh_token_opt = if let (Some(slot), Some(sub)) = (active_slot, active_sub) {
            let target = credential_target_name_for_channel(
                APP_IDENTIFIER,
                &fingerprint,
                slot,
                config.build_channel,
            );
            self.cred_store.load(&target).ok().flatten().and_then(|p| {
                if p.oauth_client_id_fingerprint == fingerprint
                    && p.sub == sub
                    && !p.refresh_token.is_empty()
                {
                    Some(p.refresh_token)
                } else {
                    None
                }
            })
        } else {
            None
        };

        let revoked_on_google = if let Some(rt) = refresh_token_opt {
            let form = url::form_urlencoded::Serializer::new(String::new())
                .append_pair("token", &rt)
                .finish();
            match self
                .transport
                .send(HttpRequest {
                    method: "POST".to_string(),
                    url: config.revoke_endpoint.clone(),
                    headers: vec![(
                        "Content-Type".to_string(),
                        "application/x-www-form-urlencoded".to_string(),
                    )],
                    body: Some(form),
                })
                .await
            {
                Ok(resp) => resp.status >= 200 && resp.status < 300,
                Err(_) => false,
            }
        } else {
            false
        };

        // Regardless of Google revoke outcome, atomically commit local logout + generation++ and always delete slots under lock
        let status = {
            let mut guard = self.inner.lock().await;
            guard.login_epoch = guard.login_epoch.saturating_add(1);
            guard.revoking = false;
            self.clear_local_auth_locked(&mut guard, &fingerprint)?;
            Self::build_status_locked(&guard)
        };

        let message = if revoked_on_google {
            "このPCからログアウトし、Google側のアクセス権も取り消しました。".to_string()
        } else {
            "このPCからはログアウトしました。Google側のアクセス権を取り消せたことは確認できませんでした。".to_string()
        };

        Ok(GoogleAuthRevokeResult {
            logged_out: true,
            revoked_on_google,
            message,
            status,
        })
    }
}

pub fn validate_project_id_format(pid: &str) -> Result<(), GoogleApiError> {
    if pid.is_empty() {
        return Err(GoogleApiError::new(
            GoogleApiErrorKind::InvalidConfig,
            "Project IDを入力してください",
        ));
    }
    let bytes = pid.as_bytes();
    let len = bytes.len();
    if !(6..=30).contains(&len) {
        return Err(GoogleApiError::new(
            GoogleApiErrorKind::InvalidConfig,
            "Project IDは6〜30文字で入力してください",
        ));
    }
    if !bytes[0].is_ascii_lowercase() {
        return Err(GoogleApiError::new(
            GoogleApiErrorKind::InvalidConfig,
            "Project IDは小文字英字で始まる必要があります",
        ));
    }
    if bytes[len - 1] == b'-' {
        return Err(GoogleApiError::new(
            GoogleApiErrorKind::InvalidConfig,
            "Project IDはハイフンで終わってはいけません",
        ));
    }
    for &b in bytes {
        if !b.is_ascii_lowercase() && !b.is_ascii_digit() && b != b'-' {
            return Err(GoogleApiError::new(
                GoogleApiErrorKind::InvalidConfig,
                "Project IDは小文字英字、数字、ハイフンのみ使用できます",
            ));
        }
    }
    Ok(())
}

async fn wait_for_loopback_callback(
    listener: TcpListener,
    timeout: Duration,
    mut cancel_rx: oneshot::Receiver<()>,
) -> Result<LoopbackCallbackOutcome, GoogleApiError> {
    let accept_fut = async {
        loop {
            let (mut stream, _) = listener.accept().await.map_err(|e| {
                GoogleApiError::new(
                    GoogleApiErrorKind::NetworkError,
                    format!("OAuthコールバック受信に失敗しました: {}", e),
                )
            })?;

            let mut buf = [0u8; 4096];
            let n = stream.read(&mut buf).await.unwrap_or(0);
            if n == 0 {
                continue;
            }
            let req_str = String::from_utf8_lossy(&buf[..n]);
            let first_line = req_str.lines().next().unwrap_or("");
            if first_line.starts_with("GET /favicon.ico") {
                let _ = stream
                    .write_all(b"HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n")
                    .await;
                continue;
            }

            let parsed = parse_loopback_request_line(first_line);
            let html = match &parsed {
                Ok(LoopbackCallbackOutcome::Code { .. }) => {
                    "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>ASR Composer</title></head><body><h2>認証が完了しました</h2><p>このタブを閉じて ASR Composer へ戻ってください。</p></body></html>"
                }
                _ => {
                    "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>ASR Composer</title></head><body><h2>認証を完了できませんでした</h2><p>ASR Composer へ戻って詳細を確認してください。</p></body></html>"
                }
            };
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                html.len(),
                html
            );
            let _ = stream.write_all(response.as_bytes()).await;
            let _ = stream.shutdown().await;
            return parsed;
        }
    };

    tokio::select! {
        res = accept_fut => res,
        _ = tokio::time::sleep(timeout) => Err(GoogleApiError::new(
            GoogleApiErrorKind::OauthCallbackTimeout,
            "Googleログインの応答がタイムアウトしました。もう一度お試しください。",
        )),
        _ = &mut cancel_rx => Err(GoogleApiError::new(
            GoogleApiErrorKind::OauthUserCancelled,
            "Googleログインがキャンセルされました。",
        )),
    }
}
