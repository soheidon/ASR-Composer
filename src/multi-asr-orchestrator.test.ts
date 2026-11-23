import { describe, it, expect, vi } from "vitest";
import type { TranscriptDocument } from "./transcript";
import {
  runMultiAsrOrchestration,
  deriveTimingGranularity,
  type MultiAsrEngineSpec,
} from "./multi-asr-orchestrator";
import { validateMultiEngineSession } from "./multi-asr";
import type { SynthesisProvider } from "./synthesis-provider";

function createMockDocument(
  mediaPath: string,
  mediaFileName: string,
  segments: Array<{ id: string; start: number; end: number; text: string }>
): TranscriptDocument {
  return {
    schemaVersion: 1,
    mediaPath,
    mediaFileName,
    createdAt: "2026-09-28T00:00:00Z",
    updatedAt: "2026-09-28T00:00:00Z",
    language: "ja",
    sourceEngine: null,
    sourceRunId: null,
    segments: segments.map((s) => ({
      id: s.id,
      start: s.start,
      end: s.end,
      speaker: null,
      originalSpeaker: null,
      text: s.text,
      originalText: s.text,
      sourceEngine: null,
      sourceSegmentId: null,
      sourceRunId: null,
      status: "raw",
    })),
  };
}

describe("multi-asr-orchestrator", () => {
  const defaultPath = "C:/test/audio.wav";
  const defaultFileName = "audio.wav";
  const defaultDuration = 10.0;

  describe("deriveTimingGranularity", () => {
    it("returns whole_audio when segments is empty", () => {
      const doc = createMockDocument(defaultPath, defaultFileName, []);
      expect(deriveTimingGranularity(doc, defaultDuration)).toBe("whole_audio");
    });

    it("returns whole_audio when single segment covers almost entire duration", () => {
      const doc = createMockDocument(defaultPath, defaultFileName, [
        { id: "s1", start: 0.0, end: 9.5, text: "All audio text" },
      ]);
      expect(deriveTimingGranularity(doc, defaultDuration)).toBe("whole_audio");
    });

    it("returns segment when single segment covers a small distinct portion", () => {
      const doc = createMockDocument(defaultPath, defaultFileName, [
        { id: "s1", start: 2.0, end: 4.0, text: "Short section" },
      ]);
      expect(deriveTimingGranularity(doc, defaultDuration)).toBe("segment");
    });

    it("returns segment when multiple segments exist", () => {
      const doc = createMockDocument(defaultPath, defaultFileName, [
        { id: "s1", start: 0.0, end: 4.0, text: "First" },
        { id: "s2", start: 4.5, end: 9.0, text: "Second" },
      ]);
      expect(deriveTimingGranularity(doc, defaultDuration)).toBe("segment");
    });
  });

  describe("Test A: Sequential execution & error isolation", () => {
    it("runs engines sequentially and continues if one fails", async () => {
      const callOrder: string[] = [];

      const engine1: MultiAsrEngineSpec = {
        engineId: "engine-1",
        displayName: "Engine 1",
        runTranscription: async () => {
          callOrder.push("engine-1");
          return createMockDocument(defaultPath, defaultFileName, [
            { id: "s1", start: 0.0, end: 4.0, text: "Hello from engine 1" },
          ]);
        },
      };

      const engine2: MultiAsrEngineSpec = {
        engineId: "engine-2",
        displayName: "Engine 2",
        runTranscription: async () => {
          callOrder.push("engine-2");
          throw new Error("Engine 2 GPU OOM");
        },
      };

      const engine3: MultiAsrEngineSpec = {
        engineId: "engine-3",
        displayName: "Engine 3",
        runTranscription: async () => {
          callOrder.push("engine-3");
          return createMockDocument(defaultPath, defaultFileName, [
            { id: "s2", start: 0.0, end: 4.0, text: "Hello from engine 3" },
          ]);
        },
      };

      const mockProvider: SynthesisProvider = {
        synthesize: async () => [
          {
            segmentId: "s1",
            originalText: "Hello from engine 1",
            correctedText: "Hello from consensus",
            explanation: "Agreed by engine 1 and 3",
            confidence: 0.9,
            evidence: [{ type: "context", description: "Consensus" }],
          },
        ],
      };

      const result = await runMultiAsrOrchestration({
        mediaPath: defaultPath,
        mediaFileName: defaultFileName,
        expectedDurationSec: defaultDuration,
        engines: [engine1, engine2, engine3],
        synthesisProvider: mockProvider,
      });

      expect(callOrder).toEqual(["engine-1", "engine-2", "engine-3"]);
      expect(result.status).toBe("success");
      if (result.status === "success") {
        expect(result.staging.engineRecords).toHaveLength(3);
        expect(result.staging.engineRecords[0].status).toBe("success");
        expect(result.staging.engineRecords[1].status).toBe("failed");
        expect(result.staging.engineRecords[1].error).toBe("Engine 2 GPU OOM");
        expect(result.staging.engineRecords[2].status).toBe("success");
      }
    });
  });

  describe("Test B: Immediate safe cancellation during ASR", () => {
    it("stops immediately and does not run subsequent engines or LLM", async () => {
      let cancelled = false;
      const engine2Run = vi.fn();

      const engine1: MultiAsrEngineSpec = {
        engineId: "engine-1",
        displayName: "Engine 1",
        runTranscription: async () => {
          cancelled = true; // cancel during/after engine 1
          return createMockDocument(defaultPath, defaultFileName, [
            { id: "s1", start: 0.0, end: 4.0, text: "Engine 1" },
          ]);
        },
      };

      const engine2: MultiAsrEngineSpec = {
        engineId: "engine-2",
        displayName: "Engine 2",
        runTranscription: engine2Run,
      };

      const result = await runMultiAsrOrchestration({
        mediaPath: defaultPath,
        mediaFileName: defaultFileName,
        expectedDurationSec: defaultDuration,
        engines: [engine1, engine2],
        isCancelled: () => cancelled,
      });

      expect(result.status).toBe("cancelled");
      expect(engine2Run).not.toHaveBeenCalled();
    });
  });

  describe("Test C: Stale run detection during ASR", () => {
    it("returns status stale when isCurrentRun becomes false", async () => {
      let currentRun = true;

      const engine1: MultiAsrEngineSpec = {
        engineId: "engine-1",
        displayName: "Engine 1",
        runTranscription: async () => {
          currentRun = false; // superseded by another run
          return createMockDocument(defaultPath, defaultFileName, [
            { id: "s1", start: 0.0, end: 4.0, text: "Engine 1" },
          ]);
        },
      };

      const engine2: MultiAsrEngineSpec = {
        engineId: "engine-2",
        displayName: "Engine 2",
        runTranscription: async () => {
          return createMockDocument(defaultPath, defaultFileName, [
            { id: "s2", start: 0.0, end: 4.0, text: "Engine 2" },
          ]);
        },
      };

      const result = await runMultiAsrOrchestration({
        mediaPath: defaultPath,
        mediaFileName: defaultFileName,
        expectedDurationSec: defaultDuration,
        engines: [engine1, engine2],
        isCurrentRun: () => currentRun,
      });

      expect(result.status).toBe("stale");
    });
  });

  describe("Test D: Anchor automatic selection priority", () => {
    it("selects segment-granularity engine with highest preferredAnchorPriority", async () => {
      const engineWhole: MultiAsrEngineSpec = {
        engineId: "engine-whole",
        displayName: "Engine Whole",
        timingGranularity: "whole_audio",
        preferredAnchorPriority: 100, // high priority but whole_audio
        runTranscription: async () =>
          createMockDocument(defaultPath, defaultFileName, [
            { id: "w1", start: 0.0, end: 10.0, text: "Whole audio" },
          ]),
      };

      const engineSeg1: MultiAsrEngineSpec = {
        engineId: "engine-seg1",
        displayName: "Engine Seg 1",
        timingGranularity: "segment",
        preferredAnchorPriority: 10,
        runTranscription: async () =>
          createMockDocument(defaultPath, defaultFileName, [
            { id: "s1", start: 0.0, end: 4.0, text: "Seg 1" },
          ]),
      };

      const engineSeg2: MultiAsrEngineSpec = {
        engineId: "engine-seg2",
        displayName: "Engine Seg 2",
        timingGranularity: "segment",
        preferredAnchorPriority: 20, // higher priority segment engine
        runTranscription: async () =>
          createMockDocument(defaultPath, defaultFileName, [
            { id: "s2", start: 0.0, end: 4.0, text: "Seg 2" },
          ]),
      };

      const mockProvider: SynthesisProvider = {
        synthesize: async () => [],
      };

      const result = await runMultiAsrOrchestration({
        mediaPath: defaultPath,
        mediaFileName: defaultFileName,
        expectedDurationSec: defaultDuration,
        engines: [engineWhole, engineSeg1, engineSeg2],
        synthesisProvider: mockProvider,
      });

      expect(result.status).toBe("success");
      if (result.status === "success") {
        expect(result.staging.session.anchorEngineId).toBe("engine-seg2");
      }
    });
  });

  describe("Test E & E2: Candidate count & Synthesis execution branching", () => {
    it("Test E: runs synthesis when candidates exist (status success)", async () => {
      const kotoba: MultiAsrEngineSpec = {
        engineId: "kotoba-whisper",
        displayName: "Kotoba Whisper",
        timingGranularity: "segment",
        runTranscription: async () =>
          createMockDocument(defaultPath, defaultFileName, [
            { id: "k1", start: 0.0, end: 4.0, text: "こんにちは世界" },
          ]),
      };

      const mockSegmentEngine: MultiAsrEngineSpec = {
        engineId: "mock-segment-engine",
        displayName: "Mock Segment Engine",
        timingGranularity: "segment",
        runTranscription: async () =>
          createMockDocument(defaultPath, defaultFileName, [
            { id: "m1", start: 0.1, end: 3.9, text: "こんにちは、世界" },
          ]),
      };

      const synthesizeFn = vi.fn().mockResolvedValue([
        {
          segmentId: "k1",
          originalText: "こんにちは世界",
          correctedText: "こんにちは、世界！",
          explanation: "Punctuation improved",
          confidence: 0.95,
          evidence: [{ type: "context", description: "Multi-ASR" }],
        },
      ]);

      const result = await runMultiAsrOrchestration({
        mediaPath: defaultPath,
        mediaFileName: defaultFileName,
        expectedDurationSec: defaultDuration,
        engines: [kotoba, mockSegmentEngine],
        synthesisProvider: { synthesize: synthesizeFn },
      });

      expect(result.status).toBe("success");
      expect(synthesizeFn).toHaveBeenCalledTimes(1);
      if (result.status === "success") {
        expect(result.staging.proposals).toHaveLength(1);
        expect(result.staging.proposals[0].correctedText).toBe("こんにちは、世界！");
      }
    });

    it("Test E2: skips synthesis (0 provider calls) when candidates = 0 (status partial_asr_only no_aligned_candidates)", async () => {
      const kotoba: MultiAsrEngineSpec = {
        engineId: "kotoba-whisper",
        displayName: "Kotoba Whisper",
        timingGranularity: "segment",
        runTranscription: async () =>
          createMockDocument(defaultPath, defaultFileName, [
            { id: "k1", start: 0.0, end: 4.0, text: "音声前半" },
            { id: "k2", start: 4.5, end: 9.0, text: "音声後半" },
          ]),
      };

      const reazon: MultiAsrEngineSpec = {
        engineId: "reazonspeech",
        displayName: "ReazonSpeech",
        timingGranularity: "whole_audio",
        runTranscription: async () =>
          createMockDocument(defaultPath, defaultFileName, [
            { id: "r1", start: 0.0, end: 10.0, text: "音声前半 音声後半" },
          ]),
      };

      const qwen: MultiAsrEngineSpec = {
        engineId: "qwen3-asr",
        displayName: "Qwen3 ASR",
        timingGranularity: "whole_audio",
        runTranscription: async () =>
          createMockDocument(defaultPath, defaultFileName, [
            { id: "q1", start: 0.0, end: 10.0, text: "音声前半 音声後半" },
          ]),
      };

      const synthesizeFn = vi.fn();

      const result = await runMultiAsrOrchestration({
        mediaPath: defaultPath,
        mediaFileName: defaultFileName,
        expectedDurationSec: defaultDuration,
        engines: [kotoba, reazon, qwen],
        synthesisProvider: { synthesize: synthesizeFn },
      });

      expect(synthesizeFn).not.toHaveBeenCalled();
      expect(result.status).toBe("partial_asr_only");
      if (result.status === "partial_asr_only") {
        expect(result.reason).toBe("no_aligned_candidates");
        expect(Object.keys(result.session.results)).toHaveLength(3);
        const validation = validateMultiEngineSession(result.session);
        expect(validation.valid).toBe(true);
      }
    });
  });

  describe("Test F: Proposal 0 with Aligned Candidates", () => {
    it("returns success with empty proposals when LLM agrees with anchor", async () => {
      const engine1: MultiAsrEngineSpec = {
        engineId: "engine-1",
        displayName: "Engine 1",
        timingGranularity: "segment",
        runTranscription: async () =>
          createMockDocument(defaultPath, defaultFileName, [
            { id: "s1", start: 0.0, end: 4.0, text: "Correct text" },
          ]),
      };

      const engine2: MultiAsrEngineSpec = {
        engineId: "engine-2",
        displayName: "Engine 2",
        timingGranularity: "segment",
        runTranscription: async () =>
          createMockDocument(defaultPath, defaultFileName, [
            { id: "s2", start: 0.0, end: 4.0, text: "Alternate text" },
          ]),
      };

      const mockProvider: SynthesisProvider = {
        synthesize: async () => [], // LLM proposes 0 changes
      };

      const result = await runMultiAsrOrchestration({
        mediaPath: defaultPath,
        mediaFileName: defaultFileName,
        expectedDurationSec: defaultDuration,
        engines: [engine1, engine2],
        synthesisProvider: mockProvider,
      });

      expect(result.status).toBe("success");
      if (result.status === "success") {
        expect(result.staging.proposals).toHaveLength(0);
      }
    });
  });

  describe("Test G: All engines fail", () => {
    it("returns failed status when all engines throw", async () => {
      const engine1: MultiAsrEngineSpec = {
        engineId: "engine-1",
        displayName: "Engine 1",
        runTranscription: async () => {
          throw new Error("Failed 1");
        },
      };
      const engine2: MultiAsrEngineSpec = {
        engineId: "engine-2",
        displayName: "Engine 2",
        runTranscription: async () => {
          throw new Error("Failed 2");
        },
      };

      const result = await runMultiAsrOrchestration({
        mediaPath: defaultPath,
        mediaFileName: defaultFileName,
        expectedDurationSec: defaultDuration,
        engines: [engine1, engine2],
      });

      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.error).toContain("All ASR engines failed");
        expect(result.engineRecords).toHaveLength(2);
      }
    });
  });

  describe("Session Invariant & Explicit Anchor Tests", () => {
    it("Test H: single engine success returns partial_asr_only single_engine_only with valid session", async () => {
      const engine1: MultiAsrEngineSpec = {
        engineId: "engine-1",
        displayName: "Engine 1",
        timingGranularity: "segment",
        runTranscription: async () =>
          createMockDocument(defaultPath, defaultFileName, [
            { id: "s1", start: 0.0, end: 4.0, text: "Engine 1" },
          ]),
      };
      const engine2: MultiAsrEngineSpec = {
        engineId: "engine-2",
        displayName: "Engine 2",
        runTranscription: async () => {
          throw new Error("Failed");
        },
      };

      const result = await runMultiAsrOrchestration({
        mediaPath: defaultPath,
        mediaFileName: defaultFileName,
        expectedDurationSec: defaultDuration,
        engines: [engine1, engine2],
      });

      expect(result.status).toBe("partial_asr_only");
      if (result.status === "partial_asr_only") {
        expect(result.reason).toBe("single_engine_only");
        expect(result.session.anchorEngineId).toBe("engine-1");
        const val = validateMultiEngineSession(result.session);
        expect(val.valid).toBe(true);
      }
    });

    it("Test I: 2 whole_audio engines success returns no_segment_timing_anchor with valid session", async () => {
      const engine1: MultiAsrEngineSpec = {
        engineId: "engine-1",
        displayName: "Engine 1",
        timingGranularity: "whole_audio",
        runTranscription: async () =>
          createMockDocument(defaultPath, defaultFileName, [
            { id: "w1", start: 0.0, end: 10.0, text: "Whole 1" },
          ]),
      };
      const engine2: MultiAsrEngineSpec = {
        engineId: "engine-2",
        displayName: "Engine 2",
        timingGranularity: "whole_audio",
        runTranscription: async () =>
          createMockDocument(defaultPath, defaultFileName, [
            { id: "w2", start: 0.0, end: 10.0, text: "Whole 2" },
          ]),
      };

      const result = await runMultiAsrOrchestration({
        mediaPath: defaultPath,
        mediaFileName: defaultFileName,
        expectedDurationSec: defaultDuration,
        engines: [engine1, engine2],
      });

      expect(result.status).toBe("partial_asr_only");
      if (result.status === "partial_asr_only") {
        expect(result.reason).toBe("no_segment_timing_anchor");
        expect(result.session.results[result.session.anchorEngineId]).toBeDefined();
        const val = validateMultiEngineSession(result.session);
        expect(val.valid).toBe(true);
      }
    });

    it("Test J & K & L: explicit invalid/failed anchorEngineId returns valid session with valid anchor", async () => {
      const engine1: MultiAsrEngineSpec = {
        engineId: "engine-1",
        displayName: "Engine 1",
        timingGranularity: "segment",
        runTranscription: async () =>
          createMockDocument(defaultPath, defaultFileName, [
            { id: "s1", start: 0.0, end: 4.0, text: "Engine 1" },
          ]),
      };
      const engine2: MultiAsrEngineSpec = {
        engineId: "engine-2",
        displayName: "Engine 2",
        timingGranularity: "segment",
        runTranscription: async () =>
          createMockDocument(defaultPath, defaultFileName, [
            { id: "s2", start: 0.0, end: 4.0, text: "Engine 2" },
          ]),
      };

      const result = await runMultiAsrOrchestration({
        mediaPath: defaultPath,
        mediaFileName: defaultFileName,
        expectedDurationSec: defaultDuration,
        engines: [engine1, engine2],
        anchorEngineId: "non-existent-engine",
      });

      expect(result.status).toBe("partial_asr_only");
      if (result.status === "partial_asr_only") {
        expect(result.reason).toBe("no_segment_timing_anchor");
        // session.anchorEngineId must be a key in session.results, not non-existent!
        expect(result.session.anchorEngineId).toBe("engine-1");
        expect(result.session.results[result.session.anchorEngineId]).toBeDefined();
        const val = validateMultiEngineSession(result.session);
        expect(val.valid).toBe(true);
      }
    });
  });

  describe("Synthesis Stale, Cancellation, and Exception Handling Tests", () => {
    it("Test M: Stale during synthesis stops next chunk and returns status stale", async () => {
      let isCurrent = true;
      let synthesizeCalls = 0;

      // Create 10 segments so that with chunkSize=2 we get multiple chunks
      const anchorSegments = Array.from({ length: 10 }, (_, i) => ({
        id: `k-${i}`,
        start: i * 1.0,
        end: i * 1.0 + 0.9,
        text: `Segment ${i}`,
      }));

      const secondarySegments = Array.from({ length: 10 }, (_, i) => ({
        id: `s-${i}`,
        start: i * 1.0,
        end: i * 1.0 + 0.9,
        text: `Segment ${i}`,
      }));

      const kotoba: MultiAsrEngineSpec = {
        engineId: "kotoba",
        displayName: "Kotoba",
        timingGranularity: "segment",
        runTranscription: async () =>
          createMockDocument(defaultPath, defaultFileName, anchorSegments),
      };

      const secondary: MultiAsrEngineSpec = {
        engineId: "secondary",
        displayName: "Secondary",
        timingGranularity: "segment",
        runTranscription: async () =>
          createMockDocument(defaultPath, defaultFileName, secondarySegments),
      };

      const mockProvider: SynthesisProvider = {
        synthesize: async (req) => {
          synthesizeCalls++;
          if (synthesizeCalls === 1) {
            // After chunk 1 completes, mark run as stale
            isCurrent = false;
          }
          return req.targets.map((t) => ({
            segmentId: t.segmentId,
            originalText: t.text,
            correctedText: `${t.text} (corrected)`,
            explanation: "test",
            confidence: 0.9,
            evidence: [{ type: "context" }],
          }));
        },
      };

      const result = await runMultiAsrOrchestration({
        mediaPath: defaultPath,
        mediaFileName: defaultFileName,
        expectedDurationSec: defaultDuration,
        engines: [kotoba, secondary],
        chunkSize: 2,
        synthesisProvider: mockProvider,
        isCurrentRun: () => isCurrent,
      });

      expect(result.status).toBe("stale");
      // Chunk 2 should NOT be called
      expect(synthesizeCalls).toBe(1);
    });

    it("Test N: Cancellation during synthesis stops next chunk and returns status cancelled", async () => {
      let isCancelled = false;
      let synthesizeCalls = 0;

      const anchorSegments = Array.from({ length: 10 }, (_, i) => ({
        id: `k-${i}`,
        start: i * 1.0,
        end: i * 1.0 + 0.9,
        text: `Segment ${i}`,
      }));

      const secondarySegments = Array.from({ length: 10 }, (_, i) => ({
        id: `s-${i}`,
        start: i * 1.0,
        end: i * 1.0 + 0.9,
        text: `Segment ${i}`,
      }));

      const kotoba: MultiAsrEngineSpec = {
        engineId: "kotoba",
        displayName: "Kotoba",
        timingGranularity: "segment",
        runTranscription: async () =>
          createMockDocument(defaultPath, defaultFileName, anchorSegments),
      };

      const secondary: MultiAsrEngineSpec = {
        engineId: "secondary",
        displayName: "Secondary",
        timingGranularity: "segment",
        runTranscription: async () =>
          createMockDocument(defaultPath, defaultFileName, secondarySegments),
      };

      const mockProvider: SynthesisProvider = {
        synthesize: async (req) => {
          synthesizeCalls++;
          if (synthesizeCalls === 1) {
            isCancelled = true;
          }
          return req.targets.map((t) => ({
            segmentId: t.segmentId,
            originalText: t.text,
            correctedText: `${t.text} (corrected)`,
            explanation: "test",
            confidence: 0.9,
            evidence: [{ type: "context" }],
          }));
        },
      };

      const result = await runMultiAsrOrchestration({
        mediaPath: defaultPath,
        mediaFileName: defaultFileName,
        expectedDurationSec: defaultDuration,
        engines: [kotoba, secondary],
        chunkSize: 2,
        synthesisProvider: mockProvider,
        isCancelled: () => isCancelled,
      });

      expect(result.status).toBe("cancelled");
      expect(synthesizeCalls).toBe(1);
    });

    it("Test O: Deterministic precedence when stale and cancelled both become true during synthesis", async () => {
      let isCurrent = true;
      let isCancelled = false;

      const anchorSegments = Array.from({ length: 6 }, (_, i) => ({
        id: `k-${i}`,
        start: i * 1.0,
        end: i * 1.0 + 0.9,
        text: `Segment ${i}`,
      }));

      const secondarySegments = Array.from({ length: 6 }, (_, i) => ({
        id: `s-${i}`,
        start: i * 1.0,
        end: i * 1.0 + 0.9,
        text: `Segment ${i}`,
      }));

      const kotoba: MultiAsrEngineSpec = {
        engineId: "kotoba",
        displayName: "Kotoba",
        timingGranularity: "segment",
        runTranscription: async () =>
          createMockDocument(defaultPath, defaultFileName, anchorSegments),
      };

      const secondary: MultiAsrEngineSpec = {
        engineId: "secondary",
        displayName: "Secondary",
        timingGranularity: "segment",
        runTranscription: async () =>
          createMockDocument(defaultPath, defaultFileName, secondarySegments),
      };

      const mockProvider: SynthesisProvider = {
        synthesize: async (req) => {
          // both become true at the same time during synthesis
          isCurrent = false;
          isCancelled = true;
          return req.targets.map((t) => ({
            segmentId: t.segmentId,
            originalText: t.text,
            correctedText: `${t.text} (corrected)`,
            explanation: "test",
            confidence: 0.9,
            evidence: [{ type: "context" }],
          }));
        },
      };

      const result = await runMultiAsrOrchestration({
        mediaPath: defaultPath,
        mediaFileName: defaultFileName,
        expectedDurationSec: defaultDuration,
        engines: [kotoba, secondary],
        chunkSize: 2,
        synthesisProvider: mockProvider,
        isCurrentRun: () => isCurrent,
        isCancelled: () => isCancelled,
      });

      expect(result.status).toBe("stale");
    });

    it("Test P: SynthesisProvider throw converts to status failed without rejecting Promise", async () => {
      const kotoba: MultiAsrEngineSpec = {
        engineId: "kotoba",
        displayName: "Kotoba",
        timingGranularity: "segment",
        runTranscription: async () =>
          createMockDocument(defaultPath, defaultFileName, [
            { id: "k1", start: 0.0, end: 4.0, text: "Kotoba" },
          ]),
      };

      const secondary: MultiAsrEngineSpec = {
        engineId: "secondary",
        displayName: "Secondary",
        timingGranularity: "segment",
        runTranscription: async () =>
          createMockDocument(defaultPath, defaultFileName, [
            { id: "s1", start: 0.0, end: 4.0, text: "Secondary" },
          ]),
      };

      const mockProvider: SynthesisProvider = {
        synthesize: async () => {
          throw new Error("Ollama connection refused: 11434");
        },
      };

      const result = await runMultiAsrOrchestration({
        mediaPath: defaultPath,
        mediaFileName: defaultFileName,
        expectedDurationSec: defaultDuration,
        engines: [kotoba, secondary],
        synthesisProvider: mockProvider,
      });

      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.error).toContain("Synthesis execution failed");
        expect(result.error).toContain("Ollama connection refused");
        expect(result.engineRecords).toHaveLength(2);
      }
    });

    it("Test Q: Provider throw after cancelled/stale returns cancelled/stale instead of failed", async () => {
      let cancelled = false;

      const kotoba: MultiAsrEngineSpec = {
        engineId: "kotoba",
        displayName: "Kotoba",
        timingGranularity: "segment",
        runTranscription: async () =>
          createMockDocument(defaultPath, defaultFileName, [
            { id: "k1", start: 0.0, end: 4.0, text: "Kotoba" },
          ]),
      };

      const secondary: MultiAsrEngineSpec = {
        engineId: "secondary",
        displayName: "Secondary",
        timingGranularity: "segment",
        runTranscription: async () =>
          createMockDocument(defaultPath, defaultFileName, [
            { id: "s1", start: 0.0, end: 4.0, text: "Secondary" },
          ]),
      };

      const mockProvider: SynthesisProvider = {
        synthesize: async () => {
          cancelled = true;
          throw new Error("Network abort");
        },
      };

      const result = await runMultiAsrOrchestration({
        mediaPath: defaultPath,
        mediaFileName: defaultFileName,
        expectedDurationSec: defaultDuration,
        engines: [kotoba, secondary],
        synthesisProvider: mockProvider,
        isCancelled: () => cancelled,
      });

      expect(result.status).toBe("cancelled");
    });
  });

  describe("Validation & General Guards", () => {
    it("Test R: Cancelled during ASR execution with delayed throw", async () => {
      let cancelled = false;
      const engine2Run = vi.fn();

      const engine1: MultiAsrEngineSpec = {
        engineId: "engine-1",
        displayName: "Engine 1",
        runTranscription: async () => {
          cancelled = true;
          throw new Error("Transcriber aborted");
        },
      };

      const engine2: MultiAsrEngineSpec = {
        engineId: "engine-2",
        displayName: "Engine 2",
        runTranscription: engine2Run,
      };

      const result = await runMultiAsrOrchestration({
        mediaPath: defaultPath,
        mediaFileName: defaultFileName,
        expectedDurationSec: defaultDuration,
        engines: [engine1, engine2],
        isCancelled: () => cancelled,
      });

      expect(result.status).toBe("cancelled");
      expect(engine2Run).not.toHaveBeenCalled();
    });

    it("Test S: Stale during ASR execution", async () => {
      let isCurrent = true;
      const engine2Run = vi.fn();

      const engine1: MultiAsrEngineSpec = {
        engineId: "engine-1",
        displayName: "Engine 1",
        runTranscription: async () => {
          isCurrent = false;
          throw new Error("Delayed error");
        },
      };

      const engine2: MultiAsrEngineSpec = {
        engineId: "engine-2",
        displayName: "Engine 2",
        runTranscription: engine2Run,
      };

      const result = await runMultiAsrOrchestration({
        mediaPath: defaultPath,
        mediaFileName: defaultFileName,
        expectedDurationSec: defaultDuration,
        engines: [engine1, engine2],
        isCurrentRun: () => isCurrent,
      });

      expect(result.status).toBe("stale");
      expect(engine2Run).not.toHaveBeenCalled();
    });

    it("Test T: Media path mismatch in returned document", async () => {
      const engine1: MultiAsrEngineSpec = {
        engineId: "engine-1",
        displayName: "Engine 1",
        timingGranularity: "segment",
        runTranscription: async () =>
          createMockDocument("C:/wrong/path.wav", defaultFileName, [
            { id: "s1", start: 0.0, end: 4.0, text: "Seg 1" },
          ]),
      };

      const engine2: MultiAsrEngineSpec = {
        engineId: "engine-2",
        displayName: "Engine 2",
        timingGranularity: "segment",
        runTranscription: async () =>
          createMockDocument(defaultPath, defaultFileName, [
            { id: "s2", start: 0.0, end: 4.0, text: "Seg 2" },
          ]),
      };

      const result = await runMultiAsrOrchestration({
        mediaPath: defaultPath,
        mediaFileName: defaultFileName,
        expectedDurationSec: defaultDuration,
        engines: [engine1, engine2],
      });

      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.error).toContain("MultiEngineSession validation failed");
      }
    });

    it("Test U: Invalid expectedDurationSec", async () => {
      const engine1: MultiAsrEngineSpec = {
        engineId: "engine-1",
        displayName: "Engine 1",
        runTranscription: vi.fn(),
      };

      const result = await runMultiAsrOrchestration({
        mediaPath: defaultPath,
        mediaFileName: defaultFileName,
        expectedDurationSec: -1,
        engines: [engine1],
      });

      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.error).toContain("expectedDurationSec must be a finite positive number");
      }
    });

    it("Test V: Empty engines config", async () => {
      const result = await runMultiAsrOrchestration({
        mediaPath: defaultPath,
        mediaFileName: defaultFileName,
        expectedDurationSec: defaultDuration,
        engines: [],
      });

      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.error).toContain("No engines configured");
      }
    });

    it("Test W: Duplicate engineId in config", async () => {
      const engine1: MultiAsrEngineSpec = {
        engineId: "duplicate-id",
        displayName: "Engine 1",
        runTranscription: vi.fn(),
      };
      const engine2: MultiAsrEngineSpec = {
        engineId: "duplicate-id",
        displayName: "Engine 2",
        runTranscription: vi.fn(),
      };

      const result = await runMultiAsrOrchestration({
        mediaPath: defaultPath,
        mediaFileName: defaultFileName,
        expectedDurationSec: defaultDuration,
        engines: [engine1, engine2],
      });

      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.error).toContain("Duplicate engine ID");
      }
    });

    it("Test X: Engine execution order preserves config array order", async () => {
      const executed: string[] = [];

      const makeEngine = (id: string): MultiAsrEngineSpec => ({
        engineId: id,
        displayName: id,
        timingGranularity: "segment",
        runTranscription: async () => {
          executed.push(id);
          return createMockDocument(defaultPath, defaultFileName, [
            { id: `${id}-seg`, start: 0.0, end: 4.0, text: id },
          ]);
        },
      });

      const result = await runMultiAsrOrchestration({
        mediaPath: defaultPath,
        mediaFileName: defaultFileName,
        expectedDurationSec: defaultDuration,
        engines: [makeEngine("C"), makeEngine("A"), makeEngine("B")],
        synthesisProvider: {
          synthesize: async () => [],
        },
      });

      expect(executed).toEqual(["C", "A", "B"]);
      expect(result.status).toBe("success");
    });
  });

  describe("Compare Mode (LLM-free, First-Engine Anchor)", () => {
    it("Test CMP-1: Executes sequentially in order, skips LLM synthesis, and keeps 1st engine timestamps as anchor", async () => {
      const executed: string[] = [];
      const synthSpy = vi.fn();

      const first: MultiAsrEngineSpec = {
        engineId: "kotoba-whisper",
        displayName: "Kotoba Whisper v2.0",
        timingGranularity: "segment",
        runTranscription: async (media) => {
          executed.push(`kotoba:${media}`);
          return createMockDocument(defaultPath, defaultFileName, [
            { id: "k1", start: 0.5, end: 2.5, text: "第1結果" },
          ]);
        },
      };

      const second: MultiAsrEngineSpec = {
        engineId: "reazonspeech",
        displayName: "ReazonSpeech v2.0",
        timingGranularity: "whole_audio",
        runTranscription: async (media) => {
          executed.push(`reazon:${media}`);
          return createMockDocument(defaultPath, defaultFileName, [
            { id: "r1", start: 0.0, end: 10.0, text: "第2結果" },
          ]);
        },
      };

      const result = await runMultiAsrOrchestration({
        mediaPath: defaultPath,
        mediaFileName: defaultFileName,
        expectedDurationSec: defaultDuration,
        engines: [first, second],
        executionMode: "compare",
        anchorEngineId: "kotoba-whisper",
        synthesisProvider: { synthesize: synthSpy },
      });

      expect(executed).toEqual([`kotoba:${defaultPath}`, `reazon:${defaultPath}`]);
      expect(synthSpy).not.toHaveBeenCalled();
      expect(result.status).toBe("compare_ready");
      if (result.status === "compare_ready") {
        expect(result.designatedAnchorEngineId).toBe("kotoba-whisper");
        expect(result.anchorAvailable).toBe(true);
        expect(result.anchorUnavailableReason).toBeUndefined();
        expect(result.engineOrder).toEqual(["kotoba-whisper", "reazonspeech"]);
        expect(result.session.results["kotoba-whisper"].document.segments[0].start).toBe(0.5);
        expect(result.session.results["reazonspeech"].document.segments[0].end).toBe(10.0);
      }
    });

    it("Test CMP-5: Compare mode respects caller-specified anchorEngineId (e.g. AI 2)", async () => {
      const executed: string[] = [];
      const engines: MultiAsrEngineSpec[] = [
        {
          engineId: "local:reazonspeech",
          displayName: "ReazonSpeech",
          timingGranularity: "segment",
          runTranscription: async () => {
            executed.push("AI 1");
            return createMockDocument(defaultPath, defaultFileName, [
              { id: "r1", start: 0.2, end: 2, text: "first" },
            ]);
          },
        },
        {
          engineId: "cloud:google_stt",
          displayName: "Google STT",
          timingGranularity: "segment",
          runTranscription: async () => {
            executed.push("AI 2");
            return createMockDocument(defaultPath, defaultFileName, [
              { id: "g1", start: 0.4, end: 2.4, text: "second" },
            ]);
          },
        },
      ];
      const result = await runMultiAsrOrchestration({
        mediaPath: defaultPath,
        mediaFileName: defaultFileName,
        expectedDurationSec: defaultDuration,
        engines,
        executionMode: "compare",
        anchorEngineId: "cloud:google_stt",
      });
      expect(executed).toEqual(["AI 1", "AI 2"]);
      expect(result.status).toBe("compare_ready");
      if (result.status === "compare_ready") {
        expect(result.designatedAnchorEngineId).toBe("cloud:google_stt");
        expect(result.anchorAvailable).toBe(true);
        expect(result.session.anchorEngineId).toBe("cloud:google_stt");
      }
    });

    it("Test CMP-2: When 1st engine fails, 2nd engine result is preserved but NOT promoted to anchor", async () => {
      const first: MultiAsrEngineSpec = {
        engineId: "kotoba-whisper",
        displayName: "Kotoba Whisper v2.0",
        timingGranularity: "segment",
        runTranscription: async () => {
          throw new Error("Kotoba crashed");
        },
      };

      const second: MultiAsrEngineSpec = {
        engineId: "reazonspeech",
        displayName: "ReazonSpeech v2.0",
        timingGranularity: "segment",
        runTranscription: async () =>
          createMockDocument(defaultPath, defaultFileName, [
            { id: "r1", start: 0.0, end: 4.0, text: "Reazon raw text" },
          ]),
      };

      const result = await runMultiAsrOrchestration({
        mediaPath: defaultPath,
        mediaFileName: defaultFileName,
        expectedDurationSec: defaultDuration,
        engines: [first, second],
        executionMode: "compare",
        anchorEngineId: "kotoba-whisper",
      });

      expect(result.status).toBe("compare_ready");
      if (result.status === "compare_ready") {
        expect(result.designatedAnchorEngineId).toBe("kotoba-whisper");
        expect(result.anchorAvailable).toBe(false);
        expect(result.anchorUnavailableReason).toBe("first_engine_failed");
        expect(result.session.anchorEngineId).toBe("");
        expect(validateMultiEngineSession(result.session, { requireAnchor: false }).valid).toBe(true);
        expect(result.session.results["reazonspeech"]?.document.segments[0].text).toBe("Reazon raw text");
      }
    });

    it("Test CMP-3: When 1st engine is whole_audio, 2nd segment engine is NOT promoted to anchor", async () => {
      const first: MultiAsrEngineSpec = {
        engineId: "reazonspeech",
        displayName: "ReazonSpeech v2.0",
        timingGranularity: "whole_audio",
        runTranscription: async () =>
          createMockDocument(defaultPath, defaultFileName, [
            { id: "r1", start: 0.0, end: 10.0, text: "Whole audio text" },
          ]),
      };

      const second: MultiAsrEngineSpec = {
        engineId: "kotoba-whisper",
        displayName: "Kotoba Whisper v2.0",
        timingGranularity: "segment",
        runTranscription: async () =>
          createMockDocument(defaultPath, defaultFileName, [
            { id: "k1", start: 0.0, end: 3.0, text: "Seg 1" },
          ]),
      };

      const result = await runMultiAsrOrchestration({
        mediaPath: defaultPath,
        mediaFileName: defaultFileName,
        expectedDurationSec: defaultDuration,
        engines: [first, second],
        executionMode: "compare",
        anchorEngineId: "reazonspeech",
      });

      expect(result.status).toBe("compare_ready");
      if (result.status === "compare_ready") {
        expect(result.designatedAnchorEngineId).toBe("reazonspeech");
        expect(result.anchorAvailable).toBe(false);
        expect(result.anchorUnavailableReason).toBe("no_segment_timing_anchor");
        expect(result.session.anchorEngineId).toBe("");
        expect(validateMultiEngineSession(result.session, { requireAnchor: false }).valid).toBe(true);
      }
    });

    it("Test CMP-4: When 1st engine has invalid segment timestamps, marks anchor unavailable and does not promote 2nd engine", async () => {
      const first: MultiAsrEngineSpec = {
        engineId: "kotoba-whisper",
        displayName: "Kotoba Whisper v2.0",
        timingGranularity: "segment",
        runTranscription: async () =>
          createMockDocument(defaultPath, defaultFileName, [
            { id: "k1", start: -1.0, end: 2.0, text: "Invalid negative start" },
          ]),
      };

      const second: MultiAsrEngineSpec = {
        engineId: "reazonspeech",
        displayName: "ReazonSpeech v2.0",
        timingGranularity: "segment",
        runTranscription: async () =>
          createMockDocument(defaultPath, defaultFileName, [
            { id: "r1", start: 0.0, end: 4.0, text: "Valid second" },
          ]),
      };

      const result = await runMultiAsrOrchestration({
        mediaPath: defaultPath,
        mediaFileName: defaultFileName,
        expectedDurationSec: defaultDuration,
        engines: [first, second],
        executionMode: "compare",
        anchorEngineId: "kotoba-whisper",
      });

      expect(result.status).toBe("compare_ready");
      if (result.status === "compare_ready") {
        expect(result.designatedAnchorEngineId).toBe("kotoba-whisper");
        expect(result.anchorAvailable).toBe(false);
        expect(result.anchorUnavailableReason).toBe("invalid_anchor_timestamps");
        expect(result.session.anchorEngineId).toBe("");
        expect(validateMultiEngineSession(result.session, { requireAnchor: false }).valid).toBe(true);
      }
    });

    it("Test CMP-7: Compare mode runs mandatory LLM comparison correction with Google raw JSON + word alignment and produces finalDocument", async () => {
      const googleRaw = {
        results: [{ alternatives: [{ transcript: "きょお は", words: [{ word: "きょお", startOffset: "0s", endOffset: "0.5s" }, { word: "は", startOffset: "0.5s", endOffset: "1s" }] }] }],
      };
      const rawBefore = JSON.stringify(googleRaw);
      const engines: MultiAsrEngineSpec[] = [
        {
          engineId: "local:kotoba-whisper",
          displayName: "Kotoba Whisper v2.0",
          timingGranularity: "segment",
          runTranscription: async () =>
            createMockDocument(defaultPath, defaultFileName, [
              { id: "k1", start: 0, end: 1.0, text: "今日は" },
            ]),
        },
        {
          engineId: "cloud:google_stt",
          displayName: "Google Cloud Speech-to-Text",
          timingGranularity: "segment",
          runTranscription: async () =>
            createMockDocument(defaultPath, defaultFileName, [
              { id: "gword-1", start: 0, end: 0.5, text: "きょお" },
              { id: "gword-2", start: 0.5, end: 1.0, text: "は" },
            ]),
        },
      ];

      let capturedPartnerCandidates = 0;
      const result = await runMultiAsrOrchestration({
        mediaPath: defaultPath,
        mediaFileName: defaultFileName,
        expectedDurationSec: defaultDuration,
        engines,
        executionMode: "compare",
        anchorEngineId: "cloud:google_stt",
        rawGoogleResponses: { "cloud:google_stt": googleRaw },
        compareCorrectionProvider: {
          async correctBatch(req) {
            capturedPartnerCandidates = req.targets.reduce((acc, t) => acc + t.partnerCandidates.length, 0);
            return req.targets.map((t) => ({
              segmentId: t.segmentId,
              correctedText: t.segmentId === "gword-1" ? "今日" : t.anchorText,
            }));
          },
        },
      });

      expect(JSON.stringify(googleRaw)).toBe(rawBefore);
      expect(capturedPartnerCandidates).toBeGreaterThan(0);
      expect(result.status).toBe("compare_ready");
      if (result.status === "compare_ready") {
        expect(result.correctionStatus).toBe("success");
        expect(result.finalDocument?.segments[0]).toMatchObject({
          id: "gword-1",
          start: 0,
          end: 0.5,
          text: "今日",
        });
        expect(result.rawGoogleResponses?.["cloud:google_stt"]).toEqual(googleRaw);
      }
    });

    it("Test CMP-8: Partial ASR failure skips LLM correction and records partialAsrFailure", async () => {
      let llmCalled = false;
      const engines: MultiAsrEngineSpec[] = [
        {
          engineId: "local:kotoba-whisper",
          displayName: "Kotoba Whisper v2.0",
          timingGranularity: "segment",
          runTranscription: async () => {
            throw new Error("CUDA OOM");
          },
        },
        {
          engineId: "local:reazonspeech",
          displayName: "ReazonSpeech v2.0",
          timingGranularity: "segment",
          runTranscription: async () =>
            createMockDocument(defaultPath, defaultFileName, [
              { id: "r1", start: 0, end: 2.0, text: "生き残った結果" },
            ]),
        },
      ];

      const result = await runMultiAsrOrchestration({
        mediaPath: defaultPath,
        mediaFileName: defaultFileName,
        expectedDurationSec: defaultDuration,
        engines,
        executionMode: "compare",
        anchorEngineId: "local:kotoba-whisper",
        compareCorrectionProvider: {
          async correctBatch() {
            llmCalled = true;
            return [];
          },
        },
      });

      expect(llmCalled).toBe(false);
      expect(result.status).toBe("compare_ready");
      if (result.status === "compare_ready") {
        expect(result.correctionStatus).toBe("skipped_partial_failure");
        expect(result.partialAsrFailure).toBe(true);
        expect(result.engineRecords.find((r) => r.engineId === "local:kotoba-whisper")?.error).toContain("CUDA OOM");
        expect(result.session.results["local:reazonspeech"].document.segments[0].text).toBe("生き残った結果");
      }
    });

    it("Test CMP-9: LLM failure in compare mode marks correctionStatus='failed' and preserves raw results", async () => {
      const engines: MultiAsrEngineSpec[] = [
        {
          engineId: "local:kotoba-whisper",
          displayName: "Kotoba Whisper v2.0",
          timingGranularity: "segment",
          runTranscription: async () =>
            createMockDocument(defaultPath, defaultFileName, [
              { id: "k1", start: 0, end: 1.5, text: "生結果1" },
            ]),
        },
        {
          engineId: "local:reazonspeech",
          displayName: "ReazonSpeech v2.0",
          timingGranularity: "segment",
          runTranscription: async () =>
            createMockDocument(defaultPath, defaultFileName, [
              { id: "r1", start: 0, end: 1.5, text: "生結果2" },
            ]),
        },
      ];

      const result = await runMultiAsrOrchestration({
        mediaPath: defaultPath,
        mediaFileName: defaultFileName,
        expectedDurationSec: defaultDuration,
        engines,
        executionMode: "compare",
        anchorEngineId: "local:kotoba-whisper",
        compareCorrectionProvider: {
          async correctBatch() {
            throw new Error("Ollama timeout");
          },
        },
      });

      expect(result.status).toBe("compare_ready");
      if (result.status === "compare_ready") {
        expect(result.correctionStatus).toBe("failed");
        expect(result.correctionError).toContain("Ollama timeout");
        expect(result.finalDocument).toBeUndefined();
        expect(result.session.results["local:kotoba-whisper"].document.segments[0].text).toBe("生結果1");
        expect(result.session.results["local:reazonspeech"].document.segments[0].text).toBe("生結果2");
      }
    });
  });
});
