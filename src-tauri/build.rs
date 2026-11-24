use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Deserialize)]
struct RawOAuthClientFile {
    client_id: String,
    #[serde(default)]
    client_secret: Option<String>,
    secret_mode: String,
    #[serde(default)]
    default_project_id: Option<String>,
}

fn validate_project_id_format_build(project_id: &str) -> Result<(), String> {
    let trimmed = project_id.trim();
    if trimmed.len() < 6 || trimmed.len() > 30 {
        return Err("default_project_id は 6〜30 文字で指定してください".to_string());
    }
    let mut chars = trimmed.chars();
    let Some(first) = chars.next() else {
        return Err("default_project_id が空です".to_string());
    };
    if !first.is_ascii_lowercase() {
        return Err("default_project_id は英小文字で始まる必要があります".to_string());
    }
    if trimmed.ends_with('-') {
        return Err("default_project_id の末尾に '-' は使えません".to_string());
    }
    if !chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
        return Err("default_project_id は英小文字・数字・ハイフンのみ使用できます".to_string());
    }
    Ok(())
}

fn generate_rust_config(
    client_id: &str,
    client_secret: Option<&str>,
    secret_mode: &str,
    default_project_id: &str,
) -> String {
    let secret_expr = match client_secret {
        Some(s) => format!("Some({:?})", s),
        None => "None".to_string(),
    };
    format!(
        "pub const BUNDLED_OAUTH_CLIENT_ID: &str = {:?};\n\
         pub const BUNDLED_OAUTH_CLIENT_SECRET: Option<&str> = {};\n\
         pub const BUNDLED_OAUTH_SECRET_MODE_STR: &str = {:?};\n\
         pub const BUNDLED_OAUTH_DEFAULT_PROJECT_ID: &str = {:?};\n",
        client_id, secret_expr, secret_mode, default_project_id
    )
}

fn load_and_validate_oauth_file(
    path: &Path,
) -> Result<(String, Option<String>, String, String), String> {
    let raw = std::fs::read_to_string(path)
        .map_err(|_| format!("OAuthクライアント設定ファイルの読み込みに失敗しました: {}", path.display()))?;
    let parsed: RawOAuthClientFile = serde_json::from_str(&raw)
        .map_err(|_| "OAuthクライアント設定ファイルのJSON形式が不正です".to_string())?;

    let client_id = parsed.client_id.trim().to_string();
    let client_secret = parsed
        .client_secret
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let secret_mode = parsed.secret_mode.trim().to_ascii_lowercase();
    let default_project_id = parsed
        .default_project_id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "OAuthクライアント設定の default_project_id が空または未設定です".to_string())?;
    validate_project_id_format_build(&default_project_id)?;

    match secret_mode.as_str() {
        "required" => {
            if client_id.is_empty() {
                return Err("OAuthクライアント設定の client_id が空です".to_string());
            }
            if client_secret.is_none() {
                return Err(
                    "OAuthクライアント設定の secret_mode が required ですが client_secret が空です"
                        .to_string(),
                );
            }
        }
        "none" => {
            if client_id.is_empty() {
                return Err("OAuthクライアント設定の client_id が空です".to_string());
            }
        }
        _ => {
            return Err(
                "OAuthクライアント設定の secret_mode は required または none を指定してください"
                    .to_string(),
            );
        }
    }

    Ok((client_id, client_secret, secret_mode, default_project_id))
}

fn write_oauth_client_config() {
    let is_debug = std::env::var("PROFILE").as_deref() != Ok("release")
        && matches!(
            std::env::var("CARGO_CFG_DEBUG_ASSERTIONS").as_deref(),
            Ok("true") | Ok("")
        );
    let config_path = PathBuf::from("..").join("oauth-client.dev.json");
    println!("cargo:rerun-if-changed={}", config_path.display());

    let generated = if config_path.exists() {
        match load_and_validate_oauth_file(&config_path) {
            Ok((id, secret, mode, default_project_id)) => {
                generate_rust_config(&id, secret.as_deref(), &mode, &default_project_id)
            }
            Err(msg) => panic!("Google OAuth 設定エラー: {msg}"),
        }
    } else if is_debug {
        // Allow building and using all other features when oauth-client.dev.json is absent in debug mode.
        generate_rust_config("", None, "required", "")
    } else {
        panic!(
            "リリースビルドにはリポジトリ直下の oauth-client.dev.json が必要です（生成されるインストーラーには設定JSONを同梱しません）。"
        );
    };

    let out_dir = PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR missing"));
    std::fs::write(out_dir.join("oauth_client_config.rs"), generated)
        .expect("failed to write oauth_client_config.rs");
}

fn main() {
    #[cfg(target_os = "windows")]
    println!("cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'");

    write_oauth_client_config();
    tauri_build::build();
}
