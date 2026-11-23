import { describe, it, expect } from "vitest";
import {
  buildCompareCorrectionInput,
  validateCompareCorrectionBatchOutput,
  runCompareCorrection,
  type CompareCorrectionItem,
  type CompareCorrectionProvider,
} from "./compare-correction";
import type { MultiEngineSession } from "./multi-asr";
import { alignMultiEngineSession } from "./multi-asr";
import type { TranscriptDocument, TranscriptSegment } from "./transcript";

function makeSeg(
  id: string,
  start: number,
  end: number,
  text: string,
  speaker: string | null,
  sourceEngine: string,
): TranscriptSegment {
  return {
    id,
    start,
    end,
    text,
    speaker,
    originalText: text,
    originalSpeaker: speaker,
    sourceEngine,
    sourceSegmentId: id,
    sourceRunId: "run-1",
    status: "raw",
  };
}

function makeDoc(engine: string, segments: TranscriptSegment[], textWithoutTiming?: string): TranscriptDocument {
  return {
    schemaVersion: 1,
    mediaPath: "audio.wav",
    mediaFileName: "audio.wav",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    language: "ja",
    sourceEngine: engine,
    sourceRunId: "run-1",
    segments,
    ...(textWithoutTiming ? { transcriptTextWithoutTiming: textWithoutTiming } : {}),
  };
}

describe("compare-correction.ts", () => {
  it("builds compare input with aligned candidates, unaligned partner segments, and timeless partner text", () => {
    const anchorDoc = makeDoc("cloud:google_stt", [
      makeSeg("gword-1", 0, 0.5, "今日", "S1", "cloud:google_stt"),
      makeSeg("gword-2", 0.5, 1.0, "は", "S1", "cloud:google_stt"),
    ]);
    const partnerDoc = makeDoc("local:kotoba-whisper", [
      makeSeg("k-1", 0, 1.0, "今日は", null, "local:kotoba-whisper"),
      makeSeg("k-2", 3.0, 4.0, "未整列区間", null, "local:kotoba-whisper"),
    ]);

    const session: MultiEngineSession = {
      sessionId: "sess-1",
      mediaPath: "audio.wav",
      mediaFileName: "audio.wav",
      expectedDurationSec: 5,
      anchorEngineId: "cloud:google_stt",
      createdAt: "2026-01-01T00:00:00Z",
      results: {
        "cloud:google_stt": {
          engineId: "cloud:google_stt",
          displayName: "Google STT",
          document: anchorDoc,
          durationSec: 5,
          completedAt: "2026-01-01T00:00:00Z",
          timingGranularity: "segment",
        },
        "local:kotoba-whisper": {
          engineId: "local:kotoba-whisper",
          displayName: "Kotoba Whisper",
          document: partnerDoc,
          durationSec: 5,
          completedAt: "2026-01-01T00:00:00Z",
          timingGranularity: "segment",
        },
      },
    };

    const alignment = alignMultiEngineSession(session);
    const input = buildCompareCorrectionInput({
      session,
      alignment,
      anchorEngineId: "cloud:google_stt",
      partnerEngineId: "local:kotoba-whisper",
    });

    expect(input.items).toHaveLength(2);
    expect(input.items[0].partnerCandidates[0].text).toBe("今日は");
    expect(input.unalignedPartnerSegments).toHaveLength(1);
    expect(input.unalignedPartnerSegments[0].segmentId).toBe("k-2");

    // Timeless partner case
    const timelessSession: MultiEngineSession = {
      ...session,
      results: {
        ...session.results,
        "cloud:xiaomi_mimo_asr": {
          engineId: "cloud:xiaomi_mimo_asr",
          displayName: "Xiaomi MiMo",
          document: makeDoc("cloud:xiaomi_mimo_asr", [], "今日は晴れです"),
          durationSec: 5,
          completedAt: "2026-01-01T00:00:00Z",
          timingGranularity: "whole_audio",
        },
      },
    };
    const timelessAlignment = alignMultiEngineSession(timelessSession);
    const timelessInput = buildCompareCorrectionInput({
      session: timelessSession,
      alignment: timelessAlignment,
      anchorEngineId: "cloud:google_stt",
      partnerEngineId: "cloud:xiaomi_mimo_asr",
    });
    expect(timelessInput.partnerWholeTextWithoutTiming).toBe("今日は晴れです");
  });

  it("validates structured correction output and rejects unknown, duplicate, or missing segment IDs", () => {
    const targets: CompareCorrectionItem[] = [
      {
        segmentId: "s1",
        start: 0,
        end: 1,
        speaker: null,
        anchorEngineId: "a",
        anchorText: "A",
        partnerCandidates: [],
      },
      {
        segmentId: "s2",
        start: 1,
        end: 2,
        speaker: null,
        anchorEngineId: "a",
        anchorText: "B",
        partnerCandidates: [],
      },
    ];

    expect(
      validateCompareCorrectionBatchOutput(targets, [
        { segmentId: "s1", correctedText: "A" },
        { segmentId: "s2", correctedText: "B" },
      ]),
    ).toEqual([
      { segmentId: "s1", correctedText: "A" },
      { segmentId: "s2", correctedText: "B" },
    ]);

    expect(() =>
      validateCompareCorrectionBatchOutput(targets, [{ segmentId: "unknown", correctedText: "A" }]),
    ).toThrow(/未知/);

    expect(() =>
      validateCompareCorrectionBatchOutput(targets, [
        { segmentId: "s1", correctedText: "A" },
        { segmentId: "s1", correctedText: "A2" },
      ]),
    ).toThrow(/重複/);

    expect(() =>
      validateCompareCorrectionBatchOutput(targets, [{ segmentId: "s1", correctedText: "A" }]),
    ).toThrow(/欠落/);
  });

  it("runCompareCorrection preserves anchor id, start, end, and speaker in finalDocument", async () => {
    const anchorDoc = makeDoc("cloud:google_stt", [
      makeSeg("gword-1", 0.25, 0.75, "きょお", "SpeakerA", "cloud:google_stt"),
      makeSeg("gword-2", 0.75, 1.25, "は", "SpeakerA", "cloud:google_stt"),
    ]);
    const partnerDoc = makeDoc("local:kotoba-whisper", [
      makeSeg("k-1", 0.2, 1.3, "今日は", null, "local:kotoba-whisper"),
    ]);
    const session: MultiEngineSession = {
      sessionId: "sess-2",
      mediaPath: "audio.wav",
      mediaFileName: "audio.wav",
      expectedDurationSec: 5,
      anchorEngineId: "cloud:google_stt",
      createdAt: "2026-01-01T00:00:00Z",
      results: {
        "cloud:google_stt": {
          engineId: "cloud:google_stt",
          displayName: "Google STT",
          document: anchorDoc,
          durationSec: 5,
          completedAt: "2026-01-01T00:00:00Z",
          timingGranularity: "segment",
        },
        "local:kotoba-whisper": {
          engineId: "local:kotoba-whisper",
          displayName: "Kotoba Whisper",
          document: partnerDoc,
          durationSec: 5,
          completedAt: "2026-01-01T00:00:00Z",
          timingGranularity: "segment",
        },
      },
    };
    const alignment = alignMultiEngineSession(session);

    const mockProvider: CompareCorrectionProvider = {
      async correctBatch(req) {
        return req.targets.map((t) => ({
          segmentId: t.segmentId,
          correctedText: t.segmentId === "gword-1" ? "今日" : t.anchorText,
        }));
      },
    };

    const runResult = await runCompareCorrection({
      session,
      alignment,
      anchorEngineId: "cloud:google_stt",
      partnerEngineId: "local:kotoba-whisper",
      provider: mockProvider,
    });

    expect(runResult.status).toBe("success");
    if (runResult.status === "success") {
      expect(runResult.corrections).toHaveLength(2);
      expect(runResult.finalDocument.segments[0]).toMatchObject({
        id: "gword-1",
        start: 0.25,
        end: 0.75,
        text: "今日",
        speaker: "SpeakerA",
      });
      expect(runResult.finalDocument.segments[1].start).toBe(0.75);
      expect(runResult.finalDocument.segments[1].end).toBe(1.25);
    }
  });
});
