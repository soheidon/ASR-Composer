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
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        AppSettings::default()
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
    settings.providers.insert(
        input.provider_id,
        ProviderSettings {
            env_name: input.env_name,
            base_url: Some(input.base_url),
            default_model: input.default_model,
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
    )
}

fn resolve_api_key(provider: &ProviderSettings) -> Result<String, FetchModelsError> {
    let env_name = provider
        .env_name
        .as_deref()
        .ok_or(FetchModelsError {
            kind: FetchErrorKind::NotConfigured,
            message: "環境変数名が設定されていません".to_string(),
        })?;
    std::env::var(env_name).map_err(|_| FetchModelsError {
        kind: FetchErrorKind::NotConfigured,
        message: format!("{} が設定されていません", env_name),
    })
}

fn classify_http_error(status: reqwest::StatusCode, body: &str) -> FetchModelsError {
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        FetchModelsError {
            kind: FetchErrorKind::AuthError,
            message: format!("認証エラー ({}): {}", status, body),
        }
    } else {
        FetchModelsError {
            kind: FetchErrorKind::ConnectionError,
            message: format!("APIエラー ({}): {}", status, body),
        }
    }
}

#[tauri::command]
async fn fetch_models(
    app: tauri::AppHandle,
    provider_id: String,
) -> Result<Vec<String>, FetchModelsError> {
    let settings = load_settings(&app);

    // Ollama: 設定未保存でも既定URLで取得可能
    if provider_id == "ollama" {
        let base_url = settings
            .providers
            .get("ollama")
            .and_then(|p| p.base_url.as_deref())
            .filter(|url| !url.trim().is_empty())
            .unwrap_or("http://localhost:11434");

        return fetch_models_ollama(base_url).await;
    }

    let provider = settings
        .providers
        .get(&provider_id)
        .ok_or(FetchModelsError {
            kind: FetchErrorKind::NotConfigured,
            message: "プロバイダーが設定されていません".to_string(),
        })?;

    let base_url = provider
        .base_url
        .as_deref()
        .filter(|url| !url.trim().is_empty())
        .ok_or(FetchModelsError {
            kind: FetchErrorKind::NotConfigured,
            message: "Base URLが設定されていません".to_string(),
        })?;

    match provider_id.as_str() {
        "anthropic" => {
            let api_key = resolve_api_key(provider)?;
            fetch_models_anthropic(base_url, &api_key).await
        }
        "gemini" => {
            let api_key = resolve_api_key(provider)?;
            fetch_models_gemini(base_url, &api_key).await
        }
        id if is_openai_compatible(id) => {
            let api_key = resolve_api_key(provider)?;
            fetch_models_openai_compatible(base_url, &api_key).await
        }
        _ => Err(FetchModelsError {
            kind: FetchErrorKind::Unsupported,
            message: "このプロバイダーはモデル一覧の自動取得に対応していません".to_string(),
        }),
    }
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

    let models = json["data"]
        .as_array()
        .ok_or(FetchModelsError {
            kind: FetchErrorKind::ConnectionError,
            message: "レスポンスにdataフィールドがありません".to_string(),
        })?
        .iter()
        .filter_map(|m| m["id"].as_str().map(String::from))
        .collect::<Vec<_>>();

    Ok(models)
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

    let models = json["data"]
        .as_array()
        .ok_or(FetchModelsError {
            kind: FetchErrorKind::ConnectionError,
            message: "レスポンスにdataフィールドがありません".to_string(),
        })?
        .iter()
        .filter_map(|m| m["id"].as_str().map(String::from))
        .collect::<Vec<_>>();

    Ok(models)
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

    let models = json["models"]
        .as_array()
        .ok_or(FetchModelsError {
            kind: FetchErrorKind::ConnectionError,
            message: "レスポンスにmodelsフィールドがありません".to_string(),
        })?
        .iter()
        .filter_map(|m| m["name"].as_str().map(|s| s.to_string()))
        .collect::<Vec<_>>();

    Ok(models)
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

    let models = json["models"]
        .as_array()
        .ok_or(FetchModelsError {
            kind: FetchErrorKind::ConnectionError,
            message: "レスポンスにmodelsフィールドがありません".to_string(),
        })?
        .iter()
        .filter_map(|m| m["name"].as_str().map(String::from))
        .collect::<Vec<_>>();

    Ok(models)
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

#[tauri::command]
fn get_env_var(name: String) -> Option<String> {
    std::env::var(&name).ok()
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            load_api_settings,
            save_provider_config,
            save_provider_secret,
            fetch_models,
            test_connection_ollama,
            get_env_var
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
            "google_stt", "azure_speech", "xiaomi_mimo", "xiaomi_mimo_asr", "zai_glm",
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
        assert!(err.message.contains("401"));
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

    // ---- resolve_api_key ----

    #[test]
    fn test_resolve_api_key_no_env_name() {
        let provider = ProviderSettings {
            env_name: None,
            base_url: None,
            default_model: None,
        };
        let result = resolve_api_key(&provider);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert_eq!(err.kind, FetchErrorKind::NotConfigured);
    }

    #[test]
    fn test_resolve_api_key_env_not_set() {
        let provider = ProviderSettings {
            env_name: Some("TEST_NONEXISTENT_KEY_12345".to_string()),
            base_url: None,
            default_model: None,
        };
        let result = resolve_api_key(&provider);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert_eq!(err.kind, FetchErrorKind::NotConfigured);
    }

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
}
