export type SegmentStatus = "raw" | "edited" | "reviewed";

export interface TranscriptSegment {
  id: string;                      // 例: "seg-000001"
  start: number;                   // 開始秒数
  end: number;                     // 終了秒数

  speaker: string | null;          // 現在の話者 (編集可能)
  originalSpeaker: string | null;  // ASR原文の話者 (不変)

  text: string;                    // 現在の正本文 (編集可能)
  originalText: string;            // ASR原文のテキスト (不変)

  sourceEngine: string | null;     // 例: "reazonspeech", "kotoba-whisper", "qwen3-asr"
  sourceSegmentId: string | null;  // 元ASRの連番ID
  sourceRunId: string | null;      // ASR実行Job ID
  status: SegmentStatus;           // "raw" | "edited" | "reviewed"
}

export interface TranscriptDocument {
  schemaVersion: 1;
  mediaPath: string;               // 元音声/動画の絶対パス
  mediaFileName: string;           // ファイル名
  createdAt: string;               // ISO 8601
  updatedAt: string;               // ISO 8601
  language: string | null;         // "ja", "en" 等
  sourceEngine: string | null;
  sourceRunId: string | null;
  segments: TranscriptSegment[];
}

/**
 * セグメントの現在の status を導出する。
 * text === originalText かつ speaker === originalSpeaker なら "raw"、
 * どちらかに差分があれば "edited" を返す。
 */
export function deriveSegmentStatus(segment: {
  text: string;
  originalText: string;
  speaker: string | null;
  originalSpeaker: string | null;
}): SegmentStatus {
  if (
    segment.text === segment.originalText &&
    segment.speaker === segment.originalSpeaker
  ) {
    return "raw";
  }
  return "edited";
}

/**
 * 2つのドキュメントのセグメント内容（speaker, text）に差分があるか判定する。
 */
export function isDocumentDirty(
  current: TranscriptDocument,
  baseline: TranscriptDocument
): boolean {
  if (current.segments.length !== baseline.segments.length) {
    return true;
  }
  for (let i = 0; i < current.segments.length; i++) {
    const cur = current.segments[i];
    const base = baseline.segments[i];
    if (cur.speaker !== base.speaker || cur.text !== base.text) {
      return true;
    }
  }
  return false;
}
