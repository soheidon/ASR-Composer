use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum FetchErrorKind {
    NotConfigured,
    AuthError,
    ConnectionError,
    Unsupported,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FetchModelsError {
    pub kind: FetchErrorKind,
    pub message: String,
}

impl fmt::Display for FetchModelsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct ProviderSettings {
    pub env_name: Option<String>,
    pub base_url: Option<String>,
    pub default_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<HashMap<String, String>>,
}

#[derive(Serialize, Deserialize, Default)]
pub struct AppSettings {
    pub providers: HashMap<String, ProviderSettings>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveProviderConfigInput {
    pub provider_id: String,
    pub env_name: Option<String>,
    pub base_url: String,
    pub default_model: Option<String>,
    #[serde(default)]
    pub options: Option<HashMap<String, String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveProviderSecretInput {
    pub env_name: String,
    pub api_key: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveProviderSecretResult {
    pub persisted: bool,
    pub warning: Option<String>,
}

fn settings_path(app: &tauri::AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .expect("failed to resolve app data dir");
    fs::create_dir_all(&dir).ok();
    dir.join("settings.json")
}

fn load_settings(app: &tauri::AppHandle) -> AppSettings {
    let path = settings_path(app);
    if path.exists() {
        let data = fs::read_to_string(&path).unwrap_or_default();
        let mut settings: AppSettings = serde_json::from_str(&data).unwrap_or_default();
        migrate_settings(&mut settings);
        settings
    } else {
        AppSettings::default()
    }
}

fn migrate_settings(settings: &mut AppSettings) {
    if let Some(moonshot) = settings.providers.get_mut("moonshot") {
        if let Some(ref url) = moonshot.base_url {
            if url == "https://api.moonshot.cn/v1" {
                moonshot.base_url = Some("https://api.moonshot.ai/v1".to_string());
            }
        }
    }
    if let Some(mimo) = settings.providers.get_mut("xiaomi_mimo") {
        if let Some(ref url) = mimo.base_url {
            if url == "https://api.xiaomimimo.com/anthropic" {
                mimo.base_url = Some("https://api.xiaomimimo.com/v1".to_string());
            }
        }
    }
}

#[tauri::command]
fn load_api_settings(app: tauri::AppHandle) -> AppSettings {
    load_settings(&app)
}

#[tauri::command]
fn save_provider_config(
    app: tauri::AppHandle,
    input: SaveProviderConfigInput,
) -> Result<(), String> {
    let path = settings_path(&app);
    let mut settings = load_settings(&app);
    let options = match input.options {
        Some(new_opts) => Some(new_opts),
        None => settings
            .providers
            .get(&input.provider_id)
            .and_then(|p| p.options.clone()),
    };
    settings.providers.insert(
        input.provider_id,
        ProviderSettings {
            env_name: input.env_name,
            base_url: Some(input.base_url),
            default_model: input.default_model,
            options,
        },
    );
    let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn save_provider_secret(
    _app: tauri::AppHandle,
    input: SaveProviderSecretInput,
) -> Result<SaveProviderSecretResult, String> {
    // 1. 現在のTauriプロセスで直ちに参照可能にする
    std::env::set_var(&input.env_name, &input.api_key);

    // 2. 永続環境変数へ保存（Windows: setx）
    //    失敗してもErrを返さず、persisted: false + warningを返す
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        let result = Command::new("setx")
            .arg(&input.env_name)
            .arg(&input.api_key)
            .status();

        match result {
            Ok(status) if status.success() => Ok(SaveProviderSecretResult {
                persisted: true,
                warning: None,
            }),
            Ok(_) => Ok(SaveProviderSecretResult {
                persisted: false,
                warning: Some(
                    "現在のセッションでは利用できますが、永続保存に失敗しました".to_string(),
                ),
            }),
            Err(e) => Ok(SaveProviderSecretResult {
                persisted: false,
                warning: Some(format!(
                    "永続保存に失敗しました（{}）。現在のセッションでは利用できます",
                    e
                )),
            }),
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok(SaveProviderSecretResult {
            persisted: false,
            warning: Some(
                "このOSでは永続保存が未対応です。現在のセッションでは利用できます".to_string(),
            ),
        })
    }
}

fn is_openai_compatible(id: &str) -> bool {
    matches!(
        id,
        "openai"
            | "openai_audio"
            | "groq"
            | "groq_speech"
            | "deepseek"
            | "openrouter"
            | "mistral"
            | "moonshot"
            | "minimax"
            | "xiaomi_mimo"
    )
}

#[derive(Debug, PartialEq, Eq)]
enum ModelFetchAdapter {
    OpenAiCompatible,
    Anthropic,
    Gemini,
    Ollama,
}

fn model_fetch_adapter(provider_id: &str) -> Option<ModelFetchAdapter> {
    if provider_id == "ollama" {
        return Some(ModelFetchAdapter::Ollama);
    }
    match provider_id {
        "anthropic" => Some(ModelFetchAdapter::Anthropic),
        "gemini" => Some(ModelFetchAdapter::Gemini),
        id if is_openai_compatible(id) => Some(ModelFetchAdapter::OpenAiCompatible),
        _ => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ProviderDefaults {
    env_name: &'static str,
    base_url: &'static str,
}

fn provider_defaults(provider_id: &str) -> Option<ProviderDefaults> {
    match provider_id {
        "openai" | "openai_audio" => Some(ProviderDefaults {
            env_name: "OPENAI_API_KEY",
            base_url: "https://api.openai.com/v1",
        }),
        "anthropic" => Some(ProviderDefaults {
            env_name: "ANTHROPIC_API_KEY",
            base_url: "https://api.anthropic.com",
        }),
        "gemini" => Some(ProviderDefaults {
            env_name: "GEMINI_API_KEY",
            base_url: "https://generativelanguage.googleapis.com/v1beta",
        }),
        "deepseek" => Some(ProviderDefaults {
            env_name: "DEEPSEEK_API_KEY",
            base_url: "https://api.deepseek.com",
        }),
        "openrouter" => Some(ProviderDefaults {
            env_name: "OPENROUTER_API_KEY",
            base_url: "https://openrouter.ai/api/v1",
        }),
        "mistral" => Some(ProviderDefaults {
            env_name: "MISTRAL_API_KEY",
            base_url: "https://api.mistral.ai/v1",
        }),
        "groq" | "groq_speech" => Some(ProviderDefaults {
            env_name: "GROQ_API_KEY",
            base_url: "https://api.groq.com/openai/v1",
        }),
        "moonshot" => Some(ProviderDefaults {
            env_name: "MOONSHOT_API_KEY",
            base_url: "https://api.moonshot.ai/v1",
        }),
        "minimax" => Some(ProviderDefaults {
            env_name: "MINIMAX_API_KEY",
            base_url: "https://api.minimax.io/v1",
        }),
        "xiaomi_mimo" => Some(ProviderDefaults {
            env_name: "XIAOMI_API_KEY",
            base_url: "https://api.xiaomimimo.com/v1",
        }),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ResolvedProviderConfig {
    env_name: String,
    base_url: String,
}

fn resolve_provider_config(
    provider_id: &str,
    saved: Option<&ProviderSettings>,
) -> Result<ResolvedProviderConfig, FetchModelsError> {
    let defaults = provider_defaults(provider_id);

    let env_name = saved
        .and_then(|p| p.env_name.as_deref())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .or_else(|| defaults.map(|d| d.env_name.to_owned()))
        .ok_or_else(|| FetchModelsError {
            kind: FetchErrorKind::NotConfigured,
            message: "プロバイダーが設定されていません".to_string(),
        })?;

    let base_url = saved
        .and_then(|p| p.base_url.as_deref())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .or_else(|| defaults.map(|d| d.base_url.to_owned()))
        .ok_or_else(|| FetchModelsError {
            kind: FetchErrorKind::NotConfigured,
            message: "Base URLが設定されていません".to_string(),
        })?;

    Ok(ResolvedProviderConfig { env_name, base_url })
}

fn classify_http_error(status: reqwest::StatusCode, body: &str) -> FetchModelsError {
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        FetchModelsError {
            kind: FetchErrorKind::AuthError,
            message: "APIキーが認証されませんでした。".to_string(),
        }
    } else if status == reqwest::StatusCode::BAD_REQUEST && body.contains("unsupported_parameter") {
        FetchModelsError {
            kind: FetchErrorKind::ConnectionError,
            message: "選択したモデルでは、現在のリクエスト形式を使用できませんでした。モデルに対応した出力トークン設定へ切り替えて再試行してください。".to_string(),
        }
    } else {
        FetchModelsError {
            kind: FetchErrorKind::ConnectionError,
            message: format!("APIエラー ({})", status),
        }
    }
}

#[tauri::command]
async fn fetch_models(
    app: tauri::AppHandle,
    provider_id: String,
) -> Result<Vec<String>, FetchModelsError> {
    let settings = load_settings(&app);

    let adapter = model_fetch_adapter(&provider_id).ok_or(FetchModelsError {
        kind: FetchErrorKind::Unsupported,
        message: "このプロバイダーはモデル一覧の自動取得に対応していません".to_string(),
    })?;

    // Ollama: 設定未保存でも既定URLで取得可能（APIキー不要）
    if adapter == ModelFetchAdapter::Ollama {
        let base_url = settings
            .providers
            .get("ollama")
            .and_then(|p| p.base_url.as_deref())
            .filter(|url| !url.trim().is_empty())
            .unwrap_or("http://localhost:11434");

        return fetch_models_ollama(base_url).await;
    }

    // クラウドAPI: 保存済み設定 → 既定値 → 環境変数の順で解決
    let saved = settings.providers.get(&provider_id);
    let resolved = resolve_provider_config(&provider_id, saved)?;

    let api_key = std::env::var(&resolved.env_name).map_err(|_| FetchModelsError {
        kind: FetchErrorKind::NotConfigured,
        message: format!("{} が設定されていません", resolved.env_name),
    })?;

    match adapter {
        ModelFetchAdapter::Anthropic => {
            fetch_models_anthropic(&resolved.base_url, &api_key).await
        }
        ModelFetchAdapter::Gemini => {
            fetch_models_gemini(&resolved.base_url, &api_key).await
        }
        ModelFetchAdapter::OpenAiCompatible => {
            fetch_models_openai_compatible(&resolved.base_url, &api_key).await
        }
        ModelFetchAdapter::Ollama => unreachable!(),
    }
}

fn invalid_models_response(message: impl Into<String>) -> FetchModelsError {
    FetchModelsError {
        kind: FetchErrorKind::ConnectionError,
        message: message.into(),
    }
}

fn parse_openai_models_response(json: &serde_json::Value) -> Result<Vec<String>, FetchModelsError> {
    let data = json
        .get("data")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| invalid_models_response("レスポンスにdataフィールドがありません"))?;

    Ok(data
        .iter()
        .filter_map(|m| m["id"].as_str().map(String::from))
        .collect())
}

fn parse_anthropic_models_response(json: &serde_json::Value) -> Result<Vec<String>, FetchModelsError> {
    let data = json
        .get("data")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| invalid_models_response("レスポンスにdataフィールドがありません"))?;

    Ok(data
        .iter()
        .filter_map(|m| m["id"].as_str().map(String::from))
        .collect())
}

fn parse_gemini_models_response(json: &serde_json::Value) -> Result<Vec<String>, FetchModelsError> {
    let models = json
        .get("models")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| invalid_models_response("レスポンスにmodelsフィールドがありません"))?;

    Ok(models
        .iter()
        .filter_map(|m| m["name"].as_str().map(|s| s.to_string()))
        .collect())
}

fn parse_ollama_models_response(json: &serde_json::Value) -> Result<Vec<String>, FetchModelsError> {
    let models = json
        .get("models")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| invalid_models_response("レスポンスにmodelsフィールドがありません"))?;

    Ok(models
        .iter()
        .filter_map(|m| m["name"].as_str().map(String::from))
        .collect())
}

async fn fetch_models_openai_compatible(
    base_url: &str,
    api_key: &str,
) -> Result<Vec<String>, FetchModelsError> {
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .send()
        .await
        .map_err(|e| FetchModelsError {
            kind: FetchErrorKind::ConnectionError,
            message: format!("リクエスト失敗: {e}"),
        })?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(classify_http_error(status, &body));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| FetchModelsError {
            kind: FetchErrorKind::ConnectionError,
            message: format!("JSON解析失敗: {e}"),
        })?;

    parse_openai_models_response(&json)
}

async fn fetch_models_anthropic(
    base_url: &str,
    api_key: &str,
) -> Result<Vec<String>, FetchModelsError> {
    let url = format!("{}/v1/models", base_url.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .send()
        .await
        .map_err(|e| FetchModelsError {
            kind: FetchErrorKind::ConnectionError,
            message: format!("リクエスト失敗: {e}"),
        })?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(classify_http_error(status, &body));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| FetchModelsError {
            kind: FetchErrorKind::ConnectionError,
            message: format!("JSON解析失敗: {e}"),
        })?;

    parse_anthropic_models_response(&json)
}

async fn fetch_models_gemini(
    base_url: &str,
    api_key: &str,
) -> Result<Vec<String>, FetchModelsError> {
    let url = format!(
        "{}/models?key={}",
        base_url.trim_end_matches('/'),
        api_key
    );
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| FetchModelsError {
            kind: FetchErrorKind::ConnectionError,
            message: format!("リクエスト失敗: {e}"),
        })?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(classify_http_error(status, &body));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| FetchModelsError {
            kind: FetchErrorKind::ConnectionError,
            message: format!("JSON解析失敗: {e}"),
        })?;

    parse_gemini_models_response(&json)
}

/// OllamaエンドポイントのURLを構築する。
/// 空欄なら `http://localhost:11434` を使用。
/// http/httpsのみ許可、認証情報・query・fragmentを除去し、パスを結合する。
fn build_ollama_endpoint(
    base_url: &str,
    endpoint: &str,
) -> Result<reqwest::Url, FetchModelsError> {
    let resolved = if base_url.trim().is_empty() {
        "http://localhost:11434"
    } else {
        base_url.trim()
    };

    let mut url = reqwest::Url::parse(resolved).map_err(|_| FetchModelsError {
        kind: FetchErrorKind::NotConfigured,
        message: "エンドポイントURLの形式が正しくありません。".to_string(),
    })?;

    if !matches!(url.scheme(), "http" | "https") {
        return Err(FetchModelsError {
            kind: FetchErrorKind::NotConfigured,
            message: "エンドポイントURLにはhttpまたはhttpsを指定してください。".to_string(),
        });
    }

    if !url.username().is_empty() || url.password().is_some() {
        return Err(FetchModelsError {
            kind: FetchErrorKind::NotConfigured,
            message: "エンドポイントURLに認証情報を含めることはできません。".to_string(),
        });
    }

    url.set_query(None);
    url.set_fragment(None);

    let path = format!(
        "{}/{}",
        url.path().trim_end_matches('/'),
        endpoint.trim_start_matches('/')
    );
    url.set_path(&path);

    Ok(url)
}

/// Ollama `/api/version` レスポンスからバージョン文字列を検証付きで取得する。
fn parse_ollama_version(body: &str) -> Result<String, FetchModelsError> {
    let result: OllamaVersionResponse = serde_json::from_str(body).map_err(|_| FetchModelsError {
        kind: FetchErrorKind::ConnectionError,
        message: "接続先からOllamaとして認識できる応答を取得できませんでした。".to_string(),
    })?;

    let version = result.version.trim();
    if version.is_empty() {
        return Err(FetchModelsError {
            kind: FetchErrorKind::ConnectionError,
            message: "接続先からOllamaのバージョンを取得できませんでした。".to_string(),
        });
    }

    Ok(version.to_string())
}

async fn fetch_models_ollama(base_url: &str) -> Result<Vec<String>, FetchModelsError> {
    let url = build_ollama_endpoint(base_url, "api/tags")?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|_| FetchModelsError {
            kind: FetchErrorKind::ConnectionError,
            message: "接続を開始できませんでした。".to_string(),
        })?;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|_| FetchModelsError {
            kind: FetchErrorKind::ConnectionError,
            message: "Ollamaに接続できませんでした。Ollamaが起動していることと、エンドポイントURLを確認してください。".to_string(),
        })?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(classify_http_error(status, &body));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| FetchModelsError {
            kind: FetchErrorKind::ConnectionError,
            message: format!("JSON解析失敗: {e}"),
        })?;

    parse_ollama_models_response(&json)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TestConnectionResult {
    pub version: String,
    pub message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestOllamaConnectionInput {
    pub base_url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestLlmConnectionInput {
    pub provider_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestLlmConnectionResult {
    pub message: String,
    pub model: String,
    pub response_text: String,
}

#[derive(Deserialize)]
struct OllamaVersionResponse {
    version: String,
}

#[tauri::command]
async fn test_connection_ollama(
    input: TestOllamaConnectionInput,
) -> Result<TestConnectionResult, FetchModelsError> {
    let url = build_ollama_endpoint(&input.base_url, "api/version")?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|_| FetchModelsError {
            kind: FetchErrorKind::ConnectionError,
            message: "接続テストを開始できませんでした。".to_string(),
        })?;

    let resp = client.get(url).send().await.map_err(|_| FetchModelsError {
        kind: FetchErrorKind::ConnectionError,
        message: "Ollamaに接続できませんでした。Ollamaが起動していることと、エンドポイントURLを確認してください。".to_string(),
    })?;

    if !resp.status().is_success() {
        let status = resp.status();
        eprintln!("Ollama /api/version returned HTTP {}", status);
        return Err(FetchModelsError {
            kind: if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
                FetchErrorKind::AuthError
            } else {
                FetchErrorKind::ConnectionError
            },
            message: format!("Ollamaから正常な応答を取得できませんでした（HTTP {}）。", status.as_u16()),
        });
    }

    let body = resp.text().await.map_err(|_| FetchModelsError {
        kind: FetchErrorKind::ConnectionError,
        message: "Ollamaからの応答を読み取れませんでした。".to_string(),
    })?;

    let version = parse_ollama_version(&body)?;

    Ok(TestConnectionResult {
        version: version.clone(),
        message: format!("接続成功（Ollama v{}）", version),
    })
}

fn is_anthropic_provider(provider_id: &str) -> bool {
    matches!(provider_id, "anthropic")
}

enum TokenLimitField {
    MaxTokens,
    MaxCompletionTokens,
}

fn openai_token_limit_field(provider_id: &str, model: &str) -> TokenLimitField {
    // OpenAI公式は max_completion_tokens を使用
    if provider_id == "openai" || provider_id == "openai_audio" {
        return TokenLimitField::MaxCompletionTokens;
    }
    // OpenAI系の reasoning モデルも max_completion_tokens
    let model_lower = model.to_lowercase();
    if model_lower.starts_with("o1")
        || model_lower.starts_with("o3")
        || model_lower.starts_with("o4")
        || model_lower.starts_with("gpt-5")
    {
        return TokenLimitField::MaxCompletionTokens;
    }
    // その他は互換性のため max_tokens
    TokenLimitField::MaxTokens
}

#[tauri::command]
async fn test_llm_connection(
    app: tauri::AppHandle,
    input: TestLlmConnectionInput,
) -> Result<TestLlmConnectionResult, FetchModelsError> {
    let settings = load_settings(&app);
    let saved = settings.providers.get(&input.provider_id);
    let resolved = resolve_provider_config(&input.provider_id, saved)?;

    let api_key = std::env::var(&resolved.env_name).map_err(|_| FetchModelsError {
        kind: FetchErrorKind::NotConfigured,
        message: format!("{} が設定されていません", resolved.env_name),
    })?;

    let model = saved
        .and_then(|p| p.default_model.as_deref())
        .filter(|m| !m.trim().is_empty())
        .unwrap_or("mimo-v2.5")
        .to_string();

    if is_anthropic_provider(&input.provider_id) {
        test_llm_anthropic(&resolved.base_url, &api_key, &model).await
    } else {
        test_llm_openai(&input.provider_id, &resolved.base_url, &api_key, &model).await
    }
}

async fn test_llm_anthropic(
    base_url: &str,
    api_key: &str,
    model: &str,
) -> Result<TestLlmConnectionResult, FetchModelsError> {
    let url = format!("{}/v1/messages", base_url.trim_end_matches('/'));

    let body = serde_json::json!({
        "model": model,
        "max_tokens": 16,
        "messages": [{"role": "user", "content": "Reply with only the number 1."}]
    });

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| FetchModelsError {
            kind: FetchErrorKind::ConnectionError,
            message: format!("リクエスト送信に失敗しました: {}", e),
        })?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        return Err(classify_http_error(status, &body_text));
    }

    let json: serde_json::Value = resp.json().await.map_err(|e| FetchModelsError {
        kind: FetchErrorKind::ConnectionError,
        message: format!("レスポンス解析に失敗しました: {}", e),
    })?;

    let response_text = json
        .get("content")
        .and_then(|c| c.as_array())
        .and_then(|arr| arr.first())
        .and_then(|block| block.get("text"))
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string();

    Ok(TestLlmConnectionResult {
        message: format!("接続成功（{}）", model),
        model: model.to_string(),
        response_text,
    })
}

async fn test_llm_openai(
    provider_id: &str,
    base_url: &str,
    api_key: &str,
    model: &str,
) -> Result<TestLlmConnectionResult, FetchModelsError> {
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));

    let mut body = serde_json::json!({
        "model": model,
        "messages": [{"role": "user", "content": "Reply with only the number 1."}]
    });

    match openai_token_limit_field(provider_id, model) {
        TokenLimitField::MaxCompletionTokens => {
            body["max_completion_tokens"] = serde_json::json!(16);
        }
        TokenLimitField::MaxTokens => {
            body["max_tokens"] = serde_json::json!(16);
        }
    }

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| FetchModelsError {
            kind: FetchErrorKind::ConnectionError,
            message: format!("リクエスト送信に失敗しました: {}", e),
        })?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        return Err(classify_http_error(status, &body_text));
    }

    let json: serde_json::Value = resp.json().await.map_err(|e| FetchModelsError {
        kind: FetchErrorKind::ConnectionError,
        message: format!("レスポンス解析に失敗しました: {}", e),
    })?;

    let response_text = json
        .get("choices")
        .and_then(|c| c.as_array())
        .and_then(|arr| arr.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|msg| msg.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string();

    Ok(TestLlmConnectionResult {
        message: format!("接続成功（{}）", model),
        model: model.to_string(),
        response_text,
    })
}

#[tauri::command]
fn get_env_var(name: String) -> Option<String> {
    std::env::var(&name).ok()
}

// ---- Google Cloud Speech-to-Text v2 ----

const GOOGLE_STT_ALLOWED_LOCATIONS: &[&str] = &[
    "us-central1",
    "asia-southeast1",
    "europe-west4",
];

const GOOGLE_STT_MAX_FILE_SIZE: u64 = 7 * 1024 * 1024; // 7MB (base64膨張を考慮)

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum GoogleSttErrorKind {
    GcloudNotFound,
    AdcUnavailable,
    InvalidConfig,
    AudioFileError,
    AuthenticationError,
    PermissionError,
    BillingOrApiDisabled,
    HttpError,
    InvalidResponse,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleSttAdcStatus {
    pub available: bool,
    pub quota_project: Option<String>,
    pub current_project: Option<String>,
    pub error: Option<String>,
    pub error_kind: Option<GoogleSttErrorKind>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleSttRecognizeInput {
    pub project_id: String,
    pub location: String,
    pub recognizer_id: String,
    pub model: String,
    pub language_code: String,
    pub audio_path: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GoogleSttRecognizeSegment {
    pub transcript: String,
    pub confidence: Option<f64>,
    pub language_code: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GoogleSttRecognizeResult {
    pub transcript: String,
    pub segments: Vec<GoogleSttRecognizeSegment>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GoogleSttProject {
    pub project_id: String,
    pub name: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GoogleSttListProjectsResult {
    pub projects: Vec<GoogleSttProject>,
    pub current_project: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleSttBuiltinTestInput {
    pub project_id: String,
    pub location: String,
}

struct GoogleSttBuiltinRecognitionConfig {
    recognizer_id: &'static str,
    language_code: &'static str,
    model: &'static str,
}

fn google_stt_builtin_recognition_config() -> GoogleSttBuiltinRecognitionConfig {
    GoogleSttBuiltinRecognitionConfig {
        recognizer_id: "_",
        language_code: "ja-JP",
        model: "chirp_2",
    }
}

fn find_gcloud_executable() -> Option<std::path::PathBuf> {
    // 1. PATH上の gcloud.cmd / gcloud を where で検索
    for name in &["gcloud.cmd", "gcloud"] {
        if let Ok(output) = std::process::Command::new("cmd.exe")
            .args(["/C", "where", name])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .output()
        {
            if output.status.success() {
                let path_str = String::from_utf8_lossy(&output.stdout);
                let first_line = path_str.lines().next().unwrap_or("").trim();
                if !first_line.is_empty() {
                    return Some(std::path::PathBuf::from(first_line));
                }
            }
        }
    }
    // 2. 候補ディレクトリを順に探索
    let candidates: Vec<String> = [
        "LOCALAPPDATA",
        "PROGRAMFILES",
        "PROGRAMFILES(X86)",
    ]
    .iter()
    .filter_map(|var| std::env::var(var).ok())
    .collect();

    for base in &candidates {
        let candidate = std::path::PathBuf::from(base)
            .join("Google")
            .join("Cloud SDK")
            .join("google-cloud-sdk")
            .join("bin")
            .join("gcloud.cmd");
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

fn get_adc_quota_project() -> Option<String> {
    let app_data = std::env::var("APPDATA").ok()?;
    let adc_path = std::path::PathBuf::from(app_data)
        .join("gcloud")
        .join("application_default_credentials.json");
    let content = fs::read_to_string(adc_path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    json.get("quota_project_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

fn get_adc_current_project(gcloud: &std::path::Path) -> Option<String> {
    let output = std::process::Command::new("cmd.exe")
        .args(["/C", &gcloud.to_string_lossy(), "config", "get-value", "project"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let project = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if project.is_empty() || project == "(unset)" {
        None
    } else {
        Some(project)
    }
}

fn parse_google_stt_projects(json_str: &str) -> Result<Vec<GoogleSttProject>, FetchModelsError> {
    let json: serde_json::Value = serde_json::from_str(json_str).map_err(|e| FetchModelsError {
        kind: FetchErrorKind::ConnectionError,
        message: format!("プロジェクト一覧のJSON解析に失敗しました: {}", e),
    })?;

    let arr = match json.as_array() {
        Some(a) => a,
        None => return Ok(Vec::new()),
    };

    let mut seen = std::collections::HashSet::new();
    let mut projects: Vec<GoogleSttProject> = Vec::new();

    for item in arr {
        let project_id = match item.get("projectId").and_then(|v| v.as_str()) {
            Some(id) => id.to_string(),
            None => continue,
        };
        if !seen.insert(project_id.clone()) {
            continue;
        }
        let name = item
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or(&project_id)
            .to_string();
        projects.push(GoogleSttProject { project_id, name });
    }

    projects.sort_by(|a, b| a.project_id.cmp(&b.project_id));
    Ok(projects)
}

#[tauri::command]
async fn google_stt_check_adc() -> GoogleSttAdcStatus {
    let gcloud = match find_gcloud_executable() {
        Some(path) => path,
        None => {
            return GoogleSttAdcStatus {
                available: false,
                quota_project: None,
                current_project: None,
                error: Some("Google Cloud CLIが見つかりません。gcloud CLIをインストールしてください。".to_string()),
                error_kind: Some(GoogleSttErrorKind::GcloudNotFound),
            };
        }
    };

    let output = std::process::Command::new("cmd.exe")
        .args(["/C", &gcloud.to_string_lossy(), "auth", "application-default", "print-access-token"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .output();

    match output {
        Ok(out) if out.status.success() => GoogleSttAdcStatus {
            available: true,
            quota_project: get_adc_quota_project(),
            current_project: get_adc_current_project(&gcloud),
            error: None,
            error_kind: None,
        },
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let (kind, msg) = if stderr.contains("Could not find") || stderr.contains("no credentials") {
                (
                    GoogleSttErrorKind::AdcUnavailable,
                    "ADCが未作成です。`gcloud auth application-default login` を実行してください。".to_string(),
                )
            } else {
                (
                    GoogleSttErrorKind::AdcUnavailable,
                    format!("ADCトークン取得に失敗しました: {}", stderr.trim()),
                )
            };
            GoogleSttAdcStatus {
                available: false,
                quota_project: get_adc_quota_project(),
                current_project: None,
                error: Some(msg),
                error_kind: Some(kind),
            }
        }
        Err(e) => GoogleSttAdcStatus {
            available: false,
            quota_project: None,
            current_project: None,
            error: Some(format!("gcloud実行に失敗しました: {}", e)),
            error_kind: Some(GoogleSttErrorKind::GcloudNotFound),
        },
    }
}

#[tauri::command]
async fn google_stt_list_projects() -> Result<GoogleSttListProjectsResult, FetchModelsError> {
    let gcloud = find_gcloud_executable().ok_or_else(|| FetchModelsError {
        kind: FetchErrorKind::NotConfigured,
        message: "Google Cloud CLIが見つかりません。gcloud CLIをインストールしてください。".to_string(),
    })?;

    let current_project = get_adc_current_project(&gcloud);

    let output = std::process::Command::new("cmd.exe")
        .args([
            "/C",
            &gcloud.to_string_lossy(),
            "projects",
            "list",
            "--filter=lifecycleState:ACTIVE",
            "--format=json(projectId,name)",
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .map_err(|e| FetchModelsError {
            kind: FetchErrorKind::ConnectionError,
            message: format!("gcloud projects list の実行に失敗しました: {}", e),
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(FetchModelsError {
            kind: FetchErrorKind::ConnectionError,
            message: format!("プロジェクト一覧の取得に失敗しました: {}", stderr.trim()),
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let projects = parse_google_stt_projects(&stdout)?;

    Ok(GoogleSttListProjectsResult {
        projects,
        current_project,
    })
}

fn validate_google_stt_input(input: &GoogleSttRecognizeInput) -> Result<(), FetchModelsError> {
    // project_id: 6-30文字, 小文字英数字ハイフン, 英字始まり, ハイフンで終わらない
    let pid = input.project_id.trim();
    if pid.is_empty() {
        return Err(FetchModelsError {
            kind: FetchErrorKind::NotConfigured,
            message: "Project IDを入力してください".to_string(),
        });
    }
    let bytes = pid.as_bytes();
    let len = bytes.len();
    if len < 6 || len > 30 {
        return Err(FetchModelsError {
            kind: FetchErrorKind::NotConfigured,
            message: "Project IDは6〜30文字で入力してください".to_string(),
        });
    }
    if !bytes[0].is_ascii_lowercase() {
        return Err(FetchModelsError {
            kind: FetchErrorKind::NotConfigured,
            message: "Project IDは小文字英字で始まる必要があります".to_string(),
        });
    }
    if bytes[len - 1] == b'-' {
        return Err(FetchModelsError {
            kind: FetchErrorKind::NotConfigured,
            message: "Project IDはハイフンで終わってはいけません".to_string(),
        });
    }
    for &b in bytes {
        if !b.is_ascii_lowercase() && !b.is_ascii_digit() && b != b'-' {
            return Err(FetchModelsError {
                kind: FetchErrorKind::NotConfigured,
                message: "Project IDは小文字英字、数字、ハイフンのみ使用できます".to_string(),
            });
        }
    }

    // location
    if !GOOGLE_STT_ALLOWED_LOCATIONS.contains(&input.location.as_str()) {
        return Err(FetchModelsError {
            kind: FetchErrorKind::NotConfigured,
            message: format!(
                "サポートされていないリージョンです: {}。使用可能: {}",
                input.location,
                GOOGLE_STT_ALLOWED_LOCATIONS.join(", ")
            ),
        });
    }

    // 必須フィールド
    if input.recognizer_id.trim().is_empty() {
        return Err(FetchModelsError {
            kind: FetchErrorKind::NotConfigured,
            message: "Recognizer IDを入力してください".to_string(),
        });
    }
    if input.model.trim().is_empty() {
        return Err(FetchModelsError {
            kind: FetchErrorKind::NotConfigured,
            message: "モデル名を入力してください".to_string(),
        });
    }
    if input.language_code.trim().is_empty() {
        return Err(FetchModelsError {
            kind: FetchErrorKind::NotConfigured,
            message: "言語コードを入力してください".to_string(),
        });
    }

    Ok(())
}

fn build_google_stt_base_url(location: &str) -> Result<String, FetchModelsError> {
    if !GOOGLE_STT_ALLOWED_LOCATIONS.contains(&location) {
        return Err(FetchModelsError {
            kind: FetchErrorKind::NotConfigured,
            message: format!(
                "サポートされていないリージョンです: {}",
                location
            ),
        });
    }
    Ok(format!("https://{}-speech.googleapis.com/v2", location))
}

fn build_google_stt_recognize_url(
    base_url: &str,
    project: &str,
    location: &str,
    recognizer: &str,
) -> String {
    format!(
        "{}/projects/{}/locations/{}/recognizers/{}:recognize",
        base_url.trim_end_matches('/'),
        project,
        location,
        recognizer,
    )
}

fn build_google_stt_request_body(
    base64_audio: &str,
    model: &str,
    language_code: &str,
) -> serde_json::Value {
    serde_json::json!({
        "config": {
            "autoDecodingConfig": {},
            "languageCodes": [language_code],
            "model": model,
        },
        "content": base64_audio,
    })
}

fn parse_google_stt_response(json: &serde_json::Value) -> Result<GoogleSttRecognizeResult, FetchModelsError> {
    let results = json
        .get("results")
        .and_then(|v| v.as_array());

    let mut segments = Vec::new();
    let mut full_transcript = String::new();

    if let Some(results_arr) = results {
        for result in results_arr {
            let alternatives = match result.get("alternatives").and_then(|v| v.as_array()) {
                Some(arr) if !arr.is_empty() => arr,
                _ => continue,
            };
            let alt = &alternatives[0];
            let transcript = alt
                .get("transcript")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            let confidence = alt
                .get("confidence")
                .and_then(|v| v.as_f64())
                .and_then(|c| if c == 0.0 { None } else { Some(c) });

            let language_code = result
                .get("languageCode")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            if !transcript.is_empty() {
                full_transcript.push_str(&transcript);
            }

            segments.push(GoogleSttRecognizeSegment {
                transcript,
                confidence,
                language_code,
            });
        }
    }

    Ok(GoogleSttRecognizeResult {
        transcript: full_transcript,
        segments,
    })
}

fn get_adc_access_token() -> Result<String, FetchModelsError> {
    let gcloud = find_gcloud_executable().ok_or_else(|| FetchModelsError {
        kind: FetchErrorKind::NotConfigured,
        message: "Google Cloud CLIが見つかりません。gcloud CLIをインストールしてください。".to_string(),
    })?;

    let output = std::process::Command::new("cmd.exe")
        .args(["/C", &gcloud.to_string_lossy(), "auth", "application-default", "print-access-token"])
        .output()
        .map_err(|e| FetchModelsError {
            kind: FetchErrorKind::ConnectionError,
            message: format!("gcloud実行に失敗しました: {}", e),
        })?;

    if !output.status.success() {
        let _stderr = String::from_utf8_lossy(&output.stderr);
        return Err(FetchModelsError {
            kind: FetchErrorKind::AuthError,
            message: "ADCトークン取得に失敗しました。`gcloud auth application-default login` を実行してください。".to_string(),
        });
    }

    let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if token.is_empty() || !token.starts_with("ya29.") {
        return Err(FetchModelsError {
            kind: FetchErrorKind::AuthError,
            message: "ADCから有効なトークンを取得できませんでした。".to_string(),
        });
    }

    Ok(token)
}

#[tauri::command]
async fn google_stt_recognize(
    input: GoogleSttRecognizeInput,
) -> Result<GoogleSttRecognizeResult, FetchModelsError> {
    validate_google_stt_input(&input)?;
    recognize_google_stt_audio(
        &input.project_id,
        &input.location,
        &input.recognizer_id,
        &input.language_code,
        &input.model,
        std::path::Path::new(&input.audio_path),
    )
    .await
}

async fn recognize_google_stt_audio(
    project_id: &str,
    location: &str,
    recognizer_id: &str,
    language_code: &str,
    model: &str,
    audio_path: &std::path::Path,
) -> Result<GoogleSttRecognizeResult, FetchModelsError> {
    // ファイル存在確認
    if !audio_path.exists() {
        return Err(FetchModelsError {
            kind: FetchErrorKind::NotConfigured,
            message: "音声ファイルが見つかりません".to_string(),
        });
    }

    // ファイルサイズ確認
    let metadata = fs::metadata(audio_path).map_err(|e| FetchModelsError {
        kind: FetchErrorKind::ConnectionError,
        message: format!("ファイル情報の取得に失敗しました: {}", e),
    })?;
    if metadata.len() > GOOGLE_STT_MAX_FILE_SIZE {
        return Err(FetchModelsError {
            kind: FetchErrorKind::NotConfigured,
            message: format!(
                "ファイルサイズが大きすぎます（{}MB）。上限は7MBです。",
                metadata.len() / 1024 / 1024
            ),
        });
    }

    // 音声読み込み + base64
    let audio_bytes = fs::read(audio_path).map_err(|e| FetchModelsError {
        kind: FetchErrorKind::ConnectionError,
        message: format!("音声ファイルの読み込みに失敗しました: {}", e),
    })?;
    use base64::Engine;
    let audio_base64 = base64::engine::general_purpose::STANDARD.encode(&audio_bytes);

    // ADCトークン取得
    let access_token = get_adc_access_token()?;

    // URL構築
    let base_url = build_google_stt_base_url(location)?;
    let url = build_google_stt_recognize_url(&base_url, project_id, location, recognizer_id);

    // リクエスト構築
    let body = build_google_stt_request_body(&audio_base64, model, language_code);

    // HTTPリクエスト
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .bearer_auth(&access_token)
        .header("x-goog-user-project", project_id)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| FetchModelsError {
            kind: FetchErrorKind::ConnectionError,
            message: format!("リクエスト送信に失敗しました: {}", e),
        })?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        let kind = if status == reqwest::StatusCode::UNAUTHORIZED
            || status == reqwest::StatusCode::FORBIDDEN
        {
            if body_text.contains("PERMISSION_DENIED") || body_text.contains("speech.recognizers") {
                FetchErrorKind::AuthError
            } else if body_text.contains("billing") || body_text.contains("SERVICE_DISABLED") {
                FetchErrorKind::ConnectionError
            } else {
                FetchErrorKind::AuthError
            }
        } else if status == reqwest::StatusCode::NOT_FOUND {
            FetchErrorKind::NotConfigured
        } else {
            FetchErrorKind::ConnectionError
        };
        return Err(FetchModelsError {
            kind,
            message: format!("Speech-to-Text APIエラー ({}): {}", status, body_text),
        });
    }

    let json: serde_json::Value = resp.json().await.map_err(|e| FetchModelsError {
        kind: FetchErrorKind::ConnectionError,
        message: format!("レスポンス解析に失敗しました: {}", e),
    })?;

    parse_google_stt_response(&json)
}

fn resolve_google_stt_builtin_audio(
    app: &tauri::AppHandle,
) -> Result<std::path::PathBuf, FetchModelsError> {
    use tauri::Manager;
    let resource_path = app
        .path()
        .resolve(
            "resources/google-stt-test-ja.wav",
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|_e| FetchModelsError {
            kind: FetchErrorKind::NotConfigured,
            message: "同梱テスト音声のパス解決に失敗しました".to_string(),
        })?;
    validate_google_stt_builtin_audio_path(resource_path)
}

fn validate_google_stt_builtin_audio_path(
    path: std::path::PathBuf,
) -> Result<std::path::PathBuf, FetchModelsError> {
    if !path.is_file() {
        return Err(FetchModelsError {
            kind: FetchErrorKind::NotConfigured,
            message: "同梱テスト音声が見つかりません".to_string(),
        });
    }
    Ok(path)
}

#[tauri::command]
async fn google_stt_run_builtin_test(
    app: tauri::AppHandle,
    input: GoogleSttBuiltinTestInput,
) -> Result<GoogleSttRecognizeResult, FetchModelsError> {
    let audio_path = resolve_google_stt_builtin_audio(&app)?;
    let config = google_stt_builtin_recognition_config();
    recognize_google_stt_audio(
        &input.project_id,
        &input.location,
        config.recognizer_id,
        config.language_code,
        config.model,
        &audio_path,
    )
    .await
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            load_api_settings,
            save_provider_config,
            save_provider_secret,
            fetch_models,
            test_connection_ollama,
            test_llm_connection,
            get_env_var,
            google_stt_check_adc,
            google_stt_list_projects,
            google_stt_recognize,
            google_stt_run_builtin_test
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- is_openai_compatible ----

    #[test]
    fn test_openai_compatible_providers() {
        let expected = vec![
            "openai", "openai_audio", "groq", "groq_speech", "deepseek",
            "openrouter", "mistral", "moonshot", "minimax",
        ];
        for id in &expected {
            assert!(is_openai_compatible(id), "{} should be OpenAI-compatible", id);
        }
    }

    #[test]
    fn test_non_openai_compatible_providers() {
        let not_compatible = vec![
            "anthropic", "gemini", "ollama", "assemblyai",
            "google_stt", "azure_speech", "xiaomi_mimo_asr", "zai_glm",
        ];
        for id in &not_compatible {
            assert!(!is_openai_compatible(id), "{} should NOT be OpenAI-compatible", id);
        }
    }

    // ---- classify_http_error ----

    #[test]
    fn test_classify_http_error_401_is_auth() {
        let err = classify_http_error(reqwest::StatusCode::UNAUTHORIZED, "Unauthorized");
        assert_eq!(err.kind, FetchErrorKind::AuthError);
        assert!(err.message.contains("認証"));
        assert!(!err.message.contains("Unauthorized"));
    }

    #[test]
    fn test_classify_http_error_403_is_auth() {
        let err = classify_http_error(reqwest::StatusCode::FORBIDDEN, "Forbidden");
        assert_eq!(err.kind, FetchErrorKind::AuthError);
    }

    #[test]
    fn test_classify_http_error_500_is_connection() {
        let err = classify_http_error(reqwest::StatusCode::INTERNAL_SERVER_ERROR, "Server Error");
        assert_eq!(err.kind, FetchErrorKind::ConnectionError);
        assert!(err.message.contains("500"));
    }

    // ---- resolve_api_key (replaced by resolve_provider_config) ----

    // (tests removed: resolve_api_key was superseded by resolve_provider_config)

    // ---- OpenAI-compatible response parsing ----

    #[test]
    fn test_parse_openai_compatible_response() {
        let json: serde_json::Value = serde_json::json!({
            "data": [
                { "id": "gpt-4o", "object": "model" },
                { "id": "whisper-1", "object": "model" },
                { "id": "gpt-4o-mini", "object": "model" }
            ]
        });
        let models: Vec<String> = json["data"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|m| m["id"].as_str().map(String::from))
            .collect();
        assert_eq!(models, vec!["gpt-4o", "whisper-1", "gpt-4o-mini"]);
    }

    #[test]
    fn test_parse_openai_response_missing_data_field() {
        let json: serde_json::Value = serde_json::json!({ "error": "no data" });
        let result = json["data"].as_array();
        assert!(result.is_none());
    }

    // ---- Ollama response parsing ----

    #[test]
    fn test_parse_ollama_response() {
        let json: serde_json::Value = serde_json::json!({
            "models": [
                { "name": "llama3:8b", "model": "llama3:8b" },
                { "name": "mistral:7b", "model": "mistral:7b" }
            ]
        });
        let models: Vec<String> = json["models"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|m| m["name"].as_str().map(String::from))
            .collect();
        assert_eq!(models, vec!["llama3:8b", "mistral:7b"]);
    }

    #[test]
    fn test_parse_ollama_response_missing_models_field() {
        let json: serde_json::Value = serde_json::json!({ "error": "no models" });
        let result = json["models"].as_array();
        assert!(result.is_none());
    }

    // ---- Gemini response parsing ----

    #[test]
    fn test_parse_gemini_response() {
        let json: serde_json::Value = serde_json::json!({
            "models": [
                { "name": "models/gemini-2.5-pro" },
                { "name": "models/gemini-2.5-flash" }
            ]
        });
        let models: Vec<String> = json["models"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|m| m["name"].as_str().map(|s| s.to_string()))
            .collect();
        assert_eq!(models, vec!["models/gemini-2.5-pro", "models/gemini-2.5-flash"]);
    }

    // ---- settings.json does NOT contain API keys ----

    #[test]
    fn test_settings_serialization_no_api_key_field() {
        let settings = AppSettings {
            providers: {
                let mut m = HashMap::new();
                m.insert(
                    "openai".to_string(),
                    ProviderSettings {
                        env_name: Some("OPENAI_API_KEY".to_string()),
                        base_url: Some("https://api.openai.com/v1".to_string()),
                        default_model: Some("gpt-4o".to_string()),
                        options: None,
                    },
                );
                m
            },
        };
        let json = serde_json::to_string(&settings).unwrap();
        assert!(!json.contains("sk-"), "settings.json must not contain API keys");
        assert!(!json.contains("api_key"), "settings.json must not contain api_key field");
        assert!(json.contains("OPENAI_API_KEY"), "settings.json should contain env_name");
    }

    // ---- Ollama env_name=None save/restore ----

    #[test]
    fn test_ollama_env_name_none_serialization() {
        let settings = AppSettings {
            providers: {
                let mut m = HashMap::new();
                m.insert(
                    "ollama".to_string(),
                    ProviderSettings {
                        env_name: None,
                        base_url: Some("http://localhost:11434".to_string()),
                        default_model: None,
                        options: None,
                    },
                );
                m
            },
        };
        let json = serde_json::to_string(&settings).unwrap();
        assert!(json.contains("null"), "env_name should serialize as null for Ollama");

        let restored: AppSettings = serde_json::from_str(&json).unwrap();
        let ollama = restored.providers.get("ollama").unwrap();
        assert!(ollama.env_name.is_none());
        assert_eq!(ollama.base_url.as_deref(), Some("http://localhost:11434"));
    }

    // ---- Moonshot base URL migration ----

    #[test]
    fn test_migrate_moonshot_old_url_to_new_url() {
        let mut settings = AppSettings {
            providers: {
                let mut m = HashMap::new();
                m.insert(
                    "moonshot".to_string(),
                    ProviderSettings {
                        env_name: Some("MOONSHOT_API_KEY".to_string()),
                        base_url: Some("https://api.moonshot.cn/v1".to_string()),
                        default_model: None,
                        options: None,
                    },
                );
                m
            },
        };
        migrate_settings(&mut settings);
        let moonshot = settings.providers.get("moonshot").unwrap();
        assert_eq!(
            moonshot.base_url.as_deref(),
            Some("https://api.moonshot.ai/v1"),
        );
    }

    #[test]
    fn test_migrate_moonshot_custom_url_untouched() {
        let mut settings = AppSettings {
            providers: {
                let mut m = HashMap::new();
                m.insert(
                    "moonshot".to_string(),
                    ProviderSettings {
                        env_name: Some("MOONSHOT_API_KEY".to_string()),
                        base_url: Some("https://custom.example.com/v1".to_string()),
                        default_model: None,
                        options: None,
                    },
                );
                m
            },
        };
        migrate_settings(&mut settings);
        let moonshot = settings.providers.get("moonshot").unwrap();
        assert_eq!(
            moonshot.base_url.as_deref(),
            Some("https://custom.example.com/v1"),
        );
    }

    #[test]
    fn test_migrate_no_moonshot_provider() {
        let mut settings = AppSettings::default();
        migrate_settings(&mut settings);
        assert!(settings.providers.is_empty());
    }

    // ---- FetchModelsError serialization ----

    #[test]
    fn test_fetch_models_error_serialization() {
        let err = FetchModelsError {
            kind: FetchErrorKind::AuthError,
            message: "認証エラー (401)".to_string(),
        };
        let json = serde_json::to_string(&err).unwrap();
        assert!(json.contains("auth_error"));
        assert!(json.contains("認証エラー"));
    }

    // ---- Unsupported provider error ----

    #[test]
    fn test_unsupported_provider_error_kind() {
        let err = FetchModelsError {
            kind: FetchErrorKind::Unsupported,
            message: "このプロバイダーはモデル一覧の自動取得に対応していません".to_string(),
        };
        assert_eq!(err.kind, FetchErrorKind::Unsupported);
    }

    // ---- Ollama fetch_models settings resolution ----

    /// OllamaのURL解決ロジック（fetch_modelsと同じ分岐）
    fn resolve_ollama_base_url(settings: &AppSettings) -> &str {
        settings
            .providers
            .get("ollama")
            .and_then(|p| p.base_url.as_deref())
            .filter(|url| !url.trim().is_empty())
            .unwrap_or("http://localhost:11434")
    }

    #[test]
    fn test_ollama_no_settings_uses_default_url() {
        let settings = AppSettings::default();
        assert_eq!(resolve_ollama_base_url(&settings), "http://localhost:11434");
    }

    #[test]
    fn test_ollama_saved_url_is_used() {
        let mut settings = AppSettings::default();
        settings.providers.insert(
            "ollama".to_string(),
            ProviderSettings {
                env_name: None,
                base_url: Some("http://192.168.1.100:11434".to_string()),
                default_model: Some("llama3:8b".to_string()),
                options: None,
            },
        );
        assert_eq!(resolve_ollama_base_url(&settings), "http://192.168.1.100:11434");
    }

    #[test]
    fn test_ollama_empty_url_uses_default() {
        let mut settings = AppSettings::default();
        settings.providers.insert(
            "ollama".to_string(),
            ProviderSettings {
                env_name: None,
                base_url: Some("".to_string()),
                default_model: None,
                options: None,
            },
        );
        assert_eq!(resolve_ollama_base_url(&settings), "http://localhost:11434");
    }

    #[test]
    fn test_ollama_none_url_uses_default() {
        let mut settings = AppSettings::default();
        settings.providers.insert(
            "ollama".to_string(),
            ProviderSettings {
                env_name: None,
                base_url: None,
                default_model: None,
                options: None,
            },
        );
        assert_eq!(resolve_ollama_base_url(&settings), "http://localhost:11434");
    }

    /// fetch_models_ollamaに渡すURLが正しい形式（/api/tags接尾辞）か検証
    #[test]
    fn test_ollama_url_construction_with_trailing_slash() {
        let url = build_ollama_endpoint("http://localhost:11434/", "api/tags").unwrap();
        assert_eq!(url.as_str(), "http://localhost:11434/api/tags");
    }

    #[test]
    fn test_ollama_url_construction_without_trailing_slash() {
        let url = build_ollama_endpoint("http://localhost:11434", "api/tags").unwrap();
        assert_eq!(url.as_str(), "http://localhost:11434/api/tags");
    }

    // ---- build_ollama_endpoint ----

    #[test]
    fn test_build_ollama_endpoint_empty_url_uses_default() {
        let url = build_ollama_endpoint("", "api/version").unwrap();
        assert_eq!(url.as_str(), "http://localhost:11434/api/version");
    }

    #[test]
    fn test_build_ollama_endpoint_whitespace_url_uses_default() {
        let url = build_ollama_endpoint("   ", "api/version").unwrap();
        assert_eq!(url.as_str(), "http://localhost:11434/api/version");
    }

    #[test]
    fn test_build_ollama_endpoint_strips_query_and_fragment() {
        let url = build_ollama_endpoint("http://localhost:11434?key=val#frag", "api/tags").unwrap();
        assert_eq!(url.as_str(), "http://localhost:11434/api/tags");
        assert!(url.query().is_none());
        assert!(url.fragment().is_none());
    }

    #[test]
    fn test_build_ollama_endpoint_rejects_ftp_scheme() {
        let result = build_ollama_endpoint("ftp://localhost:11434", "api/tags");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert_eq!(err.kind, FetchErrorKind::NotConfigured);
        assert!(err.message.contains("httpまたはhttps"));
    }

    #[test]
    fn test_build_ollama_endpoint_rejects_auth_info() {
        let result = build_ollama_endpoint("http://user:pass@localhost:11434", "api/tags");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert_eq!(err.kind, FetchErrorKind::NotConfigured);
        assert!(err.message.contains("認証情報"));
    }

    #[test]
    fn test_build_ollama_endpoint_rejects_invalid_url() {
        let result = build_ollama_endpoint("not-a-url", "api/tags");
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().kind, FetchErrorKind::NotConfigured);
    }

    #[test]
    fn test_build_ollama_endpoint_custom_port() {
        let url = build_ollama_endpoint("http://192.168.1.100:9999", "api/version").unwrap();
        assert_eq!(url.as_str(), "http://192.168.1.100:9999/api/version");
    }

    #[test]
    fn test_build_ollama_endpoint_version_endpoint() {
        let url = build_ollama_endpoint("http://localhost:11434", "api/version").unwrap();
        assert_eq!(url.as_str(), "http://localhost:11434/api/version");
    }

    // ---- parse_ollama_version ----

    #[test]
    fn test_parse_ollama_version_success() {
        let body = r#"{"version":"0.6.2"}"#;
        let version = parse_ollama_version(body).unwrap();
        assert_eq!(version, "0.6.2");
    }

    #[test]
    fn test_parse_ollama_version_empty_string() {
        let body = r#"{"version":""}"#;
        let result = parse_ollama_version(body);
        assert!(result.is_err());
        assert!(result.unwrap_err().message.contains("バージョンを取得できませんでした"));
    }

    #[test]
    fn test_parse_ollama_version_whitespace_only() {
        let body = r#"{"version":"   "}"#;
        let result = parse_ollama_version(body);
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_ollama_version_missing_field() {
        let body = r#"{"other":"value"}"#;
        let result = parse_ollama_version(body);
        assert!(result.is_err());
        assert!(result.unwrap_err().message.contains("Ollamaとして認識"));
    }

    #[test]
    fn test_parse_ollama_version_invalid_json() {
        let body = "not json";
        let result = parse_ollama_version(body);
        assert!(result.is_err());
        assert!(result.unwrap_err().message.contains("Ollamaとして認識"));
    }

    #[test]
    fn test_parse_ollama_version_empty_body() {
        let result = parse_ollama_version("");
        assert!(result.is_err());
    }

    // ---- TestConnectionResult serialization ----

    #[test]
    fn test_connection_result_serialization() {
        let result = TestConnectionResult {
            version: "0.6.2".to_string(),
            message: "接続成功（Ollama v0.6.2）".to_string(),
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("0.6.2"));
        assert!(json.contains("接続成功"));
        assert!(json.contains("version"));
        assert!(json.contains("message"));
    }

    #[test]
    fn test_connection_result_deserialization() {
        let json = r#"{"version":"0.6.2","message":"接続成功（Ollama v0.6.2）"}"#;
        let result: TestConnectionResult = serde_json::from_str(json).unwrap();
        assert_eq!(result.version, "0.6.2");
        assert_eq!(result.message, "接続成功（Ollama v0.6.2）");
    }

    // ---- model_fetch_adapter ----

    #[test]
    fn test_model_fetch_adapter_openai_compatible() {
        for id in &["openai", "openai_audio", "groq", "groq_speech", "deepseek", "openrouter", "mistral", "moonshot", "minimax"] {
            assert_eq!(model_fetch_adapter(id), Some(ModelFetchAdapter::OpenAiCompatible), "{} should be OpenAiCompatible", id);
        }
    }

    #[test]
    fn test_model_fetch_adapter_anthropic() {
        assert_eq!(model_fetch_adapter("anthropic"), Some(ModelFetchAdapter::Anthropic));
    }

    #[test]
    fn test_model_fetch_adapter_gemini() {
        assert_eq!(model_fetch_adapter("gemini"), Some(ModelFetchAdapter::Gemini));
    }

    #[test]
    fn test_model_fetch_adapter_ollama() {
        assert_eq!(model_fetch_adapter("ollama"), Some(ModelFetchAdapter::Ollama));
    }

    #[test]
    fn test_model_fetch_adapter_manual_providers_are_none() {
        for id in &["deepgram", "assemblyai", "google_stt", "azure_speech", "xiaomi_mimo_asr", "zai_glm"] {
            assert_eq!(model_fetch_adapter(id), None, "{} should be None (manual)", id);
        }
    }

    #[test]
    fn test_model_fetch_adapter_unknown_is_none() {
        assert_eq!(model_fetch_adapter("unknown_provider"), None);
        assert_eq!(model_fetch_adapter(""), None);
    }

    #[test]
    fn all_api_model_providers_have_fetch_adapters() {
        let api_ids = [
            "openai", "openai_audio", "groq", "groq_speech",
            "anthropic", "gemini", "deepseek", "openrouter",
            "mistral", "groq", "ollama", "moonshot", "minimax",
        ];
        for id in api_ids {
            assert!(model_fetch_adapter(id).is_some(), "missing model fetch adapter for {}", id);
        }
    }

    // ---- parse_openai_models_response ----

    #[test]
    fn test_parse_openai_models_normal() {
        let json = serde_json::json!({
            "data": [
                { "id": "gpt-4o", "object": "model" },
                { "id": "whisper-1", "object": "model" },
                { "id": "gpt-4o-mini", "object": "model" }
            ]
        });
        let models = parse_openai_models_response(&json).unwrap();
        assert_eq!(models, vec!["gpt-4o", "whisper-1", "gpt-4o-mini"]);
    }

    #[test]
    fn test_parse_openai_models_missing_data() {
        let json = serde_json::json!({ "error": "no data" });
        let result = parse_openai_models_response(&json);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().kind, FetchErrorKind::ConnectionError);
    }

    #[test]
    fn test_parse_openai_models_data_not_array() {
        let json = serde_json::json!({ "data": "not an array" });
        let result = parse_openai_models_response(&json);
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_openai_models_empty_array() {
        let json = serde_json::json!({ "data": [] });
        let models = parse_openai_models_response(&json).unwrap();
        assert!(models.is_empty());
    }

    #[test]
    fn test_parse_openai_models_element_missing_id() {
        let json = serde_json::json!({
            "data": [
                { "id": "gpt-4o" },
                { "object": "model" },
                { "id": "whisper-1" }
            ]
        });
        let models = parse_openai_models_response(&json).unwrap();
        assert_eq!(models, vec!["gpt-4o", "whisper-1"]);
    }

    #[test]
    fn test_parse_openai_models_order_preserved() {
        let json = serde_json::json!({
            "data": [
                { "id": "z-model" },
                { "id": "a-model" },
                { "id": "m-model" }
            ]
        });
        let models = parse_openai_models_response(&json).unwrap();
        assert_eq!(models, vec!["z-model", "a-model", "m-model"]);
    }

    #[test]
    fn test_parse_openai_models_duplicates_preserved() {
        let json = serde_json::json!({
            "data": [
                { "id": "gpt-4o" },
                { "id": "gpt-4o" }
            ]
        });
        let models = parse_openai_models_response(&json).unwrap();
        assert_eq!(models, vec!["gpt-4o", "gpt-4o"]);
    }

    // ---- parse_anthropic_models_response ----

    #[test]
    fn test_parse_anthropic_models_normal() {
        let json = serde_json::json!({
            "data": [
                { "id": "claude-sonnet-4-20250514" },
                { "id": "claude-haiku-4-5-20251001" }
            ]
        });
        let models = parse_anthropic_models_response(&json).unwrap();
        assert_eq!(models, vec!["claude-sonnet-4-20250514", "claude-haiku-4-5-20251001"]);
    }

    #[test]
    fn test_parse_anthropic_models_missing_data() {
        let json = serde_json::json!({ "models": [] });
        let result = parse_anthropic_models_response(&json);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().kind, FetchErrorKind::ConnectionError);
    }

    #[test]
    fn test_parse_anthropic_models_empty_array() {
        let json = serde_json::json!({ "data": [] });
        let models = parse_anthropic_models_response(&json).unwrap();
        assert!(models.is_empty());
    }

    // ---- parse_gemini_models_response ----

    #[test]
    fn test_parse_gemini_models_normal() {
        let json = serde_json::json!({
            "models": [
                { "name": "models/gemini-2.5-pro" },
                { "name": "models/gemini-2.5-flash" }
            ]
        });
        let models = parse_gemini_models_response(&json).unwrap();
        assert_eq!(models, vec!["models/gemini-2.5-pro", "models/gemini-2.5-flash"]);
    }

    #[test]
    fn test_parse_gemini_models_missing_models_field() {
        let json = serde_json::json!({ "data": [] });
        let result = parse_gemini_models_response(&json);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().kind, FetchErrorKind::ConnectionError);
    }

    #[test]
    fn test_parse_gemini_models_not_array() {
        let json = serde_json::json!({ "models": "not an array" });
        let result = parse_gemini_models_response(&json);
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_gemini_models_empty_array() {
        let json = serde_json::json!({ "models": [] });
        let models = parse_gemini_models_response(&json).unwrap();
        assert!(models.is_empty());
    }

    #[test]
    fn test_parse_gemini_models_name_not_stripped() {
        // Geminiのmodels/プレフィックスは除去しない（既存挙動維持）
        let json = serde_json::json!({
            "models": [
                { "name": "models/gemini-2.5-pro" }
            ]
        });
        let models = parse_gemini_models_response(&json).unwrap();
        assert_eq!(models[0], "models/gemini-2.5-pro");
    }

    // ---- parse_ollama_models_response ----

    #[test]
    fn test_parse_ollama_models_normal() {
        let json = serde_json::json!({
            "models": [
                { "name": "llama3:8b", "model": "llama3:8b" },
                { "name": "mistral:7b", "model": "mistral:7b" }
            ]
        });
        let models = parse_ollama_models_response(&json).unwrap();
        assert_eq!(models, vec!["llama3:8b", "mistral:7b"]);
    }

    #[test]
    fn test_parse_ollama_models_missing_models_field() {
        let json = serde_json::json!({ "error": "no models" });
        let result = parse_ollama_models_response(&json);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().kind, FetchErrorKind::ConnectionError);
    }

    #[test]
    fn test_parse_ollama_models_not_array() {
        let json = serde_json::json!({ "models": "not an array" });
        let result = parse_ollama_models_response(&json);
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_ollama_models_empty_array() {
        let json = serde_json::json!({ "models": [] });
        let models = parse_ollama_models_response(&json).unwrap();
        assert!(models.is_empty());
    }

    #[test]
    fn test_parse_ollama_models_element_missing_name() {
        let json = serde_json::json!({
            "models": [
                { "name": "llama3:8b" },
                { "model": "no-name-field" },
                { "name": "mistral:7b" }
            ]
        });
        let models = parse_ollama_models_response(&json).unwrap();
        assert_eq!(models, vec!["llama3:8b", "mistral:7b"]);
    }

    // ---- invalid_models_response ----

    #[test]
    fn test_invalid_models_response_kind() {
        let err = invalid_models_response("テストメッセージ");
        assert_eq!(err.kind, FetchErrorKind::ConnectionError);
        assert_eq!(err.message, "テストメッセージ");
    }

    // ---- provider_defaults ----

    #[test]
    fn test_provider_defaults_returns_values_for_openai() {
        let defaults = provider_defaults("openai").unwrap();
        assert_eq!(defaults.env_name, "OPENAI_API_KEY");
        assert_eq!(defaults.base_url, "https://api.openai.com/v1");
    }

    #[test]
    fn test_provider_defaults_ollama_is_none() {
        // ollama は fetch_models 内で個別処理されるため provider_defaults の対象外
        assert!(provider_defaults("ollama").is_none());
    }

    #[test]
    fn test_provider_defaults_unknown_returns_none() {
        assert!(provider_defaults("nonexistent").is_none());
    }

    // ---- resolve_provider_config ----

    #[test]
    fn test_resolve_returns_saved_when_both_filled() {
        let saved = ProviderSettings {
            env_name: Some("CUSTOM_KEY".to_string()),
            base_url: Some("https://custom.example.com/v1".to_string()),
            default_model: None,
            options: None,
        };
        let resolved = resolve_provider_config("openai", Some(&saved)).unwrap();
        assert_eq!(resolved.env_name, "CUSTOM_KEY");
        assert_eq!(resolved.base_url, "https://custom.example.com/v1");
    }

    #[test]
    fn test_resolve_uses_default_env_name_when_saved_is_none() {
        let saved = ProviderSettings {
            env_name: None,
            base_url: Some("https://custom.example.com/v1".to_string()),
            default_model: None,
            options: None,
        };
        let resolved = resolve_provider_config("openai", Some(&saved)).unwrap();
        assert_eq!(resolved.env_name, "OPENAI_API_KEY");
    }

    #[test]
    fn test_resolve_uses_default_base_url_when_saved_is_none() {
        let saved = ProviderSettings {
            env_name: Some("CUSTOM_KEY".to_string()),
            base_url: None,
            default_model: None,
            options: None,
        };
        let resolved = resolve_provider_config("openai", Some(&saved)).unwrap();
        assert_eq!(resolved.base_url, "https://api.openai.com/v1");
    }

    #[test]
    fn test_resolve_both_none_falls_back_to_defaults() {
        let saved = ProviderSettings {
            env_name: None,
            base_url: None,
            default_model: None,
            options: None,
        };
        let resolved = resolve_provider_config("gemini", Some(&saved)).unwrap();
        assert_eq!(resolved.env_name, "GEMINI_API_KEY");
        assert_eq!(resolved.base_url, "https://generativelanguage.googleapis.com/v1beta");
    }

    #[test]
    fn test_resolve_no_saved_uses_defaults() {
        let resolved = resolve_provider_config("anthropic", None).unwrap();
        assert_eq!(resolved.env_name, "ANTHROPIC_API_KEY");
        assert_eq!(resolved.base_url, "https://api.anthropic.com");
    }

    #[test]
    fn test_resolve_empty_env_name_falls_back_to_default() {
        let saved = ProviderSettings {
            env_name: Some("".to_string()),
            base_url: Some("https://custom.example.com/v1".to_string()),
            default_model: None,
            options: None,
        };
        let resolved = resolve_provider_config("openai", Some(&saved)).unwrap();
        assert_eq!(resolved.env_name, "OPENAI_API_KEY");
    }

    #[test]
    fn test_resolve_whitespace_env_name_falls_back_to_default() {
        let saved = ProviderSettings {
            env_name: Some("   ".to_string()),
            base_url: Some("https://custom.example.com/v1".to_string()),
            default_model: None,
            options: None,
        };
        let resolved = resolve_provider_config("openai", Some(&saved)).unwrap();
        assert_eq!(resolved.env_name, "OPENAI_API_KEY");
    }

    #[test]
    fn test_resolve_empty_base_url_falls_back_to_default() {
        let saved = ProviderSettings {
            env_name: Some("CUSTOM_KEY".to_string()),
            base_url: Some("".to_string()),
            default_model: None,
            options: None,
        };
        let resolved = resolve_provider_config("openai", Some(&saved)).unwrap();
        assert_eq!(resolved.base_url, "https://api.openai.com/v1");
    }

    #[test]
    fn test_resolve_unknown_provider_no_saved_returns_error() {
        let result = resolve_provider_config("nonexistent", None);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().kind, FetchErrorKind::NotConfigured);
    }

    #[test]
    fn test_resolve_unknown_provider_saved_is_used() {
        let saved = ProviderSettings {
            env_name: Some("MY_KEY".to_string()),
            base_url: Some("https://example.com".to_string()),
            default_model: None,
            options: None,
        };
        let resolved = resolve_provider_config("nonexistent", Some(&saved)).unwrap();
        assert_eq!(resolved.env_name, "MY_KEY");
        assert_eq!(resolved.base_url, "https://example.com");
    }

    // ---- build_google_stt_base_url ----

    #[test]
    fn test_build_google_stt_base_url_us_central1() {
        let url = build_google_stt_base_url("us-central1").unwrap();
        assert_eq!(url, "https://us-central1-speech.googleapis.com/v2");
    }

    #[test]
    fn test_build_google_stt_base_url_asia_southeast1() {
        let url = build_google_stt_base_url("asia-southeast1").unwrap();
        assert_eq!(url, "https://asia-southeast1-speech.googleapis.com/v2");
    }

    #[test]
    fn test_build_google_stt_base_url_europe_west4() {
        let url = build_google_stt_base_url("europe-west4").unwrap();
        assert_eq!(url, "https://europe-west4-speech.googleapis.com/v2");
    }

    #[test]
    fn test_build_google_stt_base_url_invalid_location() {
        let result = build_google_stt_base_url("us-east1");
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().kind, FetchErrorKind::NotConfigured);
    }

    // ---- build_google_stt_recognize_url ----

    #[test]
    fn test_build_google_stt_recognize_url_normal() {
        let url = build_google_stt_recognize_url(
            "https://us-central1-speech.googleapis.com/v2",
            "my-project",
            "us-central1",
            "_",
        );
        assert_eq!(
            url,
            "https://us-central1-speech.googleapis.com/v2/projects/my-project/locations/us-central1/recognizers/_:recognize"
        );
    }

    #[test]
    fn test_build_google_stt_recognize_url_trailing_slash() {
        let url = build_google_stt_recognize_url(
            "https://us-central1-speech.googleapis.com/v2/",
            "proj",
            "us-central1",
            "_",
        );
        assert!(url.contains("/v2/projects/"));
        assert!(!url.contains("/v2//projects/"));
    }

    // ---- build_google_stt_request_body ----

    #[test]
    fn test_build_google_stt_request_body_auto_decoding_config() {
        let body = build_google_stt_request_body("dGVzdA==", "chirp_2", "ja-JP");
        assert!(body.get("config").is_some());
        let config = body.get("config").unwrap();
        assert!(config.get("autoDecodingConfig").is_some());
        assert_eq!(config.get("autoDecodingConfig").unwrap(), &serde_json::json!({}));
    }

    #[test]
    fn test_build_google_stt_request_body_language_codes_array() {
        let body = build_google_stt_request_body("dGVzdA==", "chirp_2", "ja-JP");
        let config = body.get("config").unwrap();
        let lang_codes = config.get("languageCodes").unwrap().as_array().unwrap();
        assert_eq!(lang_codes, &vec![serde_json::json!("ja-JP")]);
    }

    #[test]
    fn test_build_google_stt_request_body_model() {
        let body = build_google_stt_request_body("dGVzdA==", "chirp_2", "ja-JP");
        let config = body.get("config").unwrap();
        assert_eq!(config.get("model").unwrap().as_str().unwrap(), "chirp_2");
    }

    #[test]
    fn test_build_google_stt_request_body_content_is_base64() {
        let body = build_google_stt_request_body("dGVzdA==", "chirp_2", "ja-JP");
        assert_eq!(body.get("content").unwrap().as_str().unwrap(), "dGVzdA==");
    }

    #[test]
    fn test_build_google_stt_request_body_no_file_path_or_token() {
        let body = build_google_stt_request_body("dGVzdA==", "chirp_2", "ja-JP");
        let json_str = serde_json::to_string(&body).unwrap();
        assert!(!json_str.contains("audio_path"));
        assert!(!json_str.contains("ya29."));
        assert!(!json_str.contains("access_token"));
    }

    // ---- parse_google_stt_response ----

    #[test]
    fn test_parse_google_stt_response_normal() {
        let json = serde_json::json!({
            "results": [
                {
                    "alternatives": [{ "transcript": "こんにちは", "confidence": 0.95 }],
                    "languageCode": "ja-JP"
                },
                {
                    "alternatives": [{ "transcript": "世界", "confidence": 0.88 }],
                    "languageCode": "ja-JP"
                }
            ]
        });
        let result = parse_google_stt_response(&json).unwrap();
        assert_eq!(result.transcript, "こんにちは世界");
        assert_eq!(result.segments.len(), 2);
        assert_eq!(result.segments[0].transcript, "こんにちは");
        assert_eq!(result.segments[0].confidence, Some(0.95));
        assert_eq!(result.segments[0].language_code.as_deref(), Some("ja-JP"));
        assert_eq!(result.segments[1].transcript, "世界");
    }

    #[test]
    fn test_parse_google_stt_response_no_results() {
        let json = serde_json::json!({});
        let result = parse_google_stt_response(&json).unwrap();
        assert_eq!(result.transcript, "");
        assert!(result.segments.is_empty());
    }

    #[test]
    fn test_parse_google_stt_response_empty_results() {
        let json = serde_json::json!({ "results": [] });
        let result = parse_google_stt_response(&json).unwrap();
        assert_eq!(result.transcript, "");
        assert!(result.segments.is_empty());
    }

    #[test]
    fn test_parse_google_stt_response_no_alternatives() {
        let json = serde_json::json!({
            "results": [
                { "alternatives": [] },
                { "alternatives": [{ "transcript": "テスト", "confidence": 0.7 }] }
            ]
        });
        let result = parse_google_stt_response(&json).unwrap();
        assert_eq!(result.transcript, "テスト");
        assert_eq!(result.segments.len(), 1);
    }

    #[test]
    fn test_parse_google_stt_response_no_confidence() {
        let json = serde_json::json!({
            "results": [
                { "alternatives": [{ "transcript": "hello" }] }
            ]
        });
        let result = parse_google_stt_response(&json).unwrap();
        assert_eq!(result.segments[0].confidence, None);
    }

    #[test]
    fn test_parse_google_stt_response_confidence_zero_is_none() {
        let json = serde_json::json!({
            "results": [
                { "alternatives": [{ "transcript": "test", "confidence": 0.0 }] }
            ]
        });
        let result = parse_google_stt_response(&json).unwrap();
        assert_eq!(result.segments[0].confidence, None);
    }

    #[test]
    fn test_parse_google_stt_response_no_language_code() {
        let json = serde_json::json!({
            "results": [
                { "alternatives": [{ "transcript": "test", "confidence": 0.5 }] }
            ]
        });
        let result = parse_google_stt_response(&json).unwrap();
        assert_eq!(result.segments[0].language_code, None);
    }

    // ---- ProviderSettings options ----

    #[test]
    fn test_provider_settings_options_serialization() {
        let mut options = HashMap::new();
        options.insert("project_id".to_string(), "my-project".to_string());
        options.insert("location".to_string(), "us-central1".to_string());
        let settings = ProviderSettings {
            env_name: None,
            base_url: Some("https://us-central1-speech.googleapis.com/v2".to_string()),
            default_model: Some("chirp_2".to_string()),
            options: Some(options),
        };
        let json = serde_json::to_string(&settings).unwrap();
        assert!(json.contains("project_id"));
        assert!(json.contains("my-project"));
    }

    #[test]
    fn test_provider_settings_options_none_not_serialized() {
        let settings = ProviderSettings {
            env_name: Some("KEY".to_string()),
            base_url: None,
            default_model: None,
            options: None,
        };
        let json = serde_json::to_string(&settings).unwrap();
        assert!(!json.contains("options"));
    }

    #[test]
    fn test_provider_settings_options_deserialization() {
        let json = r#"{"env_name":"KEY","base_url":"https://example.com","default_model":"m","options":{"project_id":"p"}}"#;
        let settings: ProviderSettings = serde_json::from_str(json).unwrap();
        let opts = settings.options.unwrap();
        assert_eq!(opts.get("project_id").unwrap(), "p");
    }

    // ---- save_provider_config options merge ----

    #[test]
    fn test_save_provider_config_options_none_keeps_existing() {
        let mut settings = AppSettings::default();
        let mut existing_opts = HashMap::new();
        existing_opts.insert("project_id".to_string(), "existing-proj".to_string());
        settings.providers.insert(
            "google_stt".to_string(),
            ProviderSettings {
                env_name: None,
                base_url: Some("https://us-central1-speech.googleapis.com/v2".to_string()),
                default_model: Some("chirp_2".to_string()),
                options: Some(existing_opts),
            },
        );

        let input = SaveProviderConfigInput {
            provider_id: "google_stt".to_string(),
            env_name: None,
            base_url: "https://us-central1-speech.googleapis.com/v2".to_string(),
            default_model: Some("chirp_2".to_string()),
            options: None,
        };

        let options = match input.options {
            Some(new_opts) => Some(new_opts),
            None => settings
                .providers
                .get(&input.provider_id)
                .and_then(|p| p.options.clone()),
        };

        assert!(options.is_some());
        assert_eq!(options.unwrap().get("project_id").unwrap(), "existing-proj");
    }

    // ---- validate_google_stt_input ----

    #[test]
    fn test_validate_google_stt_input_empty_project_id() {
        let input = GoogleSttRecognizeInput {
            project_id: "".to_string(),
            location: "us-central1".to_string(),
            recognizer_id: "_".to_string(),
            model: "chirp_2".to_string(),
            language_code: "ja-JP".to_string(),
            audio_path: "/tmp/test.wav".to_string(),
        };
        let result = validate_google_stt_input(&input);
        assert!(result.is_err());
        assert!(result.unwrap_err().message.contains("Project ID"));
    }

    #[test]
    fn test_validate_google_stt_input_invalid_location() {
        let input = GoogleSttRecognizeInput {
            project_id: "my-project-123".to_string(),
            location: "us-east1".to_string(),
            recognizer_id: "_".to_string(),
            model: "chirp_2".to_string(),
            language_code: "ja-JP".to_string(),
            audio_path: "/tmp/test.wav".to_string(),
        };
        let result = validate_google_stt_input(&input);
        assert!(result.is_err());
        assert!(result.unwrap_err().message.contains("リージョン"));
    }

    #[test]
    fn test_validate_google_stt_input_project_id_starts_with_digit() {
        let input = GoogleSttRecognizeInput {
            project_id: "1invalid-project".to_string(),
            location: "us-central1".to_string(),
            recognizer_id: "_".to_string(),
            model: "chirp_2".to_string(),
            language_code: "ja-JP".to_string(),
            audio_path: "/tmp/test.wav".to_string(),
        };
        let result = validate_google_stt_input(&input);
        assert!(result.is_err());
        assert!(result.unwrap_err().message.contains("小文字英字で始まる"));
    }

    #[test]
    fn test_validate_google_stt_input_project_id_too_short() {
        let input = GoogleSttRecognizeInput {
            project_id: "short".to_string(),
            location: "us-central1".to_string(),
            recognizer_id: "_".to_string(),
            model: "chirp_2".to_string(),
            language_code: "ja-JP".to_string(),
            audio_path: "/tmp/test.wav".to_string(),
        };
        let result = validate_google_stt_input(&input);
        assert!(result.is_err());
        assert!(result.unwrap_err().message.contains("6〜30文字"));
    }

    #[test]
    fn test_validate_google_stt_input_project_id_ends_with_hyphen() {
        let input = GoogleSttRecognizeInput {
            project_id: "my-project-".to_string(),
            location: "us-central1".to_string(),
            recognizer_id: "_".to_string(),
            model: "chirp_2".to_string(),
            language_code: "ja-JP".to_string(),
            audio_path: "/tmp/test.wav".to_string(),
        };
        let result = validate_google_stt_input(&input);
        assert!(result.is_err());
        assert!(result.unwrap_err().message.contains("ハイフンで終わって"));
    }

    #[test]
    fn test_validate_google_stt_input_valid() {
        let input = GoogleSttRecognizeInput {
            project_id: "my-project-123".to_string(),
            location: "us-central1".to_string(),
            recognizer_id: "_".to_string(),
            model: "chirp_2".to_string(),
            language_code: "ja-JP".to_string(),
            audio_path: "/tmp/test.wav".to_string(),
        };
        assert!(validate_google_stt_input(&input).is_ok());
    }

    // ---- parse_adc_quota_project ----

    #[test]
    fn test_parse_adc_quota_project_from_json() {
        let json = serde_json::json!({
            "type": "authorized_user",
            "client_id": "...",
            "client_secret": "...",
            "refresh_token": "...",
            "quota_project_id": "asr-composer-sohei"
        });
        let quota = json
            .get("quota_project_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        assert_eq!(quota.as_deref(), Some("asr-composer-sohei"));
    }

    #[test]
    fn test_parse_adc_quota_project_missing() {
        let json = serde_json::json!({
            "type": "authorized_user",
            "client_id": "..."
        });
        let quota = json
            .get("quota_project_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        assert!(quota.is_none());
    }

    // ---- find_gcloud_executable (実環境テスト) ----

    #[test]
    #[ignore] // CI環境ではgcloudが入っていないため
    fn test_find_gcloud_executable_on_this_machine() {
        let result = find_gcloud_executable();
        assert!(result.is_some(), "gcloud should be found on this machine");
        let path = result.unwrap();
        eprintln!("gcloud found at: {}", path.display());
    }

    #[test]
    #[ignore]
    fn test_get_adc_current_project_returns_value() {
        let gcloud = find_gcloud_executable().expect("gcloud not found");
        let project = get_adc_current_project(&gcloud);
        assert!(project.is_some(), "current project should be set");
        eprintln!("current project: {}", project.unwrap());
    }

    #[test]
    #[ignore]
    fn test_adc_check_components() {
        // find gcloud
        let gcloud = find_gcloud_executable();
        assert!(gcloud.is_some(), "gcloud not found");
        let gcloud = gcloud.unwrap();
        eprintln!("gcloud: {}", gcloud.display());

        // quota project from ADC JSON
        let quota = get_adc_quota_project();
        eprintln!("quota_project: {:?}", quota);

        // current project from gcloud config
        let current = get_adc_current_project(&gcloud);
        eprintln!("current_project: {:?}", current);
        assert!(current.is_some(), "current project should be set");
    }

    #[test]
    #[ignore]
    fn test_get_adc_access_token_returns_ya29() {
        let result = get_adc_access_token();
        assert!(result.is_ok(), "ADC token should be available: {:?}", result.err());
        let token = result.unwrap();
        assert!(token.starts_with("ya29."), "token should start with ya29.");
        eprintln!("token length: {} (not printing value)", token.len());
    }

    #[test]
    #[ignore]
    fn test_google_stt_recognize_with_speech() {
        let test_wav = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("test-speech-jp.wav");
        assert!(test_wav.exists(), "test-speech-jp.wav not found at {}", test_wav.display());

        let input = GoogleSttRecognizeInput {
            project_id: "asr-composer-sohei".to_string(),
            location: "us-central1".to_string(),
            recognizer_id: "_".to_string(),
            model: "chirp_2".to_string(),
            language_code: "ja-JP".to_string(),
            audio_path: test_wav.to_string_lossy().to_string(),
        };

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(async { google_stt_recognize(input).await });

        match &result {
            Ok(r) => {
                eprintln!("=== 発話音声テスト ===");
                eprintln!("transcript: '{}'", r.transcript);
                eprintln!("segments: {}", r.segments.len());
                for (i, seg) in r.segments.iter().enumerate() {
                    eprintln!("  [{}] '{}' confidence={:?} lang={:?}",
                        i, seg.transcript, seg.confidence, seg.language_code);
                }
                assert!(!r.transcript.is_empty(), "transcript should not be empty for speech audio");
            }
            Err(e) => {
                let msg = &e.message;
                assert!(!msg.contains("ya29."), "error must not contain access token");
                eprintln!("error_kind: {:?}", e.kind);
                eprintln!("error_message: {}", msg);
                panic!("speech recognition should succeed: {}", msg);
            }
        }
    }

    #[test]
    #[ignore]
    fn test_google_stt_recognize_with_silence() {
        let test_wav = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("test-audio.wav");
        assert!(test_wav.exists(), "test-audio.wav not found at {}", test_wav.display());

        let input = GoogleSttRecognizeInput {
            project_id: "asr-composer-sohei".to_string(),
            location: "us-central1".to_string(),
            recognizer_id: "_".to_string(),
            model: "chirp_2".to_string(),
            language_code: "ja-JP".to_string(),
            audio_path: test_wav.to_string_lossy().to_string(),
        };

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(async { google_stt_recognize(input).await });

        match &result {
            Ok(r) => {
                eprintln!("=== 無音テスト ===");
                eprintln!("transcript: '{}'", r.transcript);
                eprintln!("segments: {}", r.segments.len());
                for (i, seg) in r.segments.iter().enumerate() {
                    eprintln!("  [{}] '{}' confidence={:?} lang={:?}",
                        i, seg.transcript, seg.confidence, seg.language_code);
                }
                // 無音でもAPIエラーにならないことを確認
            }
            Err(e) => {
                let msg = &e.message;
                assert!(!msg.contains("ya29."), "error must not contain access token");
                eprintln!("error_kind: {:?}", e.kind);
                eprintln!("error_message: {}", msg);
                // 無音でエラーになることもあるが、gcloud/ADCレベルの失敗でないこと
                assert!(
                    !msg.contains("gcloud") && !msg.contains("ADC"),
                    "should not fail at gcloud/ADC level"
                );
            }
        }
    }

    // ---- parse_google_stt_projects ----

    #[test]
    fn test_parse_google_stt_projects_normal() {
        let json = r#"[
            {"projectId": "beta-project", "name": "Beta"},
            {"projectId": "alpha-project", "name": "Alpha"}
        ]"#;
        let projects = parse_google_stt_projects(json).unwrap();
        assert_eq!(projects.len(), 2);
        assert_eq!(projects[0].project_id, "alpha-project");
        assert_eq!(projects[0].name, "Alpha");
        assert_eq!(projects[1].project_id, "beta-project");
        assert_eq!(projects[1].name, "Beta");
    }

    #[test]
    fn test_parse_google_stt_projects_empty_array() {
        let projects = parse_google_stt_projects("[]").unwrap();
        assert!(projects.is_empty());
    }

    #[test]
    fn test_parse_google_stt_projects_invalid_json() {
        let result = parse_google_stt_projects("not json");
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_google_stt_projects_skips_missing_project_id() {
        let json = r#"[
            {"projectId": "valid-project", "name": "Valid"},
            {"name": "No ID"}
        ]"#;
        let projects = parse_google_stt_projects(json).unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].project_id, "valid-project");
    }

    #[test]
    fn test_parse_google_stt_projects_name_fallback_to_project_id() {
        let json = r#"[{"projectId": "my-proj"}]"#;
        let projects = parse_google_stt_projects(json).unwrap();
        assert_eq!(projects[0].name, "my-proj");
    }

    #[test]
    fn test_parse_google_stt_projects_dedup_by_project_id() {
        let json = r#"[
            {"projectId": "dup-proj", "name": "First"},
            {"projectId": "dup-proj", "name": "Second"}
        ]"#;
        let projects = parse_google_stt_projects(json).unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].name, "First");
    }

    #[test]
    fn test_parse_google_stt_projects_sorted_by_project_id() {
        let json = r#"[
            {"projectId": "z-project", "name": "Z"},
            {"projectId": "a-project", "name": "A"},
            {"projectId": "m-project", "name": "M"}
        ]"#;
        let projects = parse_google_stt_projects(json).unwrap();
        let ids: Vec<&str> = projects.iter().map(|p| p.project_id.as_str()).collect();
        assert_eq!(ids, vec!["a-project", "m-project", "z-project"]);
    }

    // ---- Google STT builtin test ----

    #[test]
    fn test_google_stt_builtin_recognition_config_fixed_values() {
        let config = google_stt_builtin_recognition_config();
        assert_eq!(config.recognizer_id, "_");
        assert_eq!(config.language_code, "ja-JP");
        assert_eq!(config.model, "chirp_2");
    }

    #[test]
    fn test_validate_google_stt_builtin_audio_path_exists() {
        let dir = std::env::temp_dir();
        let tmp_file = dir.join("__google_stt_test_exists__.tmp");
        fs::write(&tmp_file, b"test").unwrap();
        let result = validate_google_stt_builtin_audio_path(tmp_file.clone());
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), tmp_file);
        fs::remove_file(&tmp_file).ok();
    }

    #[test]
    fn test_validate_google_stt_builtin_audio_path_not_found() {
        let nonexistent = std::path::PathBuf::from("/nonexistent/path/test.wav");
        let result = validate_google_stt_builtin_audio_path(nonexistent);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.message.contains("同梱テスト音声が見つかりません"),
            "expected missing file message, got: {}",
            err.message,
        );
    }

    #[test]
    fn test_google_stt_builtin_test_input_only_project_id_and_location() {
        let json = r#"{"projectId":"my-proj","location":"us-central1"}"#;
        let input: GoogleSttBuiltinTestInput =
            serde_json::from_str(json).expect("should deserialize");
        assert_eq!(input.project_id, "my-proj");
        assert_eq!(input.location, "us-central1");
        // Confirm no languageCode field
        let parsed: serde_json::Value = serde_json::from_str(json).unwrap();
        assert!(
            !parsed.as_object().unwrap().contains_key("languageCode"),
            "input must not contain languageCode",
        );
    }

    #[test]
    fn test_google_stt_recognize_still_works_for_existing_path() {
        // Verify the existing recognize command delegates to the common function
        // by checking that the common function validates file existence
        let nonexistent = std::path::PathBuf::from("/nonexistent/audio.wav");
        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(async {
            recognize_google_stt_audio(
                "test-proj",
                "us-central1",
                "_",
                "ja-JP",
                "chirp_2",
                &nonexistent,
            )
            .await
        });
        assert!(result.is_err());
        assert!(result.unwrap_err().message.contains("音声ファイルが見つかりません"));
    }

    // ---- is_anthropic_provider ----

    #[test]
    fn test_is_anthropic_provider_xiaomi_mimo() {
        assert!(!is_anthropic_provider("xiaomi_mimo"));
    }

    #[test]
    fn test_is_anthropic_provider_anthropic() {
        assert!(is_anthropic_provider("anthropic"));
    }

    #[test]
    fn test_is_anthropic_provider_not_openai() {
        assert!(!is_anthropic_provider("openai"));
        assert!(!is_anthropic_provider("deepseek"));
        assert!(!is_anthropic_provider("moonshot"));
    }

    // ---- xiaomi_mimo provider defaults ----

    #[test]
    fn test_xiaomi_mimo_provider_defaults() {
        let defaults = provider_defaults("xiaomi_mimo").unwrap();
        assert_eq!(defaults.env_name, "XIAOMI_API_KEY");
        assert_eq!(defaults.base_url, "https://api.xiaomimimo.com/v1");
    }

    #[test]
    fn test_xiaomi_mimo_is_openai_compatible() {
        assert!(is_openai_compatible("xiaomi_mimo"));
    }

    #[test]
    fn test_xiaomi_mimo_openai_adapter() {
        assert_eq!(model_fetch_adapter("xiaomi_mimo"), Some(ModelFetchAdapter::OpenAiCompatible));
    }

    // ---- OpenAI URL construction ----

    #[test]
    fn test_mimo_openai_models_url() {
        let base_url = "https://api.xiaomimimo.com/v1";
        let url = format!("{}/models", base_url.trim_end_matches('/'));
        assert_eq!(url, "https://api.xiaomimimo.com/v1/models");
    }

    #[test]
    fn test_mimo_openai_chat_url() {
        let base_url = "https://api.xiaomimimo.com/v1";
        let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
        assert_eq!(url, "https://api.xiaomimimo.com/v1/chat/completions");
    }

    // ---- MiMo migration ----

    #[test]
    fn test_migrate_mimo_old_anthropic_url_to_openai() {
        let mut settings = AppSettings {
            providers: {
                let mut m = HashMap::new();
                m.insert(
                    "xiaomi_mimo".to_string(),
                    ProviderSettings {
                        env_name: Some("XIAOMI_API_KEY".to_string()),
                        base_url: Some("https://api.xiaomimimo.com/anthropic".to_string()),
                        default_model: None,
                        options: None,
                    },
                );
                m
            },
        };
        migrate_settings(&mut settings);
        let mimo = settings.providers.get("xiaomi_mimo").unwrap();
        assert_eq!(mimo.base_url.as_deref(), Some("https://api.xiaomimimo.com/v1"));
    }

    #[test]
    fn test_migrate_mimo_custom_url_untouched() {
        let mut settings = AppSettings {
            providers: {
                let mut m = HashMap::new();
                m.insert(
                    "xiaomi_mimo".to_string(),
                    ProviderSettings {
                        env_name: Some("XIAOMI_API_KEY".to_string()),
                        base_url: Some("https://custom.example.com/v1".to_string()),
                        default_model: None,
                        options: None,
                    },
                );
                m
            },
        };
        migrate_settings(&mut settings);
        let mimo = settings.providers.get("xiaomi_mimo").unwrap();
        assert_eq!(mimo.base_url.as_deref(), Some("https://custom.example.com/v1"));
    }

    // ---- Anthropic response parsing ----

    #[test]
    fn test_parse_anthropic_response_content_text() {
        let json = serde_json::json!({
            "content": [{"type": "text", "text": "1"}]
        });
        let text = json
            .get("content")
            .and_then(|c| c.as_array())
            .and_then(|arr| arr.first())
            .and_then(|block| block.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("");
        assert_eq!(text, "1");
    }

    #[test]
    fn test_parse_anthropic_response_empty_content() {
        let json = serde_json::json!({"content": []});
        let text = json
            .get("content")
            .and_then(|c| c.as_array())
            .and_then(|arr| arr.first())
            .and_then(|block| block.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("");
        assert_eq!(text, "");
    }

    #[test]
    fn test_parse_openai_response_not_used_for_anthropic() {
        // OpenAI format: choices[0].message.content
        let json = serde_json::json!({
            "choices": [{"message": {"content": "1"}}]
        });
        // Anthropic parser should NOT read this
        let text = json
            .get("content")
            .and_then(|c| c.as_array())
            .and_then(|arr| arr.first())
            .and_then(|block| block.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("");
        assert_eq!(text, ""); // correctly returns empty for non-Anthropic format
    }

    // ---- openai_token_limit_field ----

    #[test]
    fn test_openai_official_uses_max_completion_tokens() {
        assert!(matches!(
            openai_token_limit_field("openai", "gpt-5.6"),
            TokenLimitField::MaxCompletionTokens
        ));
        assert!(matches!(
            openai_token_limit_field("openai", "gpt-5"),
            TokenLimitField::MaxCompletionTokens
        ));
        assert!(matches!(
            openai_token_limit_field("openai", "gpt-4o"),
            TokenLimitField::MaxCompletionTokens
        ));
    }

    #[test]
    fn test_openai_audio_uses_max_completion_tokens() {
        assert!(matches!(
            openai_token_limit_field("openai_audio", "whisper-1"),
            TokenLimitField::MaxCompletionTokens
        ));
    }

    #[test]
    fn test_reasoning_models_use_max_completion_tokens() {
        for model in &["o1-preview", "o1-mini", "o3-mini", "o4-mini", "gpt-5.6", "gpt-5-mini"] {
            assert!(
                matches!(
                    openai_token_limit_field("other_provider", model),
                    TokenLimitField::MaxCompletionTokens
                ),
                "{} should use MaxCompletionTokens",
                model,
            );
        }
    }

    #[test]
    fn test_xiaomi_mimo_uses_max_tokens() {
        assert!(matches!(
            openai_token_limit_field("xiaomi_mimo", "mimo-v2.5"),
            TokenLimitField::MaxTokens
        ));
        assert!(matches!(
            openai_token_limit_field("xiaomi_mimo", "mimo-v2.5-pro"),
            TokenLimitField::MaxTokens
        ));
    }

    #[test]
    fn test_moonshot_uses_max_tokens() {
        assert!(matches!(
            openai_token_limit_field("moonshot", "kimi-k2"),
            TokenLimitField::MaxTokens
        ));
    }

    #[test]
    fn test_deepseek_uses_max_tokens() {
        assert!(matches!(
            openai_token_limit_field("deepseek", "deepseek-chat"),
            TokenLimitField::MaxTokens
        ));
    }

    #[test]
    fn test_openrouter_uses_max_tokens() {
        assert!(matches!(
            openai_token_limit_field("openrouter", "some-model"),
            TokenLimitField::MaxTokens
        ));
    }

    // ---- classify_http_error improvements ----

    #[test]
    fn test_classify_http_error_unsupported_parameter() {
        let err = classify_http_error(
            reqwest::StatusCode::BAD_REQUEST,
            r#"{"error": {"code": "unsupported_parameter", "param": "max_tokens"}}"#,
        );
        assert_eq!(err.kind, FetchErrorKind::ConnectionError);
        assert!(err.message.contains("現在のリクエスト形式を使用できませんでした"));
        assert!(!err.message.contains("max_tokens"));
        assert!(!err.message.contains("unsupported_parameter"));
    }

    #[test]
    fn test_classify_http_error_401_no_body_leak() {
        let err = classify_http_error(
            reqwest::StatusCode::UNAUTHORIZED,
            r#"{"error": {"message": "Invalid API key: sk-abc123"}}"#,
        );
        assert_eq!(err.kind, FetchErrorKind::AuthError);
        assert!(!err.message.contains("sk-abc123"));
        assert!(!err.message.contains("Invalid API key"));
    }

    #[test]
    fn test_classify_http_error_400_generic_no_full_body() {
        let err = classify_http_error(
            reqwest::StatusCode::BAD_REQUEST,
            r#"{"error": {"message": "Some other error"}}"#,
        );
        assert_eq!(err.kind, FetchErrorKind::ConnectionError);
        assert!(!err.message.contains("Some other error"));
        assert!(err.message.contains("400"));
    }
}
