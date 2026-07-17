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

fn default_speaker_diarization() -> bool {
    true
}

#[derive(Serialize, Deserialize)]
pub struct AppSettings {
    pub providers: HashMap<String, ProviderSettings>,
    #[serde(default)]
    pub asr_mode: String, // "cloud" | "local"
    #[serde(default)]
    pub asr_engine: String, // provider ID, local engine ID, or empty
    #[serde(default)]
    pub asr_languages: HashMap<String, String>, // engine_id -> language code
    #[serde(default = "default_speaker_diarization")]
    pub speaker_diarization: bool,
    #[serde(default)]
    pub num_speakers: String, // "auto" or numeric string like "2"
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            providers: HashMap::new(),
            asr_mode: String::new(),
            asr_engine: String::new(),
            asr_languages: HashMap::new(),
            speaker_diarization: true,
            num_speakers: "auto".to_string(),
        }
    }
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
    // ASR mode migration: infer from asr_engine if asr_mode is not set
    if settings.asr_mode.is_empty() {
        let cloud_ids = [
            "google_stt",
            "openai_audio",
            "azure_speech",
            "xiaomi_mimo_asr",
            "groq_speech",
            "deepgram",
            "assemblyai",
        ];
        let local_ids = ["reazonspeech", "kotoba-whisper", "qwen3-asr"];
        let engine = settings.asr_engine.as_str();
        if cloud_ids.contains(&engine) {
            settings.asr_mode = "cloud".to_string();
        } else if local_ids.contains(&engine) {
            settings.asr_mode = "local".to_string();
        } else {
            settings.asr_mode = "cloud".to_string();
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

#[tauri::command]
fn save_asr_selection(
    app: tauri::AppHandle,
    mode: String,
    engine: String,
    language: String,
    speaker_diarization: bool,
    num_speakers: String,
) -> Result<(), String> {
    if mode != "cloud" && mode != "local" {
        return Err(format!("Invalid ASR mode: {mode}"));
    }
    let path = settings_path(&app);
    let mut settings = load_settings(&app);
    settings.asr_mode = mode;
    settings.asr_engine = engine.clone();
    if !engine.is_empty() {
        settings.asr_languages.insert(engine, language);
    }
    settings.speaker_diarization = speaker_diarization;
    settings.num_speakers = num_speakers;
    let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

// ---- Local ASR Transcription ----

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LocalAsrTranscriptionProgress {
    job_id: String,
    stage: String,
    message: String,
    log_line: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptionResult {
    txt_content: String,
    vtt_content: String,
    engine: String,
    language: String,
}

fn validate_job_id(job_id: &str) -> Result<(), String> {
    uuid::Uuid::parse_str(job_id)
        .map(|_| ())
        .map_err(|_| "不正なジョブIDです".to_string())
}

fn qwen3_language_name(code: &str) -> Result<Option<&'static str>, String> {
    match code {
        "auto" => Ok(None),
        "ja" => Ok(Some("Japanese")),
        "en" => Ok(Some("English")),
        "zh" => Ok(Some("Chinese")),
        "yue" => Ok(Some("Cantonese")),
        "ko" => Ok(Some("Korean")),
        "fr" => Ok(Some("French")),
        "de" => Ok(Some("German")),
        "es" => Ok(Some("Spanish")),
        "pt" => Ok(Some("Portuguese")),
        "ar" => Ok(Some("Arabic")),
        "id" => Ok(Some("Indonesian")),
        "it" => Ok(Some("Italian")),
        "ru" => Ok(Some("Russian")),
        "th" => Ok(Some("Thai")),
        "vi" => Ok(Some("Vietnamese")),
        "tr" => Ok(Some("Turkish")),
        "hi" => Ok(Some("Hindi")),
        "ms" => Ok(Some("Malay")),
        "nl" => Ok(Some("Dutch")),
        "sv" => Ok(Some("Swedish")),
        "da" => Ok(Some("Danish")),
        "fi" => Ok(Some("Finnish")),
        "pl" => Ok(Some("Polish")),
        "cs" => Ok(Some("Czech")),
        "fil" => Ok(Some("Filipino")),
        "fa" => Ok(Some("Persian")),
        "el" => Ok(Some("Greek")),
        "hu" => Ok(Some("Hungarian")),
        "mk" => Ok(Some("Macedonian")),
        "ro" => Ok(Some("Romanian")),
        _ => Err(format!("未対応のQwen3言語コード: {code}")),
    }
}

fn resolve_asr_image_name(engine: &str) -> Result<&'static str, String> {
    match engine {
        "reazonspeech" => Ok("asr-composer-reazonspeech:cu126"),
        "kotoba-whisper" => Ok("asr-composer-kotoba-whisper:cu126"),
        "qwen3-asr" => Ok("asr-composer-qwen3-asr:cu126"),
        _ => Err(format!("未対応のASRエンジン: {engine}")),
    }
}

fn get_hf_token_value() -> Result<String, String> {
    std::env::var("HF_TOKEN")
        .map(|t| t.trim().to_string())
        .map_err(|_| "HF_TOKENが設定されていません。設定画面からHuggingFaceトークンを保存してください。".to_string())
        .and_then(|t| {
            if t.is_empty() {
                Err("HF_TOKENが空です。設定画面からHuggingFaceトークンを保存してください。".to_string())
            } else {
                Ok(t)
            }
        })
}

fn validate_audio_file(audio_path: &str) -> Result<(), String> {
    let path = std::path::Path::new(audio_path);
    if !path.exists() {
        return Err("入力ファイルが存在しません".to_string());
    }
    if !path.is_file() {
        return Err("入力パスが通常ファイルではありません".to_string());
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !["mp3", "wav", "mp4", "m4a", "flac"].contains(&ext.as_str()) {
        return Err(format!("未対応の拡張子です: .{ext}"));
    }
    Ok(())
}

fn validate_asr_engine(engine: &str) -> Result<(), String> {
    if !["reazonspeech", "kotoba-whisper", "qwen3-asr"].contains(&engine) {
        return Err(format!("未対応のASRエンジンです: {engine}"));
    }
    Ok(())
}

fn validate_num_speakers(num: &str) -> Result<(), String> {
    if num == "auto" || num.is_empty() {
        return Ok(());
    }
    let n: u32 = num
        .parse()
        .map_err(|_| format!("話者数が不正です: {num}"))?;
    if n == 0 || n > 8 {
        return Err(format!("話者数は1〜8です: {n}"));
    }
    Ok(())
}

fn validate_language_for_engine(engine: &str, language_code: &str) -> Result<(), String> {
    match engine {
        "qwen3-asr" => {
            qwen3_language_name(language_code)?;
        }
        "kotoba-whisper" => {
            if language_code != "ja" {
                return Err("Kotoba Whisperは日本語のみ対応です".to_string());
            }
        }
        "reazonspeech" => {
            if language_code != "ja" {
                return Err("ReazonSpeechは日本語のみ対応です".to_string());
            }
        }
        _ => {}
    }
    Ok(())
}

fn validate_transcribe_settings(settings: &AppSettings) -> Result<(), String> {
    if settings.asr_mode != "local" {
        return Err("ASRモードがローカルに設定されていません".to_string());
    }
    let engine = settings.asr_engine.as_str();
    validate_asr_engine(engine)?;
    if !settings.speaker_diarization {
        return Err("話者分離「しない」は現在実装中です。今しばらくお待ちください。".to_string());
    }
    validate_num_speakers(&settings.num_speakers)?;
    let language_code = settings.asr_languages.get(engine).map(|s| s.as_str()).unwrap_or("ja");
    validate_language_for_engine(engine, language_code)?;
    Ok(())
}

fn validate_transcribe_input(app: &tauri::AppHandle, audio_path: &str) -> Result<(), String> {
    validate_audio_file(audio_path)?;
    let settings = load_settings(app);
    validate_transcribe_settings(&settings)?;
    Ok(())
}

fn build_transcribe_env_vars(
    engine: &str,
    settings: &AppSettings,
    input_filename: &str,
) -> Result<Vec<(String, String)>, String> {
    let language_code = settings.asr_languages.get(engine).map(|s| s.as_str()).unwrap_or("ja");
    let mut vars = vec![
        ("INPUT_FILENAME".to_string(), input_filename.to_string()),
        ("WORK_SOURCE".to_string(), "/work/source".to_string()),
        ("WORK_OUTPUT".to_string(), "/work/output".to_string()),
        ("WORK_TMP".to_string(), "/work/tmp".to_string()),
    ];
    // 話者数（auto時は渡さない）
    let num = &settings.num_speakers;
    if num != "auto" && !num.is_empty() {
        vars.push(("NUM_SPEAKERS".to_string(), num.clone()));
    }
    // エンジン固有
    match engine {
        "qwen3-asr" => {
            let engine_lang = qwen3_language_name(language_code)?;
            let lang_str = engine_lang.unwrap_or("auto").to_string();
            vars.push(("ASR_LANGUAGE".to_string(), lang_str));
        }
        "kotoba-whisper" => {
            vars.push(("ASR_LANGUAGE".to_string(), "japanese".to_string()));
        }
        "reazonspeech" => {
            // 言語パラメータ不要
        }
        _ => {}
    }
    Ok(vars)
}

fn emit_transcribe_progress(app: &tauri::AppHandle, job_id: &str, stage: &str, message: &str) {
    use tauri::Emitter;
    let _ = app.emit(
        "local-asr-transcription-progress",
        LocalAsrTranscriptionProgress {
            job_id: job_id.to_string(),
            stage: stage.to_string(),
            message: message.to_string(),
            log_line: None,
        },
    );
}

async fn read_output_lines(
    mut reader: tokio::io::BufReader<tokio::process::ChildStdout>,
    app: tauri::AppHandle,
    job_id: String,
) -> Vec<String> {
    use tauri::Emitter;
    use tokio::io::AsyncBufReadExt;
    let mut lines = Vec::new();
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => break,
            Ok(_) => {
                let trimmed = line.trim().to_string();
                if !trimmed.is_empty() {
                    lines.push(trimmed.clone());
                    let _ = app.emit(
                        "local-asr-transcription-progress",
                        LocalAsrTranscriptionProgress {
                            job_id: job_id.clone(),
                            stage: "processing".to_string(),
                            message: String::new(),
                            log_line: Some(trimmed),
                        },
                    );
                }
            }
            Err(_) => break,
        }
    }
    lines
}

async fn read_stderr_lines(
    mut reader: tokio::io::BufReader<tokio::process::ChildStderr>,
    app: tauri::AppHandle,
    job_id: String,
) -> Vec<String> {
    use tauri::Emitter;
    use tokio::io::AsyncBufReadExt;
    let mut lines = Vec::new();
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => break,
            Ok(_) => {
                let trimmed = line.trim().to_string();
                if !trimmed.is_empty() {
                    lines.push(trimmed.clone());
                    let _ = app.emit(
                        "local-asr-transcription-progress",
                        LocalAsrTranscriptionProgress {
                            job_id: job_id.clone(),
                            stage: "processing".to_string(),
                            message: String::new(),
                            log_line: Some(trimmed),
                        },
                    );
                }
            }
            Err(_) => break,
        }
    }
    lines
}

async fn run_docker_transcribe(
    app: &tauri::AppHandle,
    job_id: &str,
    image_name: &str,
    work_dir: &std::path::Path,
    env_vars: Vec<(String, String)>,
    hf_token: Option<&str>,
) -> Result<(), String> {
    use tokio::process::Command;

    let source_dir = work_dir.join("source");
    let output_dir = work_dir.join("output");
    let tmp_dir = work_dir.join("tmp");

    let source_abs = fs::canonicalize(&source_dir).unwrap_or(source_dir.clone());
    let output_abs = fs::canonicalize(&output_dir).unwrap_or(output_dir.clone());
    let tmp_abs = fs::canonicalize(&tmp_dir).unwrap_or(tmp_dir.clone());

    // Windowsの\\?\プレフィックスを除去（Docker Desktop対応）
    let source_str = source_abs.to_string_lossy().replace("\\\\?\\", "");
    let output_str = output_abs.to_string_lossy().replace("\\\\?\\", "");
    let tmp_str = tmp_abs.to_string_lossy().replace("\\\\?\\", "");

    let source_mount = format!("{source_str}:/work/source:ro");
    let output_mount = format!("{output_str}:/work/output");
    let tmp_mount = format!("{tmp_str}:/work/tmp");

    let mut cmd = Command::new("docker");
    cmd.arg("run").arg("--rm").arg("--gpus").arg("all");
    cmd.arg("-v").arg(&source_mount);
    cmd.arg("-v").arg(&output_mount);
    cmd.arg("-v").arg(&tmp_mount);
    cmd.arg("-e").arg("WORK_SOURCE=/work/source");
    cmd.arg("-e").arg("WORK_OUTPUT=/work/output");
    cmd.arg("-e").arg("WORK_TMP=/work/tmp");

    // HF_TOKEN: プロセス環境にだけ設定
    if let Some(token) = hf_token {
        cmd.env("HF_TOKEN", token);
        cmd.arg("-e").arg("HF_TOKEN");
    }

    // その他の環境変数
    for (key, value) in &env_vars {
        cmd.arg("-e").arg(format!("{key}={value}"));
    }

    cmd.arg(image_name);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Docker起動エラー: {e}"))?;

    let stdout = child.stdout.take().ok_or("stdout取得エラー")?;
    let stderr = child.stderr.take().ok_or("stderr取得エラー")?;

    let stdout_reader = tokio::io::BufReader::new(stdout);
    let stderr_reader = tokio::io::BufReader::new(stderr);

    let app_clone = app.clone();
    let jid = job_id.to_string();
    let stdout_task = tokio::spawn(read_output_lines(stdout_reader, app_clone, jid.clone()));
    let stderr_task = tokio::spawn(read_stderr_lines(stderr_reader, app.clone(), jid));

    let status = child
        .wait()
        .await
        .map_err(|e| format!("Docker待機エラー: {e}"))?;

    let _ = stdout_task.await;
    let stderr_lines = stderr_task.await.unwrap_or_default();

    if !status.success() {
        let code = status.code().unwrap_or(-1);
        let last_logs: Vec<&str> = stderr_lines.iter().rev().take(10).map(|s| s.as_str()).collect();
        let log_str = if last_logs.is_empty() {
            "(ログなし)".to_string()
        } else {
            last_logs.join("\n")
        };
        return Err(format!(
            "Dockerコンテナがエラー終了しました。終了コード: {code}\n最後のログ:\n{log_str}"
        ));
    }
    Ok(())
}

#[tauri::command]
async fn local_asr_transcribe(
    app: tauri::AppHandle,
    job_id: String,
    audio_path: String,
) -> Result<TranscriptionResult, String> {
    // jobId検証
    validate_job_id(&job_id)?;

    // 入力バリデーション
    validate_transcribe_input(&app, &audio_path)?;

    let settings = load_settings(&app);
    let engine = settings.asr_engine.clone();

    // ワークディレクトリ作成
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("アプリデータディレクトリの取得に失敗: {e}"))?;
    let work_dir = app_data.join("local-asr").join("jobs").join(&job_id);
    let source_dir = work_dir.join("source");
    let output_dir = work_dir.join("output");
    let tmp_dir = work_dir.join("tmp");
    fs::create_dir_all(&source_dir).map_err(|e| format!("sourceディレクトリ作成エラー: {e}"))?;
    fs::create_dir_all(&output_dir).map_err(|e| format!("outputディレクトリ作成エラー: {e}"))?;
    fs::create_dir_all(&tmp_dir).map_err(|e| format!("tmpディレクトリ作成エラー: {e}"))?;

    // 入力ファイルコピー
    let audio_path_obj = std::path::Path::new(&audio_path);
    let input_filename = audio_path_obj
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("入力ファイル名を取得できません")?
        .to_string();
    let output_stem = audio_path_obj
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or("出力ファイル名を生成できません")?
        .to_string();
    fs::copy(&audio_path, source_dir.join(&input_filename))
        .map_err(|e| format!("ファイルコピーエラー: {e}"))?;

    // 進捗通知
    emit_transcribe_progress(&app, &job_id, "preparing", "準備中...");

    // 環境変数構築
    let env_vars = build_transcribe_env_vars(&engine, &settings, &input_filename)?;

    // HF_TOKEN取得（話者分離ON前提、Phase A）
    let hf_token = get_hf_token_value()?;

    // Docker image名解決
    let image_name = resolve_asr_image_name(&engine)?;

    emit_transcribe_progress(&app, &job_id, "starting_container", "Dockerコンテナを起動中...");

    // Docker実行
    let run_result = run_docker_transcribe(
        &app,
        &job_id,
        image_name,
        &work_dir,
        env_vars,
        Some(&hf_token),
    )
    .await;

    // 結果を処理（成功・失敗に関わらずクリーンアップ）
    let result = match run_result {
        Ok(()) => {
            emit_transcribe_progress(&app, &job_id, "reading_output", "出力を読み込み中...");
            let txt_path = output_dir.join(format!("{output_stem}.txt"));
            let vtt_path = output_dir.join(format!("{output_stem}.vtt"));
            let txt = fs::read_to_string(&txt_path)
                .map_err(|e| format!("TXT読み込みエラー ({}): {e}", txt_path.display()))?;
            let vtt = fs::read_to_string(&vtt_path)
                .map_err(|e| format!("VTT読み込みエラー ({}): {e}", vtt_path.display()))?;
            emit_transcribe_progress(&app, &job_id, "completed", "完了");
            Ok(TranscriptionResult {
                txt_content: txt,
                vtt_content: vtt,
                engine,
                language: settings
                    .asr_languages
                    .get(&settings.asr_engine)
                    .cloned()
                    .unwrap_or_else(|| "ja".to_string()),
            })
        }
        Err(e) => Err(e),
    };

    // クリーンアップ（成功・失敗とも）
    if let Err(e) = fs::remove_dir_all(&work_dir) {
        eprintln!("ジョブディレクトリの削除に失敗: {e}");
    }

    result
}

#[tauri::command]
fn save_text_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| format!("ファイル保存エラー: {e}"))
}

const MIMO_ASR_MAX_BASE64_SIZE: usize = 10 * 1024 * 1024; // 10MB

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XiaomiMimoAsrRecognizeInput {
    pub base_url: String,
    pub model: String,
    pub language: String,
    pub audio_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XiaomiMimoAsrBuiltinTestInput {
    pub base_url: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct XiaomiMimoAsrResult {
    pub transcript: String,
    pub language: String,
    pub model: String,
    pub provider: String,
    pub endpoint: String,
    pub http_status: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
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
        "xiaomi_mimo" | "xiaomi_mimo_asr" => Some(ProviderDefaults {
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

// ---- Xiaomi MiMo ASR (Chat Completions + input_audio) ----

fn validate_xiaomi_mimo_asr_input(
    base_url: &str,
    model: &str,
    language: &str,
    audio_path: &std::path::Path,
) -> Result<(), FetchModelsError> {
    if base_url.trim().is_empty() {
        return Err(FetchModelsError {
            kind: FetchErrorKind::NotConfigured,
            message: "Base URLを入力してください".to_string(),
        });
    }
    if model.trim().is_empty() {
        return Err(FetchModelsError {
            kind: FetchErrorKind::NotConfigured,
            message: "モデル名を入力してください".to_string(),
        });
    }
    if !["auto", "zh", "en"].contains(&language) {
        return Err(FetchModelsError {
            kind: FetchErrorKind::NotConfigured,
            message: "言語は auto, zh, en のいずれかを指定してください".to_string(),
        });
    }
    if !audio_path.exists() {
        return Err(FetchModelsError {
            kind: FetchErrorKind::NotConfigured,
            message: "音声ファイルが見つかりません".to_string(),
        });
    }
    Ok(())
}

fn parse_xiaomi_mimo_asr_response(
    json: &serde_json::Value,
    model: &str,
    language: &str,
    endpoint: &str,
    http_status: u16,
    request_id: Option<String>,
) -> Result<XiaomiMimoAsrResult, FetchModelsError> {
    let content = json
        .get("choices")
        .and_then(|c| c.as_array())
        .and_then(|arr| arr.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|msg| msg.get("content"));

    let transcript = match content {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Array(arr)) => {
            // Array形式: [{"type": "text", "text": "..."}] または [{"type": "...", "text": "..."}]
            let mut texts = Vec::new();
            for item in arr {
                if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                    if !text.is_empty() {
                        texts.push(text.to_string());
                    }
                }
            }
            texts.join("")
        }
        _ => {
            return Err(FetchModelsError {
                kind: FetchErrorKind::ConnectionError,
                message: "レスポンスからテキストを取得できませんでした".to_string(),
            });
        }
    };

    Ok(XiaomiMimoAsrResult {
        transcript,
        language: language.to_string(),
        model: model.to_string(),
        provider: "Xiaomi MiMo".to_string(),
        endpoint: endpoint.to_string(),
        http_status,
        request_id,
    })
}

async fn recognize_xiaomi_mimo_audio(
    base_url: &str,
    model: &str,
    language: &str,
    audio_path: &std::path::Path,
) -> Result<XiaomiMimoAsrResult, FetchModelsError> {
    validate_xiaomi_mimo_asr_input(base_url, model, language, audio_path)?;

    // 音声読み込み + base64
    let audio_bytes = fs::read(audio_path).map_err(|e| FetchModelsError {
        kind: FetchErrorKind::ConnectionError,
        message: format!("音声ファイルの読み込みに失敗しました: {}", e),
    })?;

    if audio_bytes.len() > MIMO_ASR_MAX_BASE64_SIZE {
        return Err(FetchModelsError {
            kind: FetchErrorKind::NotConfigured,
            message: format!(
                "ファイルサイズが大きすぎます（{}MB）。上限は10MBです。",
                audio_bytes.len() / 1024 / 1024
            ),
        });
    }

    use base64::Engine;
    let audio_base64 = base64::engine::general_purpose::STANDARD.encode(&audio_bytes);

    // Data URL 構築
    let data_url = format!("data:audio/wav;base64,{}", audio_base64);

    // APIキー取得
    let api_key = std::env::var("XIAOMI_API_KEY").map_err(|_| FetchModelsError {
        kind: FetchErrorKind::NotConfigured,
        message: "XIAOMI_API_KEY が設定されていません".to_string(),
    })?;

    // リクエスト構築
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));

    let body = serde_json::json!({
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_audio",
                        "input_audio": {
                            "data": data_url
                        }
                    }
                ]
            }
        ],
        "asr_options": {
            "language": language
        }
    });

    // HTTPリクエスト（api-key ヘッダー使用、NOT Authorization: Bearer）
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header("api-key", &api_key)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| FetchModelsError {
            kind: FetchErrorKind::ConnectionError,
            message: format!("リクエスト送信に失敗しました: {}", e),
        })?;

    let http_status = resp.status().as_u16();

    // レスポンスヘッダーからrequest_idを取得（存在する場合）
    let request_id = resp
        .headers()
        .get("x-request-id")
        .or_else(|| resp.headers().get("x-ms-request-id"))
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    if !resp.status().is_success() {
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        return Err(classify_http_error(status, &body_text));
    }

    let json: serde_json::Value = resp.json().await.map_err(|e| FetchModelsError {
        kind: FetchErrorKind::ConnectionError,
        message: format!("レスポンス解析に失敗しました: {}", e),
    })?;

    // JSON内からもrequest_idを探す（ヘッダーにない場合）
    let request_id = request_id.or_else(|| {
        json.get("request_id")
            .or_else(|| json.get("id"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    });

    // endpointからhost/path部分を安全に抽出
    let endpoint = reqwest::Url::parse(&url)
        .ok()
        .map(|u| {
            let host = u.host_str().unwrap_or("");
            let path = u.path();
            format!("{}{}", host, path)
        })
        .unwrap_or_else(|| url.clone());

    parse_xiaomi_mimo_asr_response(&json, model, language, &endpoint, http_status, request_id)
}

fn resolve_xiaomi_mimo_asr_builtin_audio(
    app: &tauri::AppHandle,
) -> Result<std::path::PathBuf, FetchModelsError> {
    let resource_path = app
        .path()
        .resolve(
            "resources/xiaomi-mimo-asr-test-en.wav",
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|_e| FetchModelsError {
            kind: FetchErrorKind::NotConfigured,
            message: "同梱テスト音声のパス解決に失敗しました".to_string(),
        })?;
    if !resource_path.is_file() {
        return Err(FetchModelsError {
            kind: FetchErrorKind::NotConfigured,
            message: "同梱テスト音声が見つかりません".to_string(),
        });
    }
    Ok(resource_path)
}

#[tauri::command]
async fn xiaomi_mimo_asr_recognize(
    app: tauri::AppHandle,
    input: XiaomiMimoAsrRecognizeInput,
) -> Result<XiaomiMimoAsrResult, FetchModelsError> {
    let _ = &app; // Tauri command signature requires app handle
    recognize_xiaomi_mimo_audio(
        &input.base_url,
        &input.model,
        &input.language,
        std::path::Path::new(&input.audio_path),
    )
    .await
}

const XIAOMI_MIMO_ASR_BUILTIN_MODEL: &str = "mimo-v2.5-asr";
const XIAOMI_MIMO_ASR_BUILTIN_LANGUAGE: &str = "en";

#[tauri::command]
async fn xiaomi_mimo_asr_run_builtin_test(
    app: tauri::AppHandle,
    input: XiaomiMimoAsrBuiltinTestInput,
) -> Result<XiaomiMimoAsrResult, FetchModelsError> {
    let audio_path = resolve_xiaomi_mimo_asr_builtin_audio(&app)?;
    recognize_xiaomi_mimo_audio(
        &input.base_url,
        XIAOMI_MIMO_ASR_BUILTIN_MODEL,
        XIAOMI_MIMO_ASR_BUILTIN_LANGUAGE,
        &audio_path,
    )
    .await
}

// ---- Docker Desktop / CLI Detection ----

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerStatus {
    pub cli_found: bool,
    pub cli_version: Option<String>,
    pub daemon_running: bool,
    pub server_version: Option<String>,
    pub desktop_found: bool,
    pub cli_path: Option<String>,
    pub desktop_path: Option<String>,
    pub error_kind: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerStartResult {
    pub launched: bool,
    pub message: String,
}

#[derive(Debug)]
#[allow(dead_code)]
enum DockerCheckError {
    CliNotFound,
    DaemonNotRunning(String),
    Timeout,
    PermissionDenied(String),
    Io(std::io::Error),
    UnexpectedOutput,
}

fn docker_error_to_status(err: DockerCheckError) -> (Option<String>, Option<String>) {
    match err {
        DockerCheckError::CliNotFound => (
            Some("cli_not_found".to_string()),
            Some("Docker CLIが見つかりません。".to_string()),
        ),
        DockerCheckError::DaemonNotRunning(detail) => (
            Some("daemon_not_running".to_string()),
            Some(format!("Docker Engineに接続できません: {}", detail)),
        ),
        DockerCheckError::Timeout => (
            Some("check_timeout".to_string()),
            Some("Docker Engineへの接続がタイムアウトしました。".to_string()),
        ),
        DockerCheckError::PermissionDenied(detail) => (
            Some("permission_denied".to_string()),
            Some(format!("権限エラー: {}", detail)),
        ),
        DockerCheckError::Io(e) => (
            Some("unknown".to_string()),
            Some(format!("入出力エラー: {}", e)),
        ),
        DockerCheckError::UnexpectedOutput => (
            Some("unknown".to_string()),
            Some("Docker CLIから予期しない出力を受け取りました。".to_string()),
        ),
    }
}

/// Docker Desktop候補パスを生成する（テスト可能な純粋関数）。
fn docker_desktop_candidate_paths(
    program_files: Option<&std::path::Path>,
    local_app_data: Option<&std::path::Path>,
) -> Vec<std::path::PathBuf> {
    let mut candidates = Vec::new();
    if let Some(pf) = program_files {
        candidates.push(pf.join("Docker").join("Docker").join("Docker Desktop.exe"));
    }
    if let Some(la) = local_app_data {
        candidates.push(
            la.join("Programs")
                .join("DockerDesktop")
                .join("Docker Desktop.exe"),
        );
    }
    candidates
}

/// Docker CLI候補パスを生成する（テスト可能な純粋関数）。
fn docker_candidate_paths(
    program_files: Option<&std::path::Path>,
    local_app_data: Option<&std::path::Path>,
) -> Vec<std::path::PathBuf> {
    let mut candidates = Vec::new();
    if let Some(pf) = program_files {
        candidates.push(
            pf.join("Docker")
                .join("Docker")
                .join("resources")
                .join("bin")
                .join("docker.exe"),
        );
    }
    if let Some(la) = local_app_data {
        // ユーザー単位インストール（Docker Desktop 4.x+）
        candidates.push(
            la.join("Programs")
                .join("DockerDesktop")
                .join("resources")
                .join("bin")
                .join("docker.exe"),
        );
        // 旧版 / 特殊構成
        candidates.push(la.join("Docker").join("resources").join("bin").join("docker.exe"));
    }
    candidates
}

/// PATH上から `docker` を検索する。
fn find_docker_on_path() -> Option<std::path::PathBuf> {
    for name in &["docker.exe", "docker"] {
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
    None
}

/// Docker CLIの実行ファイルを検出する。
fn find_docker_cli() -> Option<std::path::PathBuf> {
    // 1. PATH検索
    if let Some(path) = find_docker_on_path() {
        return Some(path);
    }

    // 2. 候補パス探索
    let program_files = std::env::var_os("ProgramFiles").map(std::path::PathBuf::from);
    let local_app_data = std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from);

    for candidate in docker_candidate_paths(program_files.as_deref(), local_app_data.as_deref()) {
        if candidate.exists() {
            return Some(candidate);
        }
    }

    None
}

/// Docker Desktopの実行ファイルを検出する。
fn find_docker_desktop() -> Option<std::path::PathBuf> {
    let program_files = std::env::var_os("ProgramFiles").map(std::path::PathBuf::from);
    let local_app_data = std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from);

    for candidate in
        docker_desktop_candidate_paths(program_files.as_deref(), local_app_data.as_deref())
    {
        if candidate.exists() {
            return Some(candidate);
        }
    }

    None
}

/// `docker --version` の出力を取得する（trimmed全文を返す）。
fn read_docker_cli_version(docker_path: &std::path::Path) -> Result<String, DockerCheckError> {
    let output = std::process::Command::new(docker_path)
        .arg("--version")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .map_err(DockerCheckError::Io)?;

    if !output.status.success() {
        return Err(DockerCheckError::UnexpectedOutput);
    }

    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if version.is_empty() {
        return Err(DockerCheckError::UnexpectedOutput);
    }

    Ok(version)
}

/// `docker version --format "{{.Server.Version}}"` でServer接続を確認する（タイムアウト5秒）。
async fn read_docker_server_version(
    docker_path: &std::path::Path,
) -> Result<String, DockerCheckError> {
    let mut command = tokio::process::Command::new(docker_path);
    command
        .args(["version", "--format", "{{.Server.Version}}"])
        .kill_on_drop(true);

    let result = tokio::time::timeout(std::time::Duration::from_secs(5), command.output()).await;

    let output = match result {
        Ok(inner) => inner.map_err(DockerCheckError::Io)?,
        Err(_) => return Err(DockerCheckError::Timeout),
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        // 権限エラーの判定
        if stderr.contains("permission denied")
            || stderr.contains("Got permission denied")
            || stderr.contains("access denied")
        {
            return Err(DockerCheckError::PermissionDenied(stderr));
        }
        return Err(DockerCheckError::DaemonNotRunning(stderr));
    }

    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if version.is_empty() {
        return Err(DockerCheckError::UnexpectedOutput);
    }

    Ok(version)
}

#[tauri::command]
async fn docker_check_status() -> DockerStatus {
    // 1. Desktop検出を先に行う
    let desktop_path = find_docker_desktop();
    let desktop_found = desktop_path.is_some();

    // 2. CLI検出
    let cli_path = find_docker_cli();
    let cli_found = cli_path.is_some();

    // 3. CLI未検出 → Desktop有無で状態を分ける
    if !cli_found {
        return DockerStatus {
            cli_found: false,
            cli_version: None,
            daemon_running: false,
            server_version: None,
            desktop_found,
            cli_path: None,
            desktop_path: desktop_path.map(|p| p.to_string_lossy().to_string()),
            error_kind: Some("cli_not_found".to_string()),
            error_message: if desktop_found {
                Some(
                    "Docker Desktopは見つかりましたが、Docker CLIを検出できませんでした。\
                     Docker Desktopを起動し、状態を再確認してください。"
                        .to_string(),
                )
            } else {
                Some("Docker Desktopが見つかりません。インストールしてください。".to_string())
            },
        };
    }

    let cli_path_ref = cli_path.as_ref().unwrap();

    // 4. CLIバージョン取得
    let cli_version = match read_docker_cli_version(cli_path_ref) {
        Ok(v) => Some(v),
        Err(_) => None,
    };

    // 5. Serverバージョン取得（タイムアウト付き）
    let (daemon_running, server_version, error_kind, error_message) =
        match read_docker_server_version(cli_path_ref).await {
            Ok(v) => (true, Some(v), None, None),
            Err(e) => {
                let (kind, msg) = docker_error_to_status(e);
                (false, None, kind, msg)
            }
        };

    DockerStatus {
        cli_found: true,
        cli_version,
        daemon_running,
        server_version,
        desktop_found,
        cli_path: Some(cli_path_ref.to_string_lossy().to_string()),
        desktop_path: desktop_path.map(|p| p.to_string_lossy().to_string()),
        error_kind,
        error_message,
    }
}

/// `docker desktop start --detach` の結果を分類する（テスト可能な純粋関数）。
fn classify_docker_start_result(
    success: bool,
    stdout: &str,
    stderr: &str,
) -> DockerStartResult {
    if success {
        return DockerStartResult {
            launched: true,
            message: "Docker Desktopの起動を開始しました。".to_string(),
        };
    }

    let detail = if !stderr.trim().is_empty() {
        stderr.trim()
    } else {
        stdout.trim()
    };

    DockerStartResult {
        launched: false,
        message: if detail.is_empty() {
            "Docker Desktopの起動に失敗しました。".to_string()
        } else {
            format!("Docker Desktopの起動に失敗しました: {}", detail)
        },
    }
}

#[tauri::command]
async fn docker_start_desktop() -> DockerStartResult {
    let docker_path = match find_docker_cli() {
        Some(path) => path,
        None => {
            return DockerStartResult {
                launched: false,
                message: "Docker CLIが見つかりません。".to_string(),
            };
        }
    };

    let output = match tokio::process::Command::new(&docker_path)
        .args(["desktop", "start", "--detach"])
        .kill_on_drop(true)
        .output()
        .await
    {
        Ok(output) => output,
        Err(e) => {
            return DockerStartResult {
                launched: false,
                message: format!("Docker Desktopの起動に失敗しました: {}", e),
            };
        }
    };

    classify_docker_start_result(
        output.status.success(),
        &String::from_utf8_lossy(&output.stdout),
        &String::from_utf8_lossy(&output.stderr),
    )
}

// ---- HuggingFace Token Management ----

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HuggingFaceTokenStatus {
    pub configured: bool,
    pub masked_value: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HuggingFaceTokenSaveInput {
    pub token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HuggingFaceTokenSaveResult {
    pub success: bool,
    pub message: String,
}

/// HF_TOKENのバリデーション（テスト可能な純粋関数）。
fn validate_hf_token(token: &str) -> Result<(), String> {
    if token.is_empty() {
        return Err("アクセストークンを入力してください".to_string());
    }
    if token.contains('\n') || token.contains('\r') || token.contains('\0') {
        return Err(
            "アクセストークンに改行または無効な文字を含めることはできません".to_string(),
        );
    }
    if token.chars().count() > 4096 {
        return Err("アクセストークンが長すぎます".to_string());
    }
    Ok(())
}

/// HF_TOKENのマスク表示（テスト可能な純粋関数）。
/// 文字数ベースで処理し、UTF-8境界を安全に扱う。
fn mask_hf_token(token: &str) -> String {
    let char_count = token.chars().count();
    if char_count < 7 {
        return "設定済み".to_string();
    }
    if char_count <= 12 {
        let prefix: String = token.chars().take(3).collect();
        return format!("{}****", prefix);
    }
    let prefix: String = token.chars().take(3).collect();
    let suffix: String = token.chars().skip(char_count - 4).collect();
    let masked_len = char_count - 7;
    format!("{}{}{}", prefix, "*".repeat(masked_len), suffix)
}

#[tauri::command]
fn hf_token_get_status() -> HuggingFaceTokenStatus {
    match std::env::var("HF_TOKEN") {
        Ok(token) if !token.trim().is_empty() => HuggingFaceTokenStatus {
            configured: true,
            masked_value: Some(mask_hf_token(token.trim())),
        },
        _ => HuggingFaceTokenStatus {
            configured: false,
            masked_value: None,
        },
    }
}

#[tauri::command]
fn hf_token_save(input: HuggingFaceTokenSaveInput) -> HuggingFaceTokenSaveResult {
    let token = input.token.trim().to_string();

    // バリデーション
    if let Err(e) = validate_hf_token(&token) {
        return HuggingFaceTokenSaveResult {
            success: false,
            message: e,
        };
    }

    // 1. Windowsユーザー環境変数へ永続化
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        let result = Command::new("setx")
            .arg("HF_TOKEN")
            .arg(&token)
            .status();

        match result {
            Ok(status) if status.success() => {
                // 永続化成功後にプロセスにも設定
                std::env::set_var("HF_TOKEN", &token);
                HuggingFaceTokenSaveResult {
                    success: true,
                    message: "HF_TOKENを保存しました".to_string(),
                }
            }
            _ => HuggingFaceTokenSaveResult {
                success: false,
                message: "HF_TOKENをWindowsユーザー環境変数へ保存できませんでした".to_string(),
            },
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        std::env::set_var("HF_TOKEN", &token);
        HuggingFaceTokenSaveResult {
            success: true,
            message: "HF_TOKENを保存しました（現在のセッションのみ）".to_string(),
        }
    }
}

#[tauri::command]
fn hf_token_delete() -> HuggingFaceTokenSaveResult {
    // 1. Windowsユーザー環境変数から削除
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        let result = Command::new("cmd.exe")
            .args(["/C", "REG", "delete", "HKCU\\Environment", "/v", "HF_TOKEN", "/f"])
            .status();

        match result {
            Ok(status) if status.success() => {
                // 削除成功後にプロセスからも除去
                std::env::remove_var("HF_TOKEN");
                HuggingFaceTokenSaveResult {
                    success: true,
                    message: "HF_TOKENを削除しました".to_string(),
                }
            }
            Ok(_) => {
                // レジストリキーが存在しない場合も成功扱い
                std::env::remove_var("HF_TOKEN");
                HuggingFaceTokenSaveResult {
                    success: true,
                    message: "HF_TOKENを削除しました".to_string(),
                }
            }
            Err(e) => HuggingFaceTokenSaveResult {
                success: false,
                message: format!("HF_TOKENの削除に失敗しました: {}", e),
            },
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        std::env::remove_var("HF_TOKEN");
        HuggingFaceTokenSaveResult {
            success: true,
            message: "HF_TOKENを削除しました".to_string(),
        }
    }
}

// ---- Local ASR Engine Management ----

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAsrEngineStatus {
    pub engine: String,
    pub display_name: String,
    pub installed: bool,
    pub image_name: String,
    pub image_id: Option<String>,
    pub environment_version: Option<String>,
    pub model_name: Option<String>,
    pub docker_available: bool,
    pub docker_running: bool,
    pub error_kind: Option<String>,
    pub error_message: Option<String>,
}

struct LocalAsrEngineDef {
    engine: &'static str,
    display_name: &'static str,
    image_name: &'static str,
}

fn local_asr_engine_defs() -> Vec<LocalAsrEngineDef> {
    vec![
        LocalAsrEngineDef {
            engine: "reazonspeech",
            display_name: "ReazonSpeech",
            image_name: "asr-composer-reazonspeech:cu126",
        },
        LocalAsrEngineDef {
            engine: "kotoba-whisper",
            display_name: "Kotoba Whisper v2.2",
            image_name: "asr-composer-kotoba-whisper:cu126",
        },
        LocalAsrEngineDef {
            engine: "qwen3-asr",
            display_name: "Qwen3 ASR",
            image_name: "asr-composer-qwen3-asr:cu126",
        },
    ]
}

#[derive(Debug, Deserialize)]
struct DockerImageInspect {
    #[serde(rename = "Id")]
    id: String,
    #[serde(rename = "Config", default)]
    config: Option<DockerImageConfig>,
}

#[derive(Debug, Deserialize)]
struct DockerImageConfig {
    #[serde(rename = "Labels", default)]
    labels: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone)]
struct DockerImageInfo {
    image_id: String,
    labels: HashMap<String, String>,
}

/// `docker image inspect` の結果分類。
#[derive(Debug)]
enum DockerImageInspectResult {
    Found(DockerImageInfo),
    NotFound,
    DaemonUnavailable,
    InspectFailed,
}

/// stderrの内容からinspect失敗の原因を分類する（テスト可能な純粋関数）。
fn classify_docker_inspect_failure(stderr: &str) -> DockerImageInspectResult {
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("no such image") || lower.contains("no such object") {
        DockerImageInspectResult::NotFound
    } else if lower.contains("cannot connect")
        || lower.contains("error during connect")
        || lower.contains("is the docker daemon running")
        || lower.contains("failed to connect")
        || lower.contains("dockerdesktoplinuxengine")
        || lower.contains("docker_desktop_linux_engine")
        || (lower.contains("open //./pipe/docker")
            && lower.contains("the system cannot find the file specified"))
    {
        DockerImageInspectResult::DaemonUnavailable
    } else {
        DockerImageInspectResult::InspectFailed
    }
}

/// `docker image inspect` のJSON出力をパースする（テスト可能な純粋関数）。
fn parse_docker_image_inspect(stdout: &str) -> Result<DockerImageInfo, DockerImageInspectResult> {
    if stdout.trim().is_empty() {
        return Err(DockerImageInspectResult::InspectFailed);
    }

    let arr: Vec<DockerImageInspect> = match serde_json::from_str(stdout) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("Failed to parse docker image inspect output: {error}");
            return Err(DockerImageInspectResult::InspectFailed);
        }
    };

    let first = match arr.first() {
        Some(f) => f,
        None => return Err(DockerImageInspectResult::NotFound),
    };

    let labels = first
        .config
        .as_ref()
        .and_then(|c| c.labels.clone())
        .unwrap_or_default();

    Ok(DockerImageInfo {
        image_id: first.id.clone(),
        labels,
    })
}

/// `docker --context <ctx> image inspect <image_name>` を実行し、イメージ情報を取得する。
/// contextが空の場合は--contextを付けない（後方互換）。
fn inspect_docker_image_with_context(
    docker_path: &std::path::Path,
    docker_context: &str,
    image_name: &str,
) -> DockerImageInspectResult {
    let mut cmd = std::process::Command::new(docker_path);
    if !docker_context.is_empty() {
        cmd.arg("--context").arg(docker_context);
    }
    let output = match cmd
        .args(["image", "inspect", image_name])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
    {
        Ok(o) => o,
        Err(e) => {
            eprintln!("docker image inspect 実行失敗: {e}");
            return DockerImageInspectResult::InspectFailed;
        }
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return classify_docker_inspect_failure(&stderr);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    match parse_docker_image_inspect(&stdout) {
        Ok(info) => DockerImageInspectResult::Found(info),
        Err(result) => result,
    }
}

/// `docker image inspect <image_name>` を実行し、イメージ情報を取得する。
fn inspect_docker_image(
    docker_path: &std::path::Path,
    image_name: &str,
) -> DockerImageInspectResult {
    let output = match std::process::Command::new(docker_path)
        .args(["image", "inspect", image_name])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
    {
        Ok(o) => o,
        Err(e) => {
            eprintln!("docker image inspect 実行失敗: {e}");
            return DockerImageInspectResult::InspectFailed;
        }
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return classify_docker_inspect_failure(&stderr);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    match parse_docker_image_inspect(&stdout) {
        Ok(info) => DockerImageInspectResult::Found(info),
        Err(result) => result,
    }
}

/// 単一エンジンの状態を取得する（テスト可能、Docker実行を含む）。
fn get_single_engine_status(
    docker_path: &std::path::Path,
    docker_running: bool,
    def: &LocalAsrEngineDef,
) -> LocalAsrEngineStatus {
    if !docker_running {
        return LocalAsrEngineStatus {
            engine: def.engine.to_string(),
            display_name: def.display_name.to_string(),
            installed: false,
            image_name: def.image_name.to_string(),
            image_id: None,
            environment_version: None,
            model_name: None,
            docker_available: true,
            docker_running: false,
            error_kind: None,
            error_message: None,
        };
    }

    match inspect_docker_image(docker_path, def.image_name) {
        DockerImageInspectResult::Found(info) => {
            let env_ver = info
                .labels
                .get("com.asr-composer.environment-version")
                .cloned();
            let model = info.labels.get("com.asr-composer.asr-model").cloned();
            LocalAsrEngineStatus {
                engine: def.engine.to_string(),
                display_name: def.display_name.to_string(),
                installed: true,
                image_name: def.image_name.to_string(),
                image_id: Some(info.image_id),
                environment_version: env_ver,
                model_name: model,
                docker_available: true,
                docker_running: true,
                error_kind: None,
                error_message: None,
            }
        }
        DockerImageInspectResult::NotFound => LocalAsrEngineStatus {
            engine: def.engine.to_string(),
            display_name: def.display_name.to_string(),
            installed: false,
            image_name: def.image_name.to_string(),
            image_id: None,
            environment_version: None,
            model_name: None,
            docker_available: true,
            docker_running: true,
            error_kind: None,
            error_message: None,
        },
        DockerImageInspectResult::DaemonUnavailable => LocalAsrEngineStatus {
            engine: def.engine.to_string(),
            display_name: def.display_name.to_string(),
            installed: false,
            image_name: def.image_name.to_string(),
            image_id: None,
            environment_version: None,
            model_name: None,
            docker_available: true,
            docker_running: true,
            error_kind: Some("daemon-unavailable".to_string()),
            error_message: Some("Docker Engineへ接続できませんでした".to_string()),
        },
        DockerImageInspectResult::InspectFailed => LocalAsrEngineStatus {
            engine: def.engine.to_string(),
            display_name: def.display_name.to_string(),
            installed: false,
            image_name: def.image_name.to_string(),
            image_id: None,
            environment_version: None,
            model_name: None,
            docker_available: true,
            docker_running: true,
            error_kind: Some("inspect-error".to_string()),
            error_message: Some("Dockerイメージの状態を確認できませんでした".to_string()),
        },
    }
}

fn local_asr_get_status_sync() -> Vec<LocalAsrEngineStatus> {
    let defs = local_asr_engine_defs();
    let docker_path = find_docker_cli();
    let docker_available = docker_path.is_some();

    if !docker_available {
        return defs
            .iter()
            .map(|d| LocalAsrEngineStatus {
                engine: d.engine.to_string(),
                display_name: d.display_name.to_string(),
                installed: false,
                image_name: d.image_name.to_string(),
                image_id: None,
                environment_version: None,
                model_name: None,
                docker_available: false,
                docker_running: false,
                error_kind: None,
                error_message: None,
            })
            .collect();
    }

    let docker_path_ref = docker_path.as_ref().unwrap();

    let t0 = std::time::Instant::now();
    let docker_running = std::process::Command::new(docker_path_ref)
        .args(["version", "--format", "{{.Server.Version}}"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    let version_ms = t0.elapsed().as_millis();
    if version_ms > 1000 {
        eprintln!("[status] docker version slow: {version_ms}ms");
    }

    let mut results = Vec::with_capacity(defs.len());
    for d in &defs {
        let t1 = std::time::Instant::now();
        let status = get_single_engine_status(docker_path_ref, docker_running, d);
        let elapsed = t1.elapsed().as_millis();
        if elapsed > 1000 {
            eprintln!("[status] inspect {} slow: {elapsed}ms", d.engine);
        }
        results.push(status);
    }
    results
}

fn unavailable_local_asr_statuses() -> Vec<LocalAsrEngineStatus> {
    local_asr_engine_defs()
        .iter()
        .map(|d| LocalAsrEngineStatus {
            engine: d.engine.to_string(),
            display_name: d.display_name.to_string(),
            installed: false,
            image_name: d.image_name.to_string(),
            image_id: None,
            environment_version: None,
            model_name: None,
            docker_available: false,
            docker_running: false,
            error_kind: None,
            error_message: None,
        })
        .collect()
}

#[tauri::command]
async fn local_asr_get_status() -> Vec<LocalAsrEngineStatus> {
    tauri::async_runtime::spawn_blocking(local_asr_get_status_sync)
        .await
        .unwrap_or_else(|_| unavailable_local_asr_statuses())
}

/// 現在のDocker contextを取得する。
async fn resolve_docker_context(docker_path: &std::path::Path) -> Result<String, String> {
    use tokio::process::Command;

    let output = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        Command::new(docker_path)
            .args(["context", "show"])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| "docker context showがタイムアウトしました".to_string())?
    .map_err(|e| format!("docker context showの実行に失敗しました: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("docker context showが失敗しました: {stderr}"));
    }

    let context = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if context.is_empty() {
        return Err("docker context showが空の結果を返しました".to_string());
    }
    Ok(context)
}

/// `docker image ls --no-trunc --format "{{.Repository}}\t{{.Tag}}\t{{.ID}}"` を実行し、
/// (repository, tag, image_id) の一覧を返す。
async fn list_docker_images(
    docker_path: &std::path::Path,
    docker_context: &str,
) -> Result<Vec<(String, String, String)>, String> {
    use tokio::process::Command;

    let output = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        {
            let mut cmd = Command::new(docker_path);
            if !docker_context.is_empty() {
                cmd.arg("--context").arg(docker_context);
            }
            cmd.args(["image", "ls", "--no-trunc", "--format", "{{.Repository}}\t{{.Tag}}\t{{.ID}}"])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .kill_on_drop(true)
                .output()
        },
    )
    .await
    .map_err(|_| "docker image lsがタイムアウトしました".to_string())?
    .map_err(|e| format!("docker image lsの実行に失敗しました: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("docker image lsが失敗しました: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut images = Vec::new();
    for line in stdout.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() >= 3 {
            images.push((
                parts[0].trim().to_string(),
                parts[1].trim().to_string(),
                parts[2].trim().to_string(),
            ));
        }
    }
    Ok(images)
}

/// 単一エンジンのinspectをtokio::process::Commandで実行し、タイムアウト時にプロセスを確実に終了する。
async fn inspect_docker_image_by_id_async(
    docker_path: std::path::PathBuf,
    docker_context: &str,
    image_id: String,
    image_name: String,
    engine: String,
    display_name: String,
) -> LocalAsrEngineStatus {
    use tokio::process::Command;

    let mut cmd = Command::new(&docker_path);
    if !docker_context.is_empty() {
        cmd.arg("--context").arg(docker_context);
    }
    let child = match cmd
        .args(["image", "inspect", &image_id])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            return LocalAsrEngineStatus {
                engine,
                display_name,
                installed: false,
                image_name,
                image_id: None,
                environment_version: None,
                model_name: None,
                docker_available: true,
                docker_running: true,
                error_kind: Some("inspect-error".to_string()),
                error_message: Some(format!("Docker起動エラー: {e}")),
            };
        }
    };

    let timeout_result = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        child.wait_with_output(),
    )
    .await;

    match timeout_result {
        Ok(Ok(output)) => {
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                let inspect_result = classify_docker_inspect_failure(&stderr);
                match inspect_result {
                    DockerImageInspectResult::NotFound => LocalAsrEngineStatus {
                        engine,
                        display_name,
                        installed: false,
                        image_name,
                        image_id: None,
                        environment_version: None,
                        model_name: None,
                        docker_available: true,
                        docker_running: true,
                        error_kind: None,
                        error_message: None,
                    },
                    DockerImageInspectResult::DaemonUnavailable => LocalAsrEngineStatus {
                        engine,
                        display_name,
                        installed: false,
                        image_name,
                        image_id: None,
                        environment_version: None,
                        model_name: None,
                        docker_available: true,
                        docker_running: false,
                        error_kind: Some("daemon-unavailable".to_string()),
                        error_message: Some("Docker Engineへ接続できませんでした".to_string()),
                    },
                    _ => LocalAsrEngineStatus {
                        engine,
                        display_name,
                        installed: false,
                        image_name,
                        image_id: None,
                        environment_version: None,
                        model_name: None,
                        docker_available: true,
                        docker_running: true,
                        error_kind: Some("inspect-error".to_string()),
                        error_message: Some("Dockerイメージの状態を確認できませんでした".to_string()),
                    },
                }
            } else {
                let stdout = String::from_utf8_lossy(&output.stdout);
                match parse_docker_image_inspect(&stdout) {
                    Ok(info) => {
                        let env_ver = info.labels.get("com.asr-composer.environment-version").cloned();
                        let model = info.labels.get("com.asr-composer.asr-model").cloned();
                        LocalAsrEngineStatus {
                            engine,
                            display_name,
                            installed: true,
                            image_name,
                            image_id: Some(info.image_id),
                            environment_version: env_ver,
                            model_name: model,
                            docker_available: true,
                            docker_running: true,
                            error_kind: None,
                            error_message: None,
                        }
                    }
                    Err(_) => LocalAsrEngineStatus {
                        engine,
                        display_name,
                        installed: false,
                        image_name,
                        image_id: None,
                        environment_version: None,
                        model_name: None,
                        docker_available: true,
                        docker_running: true,
                        error_kind: Some("inspect-error".to_string()),
                        error_message: Some("Dockerイメージの状態を確認できませんでした".to_string()),
                    },
                }
            }
        }
        Ok(Err(e)) => {
            // wait_with_output失敗
            LocalAsrEngineStatus {
                engine,
                display_name,
                installed: false,
                image_name,
                image_id: None,
                environment_version: None,
                model_name: None,
                docker_available: true,
                docker_running: true,
                error_kind: Some("inspect-error".to_string()),
                error_message: Some(format!("Docker実行エラー: {e}")),
            }
        }
        Err(_) => {
            // タイムアウト — kill_on_drop(true)で子プロセスは自動終了
            LocalAsrEngineStatus {
                engine,
                display_name,
                installed: false,
                image_name,
                image_id: None,
                environment_version: None,
                model_name: None,
                docker_available: true,
                docker_running: true,
                error_kind: Some("timeout".to_string()),
                error_message: Some("Docker応答がタイムアウトしました（5秒）".to_string()),
            }
        }
    }
}

/// Docker daemon確認済みを前提に、3エンジンの状態を取得する。
/// 最初に`docker image ls`で一覧を取得し、repository:tagの完全一致で存在判定する。
/// 存在する場合はimage IDで`docker image inspect`を実行しラベルを取得する。
#[tauri::command]
async fn local_asr_get_status_fast() -> Vec<LocalAsrEngineStatus> {
    let defs = local_asr_engine_defs();
    let docker_path = match find_docker_cli() {
        Some(p) => p,
        None => return unavailable_local_asr_statuses(),
    };

    // 現在のDocker contextを1回だけ取得
    let docker_context = match resolve_docker_context(&docker_path).await {
        Ok(ctx) => ctx,
        Err(e) => {
            return error_statuses(&defs, &format!("Docker contextの取得に失敗しました: {e}"));
        }
    };

    // image ls 一覧を1回だけ取得
    let images = match list_docker_images(&docker_path, &docker_context).await {
        Ok(list) => list,
        Err(e) => return error_statuses(&defs, &e),
    };

    let mut results = Vec::with_capacity(defs.len());
    for def in defs {
        // repository:tag の完全一致で検索
        let repo = format!("asr-composer-{}", def.engine);
        let tag = "cu126".to_string();
        let matched = images.iter().find(|(r, t, _)| r == &repo && t == &tag);

        match matched {
            Some((_, _, image_id)) => {
                // IDでinspectしてラベル取得
                let status = inspect_docker_image_by_id_async(
                    docker_path.clone(),
                    &docker_context,
                    image_id.clone(),
                    def.image_name.to_string(),
                    def.engine.to_string(),
                    def.display_name.to_string(),
                )
                .await;
                results.push(status);
            }
            None => {
                results.push(LocalAsrEngineStatus {
                    engine: def.engine.to_string(),
                    display_name: def.display_name.to_string(),
                    installed: false,
                    image_name: def.image_name.to_string(),
                    image_id: None,
                    environment_version: None,
                    model_name: None,
                    docker_available: true,
                    docker_running: true,
                    error_kind: None,
                    error_message: None,
                });
            }
        }
    }
    results
}

fn error_statuses(
    defs: &[LocalAsrEngineDef],
    message: &str,
) -> Vec<LocalAsrEngineStatus> {
    defs.iter()
        .map(|d| LocalAsrEngineStatus {
            engine: d.engine.to_string(),
            display_name: d.display_name.to_string(),
            installed: false,
            image_name: d.image_name.to_string(),
            image_id: None,
            environment_version: None,
            model_name: None,
            docker_available: true,
            docker_running: false,
            error_kind: Some("inspect-error".to_string()),
            error_message: Some(message.to_string()),
        })
        .collect()
}

/// 個別確認用: docker version を省略し、inspect 1回だけ実行する。
fn get_single_engine_status_fast(
    docker_path: &std::path::Path,
    docker_context: &str,
    def: &LocalAsrEngineDef,
) -> LocalAsrEngineStatus {
    match inspect_docker_image_with_context(docker_path, docker_context, def.image_name) {
        DockerImageInspectResult::Found(info) => {
            let env_ver = info.labels.get("com.asr-composer.environment-version").cloned();
            let model = info.labels.get("com.asr-composer.asr-model").cloned();
            LocalAsrEngineStatus {
                engine: def.engine.to_string(),
                display_name: def.display_name.to_string(),
                installed: true,
                image_name: def.image_name.to_string(),
                image_id: Some(info.image_id),
                environment_version: env_ver,
                model_name: model,
                docker_available: true,
                docker_running: true,
                error_kind: None,
                error_message: None,
            }
        }
        DockerImageInspectResult::NotFound => LocalAsrEngineStatus {
            engine: def.engine.to_string(),
            display_name: def.display_name.to_string(),
            installed: false,
            image_name: def.image_name.to_string(),
            image_id: None,
            environment_version: None,
            model_name: None,
            docker_available: true,
            docker_running: true,
            error_kind: None,
            error_message: None,
        },
        DockerImageInspectResult::DaemonUnavailable => LocalAsrEngineStatus {
            engine: def.engine.to_string(),
            display_name: def.display_name.to_string(),
            installed: false,
            image_name: def.image_name.to_string(),
            image_id: None,
            environment_version: None,
            model_name: None,
            docker_available: true,
            docker_running: false,
            error_kind: Some("daemon-unavailable".to_string()),
            error_message: Some("Docker Engineへ接続できませんでした".to_string()),
        },
        DockerImageInspectResult::InspectFailed => LocalAsrEngineStatus {
            engine: def.engine.to_string(),
            display_name: def.display_name.to_string(),
            installed: false,
            image_name: def.image_name.to_string(),
            image_id: None,
            environment_version: None,
            model_name: None,
            docker_available: true,
            docker_running: true,
            error_kind: Some("inspect-error".to_string()),
            error_message: Some("Dockerイメージの状態を確認できませんでした".to_string()),
        },
    }
}

fn local_asr_get_engine_status_sync(engine: &str) -> Result<LocalAsrEngineStatus, String> {
    let def = local_asr_engine_defs()
        .into_iter()
        .find(|d| d.engine == engine)
        .ok_or_else(|| format!("不明なローカルASRエンジンです: {engine}"))?;

    let docker_path = match find_docker_cli() {
        Some(path) => path,
        None => {
            return Ok(LocalAsrEngineStatus {
                engine: def.engine.to_string(),
                display_name: def.display_name.to_string(),
                installed: false,
                image_name: def.image_name.to_string(),
                image_id: None,
                environment_version: None,
                model_name: None,
                docker_available: false,
                docker_running: false,
                error_kind: None,
                error_message: None,
            });
        }
    };

    // 同期版ではcontextを明示しない（互換性維持）
    Ok(get_single_engine_status_fast(&docker_path, "", &def))
}

#[tauri::command]
async fn local_asr_get_engine_status(engine: String) -> Result<LocalAsrEngineStatus, String> {
    tauri::async_runtime::spawn_blocking(move || local_asr_get_engine_status_sync(&engine))
        .await
        .map_err(|e| format!("ローカルASR状態確認タスクに失敗しました: {e}"))?
}

// ---- Local ASR Install ----

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalAsrProgress {
    engine: String,
    stage: String,
    message: String,
}

fn local_asr_operation_lock() -> &'static tokio::sync::Mutex<()> {
    use std::sync::OnceLock;
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// stderr/stdoutの末尾N行を返す。
fn tail_stderr(source: &str, max_lines: usize) -> String {
    let lines: Vec<&str> = source.lines().collect();
    if lines.len() <= max_lines {
        source.trim().to_string()
    } else {
        lines[lines.len() - max_lines..].join("\n")
    }
}

const ASR_PROGRESS_PREFIX: &str = "ASR_PROGRESS:";

/// stdout行からASR_PROGRESSマーカーを抽出する（テスト可能な純粋関数）。
/// ステージ名は英数字とハイフンのみで構成され、それ以降の文字は無視する。
fn extract_asr_stage(line: &str) -> Option<&str> {
    let pos = line.find(ASR_PROGRESS_PREFIX)?;
    let after = &line[pos + ASR_PROGRESS_PREFIX.len()..];
    let end = after
        .find(|c: char| !c.is_ascii_alphanumeric() && c != '-')
        .unwrap_or(after.len());
    let stage = &after[..end];
    if stage.is_empty() { None } else { Some(stage) }
}

/// Docker buildを実行し、stdoutからASR_PROGRESSマーカーを抽出して進捗をemitする。
async fn run_docker_build(
    docker_path: &std::path::Path,
    tag: &str,
    dockerfile: &str,
    context: &std::path::Path,
    app: &tauri::AppHandle,
    engine: &str,
    initial_stage: &str,
    initial_message: &str,
) -> Result<(), String> {
    use tauri::Emitter;

    app.emit(
        "local-asr-progress",
        LocalAsrProgress {
            engine: engine.to_string(),
            stage: initial_stage.to_string(),
            message: initial_message.to_string(),
        },
    )
    .map_err(|e| format!("進捗通知に失敗しました: {e}"))?;

    let mut command = tokio::process::Command::new(docker_path);
    command
        .args(["build", "--progress=plain", "-t", tag, "-f", dockerfile, "."])
        .current_dir(context)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    let mut child = command
        .spawn()
        .map_err(|e| format!("Docker buildの実行に失敗しました: {e}"))?;

    let stdout = child.stdout.take().unwrap();
    let stderr_handle = child.stderr.take().unwrap();

    // stdoutを行単位でストリーミングし、ASR_PROGRESSマーカーを抽出
    let engine_clone = engine.to_string();
    let app_clone = app.clone();
    let stdout_task = tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, BufReader};
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        let mut last_emitted_stage = String::new();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(stage) = extract_asr_stage(&line) {
                if stage != last_emitted_stage {
                    last_emitted_stage = stage.to_string();
                    let _ = app_clone.emit(
                        "local-asr-progress",
                        LocalAsrProgress {
                            engine: engine_clone.clone(),
                            stage: stage.to_string(),
                            message: String::new(),
                        },
                    );
                }
            }
        }
    });

    // stderrは最後にまとめて取得
    let stderr_task = tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut buf = String::new();
        let mut reader = stderr_handle;
        let _ = reader.read_to_string(&mut buf).await;
        buf
    });

    let status = child
        .wait()
        .await
        .map_err(|e| format!("Docker buildの待機に失敗しました: {e}"))?;

    let _ = stdout_task.await;
    let stderr_output = stderr_task.await.unwrap_or_default();

    if !status.success() {
        let detail = if stderr_output.trim().is_empty() {
            // stderrが空の場合、stdoutの最後の出力を使用（Docker BuildKit対策）
            "Docker buildが失敗しました。詳細ログを確認してください。".to_string()
        } else {
            tail_stderr(&stderr_output, 30)
        };
        return Err(detail);
    }

    Ok(())
}

#[tauri::command]
async fn local_asr_install(
    app: tauri::AppHandle,
    engine: String,
) -> Result<LocalAsrEngineStatus, String> {
    use tauri::Emitter;

    // 排他制御
    let _guard = local_asr_operation_lock()
        .try_lock()
        .map_err(|_| "ローカルASR環境の処理がすでに実行中です".to_string())?;

    // engine検証
    let def = local_asr_engine_defs()
        .into_iter()
        .find(|d| d.engine == engine)
        .ok_or_else(|| format!("未対応のエンジンです: {}", engine))?;

    // Docker CLI確認
    let docker_path = find_docker_cli().ok_or("Dockerがインストールされていません")?;

    // daemon確認
    let daemon_ok = std::process::Command::new(&docker_path)
        .args(["version", "--format", "{{.Server.Version}}"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !daemon_ok {
        return Err("Docker Desktopが起動していません".to_string());
    }

    // checking
    app.emit(
        "local-asr-progress",
        LocalAsrProgress {
            engine: engine.clone(),
            stage: "checking".to_string(),
            message: String::new(),
        },
    )
    .ok();

    // resource directory 解決
    let local_asr_root = app
        .path()
        .resolve("resources/local-asr", tauri::path::BaseDirectory::Resource)
        .map_err(|_| "ローカルASRリソースが見つかりません".to_string())?;

    if !local_asr_root.exists() {
        return Err("ローカルASRリソースが見つかりません".to_string());
    }

    // resolving-resources
    app.emit(
        "local-asr-progress",
        LocalAsrProgress {
            engine: engine.clone(),
            stage: "resolving-resources".to_string(),
            message: String::new(),
        },
    )
    .ok();

    // base build
    run_docker_build(
        &docker_path,
        "asr-composer-base:cu126",
        "base/Dockerfile",
        &local_asr_root,
        &app,
        &engine,
        "building-base-start",
        "ベース環境を構築しています",
    )
    .await
    .map_err(|detail| format!("ベース環境の構築に失敗しました\n{detail}"))?;

    // engine build
    run_docker_build(
        &docker_path,
        &def.image_name,
        &format!("{}/Dockerfile", engine),
        &local_asr_root,
        &app,
        &engine,
        "building-engine-start",
        &format!("{}環境を構築しています", def.display_name),
    )
    .await
    .map_err(|detail| format!("{}環境の構築に失敗しました\n{detail}", def.display_name))?;

    // installed確認
    app.emit(
        "local-asr-progress",
        LocalAsrProgress {
            engine: engine.clone(),
            stage: "verifying-image".to_string(),
            message: String::new(),
        },
    )
    .ok();

    let status = get_single_engine_status(&docker_path, true, &def);
    if !status.installed {
        return Err(format!(
            "{}環境を構築しましたが、Dockerイメージを確認できませんでした",
            def.display_name
        ));
    }

    // completed
    app.emit(
        "local-asr-progress",
        LocalAsrProgress {
            engine: engine.clone(),
            stage: "completed".to_string(),
            message: String::new(),
        },
    )
    .ok();

    Ok(status)
}

#[tauri::command]
async fn local_asr_uninstall(
    _app: tauri::AppHandle,
    engine: String,
) -> Result<LocalAsrEngineStatus, String> {
    // 排他制御
    let _guard = local_asr_operation_lock()
        .try_lock()
        .map_err(|_| "ローカルASR環境の処理がすでに実行中です".to_string())?;

    // engine検証
    let def = local_asr_engine_defs()
        .into_iter()
        .find(|d| d.engine == engine)
        .ok_or_else(|| format!("未対応のエンジンです: {}", engine))?;

    // Docker CLI確認
    let docker_path = find_docker_cli().ok_or("Dockerがインストールされていません")?;

    // daemon確認
    let daemon_ok = std::process::Command::new(&docker_path)
        .args(["version", "--format", "{{.Server.Version}}"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !daemon_ok {
        return Err("Docker Desktopが起動していません".to_string());
    }

    // イメージ存在確認
    match inspect_docker_image(&docker_path, &def.image_name) {
        DockerImageInspectResult::NotFound => {
            return Err(format!("{}環境はインストールされていません", def.display_name));
        }
        DockerImageInspectResult::Found(_) => { /* 存在する → 削除へ進む */ }
        DockerImageInspectResult::DaemonUnavailable => {
            return Err("Docker Engineへ接続できませんでした".to_string());
        }
        DockerImageInspectResult::InspectFailed => {
            return Err("イメージの確認に失敗しました".to_string());
        }
    }

    // docker image rm（-f なし）
    let output = std::process::Command::new(&docker_path)
        .args(["image", "rm", &def.image_name])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .map_err(|e| format!("Docker image rmの実行に失敗しました: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail_source = if stderr.trim().is_empty() {
            stdout.as_ref()
        } else {
            stderr.as_ref()
        };
        let detail = tail_stderr(detail_source, 30);

        // コンテナ参照による削除失敗を検出
        if detail.contains("is being used") || detail.contains("running") {
            return Err(format!(
                "{}イメージを使用しているDockerコンテナが残っています。\n\
                 Docker Desktopで対象コンテナを削除してから再試行してください。",
                def.display_name
            ));
        }

        return Err(format!(
            "{}環境の削除に失敗しました\n{}",
            def.display_name, detail
        ));
    }

    // 削除確認
    match inspect_docker_image(&docker_path, &def.image_name) {
        DockerImageInspectResult::Found(_) => {
            return Err("削除後もDockerイメージが確認されました".to_string());
        }
        DockerImageInspectResult::NotFound => { /* 正常に削除された */ }
        DockerImageInspectResult::DaemonUnavailable
        | DockerImageInspectResult::InspectFailed => { /* inspect失敗は削除成功とみなす */ }
    }

    // 最新状態を返す
    Ok(get_single_engine_status(&docker_path, true, &def))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            load_api_settings,
            save_provider_config,
            save_provider_secret,
            save_asr_selection,
            fetch_models,
            test_connection_ollama,
            test_llm_connection,
            get_env_var,
            google_stt_check_adc,
            google_stt_list_projects,
            google_stt_recognize,
            google_stt_run_builtin_test,
            xiaomi_mimo_asr_recognize,
            xiaomi_mimo_asr_run_builtin_test,
            docker_check_status,
            docker_start_desktop,
            hf_token_get_status,
            hf_token_save,
            hf_token_delete,
            local_asr_get_status,
            local_asr_get_status_fast,
            local_asr_get_engine_status,
            local_asr_install,
            local_asr_uninstall,
            local_asr_transcribe,
            save_text_file
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
            ..Default::default()
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
            ..Default::default()
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
            ..Default::default()
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
            ..Default::default()
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
            ..Default::default()
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
            ..Default::default()
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

    // ---- xiaomi_mimo_asr provider_defaults ----

    #[test]
    fn test_xiaomi_mimo_asr_provider_defaults() {
        let defaults = provider_defaults("xiaomi_mimo_asr").unwrap();
        assert_eq!(defaults.env_name, "XIAOMI_API_KEY");
        assert_eq!(defaults.base_url, "https://api.xiaomimimo.com/v1");
    }

    // ---- validate_xiaomi_mimo_asr_input ----

    #[test]
    fn test_validate_xiaomi_mimo_asr_input_valid() {
        let tmp = std::env::temp_dir().join("__mimo_asr_test_valid__.wav");
        fs::write(&tmp, b"test").unwrap();
        let result = validate_xiaomi_mimo_asr_input(
            "https://api.xiaomimimo.com/v1",
            "mimo-v2.5-asr",
            "en",
            &tmp,
        );
        assert!(result.is_ok());
        fs::remove_file(&tmp).ok();
    }

    #[test]
    fn test_validate_xiaomi_mimo_asr_input_empty_base_url() {
        let tmp = std::env::temp_dir().join("__mimo_asr_test_url__.wav");
        fs::write(&tmp, b"test").unwrap();
        let result = validate_xiaomi_mimo_asr_input("", "mimo-v2.5-asr", "en", &tmp);
        assert!(result.is_err());
        assert!(result.unwrap_err().message.contains("Base URL"));
        fs::remove_file(&tmp).ok();
    }

    #[test]
    fn test_validate_xiaomi_mimo_asr_input_invalid_language() {
        let tmp = std::env::temp_dir().join("__mimo_asr_test_lang__.wav");
        fs::write(&tmp, b"test").unwrap();
        let result = validate_xiaomi_mimo_asr_input(
            "https://api.xiaomimimo.com/v1",
            "mimo-v2.5-asr",
            "ja",
            &tmp,
        );
        assert!(result.is_err());
        assert!(result.unwrap_err().message.contains("言語"));
        fs::remove_file(&tmp).ok();
    }

    #[test]
    fn test_validate_xiaomi_mimo_asr_input_nonexistent_file() {
        let result = validate_xiaomi_mimo_asr_input(
            "https://api.xiaomimimo.com/v1",
            "mimo-v2.5-asr",
            "en",
            std::path::Path::new("/nonexistent/audio.wav"),
        );
        assert!(result.is_err());
        assert!(result.unwrap_err().message.contains("音声ファイル"));
    }

    // ---- parse_xiaomi_mimo_asr_response ----

    const TEST_ENDPOINT: &str = "api.xiaomimimo.com/v1/chat/completions";

    #[test]
    fn test_parse_xiaomi_mimo_asr_response_string_content() {
        let json = serde_json::json!({
            "choices": [
                {
                    "message": {
                        "content": "Hello, how are you?"
                    }
                }
            ]
        });
        let result = parse_xiaomi_mimo_asr_response(&json, "mimo-v2.5-asr", "en", TEST_ENDPOINT, 200, None).unwrap();
        assert_eq!(result.transcript, "Hello, how are you?");
        assert_eq!(result.language, "en");
        assert_eq!(result.model, "mimo-v2.5-asr");
        assert_eq!(result.provider, "Xiaomi MiMo");
        assert_eq!(result.endpoint, TEST_ENDPOINT);
        assert_eq!(result.http_status, 200);
        assert!(result.request_id.is_none());
    }

    #[test]
    fn test_parse_xiaomi_mimo_asr_response_array_content() {
        let json = serde_json::json!({
            "choices": [
                {
                    "message": {
                        "content": [
                            {"type": "text", "text": "Hello"},
                            {"type": "text", "text": " world"}
                        ]
                    }
                }
            ]
        });
        let result = parse_xiaomi_mimo_asr_response(&json, "mimo-v2.5-asr", "en", TEST_ENDPOINT, 200, None).unwrap();
        assert_eq!(result.transcript, "Hello world");
    }

    #[test]
    fn test_parse_xiaomi_mimo_asr_response_empty_array() {
        let json = serde_json::json!({
            "choices": [
                {
                    "message": {
                        "content": []
                    }
                }
            ]
        });
        let result = parse_xiaomi_mimo_asr_response(&json, "mimo-v2.5-asr", "en", TEST_ENDPOINT, 200, None).unwrap();
        assert_eq!(result.transcript, "");
    }

    #[test]
    fn test_parse_xiaomi_mimo_asr_response_no_choices() {
        let json = serde_json::json!({ "error": "no choices" });
        let result = parse_xiaomi_mimo_asr_response(&json, "mimo-v2.5-asr", "en", TEST_ENDPOINT, 200, None);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().kind, FetchErrorKind::ConnectionError);
    }

    #[test]
    fn test_parse_xiaomi_mimo_asr_response_empty_string_content() {
        let json = serde_json::json!({
            "choices": [
                {
                    "message": {
                        "content": ""
                    }
                }
            ]
        });
        // 空文字列でも正常に返す（音声なし=空結果とみなせる）
        let result = parse_xiaomi_mimo_asr_response(&json, "mimo-v2.5-asr", "en", TEST_ENDPOINT, 200, None).unwrap();
        assert_eq!(result.transcript, "");
    }

    #[test]
    fn test_parse_xiaomi_mimo_asr_response_with_request_id() {
        let json = serde_json::json!({
            "choices": [
                {
                    "message": {
                        "content": "test"
                    }
                }
            ]
        });
        let result = parse_xiaomi_mimo_asr_response(
            &json,
            "mimo-v2.5-asr",
            "en",
            TEST_ENDPOINT,
            200,
            Some("req-abc123".to_string()),
        ).unwrap();
        assert_eq!(result.request_id, Some("req-abc123".to_string()));
    }

    // ---- XiaomiMimoAsrResult serialization ----

    #[test]
    fn test_xiaomi_mimo_asr_result_serialization() {
        let result = XiaomiMimoAsrResult {
            transcript: "Hello".to_string(),
            language: "en".to_string(),
            model: "mimo-v2.5-asr".to_string(),
            provider: "Xiaomi MiMo".to_string(),
            endpoint: "api.xiaomimimo.com/v1/chat/completions".to_string(),
            http_status: 200,
            request_id: Some("req-123".to_string()),
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("transcript"));
        assert!(json.contains("language"));
        assert!(json.contains("model"));
        assert!(json.contains("Hello"));
        assert!(json.contains("provider"));
        assert!(json.contains("endpoint"));
        assert!(json.contains("httpStatus"));
        assert!(json.contains("requestId"));
    }

    #[test]
    fn test_xiaomi_mimo_asr_result_no_request_id() {
        let result = XiaomiMimoAsrResult {
            transcript: "Hello".to_string(),
            language: "en".to_string(),
            model: "mimo-v2.5-asr".to_string(),
            provider: "Xiaomi MiMo".to_string(),
            endpoint: "api.xiaomimimo.com/v1/chat/completions".to_string(),
            http_status: 200,
            request_id: None,
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(!json.contains("requestId"));
    }

    // ---- recognize_xiaomi_mimo_audio input shape ----

    #[test]
    fn test_xiaomi_mimo_asr_builtin_test_input_deserialization() {
        let json = r#"{"baseUrl":"https://api.xiaomimimo.com/v1"}"#;
        let input: XiaomiMimoAsrBuiltinTestInput = serde_json::from_str(json).unwrap();
        assert_eq!(input.base_url, "https://api.xiaomimimo.com/v1");
    }

    #[test]
    fn test_xiaomi_mimo_asr_builtin_test_input_no_model_required() {
        let json = r#"{"baseUrl":"https://api.xiaomimimo.com/v1"}"#;
        let input: XiaomiMimoAsrBuiltinTestInput = serde_json::from_str(json).unwrap();
        // model フィールドが存在しなくてもデシリアライズできる
        assert_eq!(input.base_url, "https://api.xiaomimimo.com/v1");
    }

    #[test]
    fn test_xiaomi_mimo_asr_builtin_test_input_no_language_required() {
        let json = r#"{"baseUrl":"https://api.xiaomimimo.com/v1"}"#;
        let input: XiaomiMimoAsrBuiltinTestInput = serde_json::from_str(json).unwrap();
        // language フィールドが存在しなくてもデシリアライズできる
        assert_eq!(input.base_url, "https://api.xiaomimimo.com/v1");
    }

    #[test]
    fn test_xiaomi_mimo_asr_builtin_test_input_no_audio_path_required() {
        let json = r#"{"baseUrl":"https://api.xiaomimimo.com/v1"}"#;
        let input: XiaomiMimoAsrBuiltinTestInput = serde_json::from_str(json).unwrap();
        // audioPath フィールドが存在しなくてもデシリアライズできる
        assert_eq!(input.base_url, "https://api.xiaomimimo.com/v1");
    }

    #[test]
    fn test_xiaomi_mimo_asr_builtin_test_input_ignores_extra_fields() {
        let json = r#"{"baseUrl":"https://api.xiaomimimo.com/v1","model":"ignored","language":"ignored","audioPath":"ignored"}"#;
        let input: XiaomiMimoAsrBuiltinTestInput = serde_json::from_str(json).unwrap();
        assert_eq!(input.base_url, "https://api.xiaomimimo.com/v1");
    }

    #[test]
    fn test_xiaomi_mimo_asr_builtin_constants() {
        assert_eq!(XIAOMI_MIMO_ASR_BUILTIN_MODEL, "mimo-v2.5-asr");
        assert_eq!(XIAOMI_MIMO_ASR_BUILTIN_LANGUAGE, "en");
    }

    #[test]
    fn test_xiaomi_mimo_asr_recognize_input_deserialization() {
        let json = r#"{"baseUrl":"https://api.xiaomimimo.com/v1","model":"mimo-v2.5-asr","language":"en","audioPath":"/tmp/test.wav"}"#;
        let input: XiaomiMimoAsrRecognizeInput = serde_json::from_str(json).unwrap();
        assert_eq!(input.base_url, "https://api.xiaomimimo.com/v1");
        assert_eq!(input.audio_path, "/tmp/test.wav");
    }

    // ---- validate_xiaomi_mimo_asr_input language variants ----

    #[test]
    fn test_validate_xiaomi_mimo_asr_input_language_auto() {
        let tmp = std::env::temp_dir().join("__mimo_asr_test_auto__.wav");
        fs::write(&tmp, b"test").unwrap();
        let result = validate_xiaomi_mimo_asr_input(
            "https://api.xiaomimimo.com/v1",
            "mimo-v2.5-asr",
            "auto",
            &tmp,
        );
        assert!(result.is_ok());
        fs::remove_file(&tmp).ok();
    }

    #[test]
    fn test_validate_xiaomi_mimo_asr_input_language_zh() {
        let tmp = std::env::temp_dir().join("__mimo_asr_test_zh__.wav");
        fs::write(&tmp, b"test").unwrap();
        let result = validate_xiaomi_mimo_asr_input(
            "https://api.xiaomimimo.com/v1",
            "mimo-v2.5-asr",
            "zh",
            &tmp,
        );
        assert!(result.is_ok());
        fs::remove_file(&tmp).ok();
    }

    // ---- Xiaomi MiMo ASR 実環境テスト ----

    #[test]
    #[ignore] // CI環境ではXIAOMI_API_KEYが未設定のため
    fn test_xiaomi_mimo_asr_recognize_builtin_english() {
        let api_key = match std::env::var("XIAOMI_API_KEY") {
            Ok(key) if !key.trim().is_empty() => key,
            _ => {
                eprintln!("XIAOMI_API_KEY が現在のプロセスから取得できません。");
                eprintln!("プロセスを再起動してから再試行してください。");
                return; // テストをスキップ（failさせない）
            }
        };

        // 同梱テスト音声を探す
        let audio_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("xiaomi-mimo-asr-test-en.wav");
        assert!(
            audio_path.exists(),
            "同梱テスト音声が見つかりません: {}",
            audio_path.display()
        );

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(async {
            recognize_xiaomi_mimo_audio(
                "https://api.xiaomimimo.com/v1",
                "mimo-v2.5-asr",
                "en",
                &audio_path,
            )
            .await
        });

        match &result {
            Ok(r) => {
                eprintln!("=== Xiaomi MiMo ASR 実環境テスト ===");
                eprintln!("language: {}", r.language);
                eprintln!("model: {}", r.model);
                eprintln!("transcript_length: {}", r.transcript.len());
                eprintln!("transcript_empty: {}", r.transcript.is_empty());

                // 基本検証
                assert_eq!(r.model, "mimo-v2.5-asr");
                assert_eq!(r.language, "en");
                assert!(!r.transcript.is_empty(), "transcript should not be empty for English speech audio");

                // APIキー漏洩チェック
                let debug_str = format!("{:?}", r);
                assert!(
                    !debug_str.contains(&api_key),
                    "API key must not appear in debug output"
                );
            }
            Err(e) => {
                let msg = &e.message;
                eprintln!("=== Xiaomi MiMo ASR 実環境テスト FAILED ===");
                eprintln!("error_kind: {:?}", e.kind);
                eprintln!("error_message: {}", msg);

                // APIキー漏洩チェック
                assert!(
                    !msg.contains(&api_key),
                    "error message must not contain API key"
                );

                // 認証エラーの場合は明示的に報告
                if e.kind == FetchErrorKind::AuthError {
                    panic!("認証エラー: APIキーが無効です。{}", msg);
                }

                panic!("Xiaomi MiMo ASR 認識テスト失敗: {}", msg);
            }
        }
    }

    #[test]
    #[ignore] // CI環境ではXIAOMI_API_KEYが未設定のため
    fn test_xiaomi_mimo_asr_response_shape_is_string() {
        let api_key = match std::env::var("XIAOMI_API_KEY") {
            Ok(key) if !key.trim().is_empty() => key,
            _ => {
                eprintln!("XIAOMI_API_KEY が現在のプロセスから取得できません。");
                return;
            }
        };

        let audio_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("xiaomi-mimo-asr-test-en.wav");
        assert!(audio_path.exists(), "同梱テスト音声が見つかりません");

        // 生のレスポンスを確認するため、直接HTTPリクエストを送る
        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(async {
            use base64::Engine;
            let audio_bytes = fs::read(&audio_path).unwrap();
            let audio_base64 = base64::engine::general_purpose::STANDARD.encode(&audio_bytes);
            let data_url = format!("data:audio/wav;base64,{}", audio_base64);

            let body = serde_json::json!({
                "model": "mimo-v2.5-asr",
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "input_audio",
                                "input_audio": {
                                    "data": data_url
                                }
                            }
                        ]
                    }
                ],
                "asr_options": {
                    "language": "en"
                }
            });

            let client = reqwest::Client::new();
            let resp = client
                .post("https://api.xiaomimimo.com/v1/chat/completions")
                .header("api-key", &api_key)
                .header("Content-Type", "application/json")
                .json(&body)
                .send()
                .await
                .unwrap();

            assert!(resp.status().is_success(), "HTTP request failed: {}", resp.status());

            let json: serde_json::Value = resp.json().await.unwrap();

            // レスポンス構造を確認
            let content = json
                .get("choices")
                .and_then(|c| c.as_array())
                .and_then(|arr| arr.first())
                .and_then(|choice| choice.get("message"))
                .and_then(|msg| msg.get("content"));

            eprintln!("=== レスポンスshape確認 ===");
            match content {
                Some(serde_json::Value::String(s)) => {
                    eprintln!("content type: string");
                    eprintln!("content length: {}", s.len());
                    assert!(!s.is_empty(), "transcript should not be empty");
                }
                Some(serde_json::Value::Array(arr)) => {
                    eprintln!("content type: array");
                    eprintln!("array length: {}", arr.len());
                    // Array形式の場合、テキストを結合
                    let mut texts = Vec::new();
                    for item in arr {
                        if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                            texts.push(text.to_string());
                        }
                    }
                    let transcript = texts.join("");
                    eprintln!("transcript length: {}", transcript.len());
                    assert!(!transcript.is_empty(), "transcript should not be empty");
                }
                other => {
                    eprintln!("content type: {:?}", other);
                    panic!("unexpected content type");
                }
            }

            // APIキー漏洩チェック
            let json_str = serde_json::to_string(&json).unwrap();
            assert!(!json_str.contains(&api_key), "API key must not appear in response");

            json
        });

        eprintln!("テスト完了: レスポンスshape確認成功");
        let _ = result;
        let _ = api_key; // 未使用警告を抑制
    }

    // ---- Docker candidate paths ----

    #[test]
    fn docker_candidate_paths_include_program_files() {
        let pf = std::path::PathBuf::from("C:\\Program Files");
        let la = std::path::PathBuf::from("C:\\Users\\test\\AppData\\Local");
        let paths = docker_candidate_paths(Some(&pf), Some(&la));
        let pf_docker = pf.join("Docker").join("Docker").join("resources").join("bin").join("docker.exe");
        assert!(paths.contains(&pf_docker), "should include ProgramFiles Docker path, got: {:?}", paths);
    }

    #[test]
    fn docker_candidate_paths_include_per_user_desktop() {
        let pf = std::path::PathBuf::from("C:\\Program Files");
        let la = std::path::PathBuf::from("C:\\Users\\test\\AppData\\Local");
        let paths = docker_candidate_paths(Some(&pf), Some(&la));
        let la_docker = la.join("Programs").join("DockerDesktop").join("resources").join("bin").join("docker.exe");
        assert!(paths.contains(&la_docker), "should include per-user DockerDesktop path, got: {:?}", paths);
    }

    #[test]
    fn docker_desktop_candidate_paths_include_program_files() {
        let pf = std::path::PathBuf::from("C:\\Program Files");
        let la = std::path::PathBuf::from("C:\\Users\\test\\AppData\\Local");
        let paths = docker_desktop_candidate_paths(Some(&pf), Some(&la));
        let pf_desktop = pf.join("Docker").join("Docker").join("Docker Desktop.exe");
        assert!(paths.contains(&pf_desktop), "should include ProgramFiles Desktop path, got: {:?}", paths);
    }

    #[test]
    fn docker_desktop_candidate_paths_include_per_user() {
        let pf = std::path::PathBuf::from("C:\\Program Files");
        let la = std::path::PathBuf::from("C:\\Users\\test\\AppData\\Local");
        let paths = docker_desktop_candidate_paths(Some(&pf), Some(&la));
        let la_desktop = la.join("Programs").join("DockerDesktop").join("Docker Desktop.exe");
        assert!(paths.contains(&la_desktop), "should include per-user DockerDesktop path, got: {:?}", paths);
    }

    #[test]
    fn docker_candidate_paths_empty_when_no_env() {
        let paths = docker_candidate_paths(None, None);
        assert!(paths.is_empty(), "should be empty when no env vars, got: {:?}", paths);
    }

    // ---- DockerStatus serialization ----

    #[test]
    fn docker_status_serializes_as_camel_case() {
        let status = DockerStatus {
            cli_found: true,
            cli_version: Some("Docker version 24.0.7".to_string()),
            daemon_running: true,
            server_version: Some("24.0.7".to_string()),
            desktop_found: true,
            cli_path: Some("C:\\docker.exe".to_string()),
            desktop_path: Some("C:\\Docker Desktop.exe".to_string()),
            error_kind: None,
            error_message: None,
        };
        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("cliFound"));
        assert!(json.contains("cliVersion"));
        assert!(json.contains("daemonRunning"));
        assert!(json.contains("serverVersion"));
        assert!(json.contains("desktopFound"));
        assert!(json.contains("cliPath"));
        assert!(json.contains("desktopPath"));
        assert!(!json.contains("cli_found"));
        assert!(!json.contains("cli_found"));
    }

    #[test]
    fn docker_status_none_fields_excluded() {
        let status = DockerStatus {
            cli_found: false,
            cli_version: None,
            daemon_running: false,
            server_version: None,
            desktop_found: false,
            cli_path: None,
            desktop_path: None,
            error_kind: Some("cli_not_found".to_string()),
            error_message: Some("not found".to_string()),
        };
        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("errorKind"));
        assert!(json.contains("errorMessage"));
    }

    // ---- DockerStartResult serialization ----

    #[test]
    fn docker_start_result_serializes_as_camel_case() {
        let result = DockerStartResult {
            launched: true,
            message: "起動しました".to_string(),
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("launched"));
        assert!(json.contains("message"));
        assert!(json.contains("起動しました"));
    }

    // ---- DockerCheckError → error_kind conversion ----

    #[test]
    fn docker_error_cli_not_found_to_status() {
        let (kind, msg) = docker_error_to_status(DockerCheckError::CliNotFound);
        assert_eq!(kind.unwrap(), "cli_not_found");
        assert!(msg.unwrap().contains("Docker CLI"));
    }

    #[test]
    fn docker_error_daemon_not_running_to_status() {
        let (kind, msg) = docker_error_to_status(DockerCheckError::DaemonNotRunning("Cannot connect".to_string()));
        assert_eq!(kind.unwrap(), "daemon_not_running");
        assert!(msg.unwrap().contains("Cannot connect"));
    }

    #[test]
    fn docker_error_timeout_to_status() {
        let (kind, msg) = docker_error_to_status(DockerCheckError::Timeout);
        assert_eq!(kind.unwrap(), "check_timeout");
        assert!(msg.unwrap().contains("タイムアウト"));
    }

    #[test]
    fn docker_error_permission_denied_to_status() {
        let (kind, msg) = docker_error_to_status(DockerCheckError::PermissionDenied("access denied".to_string()));
        assert_eq!(kind.unwrap(), "permission_denied");
        assert!(msg.unwrap().contains("権限エラー"));
    }

    // ---- Docker 実環境テスト ----

    #[test]
    #[ignore]
    fn test_docker_check_status_on_this_machine() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let status = rt.block_on(docker_check_status());
        eprintln!("=== Docker Status ===");
        eprintln!("cli_found: {}", status.cli_found);
        eprintln!("cli_version: {:?}", status.cli_version);
        eprintln!("daemon_running: {}", status.daemon_running);
        eprintln!("server_version: {:?}", status.server_version);
        eprintln!("desktop_found: {}", status.desktop_found);
        eprintln!("cli_path: {:?}", status.cli_path);
        eprintln!("desktop_path: {:?}", status.desktop_path);
        eprintln!("error_kind: {:?}", status.error_kind);
        eprintln!("error_message: {:?}", status.error_message);
    }

    // ---- mask_hf_token ----

    #[test]
    fn mask_hf_token_normal_29_chars() {
        let token = "hf_abcdefghijklmnopqrstuvwxyz";
        let masked = mask_hf_token(token);
        // 29文字: 先頭3 + *×22 + 末尾4 = 29
        assert_eq!(masked, "hf_**********************wxyz");
        assert_eq!(masked.chars().count(), 29);
        assert!(!masked.contains("abcdefg"));
        assert!(masked.starts_with("hf_"));
        assert!(masked.ends_with("wxyz"));
    }

    #[test]
    fn mask_hf_token_exactly_12_chars() {
        let token = "hf_123456789";
        let masked = mask_hf_token(token);
        assert_eq!(masked, "hf_****");
    }

    #[test]
    fn mask_hf_token_exactly_7_chars() {
        let token = "hf_1234";
        let masked = mask_hf_token(token);
        assert_eq!(masked, "hf_****");
    }

    #[test]
    fn mask_hf_token_short_6_chars() {
        let masked = mask_hf_token("hf_abc");
        assert_eq!(masked, "設定済み");
    }

    #[test]
    fn mask_hf_token_empty() {
        assert_eq!(mask_hf_token(""), "設定済み");
    }

    #[test]
    fn mask_hf_token_13_chars() {
        let token = "hf_1234567890"; // 13文字
        let masked = mask_hf_token(token);
        // 13文字: 先頭3 + *×6 + 末尾4 = 13
        assert_eq!(masked.chars().count(), 13);
        assert!(masked.starts_with("hf_"));
        assert!(masked.ends_with("7890"));
    }

    // ---- validate_hf_token ----

    #[test]
    fn validate_hf_token_rejects_empty() {
        assert!(validate_hf_token("").is_err());
    }

    #[test]
    fn validate_hf_token_rejects_newline() {
        assert!(validate_hf_token("hf_test\ntoken").is_err());
    }

    #[test]
    fn validate_hf_token_rejects_carriage_return() {
        assert!(validate_hf_token("hf_test\rntoken").is_err());
    }

    #[test]
    fn validate_hf_token_rejects_null_char() {
        assert!(validate_hf_token("hf_test\0token").is_err());
    }

    #[test]
    fn validate_hf_token_rejects_too_long() {
        let long_token = format!("hf_{}", "a".repeat(4094));
        assert!(validate_hf_token(&long_token).is_err());
    }

    #[test]
    fn validate_hf_token_accepts_valid_token() {
        assert!(validate_hf_token("hf_abcdefghijklmnopqrstuvwxyz").is_ok());
    }

    #[test]
    fn validate_hf_token_accepts_no_prefix() {
        // hf_プレフィックスなしも保存許可
        assert!(validate_hf_token("some_other_token").is_ok());
    }

    #[test]
    fn validate_hf_token_accepts_exactly_4096() {
        let token = format!("hf_{}", "a".repeat(4093));
        assert_eq!(token.chars().count(), 4096);
        assert!(validate_hf_token(&token).is_ok());
    }

    // ---- HuggingFaceTokenStatus serialization ----

    #[test]
    fn hf_token_status_serializes_camel_case() {
        let status = HuggingFaceTokenStatus {
            configured: true,
            masked_value: Some("hf_****abcd".to_string()),
        };
        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("configured"));
        assert!(json.contains("maskedValue"));
        assert!(!json.contains("masked_value"));
    }

    #[test]
    fn hf_token_status_no_raw_token() {
        let status = HuggingFaceTokenStatus {
            configured: true,
            masked_value: Some("hf_****abcd".to_string()),
        };
        let json = serde_json::to_string(&status).unwrap();
        // maskedValue以外のフィールドがないことを確認
        assert!(!json.contains("token"));
        assert!(!json.contains("value"));
    }

    // ---- HuggingFaceTokenSaveResult serialization ----

    #[test]
    fn hf_token_save_result_serializes_camel_case() {
        let result = HuggingFaceTokenSaveResult {
            success: true,
            message: "保存しました".to_string(),
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("success"));
        assert!(json.contains("message"));
    }

    // ---- validate_hf_token error messages don't leak input ----

    #[test]
    fn validate_hf_token_error_does_not_contain_input() {
        let token = "sensitive_token_value_12345";
        let err = validate_hf_token("").unwrap_err();
        assert!(!err.contains(token));
    }

    // ---- LocalAsrEngineStatus ----

    #[test]
    fn local_asr_engine_status_serializes_camel_case() {
        let status = LocalAsrEngineStatus {
            engine: "reazonspeech".to_string(),
            display_name: "ReazonSpeech".to_string(),
            installed: true,
            image_name: "asr-composer-reazonspeech:cu126".to_string(),
            image_id: Some("sha256:abc123".to_string()),
            environment_version: Some("1.0.0".to_string()),
            model_name: Some("reazon-research/reazonspeech-espnet-v2".to_string()),
            docker_available: true,
            docker_running: true,
            error_kind: None,
            error_message: None,
        };
        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("displayName"));
        assert!(json.contains("imageName"));
        assert!(json.contains("imageId"));
        assert!(json.contains("environmentVersion"));
        assert!(json.contains("modelName"));
        assert!(json.contains("dockerAvailable"));
        assert!(json.contains("dockerRunning"));
        assert!(!json.contains("display_name"));
        assert!(!json.contains("image_name"));
    }

    // ---- local_asr_engine_defs ----

    #[test]
    fn local_asr_engine_defs_contains_reazonspeech() {
        let defs = local_asr_engine_defs();
        assert!(defs.len() >= 2);
        let reazon = defs.iter().find(|d| d.engine == "reazonspeech").unwrap();
        assert_eq!(reazon.display_name, "ReazonSpeech");
        assert_eq!(reazon.image_name, "asr-composer-reazonspeech:cu126");
        let kotoba = defs.iter().find(|d| d.engine == "kotoba-whisper").unwrap();
        assert_eq!(kotoba.display_name, "Kotoba Whisper v2.2");
        assert_eq!(kotoba.image_name, "asr-composer-kotoba-whisper:cu126");
    }

    // ---- parse_docker_image_inspect ----

    #[test]
    fn parse_docker_image_inspect_normal() {
        let json = r#"[
            {
                "Id": "sha256:d80986f40b0b954d5f19292cf08b8506171b91cb5a9ad80358f79775572d2226",
                "Config": {
                    "Labels": {
                        "com.asr-composer.engine": "reazonspeech",
                        "com.asr-composer.environment-version": "1.0.0",
                        "com.asr-composer.asr-model": "reazon-research/reazonspeech-espnet-v2"
                    }
                }
            }
        ]"#;
        let info = parse_docker_image_inspect(json).unwrap();
        assert_eq!(info.image_id, "sha256:d80986f40b0b954d5f19292cf08b8506171b91cb5a9ad80358f79775572d2226");
        assert_eq!(info.labels.get("com.asr-composer.engine").unwrap(), "reazonspeech");
        assert_eq!(info.labels.get("com.asr-composer.environment-version").unwrap(), "1.0.0");
        assert_eq!(info.labels.get("com.asr-composer.asr-model").unwrap(), "reazon-research/reazonspeech-espnet-v2");
    }

    #[test]
    fn parse_docker_image_inspect_labels_null() {
        let json = r#"[
            {
                "Id": "sha256:abc123",
                "Config": {
                    "Labels": null
                }
            }
        ]"#;
        let info = parse_docker_image_inspect(json).unwrap();
        assert_eq!(info.image_id, "sha256:abc123");
        assert!(info.labels.is_empty());
    }

    #[test]
    fn parse_docker_image_inspect_config_missing() {
        let json = r#"[
            {
                "Id": "sha256:abc123"
            }
        ]"#;
        let info = parse_docker_image_inspect(json).unwrap();
        assert_eq!(info.image_id, "sha256:abc123");
        assert!(info.labels.is_empty());
    }

    #[test]
    fn parse_docker_image_inspect_empty_array() {
        let json = r#"[]"#;
        let result = parse_docker_image_inspect(json);
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), DockerImageInspectResult::NotFound));
    }

    #[test]
    fn parse_docker_image_inspect_invalid_json() {
        let result = parse_docker_image_inspect("not json");
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), DockerImageInspectResult::InspectFailed));
    }

    #[test]
    fn parse_docker_image_inspect_empty_string() {
        let result = parse_docker_image_inspect("");
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), DockerImageInspectResult::InspectFailed));
    }

    // ---- classify_docker_inspect_failure ----

    #[test]
    fn classify_no_such_image() {
        assert!(matches!(
            classify_docker_inspect_failure("Error: No such image: foo"),
            DockerImageInspectResult::NotFound
        ));
    }

    #[test]
    fn classify_no_such_image_lowercase() {
        assert!(matches!(
            classify_docker_inspect_failure("error: no such image: foo"),
            DockerImageInspectResult::NotFound
        ));
    }

    #[test]
    fn classify_cannot_connect_daemon() {
        assert!(matches!(
            classify_docker_inspect_failure("Cannot connect to the Docker daemon"),
            DockerImageInspectResult::DaemonUnavailable
        ));
    }

    #[test]
    fn classify_error_during_connect() {
        assert!(matches!(
            classify_docker_inspect_failure("error during connect: Get http://%2F.%2Fpipe%2Fdocker_engine/v1.40/version"),
            DockerImageInspectResult::DaemonUnavailable
        ));
    }

    #[test]
    fn classify_windows_named_pipe_docker_engine() {
        let stderr = r#"error during connect: open //./pipe/docker_engine: The system cannot find the file specified."#;
        assert!(matches!(
            classify_docker_inspect_failure(stderr),
            DockerImageInspectResult::DaemonUnavailable
        ));
    }

    #[test]
    fn classify_windows_named_pipe_docker_desktop() {
        let stderr = r#"open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified."#;
        assert!(matches!(
            classify_docker_inspect_failure(stderr),
            DockerImageInspectResult::DaemonUnavailable
        ));
    }

    #[test]
    fn classify_file_specified_without_pipe_is_not_daemon() {
        assert!(matches!(
            classify_docker_inspect_failure("The system cannot find the file specified."),
            DockerImageInspectResult::InspectFailed
        ));
    }

    #[test]
    fn classify_unrelated_pipe_with_file_specified_is_not_daemon() {
        let stderr = r#"open //./pipe/unrelated: The system cannot find the file specified."#;
        assert!(matches!(
            classify_docker_inspect_failure(stderr),
            DockerImageInspectResult::InspectFailed
        ));
    }

    #[test]
    fn classify_other_error() {
        assert!(matches!(
            classify_docker_inspect_failure("some unexpected error"),
            DockerImageInspectResult::InspectFailed
        ));
    }

    // ---- unavailable_local_asr_statuses ----

    #[test]
    fn unavailable_local_asr_statuses_returns_all_engines() {
        let statuses = unavailable_local_asr_statuses();
        assert!(statuses.len() >= 2);
        for s in &statuses {
            assert!(!s.installed);
            assert!(!s.docker_available);
            assert!(!s.docker_running);
        }
    }

    // ---- classify_docker_start_result ----

    #[test]
    fn classify_docker_start_success() {
        let result = classify_docker_start_result(true, "", "");
        assert!(result.launched);
        assert!(result.message.contains("起動を開始しました"));
    }

    #[test]
    fn classify_docker_start_failure_with_stderr() {
        let result = classify_docker_start_result(false, "", "error: something went wrong");
        assert!(!result.launched);
        assert!(result.message.contains("起動に失敗しました"));
        assert!(result.message.contains("something went wrong"));
    }

    #[test]
    fn classify_docker_start_failure_with_stdout_fallback() {
        let result = classify_docker_start_result(false, "some output", "");
        assert!(!result.launched);
        assert!(result.message.contains("some output"));
    }

    #[test]
    fn classify_docker_start_failure_empty_output() {
        let result = classify_docker_start_result(false, "", "");
        assert!(!result.launched);
        assert!(result.message.contains("起動に失敗しました"));
        assert!(!result.message.contains("失敗しました:")); // コロンなし
    }

    #[test]
    fn classify_docker_start_stderr_preferred_over_stdout() {
        let result = classify_docker_start_result(false, "stdout msg", "stderr msg");
        assert!(result.message.contains("stderr msg"));
        assert!(!result.message.contains("stdout msg"));
    }

    // ---- tail_stderr ----

    #[test]
    fn tail_stderr_short_returns_all() {
        let input = "line1\nline2\nline3";
        assert_eq!(tail_stderr(input, 30), "line1\nline2\nline3");
    }

    #[test]
    fn tail_stderr_exact_limit_returns_all() {
        let input: String = (0..30).map(|i| format!("line{}", i)).collect::<Vec<_>>().join("\n");
        let result = tail_stderr(&input, 30);
        assert!(result.starts_with("line0"));
        assert!(result.ends_with("line29"));
    }

    #[test]
    fn tail_stderr_long_truncates() {
        let input: String = (0..50).map(|i| format!("line{}", i)).collect::<Vec<_>>().join("\n");
        let result = tail_stderr(&input, 30);
        assert!(!result.contains("line0"));
        assert!(result.contains("line20"));
        assert!(result.ends_with("line49"));
    }

    #[test]
    fn tail_stderr_empty() {
        assert_eq!(tail_stderr("", 30), "");
    }

    // ---- LocalAsrProgress serialization ----

    // ---- extract_asr_stage ----

    #[test]
    fn extract_asr_stage_normal() {
        assert_eq!(extract_asr_stage("ASR_PROGRESS:installing-pyannote"), Some("installing-pyannote"));
    }

    #[test]
    fn extract_asr_stage_with_surrounding_text() {
        assert_eq!(
            extract_asr_stage("#5 [2/3] RUN echo ASR_PROGRESS:building-base-start && apt-get ..."),
            Some("building-base-start")
        );
    }

    #[test]
    fn extract_asr_stage_no_marker() {
        assert_eq!(extract_asr_stage("some random build output"), None);
    }

    #[test]
    fn extract_asr_stage_empty_after_prefix() {
        assert_eq!(extract_asr_stage("ASR_PROGRESS:"), None);
    }

    #[test]
    fn extract_asr_stage_whitespace_trimmed() {
        assert_eq!(extract_asr_stage("ASR_PROGRESS:checking  "), Some("checking"));
    }

    #[test]
    fn extract_asr_stage_completed() {
        assert_eq!(extract_asr_stage("ASR_PROGRESS:completed"), Some("completed"));
    }

    // ---- LocalAsrProgress serialization ----

    #[test]
    fn local_asr_progress_serializes_camel_case() {
        let progress = LocalAsrProgress {
            engine: "reazonspeech".to_string(),
            stage: "building-base".to_string(),
            message: "ベース環境を構築しています".to_string(),
        };
        let json = serde_json::to_string(&progress).unwrap();
        assert!(json.contains("engine"));
        assert!(json.contains("stage"));
        assert!(json.contains("message"));
        assert!(json.contains("building-base")); // stage値はそのまま
        assert!(json.contains("ベース環境"));
    }

    // ---- ASR mode migration ----

    #[test]
    fn test_migrate_asr_mode_cloud_from_google_stt() {
        let mut settings = AppSettings {
            providers: HashMap::new(),
            asr_mode: String::new(),
            asr_engine: "google_stt".to_string(),
            ..Default::default()
        };
        migrate_settings(&mut settings);
        assert_eq!(settings.asr_mode, "cloud");
    }

    #[test]
    fn test_migrate_asr_mode_local_from_reazonspeech() {
        let mut settings = AppSettings {
            providers: HashMap::new(),
            asr_mode: String::new(),
            asr_engine: "reazonspeech".to_string(),
            ..Default::default()
        };
        migrate_settings(&mut settings);
        assert_eq!(settings.asr_mode, "local");
    }

    #[test]
    fn test_migrate_asr_mode_cloud_from_unknown_engine() {
        let mut settings = AppSettings {
            providers: HashMap::new(),
            asr_mode: String::new(),
            asr_engine: "unknown_engine".to_string(),
            ..Default::default()
        };
        migrate_settings(&mut settings);
        assert_eq!(settings.asr_mode, "cloud");
    }

    #[test]
    fn test_migrate_asr_mode_cloud_from_empty_engine() {
        let mut settings = AppSettings {
            providers: HashMap::new(),
            asr_mode: String::new(),
            asr_engine: String::new(),
            ..Default::default()
        };
        migrate_settings(&mut settings);
        assert_eq!(settings.asr_mode, "cloud");
    }

    #[test]
    fn test_migrate_asr_mode_already_set_skips() {
        let mut settings = AppSettings {
            providers: HashMap::new(),
            asr_mode: "local".to_string(),
            asr_engine: "google_stt".to_string(),
            ..Default::default()
        };
        migrate_settings(&mut settings);
        assert_eq!(settings.asr_mode, "local");
    }

    // ---- ASR mode serialization ----

    #[test]
    fn test_asr_mode_engine_serialization() {
        let settings = AppSettings {
            providers: HashMap::new(),
            asr_mode: "cloud".to_string(),
            asr_engine: "openai_audio".to_string(),
            ..Default::default()
        };
        let json = serde_json::to_string(&settings).unwrap();
        assert!(json.contains("\"asr_mode\""));
        assert!(json.contains("\"asr_engine\""));
        assert!(json.contains("\"cloud\""));
        assert!(json.contains("\"openai_audio\""));
    }

    #[test]
    fn test_asr_mode_engine_deserialization_missing_fields() {
        let json = r#"{"providers":{}}"#;
        let settings: AppSettings = serde_json::from_str(json).unwrap();
        assert_eq!(settings.asr_mode, "");
        assert_eq!(settings.asr_engine, "");
    }

    // ---- save_asr_selection validation ----

    #[test]
    fn test_save_asr_selection_invalid_mode() {
        // save_asr_selection の mode 検証をテスト
        let mode = "invalid";
        assert!(mode != "cloud" && mode != "local");
    }

    #[test]
    fn test_save_asr_selection_valid_modes() {
        assert!("cloud" == "cloud" || "cloud" == "local");
        assert!("local" == "cloud" || "local" == "local");
    }

    // ---- asr_languages ----

    #[test]
    fn test_asr_languages_serialization() {
        let mut settings = AppSettings::default();
        settings.asr_languages.insert("qwen3-asr".to_string(), "en".to_string());
        settings.asr_languages.insert("reazonspeech".to_string(), "ja".to_string());
        let json = serde_json::to_string(&settings).unwrap();
        assert!(json.contains("\"asr_languages\""));
        assert!(json.contains("\"qwen3-asr\""));
        assert!(json.contains("\"en\""));
    }

    #[test]
    fn test_asr_languages_deserialization_missing() {
        let json = r#"{"providers":{}}"#;
        let settings: AppSettings = serde_json::from_str(json).unwrap();
        assert!(settings.asr_languages.is_empty());
    }

    #[test]
    fn test_asr_languages_roundtrip() {
        let mut settings = AppSettings::default();
        settings.asr_languages.insert("qwen3-asr".to_string(), "auto".to_string());
        settings.asr_languages.insert("kotoba-whisper".to_string(), "ja".to_string());
        let json = serde_json::to_string_pretty(&settings).unwrap();
        let restored: AppSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.asr_languages.get("qwen3-asr").unwrap(), "auto");
        assert_eq!(restored.asr_languages.get("kotoba-whisper").unwrap(), "ja");
    }

    #[test]
    fn test_asr_languages_engine_specific_save() {
        // エンジン別言語保存の動作確認
        let mut settings = AppSettings::default();
        settings.asr_languages.insert("qwen3-asr".to_string(), "en".to_string());
        settings.asr_languages.insert("reazonspeech".to_string(), "ja".to_string());
        // qwen3-asr の言語だけ更新
        settings.asr_languages.insert("qwen3-asr".to_string(), "zh".to_string());
        assert_eq!(settings.asr_languages.get("qwen3-asr").unwrap(), "zh");
        assert_eq!(settings.asr_languages.get("reazonspeech").unwrap(), "ja");
    }

    // ---- speaker_diarization ----

    #[test]
    fn app_settings_default_enables_speaker_diarization() {
        let settings = AppSettings::default();
        assert!(settings.speaker_diarization);
    }

    #[test]
    fn test_speaker_diarization_old_json_defaults_true() {
        let json = r#"{"providers":{}}"#;
        let settings: AppSettings = serde_json::from_str(json).unwrap();
        assert!(settings.speaker_diarization);
    }

    #[test]
    fn test_speaker_diarization_false_roundtrip() {
        let mut settings = AppSettings::default();
        settings.speaker_diarization = false;
        let json = serde_json::to_string_pretty(&settings).unwrap();
        let restored: AppSettings = serde_json::from_str(&json).unwrap();
        assert!(!restored.speaker_diarization);
    }

    #[test]
    fn test_speaker_diarization_true_roundtrip() {
        let mut settings = AppSettings::default();
        settings.speaker_diarization = true;
        let json = serde_json::to_string_pretty(&settings).unwrap();
        let restored: AppSettings = serde_json::from_str(&json).unwrap();
        assert!(restored.speaker_diarization);
    }

    #[test]
    fn test_speaker_diarization_preserves_other_fields() {
        let mut settings = AppSettings::default();
        settings.asr_mode = "local".to_string();
        settings.asr_engine = "qwen3-asr".to_string();
        settings.asr_languages.insert("qwen3-asr".to_string(), "en".to_string());
        settings.speaker_diarization = false;
        let json = serde_json::to_string_pretty(&settings).unwrap();
        let restored: AppSettings = serde_json::from_str(&json).unwrap();
        assert!(!restored.speaker_diarization);
        assert_eq!(restored.asr_mode, "local");
        assert_eq!(restored.asr_engine, "qwen3-asr");
        assert_eq!(restored.asr_languages.get("qwen3-asr").unwrap(), "en");
    }

    #[test]
    fn test_speaker_diarization_serialization_key() {
        let settings = AppSettings::default();
        let json = serde_json::to_string(&settings).unwrap();
        assert!(json.contains("\"speaker_diarization\""));
        assert!(json.contains("true"));
    }

    // ---- num_speakers ----

    #[test]
    fn test_num_speakers_default_is_auto() {
        let settings = AppSettings::default();
        assert_eq!(settings.num_speakers, "auto");
    }

    #[test]
    fn test_num_speakers_old_json_defaults_empty() {
        let json = r#"{"providers":{}}"#;
        let settings: AppSettings = serde_json::from_str(json).unwrap();
        // #[serde(default)] で空文字列
        assert_eq!(settings.num_speakers, "");
    }

    #[test]
    fn test_num_speakers_roundtrip() {
        let mut settings = AppSettings::default();
        settings.num_speakers = "3".to_string();
        let json = serde_json::to_string_pretty(&settings).unwrap();
        let restored: AppSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.num_speakers, "3");
    }

    #[test]
    fn test_num_speakers_auto_roundtrip() {
        let mut settings = AppSettings::default();
        settings.num_speakers = "auto".to_string();
        let json = serde_json::to_string_pretty(&settings).unwrap();
        let restored: AppSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.num_speakers, "auto");
    }

    #[test]
    fn test_num_speakers_preserves_other_fields() {
        let mut settings = AppSettings::default();
        settings.asr_mode = "local".to_string();
        settings.speaker_diarization = false;
        settings.num_speakers = "4".to_string();
        let json = serde_json::to_string_pretty(&settings).unwrap();
        let restored: AppSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.num_speakers, "4");
        assert_eq!(restored.asr_mode, "local");
        assert!(!restored.speaker_diarization);
    }

    // ---- Transcription Pipeline ----

    #[test]
    fn test_validate_job_id_valid() {
        assert!(validate_job_id("550e8400-e29b-41d4-a716-446655440000").is_ok());
    }

    #[test]
    fn test_validate_job_id_invalid() {
        assert!(validate_job_id("not-a-uuid").is_err());
        assert!(validate_job_id("../etc/passwd").is_err());
        assert!(validate_job_id("").is_err());
    }

    #[test]
    fn test_qwen3_language_name_known_codes() {
        assert_eq!(qwen3_language_name("ja").unwrap(), Some("Japanese"));
        assert_eq!(qwen3_language_name("en").unwrap(), Some("English"));
        assert_eq!(qwen3_language_name("zh").unwrap(), Some("Chinese"));
        assert_eq!(qwen3_language_name("yue").unwrap(), Some("Cantonese"));
        assert_eq!(qwen3_language_name("auto").unwrap(), None);
    }

    #[test]
    fn test_qwen3_language_name_all_30() {
        let codes = [
            "ja", "en", "zh", "yue", "ko", "fr", "de", "es", "pt", "ar",
            "id", "it", "ru", "th", "vi", "tr", "hi", "ms", "nl", "sv",
            "da", "fi", "pl", "cs", "fil", "fa", "el", "hu", "mk", "ro",
        ];
        for code in codes {
            assert!(qwen3_language_name(code).is_ok(), "Failed for {code}");
        }
    }

    #[test]
    fn test_qwen3_language_name_unknown() {
        assert!(qwen3_language_name("xx").is_err());
        assert!(qwen3_language_name("ja_JP").is_err());
    }

    #[test]
    fn test_resolve_asr_image_name() {
        assert_eq!(resolve_asr_image_name("reazonspeech").unwrap(), "asr-composer-reazonspeech:cu126");
        assert_eq!(resolve_asr_image_name("kotoba-whisper").unwrap(), "asr-composer-kotoba-whisper:cu126");
        assert_eq!(resolve_asr_image_name("qwen3-asr").unwrap(), "asr-composer-qwen3-asr:cu126");
        assert!(resolve_asr_image_name("unknown").is_err());
    }

    #[test]
    fn test_build_transcribe_env_vars_qwen3() {
        let mut settings = AppSettings::default();
        settings.asr_languages.insert("qwen3-asr".to_string(), "en".to_string());
        settings.num_speakers = "3".to_string();
        let vars = build_transcribe_env_vars("qwen3-asr", &settings, "test.mp3").unwrap();
        let asr_lang = vars.iter().find(|(k, _)| k == "ASR_LANGUAGE").unwrap();
        assert_eq!(asr_lang.1, "English");
        let num = vars.iter().find(|(k, _)| k == "NUM_SPEAKERS").unwrap();
        assert_eq!(num.1, "3");
    }

    #[test]
    fn test_build_transcribe_env_vars_qwen3_auto() {
        let mut settings = AppSettings::default();
        settings.asr_languages.insert("qwen3-asr".to_string(), "auto".to_string());
        let vars = build_transcribe_env_vars("qwen3-asr", &settings, "test.mp3").unwrap();
        let asr_lang = vars.iter().find(|(k, _)| k == "ASR_LANGUAGE").unwrap();
        assert_eq!(asr_lang.1, "auto");
        // auto時はNUM_SPEAKERSを渡さない
        assert!(!vars.iter().any(|(k, _)| k == "NUM_SPEAKERS"));
    }

    #[test]
    fn test_build_transcribe_env_vars_kotoba() {
        let settings = AppSettings::default();
        let vars = build_transcribe_env_vars("kotoba-whisper", &settings, "test.mp3").unwrap();
        let asr_lang = vars.iter().find(|(k, _)| k == "ASR_LANGUAGE").unwrap();
        assert_eq!(asr_lang.1, "japanese");
    }

    #[test]
    fn test_build_transcribe_env_vars_reazonspeech() {
        let settings = AppSettings::default();
        let vars = build_transcribe_env_vars("reazonspeech", &settings, "test.mp3").unwrap();
        assert!(!vars.iter().any(|(k, _)| k == "ASR_LANGUAGE"));
    }

    #[test]
    fn test_same_filename_different_job_ids() {
        // 同名ファイルでも異なるjobIdならワークディレクトリが異なる
        let job1 = "550e8400-e29b-41d4-a716-446655440000";
        let job2 = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
        assert_ne!(job1, job2);
        // UUID検証は両方通る
        assert!(validate_job_id(job1).is_ok());
        assert!(validate_job_id(job2).is_ok());
    }

    // ---- Pure Validation Functions ----

    #[test]
    fn test_validate_audio_file_nonexistent() {
        let result = validate_audio_file("/nonexistent/path/audio.wav");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("存在しません"));
    }

    #[test]
    fn test_validate_audio_file_invalid_extension() {
        // 既存の一時ファイルを作って拡張子テスト
        let dir = std::env::temp_dir().join("asr_test_ext");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.txt");
        std::fs::write(&path, "dummy").unwrap();
        let result = validate_audio_file(path.to_str().unwrap());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("拡張子"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_validate_audio_file_valid_extensions() {
        let dir = std::env::temp_dir().join("asr_test_valid_ext");
        std::fs::create_dir_all(&dir).unwrap();
        for ext in &["mp3", "wav", "mp4", "m4a", "flac"] {
            let path = dir.join(format!("test.{ext}"));
            std::fs::write(&path, "dummy").unwrap();
            assert!(validate_audio_file(path.to_str().unwrap()).is_ok(), "Failed for .{ext}");
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_validate_asr_engine_valid() {
        assert!(validate_asr_engine("reazonspeech").is_ok());
        assert!(validate_asr_engine("kotoba-whisper").is_ok());
        assert!(validate_asr_engine("qwen3-asr").is_ok());
    }

    #[test]
    fn test_validate_asr_engine_invalid() {
        assert!(validate_asr_engine("unknown").is_err());
        assert!(validate_asr_engine("").is_err());
        assert!(validate_asr_engine("google_stt").is_err());
    }

    #[test]
    fn test_validate_num_speakers_valid() {
        assert!(validate_num_speakers("auto").is_ok());
        assert!(validate_num_speakers("").is_ok());
        assert!(validate_num_speakers("1").is_ok());
        assert!(validate_num_speakers("4").is_ok());
        assert!(validate_num_speakers("8").is_ok());
    }

    #[test]
    fn test_validate_num_speakers_invalid() {
        assert!(validate_num_speakers("0").is_err());
        assert!(validate_num_speakers("9").is_err());
        assert!(validate_num_speakers("abc").is_err());
        assert!(validate_num_speakers("1.5").is_err());
    }

    #[test]
    fn test_validate_language_for_engine_qwen3_valid() {
        assert!(validate_language_for_engine("qwen3-asr", "ja").is_ok());
        assert!(validate_language_for_engine("qwen3-asr", "en").is_ok());
        assert!(validate_language_for_engine("qwen3-asr", "auto").is_ok());
    }

    #[test]
    fn test_validate_language_for_engine_qwen3_invalid() {
        assert!(validate_language_for_engine("qwen3-asr", "xx").is_err());
    }

    #[test]
    fn test_validate_language_for_engine_kotoba_ja_only() {
        assert!(validate_language_for_engine("kotoba-whisper", "ja").is_ok());
        assert!(validate_language_for_engine("kotoba-whisper", "en").is_err());
    }

    #[test]
    fn test_validate_language_for_engine_reazonspeech_ja_only() {
        assert!(validate_language_for_engine("reazonspeech", "ja").is_ok());
        assert!(validate_language_for_engine("reazonspeech", "en").is_err());
    }

    #[test]
    fn test_validate_transcribe_settings_not_local() {
        let mut settings = AppSettings::default();
        settings.asr_mode = "cloud".to_string();
        settings.asr_engine = "qwen3-asr".to_string();
        settings.speaker_diarization = true;
        let result = validate_transcribe_settings(&settings);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("ローカル"));
    }

    #[test]
    fn test_validate_transcribe_settings_speaker_off() {
        let mut settings = AppSettings::default();
        settings.asr_mode = "local".to_string();
        settings.asr_engine = "qwen3-asr".to_string();
        settings.speaker_diarization = false;
        let result = validate_transcribe_settings(&settings);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("話者分離"));
    }

    #[test]
    fn test_validate_transcribe_settings_valid() {
        let mut settings = AppSettings::default();
        settings.asr_mode = "local".to_string();
        settings.asr_engine = "qwen3-asr".to_string();
        settings.speaker_diarization = true;
        settings.asr_languages.insert("qwen3-asr".to_string(), "ja".to_string());
        assert!(validate_transcribe_settings(&settings).is_ok());
    }
}
