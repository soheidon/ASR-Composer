import { describe, it, expect } from "vitest";
import {
  deriveSegmentStatus,
  isDocumentDirty,
  type TranscriptDocument,
  type TranscriptSegment,
} from "./transcript";

describe("transcript model and utilities", () => {
  it("derives raw status when text and speaker match originals", () => {
    const segment: TranscriptSegment = {
      id: "seg-000001",
      start: 0.0,
      end: 2.0,
      speaker: "SPEAKER_00",
      originalSpeaker: "SPEAKER_00",
      text: "こんにちは",
      originalText: "こんにちは",
      sourceEngine: "reazonspeech",
      sourceSegmentId: "1",
      sourceRunId: "job-1",
      status: "raw",
    };

    expect(deriveSegmentStatus(segment)).toBe("raw");
  });

  it("derives edited status when text is changed", () => {
    const segment: TranscriptSegment = {
      id: "seg-000001",
      start: 0.0,
      end: 2.0,
      speaker: "SPEAKER_00",
      originalSpeaker: "SPEAKER_00",
      text: "こんにちは！",
      originalText: "こんにちは",
      sourceEngine: "reazonspeech",
      sourceSegmentId: "1",
      sourceRunId: "job-1",
      status: "raw",
    };

    expect(deriveSegmentStatus(segment)).toBe("edited");
  });

  it("derives edited status when speaker is changed", () => {
    const segment: TranscriptSegment = {
      id: "seg-000001",
      start: 0.0,
      end: 2.0,
      speaker: "田中",
      originalSpeaker: "SPEAKER_00",
      text: "こんにちは",
      originalText: "こんにちは",
      sourceEngine: "reazonspeech",
      sourceSegmentId: "1",
      sourceRunId: "job-1",
      status: "raw",
    };

    expect(deriveSegmentStatus(segment)).toBe("edited");
  });

  it("reverts status to raw when edited text and speaker are reverted to original", () => {
    const segment: TranscriptSegment = {
      id: "seg-000001",
      start: 0.0,
      end: 2.0,
      speaker: "田中",
      originalSpeaker: "SPEAKER_00",
      text: "変更されたテキスト",
      originalText: "こんにちは",
      sourceEngine: "reazonspeech",
      sourceSegmentId: "1",
      sourceRunId: "job-1",
      status: "edited",
    };

    expect(deriveSegmentStatus(segment)).toBe("edited");

    segment.speaker = "SPEAKER_00";
    segment.text = "こんにちは";
    expect(deriveSegmentStatus(segment)).toBe("raw");
  });

  it("correctly identifies dirty and clean documents", () => {
    const doc1: TranscriptDocument = {
      schemaVersion: 1,
      mediaPath: "test.wav",
      mediaFileName: "test.wav",
      createdAt: "2026-09-26T20:00:00Z",
      updatedAt: "2026-09-26T20:00:00Z",
      language: "ja",
      sourceEngine: "reazonspeech",
      sourceRunId: "job-1",
      segments: [
        {
          id: "seg-000001",
          start: 0,
          end: 1,
          speaker: "SPK",
          originalSpeaker: "SPK",
          text: "A",
          originalText: "A",
          sourceEngine: "reazonspeech",
          sourceSegmentId: "1",
          sourceRunId: "job-1",
          status: "raw",
        },
      ],
    };

    const doc2: TranscriptDocument = JSON.parse(JSON.stringify(doc1));
    expect(isDocumentDirty(doc1, doc2)).toBe(false);

    doc2.segments[0].text = "B";
    expect(isDocumentDirty(doc2, doc1)).toBe(true);
  });
});
