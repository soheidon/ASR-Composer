import type { TranscriptDocument, TranscriptSegment } from "./transcript";

export interface GoogleSttRawWord {
  word?: string;
  startOffset?: string;
  endOffset?: string;
  confidence?: number;
  speakerLabel?: string;
  [key: string]: unknown;
}

export interface GoogleSttRawAlternative {
  transcript?: string;
  confidence?: number;
  words?: GoogleSttRawWord[];
  [key: string]: unknown;
}

export interface GoogleSttRawResultItem {
  alternatives?: GoogleSttRawAlternative[];
  resultEndOffset?: string;
  languageCode?: string;
  [key: string]: unknown;
}

export interface GoogleSttRawResponse {
  results?: GoogleSttRawResultItem[];
  [key: string]: unknown;
}

export interface GoogleSttRecognizeIpcResult {
  transcript?: string;
  rawResponse?: GoogleSttRawResponse;
  segments?: Array<{
    transcript?: string;
    startOffset?: string | null;
    endOffset?: string | null;
    words?: GoogleSttRawWord[];
    confidence?: number | null;
    languageCode?: string | null;
  }>;
}

/**
 * Google Protobuf Duration 文字列（例: "0.850s", "12s"）を秒数へ変換する。
 * 欠落・負値・不正文字列時は補完せず null を返す。
 */
export function parseGoogleDurationToSeconds(offset: unknown): number | null {
  if (typeof offset !== "string") {
    return null;
  }
  const trimmed = offset.trim();
  const match = /^(\d+(?:\.\d+)?)s$/.exec(trimmed);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) {
    return null;
  }
  return value;
}

export type GoogleConversionResult =
  | {
      ok: true;
      document: TranscriptDocument;
    }
  | {
      ok: false;
      reason: string;
      documentWithoutTiming: TranscriptDocument;
    };

/**
 * Google V2 recognize HTTP 生応答 JSON を変更せず、比較用 TranscriptDocument（1語1セグメント）を生成する。
 */
export function convertGoogleRawResponseToTranscriptDocument(params: {
  rawResponse: GoogleSttRawResponse;
  mediaPath: string;
  mediaFileName: string;
  language: string;
  sourceRunId: string;
  expectedDurationSec?: number;
  transcriptFallback?: string;
}): GoogleConversionResult {
  const {
    rawResponse,
    mediaPath,
    mediaFileName,
    language,
    sourceRunId,
    expectedDurationSec,
    transcriptFallback = "",
  } = params;

  const now = new Date().toISOString();
  const results = Array.isArray(rawResponse?.results) ? rawResponse.results : [];
  const fullTranscript =
    results
      .map((r) => r.alternatives?.[0]?.transcript ?? "")
      .join("")
      .trim() || transcriptFallback.trim();

  const makeFallbackDoc = (): TranscriptDocument => ({
    schemaVersion: 1,
    mediaPath,
    mediaFileName,
    createdAt: now,
    updatedAt: now,
    language,
    sourceEngine: "cloud:google_stt",
    sourceRunId,
    segments: [],
    transcriptTextWithoutTiming: fullTranscript,
  });

  const segments: TranscriptSegment[] = [];
  let wordCounter = 0;

  for (const resultItem of results) {
    const alt = resultItem?.alternatives?.[0];
    if (!alt) continue;
    const altTranscript = typeof alt.transcript === "string" ? alt.transcript.trim() : "";
    const words = Array.isArray(alt.words) ? alt.words : [];
    if (altTranscript.length > 0 && words.length === 0) {
      return {
        ok: false,
        reason: "Google Speech-to-Textの認識結果の一部に単語タイムスタンプ(words)が欠落しています",
        documentWithoutTiming: makeFallbackDoc(),
      };
    }
    for (const w of words) {
      const wordText = typeof w.word === "string" ? w.word : "";
      if (!wordText.trim()) {
        return {
          ok: false,
          reason: "Google Speech-to-Textの単語データに空のwordが含まれています",
          documentWithoutTiming: makeFallbackDoc(),
        };
      }
      const start = parseGoogleDurationToSeconds(w.startOffset);
      const end = parseGoogleDurationToSeconds(w.endOffset);
      if (start === null || end === null) {
        return {
          ok: false,
          reason: `Google単語「${wordText}」の開始/終了時刻が欠落または不正です`,
          documentWithoutTiming: makeFallbackDoc(),
        };
      }
      if (end <= start) {
        return {
          ok: false,
          reason: `Google単語「${wordText}」の時刻が逆転または長さ0です (${start}s..${end}s)`,
          documentWithoutTiming: makeFallbackDoc(),
        };
      }
      if (
        typeof expectedDurationSec === "number" &&
        Number.isFinite(expectedDurationSec) &&
        expectedDurationSec > 0 &&
        end > expectedDurationSec
      ) {
        return {
          ok: false,
          reason: `Google単語「${wordText}」の終了時刻 (${end}s) が音声長 (${expectedDurationSec}s) を超えています`,
          documentWithoutTiming: makeFallbackDoc(),
        };
      }

      wordCounter += 1;
      const segId = `gword-${String(wordCounter).padStart(6, "0")}`;
      const speaker =
        typeof w.speakerLabel === "string" && w.speakerLabel.trim()
          ? w.speakerLabel.trim()
          : null;

      segments.push({
        id: segId,
        start,
        end,
        speaker,
        originalSpeaker: speaker,
        text: wordText,
        originalText: wordText,
        sourceEngine: "cloud:google_stt",
        sourceSegmentId: segId,
        sourceRunId,
        status: "raw",
      });
    }
  }

  if (segments.length === 0) {
    return {
      ok: false,
      reason: "Google Speech-to-Textの応答に単語タイムスタンプが含まれていません",
      documentWithoutTiming: makeFallbackDoc(),
    };
  }

  return {
    ok: true,
    document: {
      schemaVersion: 1,
      mediaPath,
      mediaFileName,
      createdAt: now,
      updatedAt: now,
      language,
      sourceEngine: "cloud:google_stt",
      sourceRunId,
      segments,
    },
  };
}
