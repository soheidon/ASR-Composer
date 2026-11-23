import { describe, it, expect } from "vitest";
import {
  parseGoogleDurationToSeconds,
  convertGoogleRawResponseToTranscriptDocument,
  type GoogleSttRawResponse,
} from "./google-stt";

describe("google-stt.ts", () => {
  describe("parseGoogleDurationToSeconds", () => {
    it("parses valid protobuf duration strings to seconds", () => {
      expect(parseGoogleDurationToSeconds("0s")).toBe(0);
      expect(parseGoogleDurationToSeconds("0.850s")).toBe(0.85);
      expect(parseGoogleDurationToSeconds("12.5s")).toBe(12.5);
      expect(parseGoogleDurationToSeconds(" 3.25s ")).toBe(3.25);
    });

    it("returns null for missing, negative, or malformed durations without fabricating", () => {
      expect(parseGoogleDurationToSeconds(undefined)).toBeNull();
      expect(parseGoogleDurationToSeconds(null)).toBeNull();
      expect(parseGoogleDurationToSeconds("")).toBeNull();
      expect(parseGoogleDurationToSeconds("-1.5s")).toBeNull();
      expect(parseGoogleDurationToSeconds("1.5")).toBeNull();
      expect(parseGoogleDurationToSeconds("abc")).toBeNull();
    });
  });

  describe("convertGoogleRawResponseToTranscriptDocument", () => {
    it("converts results[].alternatives[0].words[] (1 word = 1 segment) without mutating rawResponse", () => {
      const rawResponse: GoogleSttRawResponse = {
        results: [
          {
            alternatives: [
              {
                transcript: "Hello world",
                words: [
                  { word: "Hello", startOffset: "0.100s", endOffset: "0.500s", speakerLabel: "1" },
                  { word: "world", startOffset: "0.500s", endOffset: "1.100s", speakerLabel: "1" },
                ],
              },
            ],
            resultEndOffset: "1.200s",
          },
        ],
        metadata: { totalBilledDuration: "2s" },
      };
      const snapshotBefore = JSON.stringify(rawResponse);

      const converted = convertGoogleRawResponseToTranscriptDocument({
        rawResponse,
        mediaPath: "C:/audio/test.wav",
        mediaFileName: "test.wav",
        language: "en",
        sourceRunId: "run-1",
        expectedDurationSec: 5,
      });

      expect(JSON.stringify(rawResponse)).toBe(snapshotBefore);
      expect(converted.ok).toBe(true);
      if (converted.ok) {
        expect(converted.document.segments).toHaveLength(2);
        expect(converted.document.segments[0]).toMatchObject({
          id: "gword-000001",
          start: 0.1,
          end: 0.5,
          text: "Hello",
          speaker: "1",
        });
        expect(converted.document.segments[1]).toMatchObject({
          id: "gword-000002",
          start: 0.5,
          end: 1.1,
          text: "world",
          speaker: "1",
        });
      }
    });

    it("rejects missing, reversed, or out-of-range word timestamps without fabrication", () => {
      const missingOffsets: GoogleSttRawResponse = {
        results: [
          {
            alternatives: [
              {
                transcript: "Hello",
                words: [{ word: "Hello", startOffset: "0.100s" }],
              },
            ],
          },
        ],
      };
      const r1 = convertGoogleRawResponseToTranscriptDocument({
        rawResponse: missingOffsets,
        mediaPath: "test.wav",
        mediaFileName: "test.wav",
        language: "en",
        sourceRunId: "run-1",
      });
      expect(r1.ok).toBe(false);
      if (!r1.ok) {
        expect(r1.documentWithoutTiming.segments).toEqual([]);
        expect(r1.documentWithoutTiming.transcriptTextWithoutTiming).toBe("Hello");
      }

      const reversedOffsets: GoogleSttRawResponse = {
        results: [
          {
            alternatives: [
              {
                transcript: "Hello",
                words: [{ word: "Hello", startOffset: "1.500s", endOffset: "1.000s" }],
              },
            ],
          },
        ],
      };
      const r2 = convertGoogleRawResponseToTranscriptDocument({
        rawResponse: reversedOffsets,
        mediaPath: "test.wav",
        mediaFileName: "test.wav",
        language: "en",
        sourceRunId: "run-2",
      });
      expect(r2.ok).toBe(false);

      const outOfRangeOffsets: GoogleSttRawResponse = {
        results: [
          {
            alternatives: [
              {
                transcript: "Hello",
                words: [{ word: "Hello", startOffset: "0.500s", endOffset: "5.500s" }],
              },
            ],
          },
        ],
      };
      const r3 = convertGoogleRawResponseToTranscriptDocument({
        rawResponse: outOfRangeOffsets,
        mediaPath: "test.wav",
        mediaFileName: "test.wav",
        language: "en",
        sourceRunId: "run-3",
        expectedDurationSec: 5,
      });
      expect(r3.ok).toBe(false);

      const partialMissingWords: GoogleSttRawResponse = {
        results: [
          {
            alternatives: [
              {
                transcript: "Hello",
                words: [{ word: "Hello", startOffset: "0.100s", endOffset: "0.500s" }],
              },
            ],
          },
          {
            alternatives: [
              {
                transcript: "world",
                words: [],
              },
            ],
          },
        ],
      };
      const r4 = convertGoogleRawResponseToTranscriptDocument({
        rawResponse: partialMissingWords,
        mediaPath: "test.wav",
        mediaFileName: "test.wav",
        language: "en",
        sourceRunId: "run-4",
      });
      expect(r4.ok).toBe(false);
    });
  });
});
