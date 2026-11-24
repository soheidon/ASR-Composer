use crate::google_oauth::{
    GoogleApiError, GoogleApiErrorKind, GoogleAuthManager, GoogleAuthSnapshot, GoogleAuthStatus,
    GoogleHttpTransport, GoogleOnboardingSnapshot, HttpRequest, OnboardingAcquireOutcome,
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

pub const CLOUD_RESOURCE_MANAGER_SEARCH_URL: &str =
    "https://cloudresourcemanager.googleapis.com/v3/projects:search";
pub const SERVICE_USAGE_BASE_URL: &str = "https://serviceusage.googleapis.com/v1";
pub const ALLOWED_ENABLE_SERVICE_NAME: &str = "speech.googleapis.com";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SpeechApiEnableStateResult {
    pub project_id: String,
    pub service_name: String,
    pub state: String,
    pub auth_generation: u64,
    pub sub: String,
    pub oauth_client_id_fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EnableSpeechApiResult {
    pub project_id: String,
    pub service_name: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_name: Option<String>,
    pub auth_generation: u64,
    pub sub: String,
    pub oauth_client_id_fingerprint: String,
}

pub fn validate_allowed_enable_service(service_name: &str) -> Result<(), GoogleApiError> {
    if service_name.trim() == ALLOWED_ENABLE_SERVICE_NAME {
        Ok(())
    } else {
        Err(GoogleApiError::new(
            GoogleApiErrorKind::InvalidConfig,
            "アプリから有効化できるAPIは speech.googleapis.com のみです。",
        ))
    }
}

pub fn normalize_consumer_project(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let normalized = trimmed.strip_prefix("projects/").unwrap_or(trimmed).trim();
    if normalized.is_empty() {
        None
    } else {
        Some(normalized.to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GoogleCloudProject {
    pub project_id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleCloudListProjectsResult {
    pub projects: Vec<GoogleCloudProject>,
    pub auth_generation: u64,
    pub sub: String,
    pub oauth_client_id_fingerprint: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GoogleOnboardingOutcome {
    Ready,
    AlreadyReadyUserProject,
    NeedsApiEnableConsent,
    ProjectAccessDenied,
    ReauthRequired,
    WorkspaceDenied,
    BillingOrQuotaError,
    NetworkOrTimeout,
    ConfigurationError,
    CancelledOrStale,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleOnboardingResult {
    pub outcome: GoogleOnboardingOutcome,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required_permission: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_service: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub consumer_project: Option<String>,
    pub auth_generation: u64,
    pub auth_session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sub: Option<String>,
    pub oauth_client_id_fingerprint: String,
    pub status: GoogleAuthStatus,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteOnboardingRequest {
    #[serde(default)]
    pub enable_speech_api_if_needed: bool,
    #[serde(default)]
    pub expected_auth_session_id: Option<String>,
    #[serde(default)]
    pub expected_auth_generation: Option<u64>,
    #[serde(default)]
    pub expected_sub: Option<String>,
    #[serde(default)]
    pub expected_oauth_client_id_fingerprint: Option<String>,
    #[serde(default)]
    pub expected_project_id: Option<String>,
}

enum CloudSessionSnapshot {
    Regular(GoogleAuthSnapshot),
    Onboarding(GoogleOnboardingSnapshot),
}

impl CloudSessionSnapshot {
    fn project_id(&self) -> Option<&str> {
        match self {
            Self::Regular(s) => s.project_id.as_deref(),
            Self::Onboarding(s) => Some(s.project_id.as_str()),
        }
    }

    fn access_token(&self) -> &str {
        match self {
            Self::Regular(s) => &s.access_token,
            Self::Onboarding(s) => &s.access_token,
        }
    }

    fn auth_generation(&self) -> u64 {
        match self {
            Self::Regular(s) => s.auth_generation,
            Self::Onboarding(s) => s.auth_generation,
        }
    }

    fn sub(&self) -> &str {
        match self {
            Self::Regular(s) => &s.sub,
            Self::Onboarding(s) => &s.sub,
        }
    }

    fn fingerprint(&self) -> &str {
        match self {
            Self::Regular(s) => &s.oauth_client_id_fingerprint,
            Self::Onboarding(s) => &s.oauth_client_id_fingerprint,
        }
    }

    async fn is_current<T: GoogleHttpTransport>(&self, auth: &GoogleAuthManager<T>) -> bool {
        match self {
            Self::Regular(s) => auth.is_snapshot_current(s).await,
            Self::Onboarding(s) => auth.is_onboarding_snapshot_current(s).await,
        }
    }

    async fn force_refresh<T: GoogleHttpTransport>(
        self,
        auth: &GoogleAuthManager<T>,
    ) -> Result<Self, GoogleApiError> {
        match self {
            Self::Regular(s) => Ok(Self::Regular(auth.force_refresh_snapshot(&s).await?)),
            Self::Onboarding(s) => Ok(Self::Onboarding(
                auth.refresh_onboarding_snapshot_if_current(&s).await?,
            )),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleSpeechWordInfo {
    pub word: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_offset: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_offset: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleSpeechSegment {
    pub transcript: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_offset: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_offset: Option<String>,
    pub words: Vec<GoogleSpeechWordInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleSpeechRecognizeResult {
    pub transcript: String,
    pub segments: Vec<GoogleSpeechSegment>,
    pub raw_response: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_generation: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sub: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oauth_client_id_fingerprint: Option<String>,
}

#[derive(Deserialize)]
struct RawProjectSearchResponse {
    #[serde(default)]
    projects: Vec<RawCloudProject>,
    #[serde(rename = "nextPageToken")]
    next_page_token: Option<String>,
}

#[derive(Deserialize)]
struct RawCloudProject {
    #[serde(rename = "projectId")]
    project_id: Option<String>,
    #[serde(rename = "displayName")]
    display_name: Option<String>,
    name: Option<String>,
    state: Option<String>,
}

struct ParsedGoogleErrorDetails {
    api_status: Option<String>,
    api_message: String,
    primary_reason: Option<String>,
    target_service: Option<String>,
    consumer_project: Option<String>,
}

fn parse_google_error_details(body: &str) -> ParsedGoogleErrorDetails {
    let parsed: Option<serde_json::Value> = serde_json::from_str(body).ok();
    let err_obj = parsed.as_ref().and_then(|v| v.get("error"));

    let api_status = err_obj
        .and_then(|e| e.get("status"))
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let api_message = err_obj
        .and_then(|e| e.get("message"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .unwrap_or_default();

    let mut reasons: Vec<String> = Vec::new();
    let mut target_service: Option<String> = None;
    let mut consumer_project: Option<String> = None;

    if let Some(details) = err_obj.and_then(|e| e.get("details")).and_then(|v| v.as_array()) {
        for d in details {
            if let Some(r) = d.get("reason").and_then(|v| v.as_str()) {
                reasons.push(r.to_string());
            }
            if target_service.is_none() {
                target_service = d
                    .get("metadata")
                    .and_then(|m| m.get("service"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty());
            }
            if consumer_project.is_none() {
                consumer_project = d
                    .get("metadata")
                    .and_then(|m| m.get("consumer"))
                    .and_then(|v| v.as_str())
                    .and_then(normalize_consumer_project);
            }
        }
    }

    ParsedGoogleErrorDetails {
        api_status,
        api_message,
        primary_reason: reasons.first().cloned(),
        target_service,
        consumer_project,
    }
}

pub fn classify_google_cloud_api_error(
    status: u16,
    body: &str,
    is_project_list: bool,
) -> GoogleApiError {
    let details = parse_google_error_details(body);
    let reason_upper = details.primary_reason.as_deref().unwrap_or("").to_ascii_uppercase();
    let status_upper = details.api_status.as_deref().unwrap_or("").to_ascii_uppercase();
    let msg_lower = details.api_message.to_ascii_lowercase();

    let kind = if is_project_list {
        if reason_upper == "ACCESS_TOKEN_SCOPE_INSUFFICIENT" || reason_upper == "INSUFFICIENT_SCOPES"
        {
            GoogleApiErrorKind::OauthScopeNotGranted
        } else if reason_upper == "ADMIN_POLICY_ENFORCED"
            || msg_lower.contains("admin_policy_enforced")
        {
            GoogleApiErrorKind::OauthAdminPolicyEnforced
        } else if status == 403 || status_upper == "PERMISSION_DENIED" {
            GoogleApiErrorKind::ProjectListPermissionDenied
        } else if status == 429 || status_upper == "RESOURCE_EXHAUSTED" {
            GoogleApiErrorKind::QuotaOrResourceExhausted
        } else {
            GoogleApiErrorKind::HttpError
        }
    } else if (reason_upper == "SERVICE_DISABLED" || reason_upper == "API_DISABLED")
        && details
            .target_service
            .as_deref()
            .map(|s| s == ALLOWED_ENABLE_SERVICE_NAME)
            .unwrap_or(true)
    {
        GoogleApiErrorKind::SpeechApiDisabled
    } else if reason_upper == "ACCESS_TOKEN_SCOPE_INSUFFICIENT"
        || reason_upper == "INSUFFICIENT_SCOPES"
    {
        GoogleApiErrorKind::OauthScopeNotGranted
    } else if reason_upper == "ADMIN_POLICY_ENFORCED" || msg_lower.contains("admin_policy_enforced")
    {
        GoogleApiErrorKind::OauthAdminPolicyEnforced
    } else if reason_upper == "BILLING_DISABLED" {
        GoogleApiErrorKind::BillingDisabled
    } else if status == 429
        || status_upper == "RESOURCE_EXHAUSTED"
        || reason_upper == "RATE_LIMIT_EXCEEDED"
    {
        GoogleApiErrorKind::QuotaOrResourceExhausted
    } else if status == 404 || status_upper == "NOT_FOUND" {
        if msg_lower.contains("recognizer") {
            GoogleApiErrorKind::RecognizerNotFound
        } else if msg_lower.contains("project") {
            GoogleApiErrorKind::ProjectNotAccessible
        } else {
            GoogleApiErrorKind::HttpError
        }
    } else if status == 403 || status_upper == "PERMISSION_DENIED" {
        if msg_lower.contains("recognizer") || msg_lower.contains("speech.recognizers") {
            GoogleApiErrorKind::RecognizerPermissionDenied
        } else if msg_lower.contains("project") && !msg_lower.contains("speech") {
            GoogleApiErrorKind::ProjectNotAccessible
        } else {
            GoogleApiErrorKind::SpeechPermissionDenied
        }
    } else {
        GoogleApiErrorKind::HttpError
    };

    let safe_message = if !details.api_message.is_empty() {
        format!("Google APIエラー ({}): {}", status, details.api_message)
    } else {
        format!("Google APIエラー (HTTP {})", status)
    };

    GoogleApiError {
        kind,
        message: safe_message,
        http_status: Some(status),
        api_status: details.api_status,
        reason: details.primary_reason,
        target_service: details.target_service,
        consumer_project: details.consumer_project,
        auth_generation: None,
        sub: None,
        oauth_client_id_fingerprint: None,
    }
}

pub fn classify_service_usage_error(
    status: u16,
    body: &str,
    expected_project_id: &str,
) -> GoogleApiError {
    let details = parse_google_error_details(body);
    let reason_upper = details.primary_reason.as_deref().unwrap_or("").to_ascii_uppercase();
    let status_upper = details.api_status.as_deref().unwrap_or("").to_ascii_uppercase();
    let msg_lower = details.api_message.to_ascii_lowercase();

    let (kind, message) = if reason_upper == "ACCESS_TOKEN_SCOPE_INSUFFICIENT"
        || reason_upper == "INSUFFICIENT_SCOPES"
    {
        (
            GoogleApiErrorKind::OauthScopeNotGranted,
            "Googleアカウントの認証スコープが不足しています。再ログインして権限を許可してください。"
                .to_string(),
        )
    } else if reason_upper == "ADMIN_POLICY_ENFORCED" || msg_lower.contains("admin_policy_enforced")
    {
        (
            GoogleApiErrorKind::OauthAdminPolicyEnforced,
            format!(
                "Workspace管理ポリシーにより、Project `{}` でのAPI操作が制限されています。",
                expected_project_id
            ),
        )
    } else if (reason_upper == "SERVICE_DISABLED" || reason_upper == "API_DISABLED")
        && details.target_service.as_deref() != Some(ALLOWED_ENABLE_SERVICE_NAME)
    {
        (
            GoogleApiErrorKind::ServiceUsageApiDisabled,
            format!(
                "Project `{}` では Service Usage API (serviceusage.googleapis.com) が無効のため、アプリからAPI状態確認・有効化を実行できません。",
                expected_project_id
            ),
        )
    } else if status == 403 || status_upper == "PERMISSION_DENIED" {
        (
            GoogleApiErrorKind::ServiceUsagePermissionDenied,
            format!(
                "Project `{}` で Speech-to-Text API を確認・有効化する権限（serviceusage.services.enable）が不足しています。",
                expected_project_id
            ),
        )
    } else if status == 429 || status_upper == "RESOURCE_EXHAUSTED" {
        (
            GoogleApiErrorKind::QuotaOrResourceExhausted,
            "Service Usage API のリクエスト上限に達しました。しばらく待ってから再試行してください。"
                .to_string(),
        )
    } else {
        (
            GoogleApiErrorKind::HttpError,
            format!("Service Usage API 呼び出しに失敗しました (HTTP {})", status),
        )
    };

    GoogleApiError {
        kind,
        message,
        http_status: Some(status),
        api_status: details.api_status,
        reason: details.primary_reason,
        target_service: details.target_service,
        consumer_project: details.consumer_project,
        auth_generation: None,
        sub: None,
        oauth_client_id_fingerprint: None,
    }
}

pub async fn list_projects_with_auth<T: GoogleHttpTransport>(
    auth: &GoogleAuthManager<T>,
    transport: &T,
    search_base_url: Option<&str>,
) -> Result<GoogleCloudListProjectsResult, GoogleApiError> {
    let mut snapshot = auth.acquire_snapshot(false).await?;
    let base_url = search_base_url.unwrap_or(CLOUD_RESOURCE_MANAGER_SEARCH_URL);

    let mut all_projects: Vec<GoogleCloudProject> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut page_token: Option<String> = None;
    let mut retried_after_401 = false;

    loop {
        if !auth.is_snapshot_current(&snapshot).await {
            return Err(GoogleApiError::new(
                GoogleApiErrorKind::NotAuthenticated,
                "アカウントまたは設定が変更されたためプロジェクト一覧取得を中止しました。",
            )
            .with_snapshot_meta(
                snapshot.auth_generation,
                &snapshot.sub,
                &snapshot.oauth_client_id_fingerprint,
            ));
        }

        let mut url = url::Url::parse(base_url).map_err(|_| {
            GoogleApiError::new(
                GoogleApiErrorKind::InvalidConfig,
                "Cloud Resource Manager URLが不正です。",
            )
        })?;
        {
            let mut qp = url.query_pairs_mut();
            qp.append_pair("query", "state:ACTIVE");
            if let Some(ref pt) = page_token {
                qp.append_pair("pageToken", pt);
            }
        }

        let resp = transport
            .send(HttpRequest {
                method: "GET".to_string(),
                url: url.to_string(),
                headers: vec![(
                    "Authorization".to_string(),
                    format!("Bearer {}", snapshot.access_token),
                )],
                body: None,
            })
            .await
            .map_err(|e| {
                GoogleApiError::new(
                    GoogleApiErrorKind::NetworkError,
                    format!("プロジェクト一覧取得の通信に失敗しました: {}", e),
                )
                .with_snapshot_meta(
                    snapshot.auth_generation,
                    &snapshot.sub,
                    &snapshot.oauth_client_id_fingerprint,
                )
            })?;

        if resp.status == 401 && !retried_after_401 {
            retried_after_401 = true;
            snapshot = auth.force_refresh_snapshot(&snapshot).await?;
            continue;
        }

        if resp.status < 200 || resp.status >= 300 {
            return Err(
                classify_google_cloud_api_error(resp.status, &resp.body, true).with_snapshot_meta(
                    snapshot.auth_generation,
                    &snapshot.sub,
                    &snapshot.oauth_client_id_fingerprint,
                ),
            );
        }

        let parsed: RawProjectSearchResponse = serde_json::from_str(&resp.body).map_err(|e| {
            GoogleApiError::new(
                GoogleApiErrorKind::HttpError,
                format!("プロジェクト一覧応答の解析に失敗しました: {}", e),
            )
            .with_snapshot_meta(
                snapshot.auth_generation,
                &snapshot.sub,
                &snapshot.oauth_client_id_fingerprint,
            )
        })?;

        for p in parsed.projects {
            if let Some(ref st) = p.state {
                if st != "ACTIVE" {
                    continue;
                }
            }
            let Some(pid) = p.project_id.filter(|s| !s.trim().is_empty()) else {
                continue;
            };
            if !seen.insert(pid.clone()) {
                continue;
            }
            let display = p
                .display_name
                .or(p.name)
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| pid.clone());
            all_projects.push(GoogleCloudProject {
                project_id: pid,
                name: display,
            });
        }

        match parsed.next_page_token {
            Some(tok) if !tok.is_empty() => page_token = Some(tok),
            _ => break,
        }
    }

    if !auth.is_snapshot_current(&snapshot).await {
        return Err(GoogleApiError::new(
            GoogleApiErrorKind::NotAuthenticated,
            "アカウントまたは設定が変更されたため古いプロジェクト一覧を破棄しました。",
        )
        .with_snapshot_meta(
            snapshot.auth_generation,
            &snapshot.sub,
            &snapshot.oauth_client_id_fingerprint,
        ));
    }

    all_projects.sort_by(|a, b| a.project_id.cmp(&b.project_id));
    Ok(GoogleCloudListProjectsResult {
        projects: all_projects,
        auth_generation: snapshot.auth_generation,
        sub: snapshot.sub,
        oauth_client_id_fingerprint: snapshot.oauth_client_id_fingerprint,
    })
}

pub async fn execute_speech_v2_recognize_with_snapshot<T: GoogleHttpTransport, U, F>(
    auth: &GoogleAuthManager<T>,
    transport: &T,
    expected_project_id: Option<&str>,
    build_url: U,
    request_body: &serde_json::Value,
    parse_fn: F,
    mark_verified_on_success: bool,
) -> Result<GoogleSpeechRecognizeResult, GoogleApiError>
where
    U: Fn(&str) -> String,
    F: Fn(&serde_json::Value) -> Result<GoogleSpeechRecognizeResult, GoogleApiError>,
{
    let snapshot = auth.acquire_snapshot(true).await?;
    let snapshot_project = snapshot.project_id.clone().ok_or_else(|| {
        GoogleApiError::new(
            GoogleApiErrorKind::InvalidConfig,
            "Google Cloud プロジェクトIDが設定されていません。",
        )
    })?;

    if let Some(expected) = expected_project_id {
        if !expected.trim().is_empty() && expected.trim() != snapshot_project {
            return Err(GoogleApiError::new(
                GoogleApiErrorKind::InvalidConfig,
                "選択中のGoogle Cloud プロジェクトIDが現在の認証状態と一致しません。",
            )
            .with_snapshot_meta(
                snapshot.auth_generation,
                &snapshot.sub,
                &snapshot.oauth_client_id_fingerprint,
            ));
        }
    }

    execute_speech_v2_recognize_session(
        auth,
        transport,
        CloudSessionSnapshot::Regular(snapshot),
        build_url,
        request_body,
        parse_fn,
        mark_verified_on_success,
    )
    .await
    .map(|(res, _)| res)
}

async fn execute_speech_v2_recognize_session<T: GoogleHttpTransport, U, F>(
    auth: &GoogleAuthManager<T>,
    transport: &T,
    mut session: CloudSessionSnapshot,
    build_url: U,
    request_body: &serde_json::Value,
    parse_fn: F,
    mark_verified_on_success: bool,
) -> Result<(GoogleSpeechRecognizeResult, CloudSessionSnapshot), GoogleApiError>
where
    U: Fn(&str) -> String,
    F: Fn(&serde_json::Value) -> Result<GoogleSpeechRecognizeResult, GoogleApiError>,
{
    let snapshot_project = session
        .project_id()
        .map(str::to_string)
        .ok_or_else(|| {
            GoogleApiError::new(
                GoogleApiErrorKind::InvalidConfig,
                "Google Cloud プロジェクトIDが設定されていません。",
            )
        })?;

    let url = build_url(&snapshot_project);

    let body_str = serde_json::to_string(request_body).map_err(|e| {
        GoogleApiError::new(
            GoogleApiErrorKind::InvalidConfig,
            format!("リクエストJSON構築に失敗しました: {}", e),
        )
    })?;

    let mut retried_after_401 = false;
    let resp = loop {
        if !session.is_current(auth).await {
            return Err(GoogleApiError::new(
                GoogleApiErrorKind::NotAuthenticated,
                "認証状態が変更されたため音声認識を中止しました。",
            )
            .with_snapshot_meta(
                session.auth_generation(),
                session.sub(),
                session.fingerprint(),
            ));
        }

        let r = transport
            .send(HttpRequest {
                method: "POST".to_string(),
                url: url.to_string(),
                headers: vec![
                    (
                        "Authorization".to_string(),
                        format!("Bearer {}", session.access_token()),
                    ),
                    ("x-goog-user-project".to_string(), snapshot_project.clone()),
                    ("Content-Type".to_string(), "application/json".to_string()),
                ],
                body: Some(body_str.clone()),
            })
            .await
            .map_err(|e| {
                GoogleApiError::new(
                    GoogleApiErrorKind::NetworkError,
                    format!("Speech-to-Text API通信に失敗しました: {}", e),
                )
                .with_snapshot_meta(
                    session.auth_generation(),
                    session.sub(),
                    session.fingerprint(),
                )
            })?;

        if r.status == 401 && !retried_after_401 {
            retried_after_401 = true;
            session = session.force_refresh(auth).await?;
            continue;
        }
        break r;
    };

    if resp.status < 200 || resp.status >= 300 {
        return Err(
            classify_google_cloud_api_error(resp.status, &resp.body, false).with_snapshot_meta(
                session.auth_generation(),
                session.sub(),
                session.fingerprint(),
            ),
        );
    }

    if !session.is_current(auth).await {
        return Err(GoogleApiError::new(
            GoogleApiErrorKind::NotAuthenticated,
            "認証状態が変更されたため古い認識結果を破棄しました。",
        )
        .with_snapshot_meta(
            session.auth_generation(),
            session.sub(),
            session.fingerprint(),
        ));
    }

    let json: serde_json::Value = serde_json::from_str(&resp.body).map_err(|e| {
        GoogleApiError::new(
            GoogleApiErrorKind::HttpError,
            format!("Speech-to-Text応答JSONの解析に失敗しました: {}", e),
        )
        .with_snapshot_meta(
            session.auth_generation(),
            session.sub(),
            session.fingerprint(),
        )
    })?;

    let mut result = parse_fn(&json)?;
    if mark_verified_on_success {
        if let CloudSessionSnapshot::Regular(ref regular) = session {
            auth.mark_project_verified_if_current(regular).await?;
        }
    }
    result.auth_generation = Some(session.auth_generation());
    result.sub = Some(session.sub().to_string());
    result.oauth_client_id_fingerprint = Some(session.fingerprint().to_string());
    Ok((result, session))
}

#[derive(Deserialize)]
struct RawServiceUsageGetResponse {
    state: Option<String>,
}

#[derive(Deserialize)]
struct RawServiceUsageOperation {
    name: Option<String>,
    done: Option<bool>,
    error: Option<serde_json::Value>,
}

async fn acquire_snapshot_for_project<T: GoogleHttpTransport>(
    auth: &GoogleAuthManager<T>,
    expected_project_id: Option<&str>,
) -> Result<(crate::google_oauth::GoogleAuthSnapshot, String), GoogleApiError> {
    let snapshot = auth.acquire_snapshot(true).await?;
    let snapshot_project = snapshot.project_id.clone().ok_or_else(|| {
        GoogleApiError::new(
            GoogleApiErrorKind::InvalidConfig,
            "Google Cloud プロジェクトIDが設定されていません。",
        )
    })?;
    if let Some(expected) = expected_project_id {
        if !expected.trim().is_empty() && expected.trim() != snapshot_project {
            return Err(GoogleApiError::new(
                GoogleApiErrorKind::InvalidConfig,
                "選択中のGoogle Cloud プロジェクトIDが現在の認証状態と一致しません。",
            )
            .with_snapshot_meta(
                snapshot.auth_generation,
                &snapshot.sub,
                &snapshot.oauth_client_id_fingerprint,
            ));
        }
    }
    Ok((snapshot, snapshot_project))
}

pub async fn check_speech_api_state_with_auth<T: GoogleHttpTransport>(
    auth: &GoogleAuthManager<T>,
    transport: &T,
    expected_project_id: Option<&str>,
    service_usage_base_url: Option<&str>,
) -> Result<SpeechApiEnableStateResult, GoogleApiError> {
    let (mut snapshot, snapshot_project) =
        acquire_snapshot_for_project(auth, expected_project_id).await?;
    let base = service_usage_base_url
        .unwrap_or(SERVICE_USAGE_BASE_URL)
        .trim_end_matches('/');
    let url = format!(
        "{}/projects/{}/services/{}",
        base, snapshot_project, ALLOWED_ENABLE_SERVICE_NAME
    );

    let mut retried_after_401 = false;
    let resp = loop {
        if !auth.is_snapshot_current(&snapshot).await {
            return Err(GoogleApiError::new(
                GoogleApiErrorKind::NotAuthenticated,
                "認証状態またはProjectが変更されたためAPI状態確認を中止しました。",
            )
            .with_snapshot_meta(
                snapshot.auth_generation,
                &snapshot.sub,
                &snapshot.oauth_client_id_fingerprint,
            ));
        }
        let r = transport
            .send(HttpRequest {
                method: "GET".to_string(),
                url: url.clone(),
                headers: vec![(
                    "Authorization".to_string(),
                    format!("Bearer {}", snapshot.access_token),
                )],
                body: None,
            })
            .await
            .map_err(|_| {
                GoogleApiError::new(
                    GoogleApiErrorKind::NetworkError,
                    "Service Usage API との通信に失敗しました。ネットワーク接続を確認してください。",
                )
                .with_snapshot_meta(
                    snapshot.auth_generation,
                    &snapshot.sub,
                    &snapshot.oauth_client_id_fingerprint,
                )
            })?;
        if r.status == 401 && !retried_after_401 {
            retried_after_401 = true;
            snapshot = auth.force_refresh_snapshot(&snapshot).await?;
            continue;
        }
        break r;
    };

    if resp.status < 200 || resp.status >= 300 {
        return Err(
            classify_service_usage_error(resp.status, &resp.body, &snapshot_project)
                .with_snapshot_meta(
                    snapshot.auth_generation,
                    &snapshot.sub,
                    &snapshot.oauth_client_id_fingerprint,
                ),
        );
    }

    if !auth.is_snapshot_current(&snapshot).await {
        return Err(GoogleApiError::new(
            GoogleApiErrorKind::NotAuthenticated,
            "認証状態またはProjectが変更されたため古いAPI状態結果を破棄しました。",
        )
        .with_snapshot_meta(
            snapshot.auth_generation,
            &snapshot.sub,
            &snapshot.oauth_client_id_fingerprint,
        ));
    }

    let parsed: RawServiceUsageGetResponse = serde_json::from_str(&resp.body).map_err(|_| {
        GoogleApiError::new(
            GoogleApiErrorKind::HttpError,
            "Service Usage API 応答の解析に失敗しました。",
        )
        .with_snapshot_meta(
            snapshot.auth_generation,
            &snapshot.sub,
            &snapshot.oauth_client_id_fingerprint,
        )
    })?;

    let state = parsed
        .state
        .unwrap_or_else(|| "STATE_UNSPECIFIED".to_string())
        .to_ascii_uppercase();

    Ok(SpeechApiEnableStateResult {
        project_id: snapshot_project,
        service_name: ALLOWED_ENABLE_SERVICE_NAME.to_string(),
        state,
        auth_generation: snapshot.auth_generation,
        sub: snapshot.sub,
        oauth_client_id_fingerprint: snapshot.oauth_client_id_fingerprint,
    })
}

pub async fn enable_speech_api_with_auth<T: GoogleHttpTransport>(
    auth: &GoogleAuthManager<T>,
    transport: &T,
    expected_project_id: Option<&str>,
    confirmed_by_user: bool,
    service_usage_base_url: Option<&str>,
    poll_interval: std::time::Duration,
    max_polls: usize,
) -> Result<EnableSpeechApiResult, GoogleApiError> {
    if !confirmed_by_user {
        return Err(GoogleApiError::new(
            GoogleApiErrorKind::InvalidConfig,
            "Speech-to-Text API の有効化には利用者の明示的な同意が必要です。",
        ));
    }
    validate_allowed_enable_service(ALLOWED_ENABLE_SERVICE_NAME)?;

    let (snapshot, _) = acquire_snapshot_for_project(auth, expected_project_id).await?;
    enable_speech_api_session(
        auth,
        transport,
        CloudSessionSnapshot::Regular(snapshot),
        service_usage_base_url,
        poll_interval,
        max_polls,
    )
    .await
    .map(|(res, _)| res)
}

async fn enable_speech_api_session<T: GoogleHttpTransport>(
    auth: &GoogleAuthManager<T>,
    transport: &T,
    mut session: CloudSessionSnapshot,
    service_usage_base_url: Option<&str>,
    poll_interval: std::time::Duration,
    max_polls: usize,
) -> Result<(EnableSpeechApiResult, CloudSessionSnapshot), GoogleApiError> {
    let snapshot_project = session
        .project_id()
        .map(str::to_string)
        .ok_or_else(|| {
            GoogleApiError::new(
                GoogleApiErrorKind::InvalidConfig,
                "Google Cloud プロジェクトIDが設定されていません。",
            )
        })?;
    let base = service_usage_base_url
        .unwrap_or(SERVICE_USAGE_BASE_URL)
        .trim_end_matches('/');
    let enable_url = format!(
        "{}/projects/{}/services/{}:enable",
        base, snapshot_project, ALLOWED_ENABLE_SERVICE_NAME
    );

    let mut retried_after_401 = false;
    let enable_resp = loop {
        if !session.is_current(auth).await {
            return Err(GoogleApiError::new(
                GoogleApiErrorKind::NotAuthenticated,
                "認証状態またはProjectが変更されたためAPI有効化を中止しました。",
            )
            .with_snapshot_meta(
                session.auth_generation(),
                session.sub(),
                session.fingerprint(),
            ));
        }

        let r = transport
            .send(HttpRequest {
                method: "POST".to_string(),
                url: enable_url.clone(),
                headers: vec![
                    (
                        "Authorization".to_string(),
                        format!("Bearer {}", session.access_token()),
                    ),
                    ("Content-Type".to_string(), "application/json".to_string()),
                ],
                body: Some("{}".to_string()),
            })
            .await
            .map_err(|_| {
                GoogleApiError::new(
                    GoogleApiErrorKind::NetworkError,
                    "Speech-to-Text API 有効化要求の通信に失敗しました。",
                )
                .with_snapshot_meta(
                    session.auth_generation(),
                    session.sub(),
                    session.fingerprint(),
                )
            })?;

        if r.status == 401 && !retried_after_401 {
            retried_after_401 = true;
            session = session.force_refresh(auth).await?;
            continue;
        }
        break r;
    };

    if enable_resp.status < 200 || enable_resp.status >= 300 {
        return Err(
            classify_service_usage_error(enable_resp.status, &enable_resp.body, &snapshot_project)
                .with_snapshot_meta(
                    session.auth_generation(),
                    session.sub(),
                    session.fingerprint(),
                ),
        );
    }

    let mut op: RawServiceUsageOperation =
        serde_json::from_str(&enable_resp.body).map_err(|_| {
            GoogleApiError::new(
                GoogleApiErrorKind::ServiceUsageOperationFailed,
                "API有効化 Operation 応答の解析に失敗しました。",
            )
            .with_snapshot_meta(
                session.auth_generation(),
                session.sub(),
                session.fingerprint(),
            )
        })?;

    if op.done != Some(true) {
        let Some(op_name) = op.name.clone().filter(|s| !s.trim().is_empty()) else {
            return Err(GoogleApiError::new(
                GoogleApiErrorKind::ServiceUsageOperationTimeout,
                format!(
                    "Project `{}` への有効化要求を送信しましたが完了を確認できませんでした。状態を再確認してください。",
                    snapshot_project
                ),
            )
            .with_snapshot_meta(
                session.auth_generation(),
                session.sub(),
                session.fingerprint(),
            ));
        };

        let op_url = format!("{}/{}", base, op_name.trim_start_matches('/'));
        let mut completed = false;
        for _ in 0..max_polls {
            if !poll_interval.is_zero() {
                tokio::time::sleep(poll_interval).await;
            }
            if !session.is_current(auth).await {
                return Err(GoogleApiError::new(
                    GoogleApiErrorKind::NotAuthenticated,
                    format!(
                        "アカウントまたはProjectが変更されたため、Project `{}` の有効化待機を中断しました（Google側では変更が完了している場合があります）。",
                        snapshot_project
                    ),
                )
                .with_snapshot_meta(
                    session.auth_generation(),
                    session.sub(),
                    session.fingerprint(),
                ));
            }

            let mut poll_resp = transport
                .send(HttpRequest {
                    method: "GET".to_string(),
                    url: op_url.clone(),
                    headers: vec![(
                        "Authorization".to_string(),
                        format!("Bearer {}", session.access_token()),
                    )],
                    body: None,
                })
                .await
                .map_err(|_| {
                    GoogleApiError::new(
                        GoogleApiErrorKind::ServiceUsageOperationTimeout,
                        format!(
                            "Project `{}` のAPI有効化状態の確認中に通信が失敗しました。状態を再確認してください。",
                            snapshot_project
                        ),
                    )
                    .with_snapshot_meta(
                        session.auth_generation(),
                        session.sub(),
                        session.fingerprint(),
                    )
                })?;

            if poll_resp.status == 401 {
                session = session.force_refresh(auth).await?;
                poll_resp = transport
                    .send(HttpRequest {
                        method: "GET".to_string(),
                        url: op_url.clone(),
                        headers: vec![(
                            "Authorization".to_string(),
                            format!("Bearer {}", session.access_token()),
                        )],
                        body: None,
                    })
                    .await
                    .map_err(|_| {
                        GoogleApiError::new(
                            GoogleApiErrorKind::ServiceUsageOperationTimeout,
                            format!(
                                "Project `{}` のAPI有効化状態の確認中に通信が失敗しました。状態を再確認してください。",
                                snapshot_project
                            ),
                        )
                        .with_snapshot_meta(
                            session.auth_generation(),
                            session.sub(),
                            session.fingerprint(),
                        )
                    })?;
            }

            if poll_resp.status < 200 || poll_resp.status >= 300 {
                return Err(classify_service_usage_error(
                    poll_resp.status,
                    &poll_resp.body,
                    &snapshot_project,
                )
                .with_snapshot_meta(
                    session.auth_generation(),
                    session.sub(),
                    session.fingerprint(),
                ));
            }

            op = serde_json::from_str(&poll_resp.body).map_err(|_| {
                GoogleApiError::new(
                    GoogleApiErrorKind::ServiceUsageOperationFailed,
                    "API有効化 Operation ポーリング応答の解析に失敗しました。",
                )
                .with_snapshot_meta(
                    session.auth_generation(),
                    session.sub(),
                    session.fingerprint(),
                )
            })?;

            if op.done == Some(true) {
                completed = true;
                break;
            }
        }

        if !completed {
            return Err(GoogleApiError::new(
                GoogleApiErrorKind::ServiceUsageOperationTimeout,
                format!(
                    "Project `{}` の Speech-to-Text API 有効化がタイムアウトしました（Google側で処理中の可能性があります）。「状態を再確認」を実行してください。",
                    snapshot_project
                ),
            )
            .with_snapshot_meta(
                session.auth_generation(),
                session.sub(),
                session.fingerprint(),
            ));
        }
    }

    if !session.is_current(auth).await {
        return Err(GoogleApiError::new(
            GoogleApiErrorKind::NotAuthenticated,
            format!(
                "アカウントまたはProjectが変更されたため、Project `{}` の古い有効化結果を破棄しました。",
                snapshot_project
            ),
        )
        .with_snapshot_meta(
            session.auth_generation(),
            session.sub(),
            session.fingerprint(),
        ));
    }

    if let Some(op_err) = op.error {
        let msg = op_err
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("API有効化 Operation が失敗しました");
        return Err(GoogleApiError::new(
            GoogleApiErrorKind::ServiceUsageOperationFailed,
            format!("Project `{}` の Speech-to-Text API 有効化に失敗しました: {}", snapshot_project, msg),
        )
        .with_snapshot_meta(
            session.auth_generation(),
            session.sub(),
            session.fingerprint(),
        ));
    }

    let result = EnableSpeechApiResult {
        project_id: snapshot_project,
        service_name: ALLOWED_ENABLE_SERVICE_NAME.to_string(),
        status: "enabled".to_string(),
        operation_name: op.name,
        auth_generation: session.auth_generation(),
        sub: session.sub().to_string(),
        oauth_client_id_fingerprint: session.fingerprint().to_string(),
    };
    Ok((result, session))
}

fn map_error_to_onboarding_result(
    err: GoogleApiError,
    project_id: Option<String>,
    email: Option<String>,
    status: GoogleAuthStatus,
) -> GoogleOnboardingResult {
    let outcome = match err.kind {
        GoogleApiErrorKind::SpeechApiDisabled => {
            let matching_consumer = err.target_service.as_deref() == Some(ALLOWED_ENABLE_SERVICE_NAME)
                && project_id.as_deref().is_some()
                && err.consumer_project.as_deref() == project_id.as_deref();
            if matching_consumer {
                GoogleOnboardingOutcome::NeedsApiEnableConsent
            } else {
                GoogleOnboardingOutcome::ProjectAccessDenied
            }
        }
        GoogleApiErrorKind::ServiceUsagePermissionDenied
        | GoogleApiErrorKind::ServiceUsageApiDisabled
        | GoogleApiErrorKind::SpeechPermissionDenied
        | GoogleApiErrorKind::ProjectNotAccessible
        | GoogleApiErrorKind::RecognizerPermissionDenied
        | GoogleApiErrorKind::RecognizerNotFound => GoogleOnboardingOutcome::ProjectAccessDenied,
        GoogleApiErrorKind::OauthAdminPolicyEnforced => GoogleOnboardingOutcome::WorkspaceDenied,
        GoogleApiErrorKind::OauthScopeNotGranted
        | GoogleApiErrorKind::OauthInvalidGrant
        | GoogleApiErrorKind::OauthRefreshTokenMissing
        | GoogleApiErrorKind::OauthConsentDenied
        | GoogleApiErrorKind::OauthStateMismatch
        | GoogleApiErrorKind::NotAuthenticated
        | GoogleApiErrorKind::TokenRefreshFailed => {
            if status.state == crate::google_oauth::GoogleAuthConnectionState::Connected {
                // e.g. concurrent switch/logout invalidated the in-flight onboarding snapshot
                GoogleOnboardingOutcome::CancelledOrStale
            } else {
                GoogleOnboardingOutcome::ReauthRequired
            }
        }
        GoogleApiErrorKind::OauthUserCancelled | GoogleApiErrorKind::OauthCallbackTimeout => {
            GoogleOnboardingOutcome::CancelledOrStale
        }
        GoogleApiErrorKind::BillingDisabled | GoogleApiErrorKind::QuotaOrResourceExhausted => {
            GoogleOnboardingOutcome::BillingOrQuotaError
        }
        GoogleApiErrorKind::NetworkError | GoogleApiErrorKind::ServiceUsageOperationTimeout => {
            GoogleOnboardingOutcome::NetworkOrTimeout
        }
        GoogleApiErrorKind::InvalidConfig => GoogleOnboardingOutcome::ConfigurationError,
        GoogleApiErrorKind::ServiceUsageOperationFailed
        | GoogleApiErrorKind::ProjectListPermissionDenied
        | GoogleApiErrorKind::HttpError => GoogleOnboardingOutcome::Error,
    };
    let required_permission = if err.kind == GoogleApiErrorKind::ServiceUsagePermissionDenied {
        Some("serviceusage.services.enable".to_string())
    } else {
        None
    };

    GoogleOnboardingResult {
        outcome,
        message: err.message,
        project_id,
        email,
        required_permission,
        target_service: err.target_service,
        consumer_project: err.consumer_project,
        auth_generation: status.auth_generation,
        auth_session_id: status.auth_session_id.clone(),
        sub: status.sub.clone(),
        oauth_client_id_fingerprint: status.oauth_client_id_fingerprint.clone(),
        status,
    }
}

pub async fn complete_onboarding_with_auth<T: GoogleHttpTransport, U, F>(
    auth: &GoogleAuthManager<T>,
    transport: &T,
    req: CompleteOnboardingRequest,
    build_url: U,
    request_body: &serde_json::Value,
    parse_fn: F,
    service_usage_base_url: Option<&str>,
    poll_interval: std::time::Duration,
    max_polls: usize,
) -> Result<GoogleOnboardingResult, GoogleApiError>
where
    U: Fn(&str) -> String,
    F: Fn(&serde_json::Value) -> Result<GoogleSpeechRecognizeResult, GoogleApiError>,
{
    let snapshot = match auth.acquire_onboarding_snapshot().await {
        Ok(OnboardingAcquireOutcome::AlreadyReadyUserProject(status)) => {
            return Ok(GoogleOnboardingResult {
                outcome: GoogleOnboardingOutcome::AlreadyReadyUserProject,
                message: "手動設定済みのProjectを利用できます。".to_string(),
                project_id: status.project_id.clone(),
                email: status.email.clone(),
                required_permission: None,
                target_service: None,
                consumer_project: None,
                auth_generation: status.auth_generation,
                auth_session_id: status.auth_session_id.clone(),
                sub: status.sub.clone(),
                oauth_client_id_fingerprint: status.oauth_client_id_fingerprint.clone(),
                status,
            });
        }
        Ok(OnboardingAcquireOutcome::ReadyForOnboarding(s)) => s,
        Err(err) => {
            let status = auth.get_status().await;
            return Ok(map_error_to_onboarding_result(
                err,
                status.default_project_id.clone(),
                status.email.clone(),
                status,
            ));
        }
    };

    if req.enable_speech_api_if_needed {
        let expected_matches = req
            .expected_auth_session_id
            .as_deref()
            .is_some_and(|v| v == snapshot.auth_session_id)
            && req
                .expected_auth_generation
                .is_some_and(|v| v == snapshot.auth_generation)
            && req.expected_sub.as_deref().is_some_and(|v| v == snapshot.sub)
            && req
                .expected_oauth_client_id_fingerprint
                .as_deref()
                .is_some_and(|v| v == snapshot.oauth_client_id_fingerprint)
            && req
                .expected_project_id
                .as_deref()
                .is_some_and(|v| v == snapshot.project_id);

        if !expected_matches {
            let status = auth.get_status().await;
            return Ok(GoogleOnboardingResult {
                outcome: GoogleOnboardingOutcome::CancelledOrStale,
                message: "認証状態またはProjectが変更されたためAPI有効化を中止しました。".to_string(),
                project_id: Some(snapshot.project_id),
                email: Some(snapshot.email),
                required_permission: None,
                target_service: None,
                consumer_project: None,
                auth_generation: status.auth_generation,
                auth_session_id: status.auth_session_id.clone(),
                sub: status.sub.clone(),
                oauth_client_id_fingerprint: status.oauth_client_id_fingerprint.clone(),
                status,
            });
        }
    }

    let bound_project = snapshot.project_id.clone();
    let bound_email = snapshot.email.clone();
    let mut session = CloudSessionSnapshot::Onboarding(snapshot);

    if req.enable_speech_api_if_needed {
        match enable_speech_api_session(
            auth,
            transport,
            session,
            service_usage_base_url,
            poll_interval,
            max_polls,
        )
        .await
        {
            Ok((_, next_session)) => {
                session = next_session;
            }
            Err(err) => {
                let status = auth.get_status().await;
                return Ok(map_error_to_onboarding_result(
                    err,
                    Some(bound_project),
                    Some(bound_email),
                    status,
                ));
            }
        }
    }

    let recognize_outcome = execute_speech_v2_recognize_session(
        auth,
        transport,
        session,
        build_url,
        request_body,
        parse_fn,
        false,
    )
    .await;

    let (_recognize_res, updated_session) = match recognize_outcome {
        Ok(pair) => pair,
        Err(err) => {
            let status = auth.get_status().await;
            return Ok(map_error_to_onboarding_result(
                err,
                Some(bound_project),
                Some(bound_email),
                status,
            ));
        }
    };

    let CloudSessionSnapshot::Onboarding(final_snapshot) = updated_session else {
        unreachable!("onboarding session must remain Onboarding");
    };

    match auth
        .complete_default_onboarding_commit_if_current(&final_snapshot)
        .await
    {
        Ok(Some(committed_status)) => Ok(GoogleOnboardingResult {
            outcome: GoogleOnboardingOutcome::Ready,
            message: format!("Google Cloud（{}）の接続確認が完了しました。", bound_project),
            project_id: Some(bound_project),
            email: Some(bound_email),
            required_permission: None,
            target_service: None,
            consumer_project: None,
            auth_generation: committed_status.auth_generation,
            auth_session_id: committed_status.auth_session_id.clone(),
            sub: committed_status.sub.clone(),
            oauth_client_id_fingerprint: committed_status.oauth_client_id_fingerprint.clone(),
            status: committed_status,
        }),
        Ok(None) => {
            let status = auth.get_status().await;
            Ok(GoogleOnboardingResult {
                outcome: GoogleOnboardingOutcome::CancelledOrStale,
                message: "認証状態またはProjectが変更されたため既定Projectの確定を中止しました。".to_string(),
                project_id: Some(bound_project),
                email: Some(bound_email),
                required_permission: None,
                target_service: None,
                consumer_project: None,
                auth_generation: status.auth_generation,
                auth_session_id: status.auth_session_id.clone(),
                sub: status.sub.clone(),
                oauth_client_id_fingerprint: status.oauth_client_id_fingerprint.clone(),
                status,
            })
        }
        Err(err) => {
            let status = auth.get_status().await;
            Ok(map_error_to_onboarding_result(
                err,
                Some(bound_project),
                Some(bound_email),
                status,
            ))
        }
    }
}
