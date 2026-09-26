use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::Write;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegment {
    pub id: String,
    pub start: f64,
    pub end: f64,
    pub speaker: Option<String>,
    pub original_speaker: Option<String>,
    pub text: String,
    pub original_text: String,
    pub source_engine: Option<String>,
    pub source_segment_id: Option<String>,
    pub source_run_id: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptDocument {
    pub schema_version: u32,
    pub media_path: String,
    pub media_file_name: String,
    pub created_at: String,
    pub updated_at: String,
    pub language: Option<String>,
    pub source_engine: Option<String>,
    pub source_run_id: Option<String>,
    pub segments: Vec<TranscriptSegment>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RawSegment {
    pub start: f64,
    pub end: f64,
    pub speaker: Option<String>,
    pub text: String,
}

impl TranscriptDocument {
    /// 生セグメントJSONからCanonical TranscriptDocumentを生成する
    pub fn from_raw_segments(
        raw_segments: Vec<RawSegment>,
        media_path: String,
        media_file_name: String,
        language: Option<String>,
        source_engine: Option<String>,
        source_run_id: Option<String>,
    ) -> Self {
        let now = chrono_now_iso();
        let segments = raw_segments
            .into_iter()
            .enumerate()
            .map(|(idx, r)| {
                let speaker = r.speaker.filter(|s| !s.is_empty());
                let original_speaker = speaker.clone();
                let text = r.text;
                let original_text = text.clone();
                let source_segment_id = Some((idx + 1).to_string());

                TranscriptSegment {
                    id: format!("seg-{:06}", idx + 1),
                    start: r.start,
                    end: r.end,
                    speaker,
                    original_speaker,
                    text,
                    original_text,
                    source_engine: source_engine.clone(),
                    source_segment_id,
                    source_run_id: source_run_id.clone(),
                    status: "raw".to_string(),
                }
            })
            .collect();

        TranscriptDocument {
            schema_version: 1,
            media_path,
            media_file_name,
            created_at: now.clone(),
            updated_at: now,
            language,
            source_engine,
            source_run_id,
            segments,
        }
    }
}

fn chrono_now_iso() -> String {
    // 外部クレート依存を増やさずISO 8601フォーマットを生成（std::time利用）
    let now = std::time::SystemTime::now();
    let dt = humantime_or_basic_iso(now);
    dt
}

fn humantime_or_basic_iso(now: std::time::SystemTime) -> String {
    let dur = now
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs();
    // 簡易的なUTC日付時間計算
    let days = secs / 86400;
    let rem_secs = secs % 86400;
    let hours = rem_secs / 3600;
    let minutes = (rem_secs % 3600) / 60;
    let seconds = rem_secs % 60;

    // 1970年からの閏年考慮日付計算
    let (year, month, day) = days_to_ymd(days);
    format!("{year:04}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{seconds:02}Z")
}

fn days_to_ymd(days: u64) -> (u32, u32, u32) {
    let mut d = days as i64;
    let mut y = 1970;
    loop {
        let leap = is_leap(y);
        let days_in_year = if leap { 366 } else { 365 };
        if d < days_in_year {
            break;
        }
        d -= days_in_year;
        y += 1;
    }
    let leap = is_leap(y);
    let month_days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut m = 1;
    for &md in &month_days {
        if d < md {
            break;
        }
        d -= md;
        m += 1;
    }
    (y as u32, m, (d + 1) as u32)
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0)
}

/// TranscriptDocument を .asrc.json へアトミックに保存する
pub fn save_transcript_document_atomic(path: &Path, doc: &TranscriptDocument) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("ディレクトリ作成エラー: {e}"))?;
    }

    let json_bytes = serde_json::to_vec_pretty(doc)
        .map_err(|e| format!("JSONシリアライズエラー: {e}"))?;

    let file_stem = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("transcript");
    let random_id = uuid::Uuid::new_v4().to_string();
    let tmp_file_name = format!(".{file_stem}.{random_id}.tmp");
    let tmp_path = path.parent().unwrap_or_else(|| Path::new(".")).join(&tmp_file_name);

    // 一時ファイルに書き込み & flush
    {
        let mut f = File::create(&tmp_path)
            .map_err(|e| format!("一時ファイル作成エラー ({}): {e}", tmp_path.display()))?;
        f.write_all(&json_bytes)
            .map_err(|e| format!("一時ファイル書き込みエラー: {e}"))?;
        f.sync_all()
            .map_err(|e| format!("ディスクフラッシュエラー: {e}"))?;
    }

    // アトミック置換
    let replace_res = replace_file_atomic(&tmp_path, path);
    if replace_res.is_err() {
        let _ = fs::remove_file(&tmp_path);
    }
    replace_res
}

/// OSネイティブなアトミックファイル置換
fn replace_file_atomic(src: &Path, dest: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH};

        let src_wide: Vec<u16> = src.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        let dest_wide: Vec<u16> = dest.as_os_str().encode_wide().chain(std::iter::once(0)).collect();

        let success = unsafe {
            MoveFileExW(
                src_wide.as_ptr(),
                dest_wide.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };

        if success == 0 {
            let err = std::io::Error::last_os_error();
            return Err(format!("Windowsファイル置換エラー: {err}"));
        }
        Ok(())
    }

    #[cfg(not(windows))]
    {
        fs::rename(src, dest).map_err(|e| format!("ファイル置換エラー: {e}"))
    }
}

/// .asrc.json を読み込み、スキーマバージョンを検証して返す
pub fn load_transcript_document(path: &Path) -> Result<TranscriptDocument, String> {
    if !path.exists() {
        return Err(format!("指定されたファイルが存在しません: {}", path.display()));
    }
    let content = fs::read_to_string(path)
        .map_err(|e| format!("ファイル読み込みエラー ({}): {e}", path.display()))?;

    let doc: TranscriptDocument = serde_json::from_str(&content)
        .map_err(|e| format!("JSONパースエラー ({}): {e}", path.display()))?;

    if doc.schema_version != 1 {
        return Err(format!(
            "未対応のスキーマバージョンです: {} (対応バージョン: 1)",
            doc.schema_version
        ));
    }

    Ok(doc)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_from_raw_segments() {
        let raw = vec![
            RawSegment {
                start: 0.5,
                end: 2.3,
                speaker: Some("SPEAKER_00".to_string()),
                text: "こんにちは".to_string(),
            },
            RawSegment {
                start: 2.5,
                end: 4.0,
                speaker: None,
                text: "さようなら".to_string(),
            },
        ];

        let doc = TranscriptDocument::from_raw_segments(
            raw,
            "C:\\audio\\test.wav".to_string(),
            "test.wav".to_string(),
            Some("ja".to_string()),
            Some("reazonspeech".to_string()),
            Some("job-123".to_string()),
        );

        assert_eq!(doc.schema_version, 1);
        assert_eq!(doc.media_file_name, "test.wav");
        assert_eq!(doc.segments.len(), 2);

        assert_eq!(doc.segments[0].id, "seg-000001");
        assert_eq!(doc.segments[0].speaker, Some("SPEAKER_00".to_string()));
        assert_eq!(doc.segments[0].original_speaker, Some("SPEAKER_00".to_string()));
        assert_eq!(doc.segments[0].text, "こんにちは");
        assert_eq!(doc.segments[0].original_text, "こんにちは");
        assert_eq!(doc.segments[0].status, "raw");

        assert_eq!(doc.segments[1].id, "seg-000002");
        assert_eq!(doc.segments[1].speaker, None);
        assert_eq!(doc.segments[1].original_speaker, None);
        assert_eq!(doc.segments[1].status, "raw");
    }

    #[test]
    fn test_atomic_save_and_load() {
        let dir = std::env::temp_dir().join(format!("asr_test_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let target_path = dir.join("test.asrc.json");

        let doc = TranscriptDocument::from_raw_segments(
            vec![RawSegment {
                start: 1.0,
                end: 3.0,
                speaker: Some("SPK_0".to_string()),
                text: "テスト本文".to_string(),
            }],
            "test.mp3".to_string(),
            "test.mp3".to_string(),
            Some("ja".to_string()),
            Some("kotoba-whisper".to_string()),
            Some("run-001".to_string()),
        );

        // 新規保存
        save_transcript_document_atomic(&target_path, &doc).unwrap();
        assert!(target_path.exists());

        // 読み込み確認
        let loaded = load_transcript_document(&target_path).unwrap();
        assert_eq!(loaded.schema_version, 1);
        assert_eq!(loaded.segments[0].text, "テスト本文");
        assert_eq!(loaded.segments[0].original_speaker, Some("SPK_0".to_string()));

        // 上書き保存（Windows置換テスト）
        let mut modified = loaded.clone();
        modified.segments[0].text = "編集された本文".to_string();
        modified.segments[0].status = "edited".to_string();

        save_transcript_document_atomic(&target_path, &modified).unwrap();
        let reloaded = load_transcript_document(&target_path).unwrap();
        assert_eq!(reloaded.segments[0].text, "編集された本文");
        assert_eq!(reloaded.segments[0].original_text, "テスト本文");
        assert_eq!(reloaded.segments[0].status, "edited");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_schema_version_mismatch() {
        let dir = std::env::temp_dir().join(format!("asr_test_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("v2.asrc.json");

        let json_v2 = r#"{
            "schemaVersion": 2,
            "mediaPath": "test.wav",
            "mediaFileName": "test.wav",
            "createdAt": "2026-09-26T20:00:00Z",
            "updatedAt": "2026-09-26T20:00:00Z",
            "language": "ja",
            "sourceEngine": "reazonspeech",
            "sourceRunId": "job-1",
            "segments": []
        }"#;

        fs::write(&path, json_v2).unwrap();
        let err = load_transcript_document(&path).unwrap_err();
        assert!(err.contains("未対応のスキーマバージョン"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_invalid_json() {
        let dir = std::env::temp_dir().join(format!("asr_test_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("invalid.asrc.json");

        fs::write(&path, "not a valid json content").unwrap();
        let err = load_transcript_document(&path).unwrap_err();
        assert!(err.contains("JSONパースエラー"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_1000_segments_performance() {
        let raw_1000: Vec<RawSegment> = (0..1000)
            .map(|i| RawSegment {
                start: i as f64 * 3.0,
                end: (i + 1) as f64 * 3.0,
                speaker: Some(format!("SPEAKER_{:02}", i % 4)),
                text: format!("これは第{}番目の発言セグメントのテキストデータです。", i + 1),
            })
            .collect();

        let start_time = std::time::Instant::now();
        let doc = TranscriptDocument::from_raw_segments(
            raw_1000,
            "C:\\audio\\long_interview.wav".to_string(),
            "long_interview.wav".to_string(),
            Some("ja".to_string()),
            Some("qwen3-asr".to_string()),
            Some("run-1000".to_string()),
        );
        let creation_dur = start_time.elapsed();
        assert_eq!(doc.segments.len(), 1000);
        assert_eq!(doc.segments[999].id, "seg-001000");

        let dir = std::env::temp_dir().join(format!("asr_test_1000_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("long_interview.asrc.json");

        let save_start = std::time::Instant::now();
        save_transcript_document_atomic(&path, &doc).unwrap();
        let save_dur = save_start.elapsed();

        let load_start = std::time::Instant::now();
        let loaded = load_transcript_document(&path).unwrap();
        let load_dur = load_start.elapsed();

        assert_eq!(loaded.segments.len(), 1000);
        assert_eq!(loaded.segments[999].original_text, "これは第1000番目の発言セグメントのテキストデータです。");

        // 1000セグメントの処理時間が十分高速（それぞれ50ms未満）であることを確認
        assert!(creation_dur.as_millis() < 50);
        assert!(save_dur.as_millis() < 100);
        assert!(load_dur.as_millis() < 50);

        let _ = fs::remove_dir_all(&dir);
    }
}
