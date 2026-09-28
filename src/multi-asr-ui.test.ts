import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TranscriptDocument } from "./transcript";
import type { MultiEngineSession, MultiEngineAlignmentResult } from "./multi-asr";
import type { SynthesisProposal } from "./synthesis";
import {
  acquireExecutionLock,
  releaseExecutionLock,
  isAsrRunning,
  getActiveExecutionType,
  handleAudioFileSelection,
  getSelectedAudioDurationSec,
  getMultiAsrStaging,
  setMultiAsrStaging,
  setMultiAsrProgress,
  setMultiAsrLastFailed,
  resetMultiAsrUiStateForTest,
  syncMultiAsrUiFromState,
  executeEditorHandoff,
  setAudioFactoryForTest,
  setSelectedAudioDurationSecForTest,
  startMultiAsrFromUi,
  type StagedMultiAsrResult,
} from "./multi-asr-ui";
import * as editorModule from "./editor";

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
    sourceEngine: "kotoba-whisper",
    sourceRunId: "run-1",
    segments: segments.map((s) => ({
      id: s.id,
      start: s.start,
      end: s.end,
      speaker: null,
      originalSpeaker: null,
      text: s.text,
      originalText: s.text,
      sourceEngine: "kotoba-whisper",
      sourceSegmentId: null,
      sourceRunId: "run-1",
      status: "raw",
    })),
  };
}

describe("multi-asr-ui", () => {
  beforeEach(() => {
    resetMultiAsrUiStateForTest();
    setAudioFactoryForTest(null);
    document.body.innerHTML = `
      <div id="page-transcribe">
        <button id="startBtn">Single ASR</button>
        <button id="startMultiAsrBtn">Multi-ASR</button>
        <button id="cancelMultiAsrBtn" style="display: none;">Cancel</button>
        <div id="multiAsrProgressSection" style="display: none;">
          <span class="multi-asr-progress-text"></span>
          <div class="multi-asr-progress-bar" style="width: 0%;"></div>
        </div>
        <div id="multiAsrResultSection" style="display: none;"></div>
      </div>
    `;
  });

  afterEach(() => {
    setAudioFactoryForTest(null);
    vi.restoreAllMocks();
  });

  describe("Test A & B: Execution Lock & Mutex", () => {
    it("Test A: acquires multi-ASR execution lock successfully", () => {
      expect(isAsrRunning()).toBe(false);
      const acquired = acquireExecutionLock("multi", "run-1");
      expect(acquired).toBe(true);
      expect(isAsrRunning()).toBe(true);
      expect(getActiveExecutionType()).toBe("multi");

      const singleBtn = document.getElementById("startBtn") as HTMLButtonElement;
      const multiBtn = document.getElementById("startMultiAsrBtn") as HTMLButtonElement;
      expect(singleBtn.disabled).toBe(true);
      expect(multiBtn.disabled).toBe(true);
    });

    it("Test B: prevents single-ASR while multi-ASR is running and vice versa", () => {
      expect(acquireExecutionLock("single", "single-run-1")).toBe(true);
      expect(acquireExecutionLock("multi", "multi-run-1")).toBe(false);

      // Releasing with wrong owner ID should NOT release lock
      releaseExecutionLock("wrong-id");
      expect(isAsrRunning()).toBe(true);

      // Releasing with correct owner ID releases lock
      releaseExecutionLock("single-run-1");
      expect(isAsrRunning()).toBe(false);

      expect(acquireExecutionLock("multi", "multi-run-1")).toBe(true);
      expect(acquireExecutionLock("single", "single-run-2")).toBe(false);
    });
  });

  describe("Test D, D2, D3: Media Duration Resolution & Generation Guard", () => {
    it("Test D: sets duration on successful metadata load", async () => {
      // Mock Audio
      const mockAudio = {
        duration: 12.5,
        addEventListener: vi.fn((event, handler) => {
          if (event === "loadedmetadata") {
            setTimeout(handler, 10);
          }
        }),
        removeEventListener: vi.fn(),
        src: "",
      };
      setAudioFactoryForTest(() => mockAudio);

      const duration = await handleAudioFileSelection("C:/test/sample.wav", (p) => p);
      expect(duration).toBe(12.5);
      expect(getSelectedAudioDurationSec()).toBe(12.5);
      expect(mockAudio.removeEventListener).toHaveBeenCalled();
    });

    it("Test D2: handles duration probe error without crashing and leaves duration null", async () => {
      const mockAudio = {
        duration: NaN,
        addEventListener: vi.fn((event, handler) => {
          if (event === "error") {
            setTimeout(handler, 10);
          }
        }),
        removeEventListener: vi.fn(),
        src: "",
      };
      setAudioFactoryForTest(() => mockAudio);

      const duration = await handleAudioFileSelection("C:/test/corrupt.wav", (p) => p);
      expect(duration).toBeNull();
      expect(getSelectedAudioDurationSec()).toBeNull();
    });

    it("Test D3: discards delayed response from previous file selection generation", async () => {
      let triggerA: (() => void) | undefined;
      let triggerB: (() => void) | undefined;
      let count = 0;

      setAudioFactoryForTest(() => {
        count++;
        const currentCount = count;
        return {
          duration: currentCount === 1 ? 10.0 : 25.0,
          addEventListener: vi.fn((event, handler) => {
            if (event === "loadedmetadata") {
              if (currentCount === 1) triggerA = handler;
              if (currentCount === 2) triggerB = handler;
            }
          }),
          removeEventListener: vi.fn(),
          src: "",
        };
      });

      // Select File A
      const promiseA = handleAudioFileSelection("C:/test/fileA.wav", (p) => p);
      // Select File B immediately
      const promiseB = handleAudioFileSelection("C:/test/fileB.wav", (p) => p);

      // Trigger File B first, then File A later
      if (triggerB) (triggerB as () => void)();
      const resB = await promiseB;
      expect(resB).toBe(25.0);
      expect(getSelectedAudioDurationSec()).toBe(25.0);

      if (triggerA) (triggerA as () => void)();
      const resA = await promiseA;
      // File A's result must be discarded (null) and not overwrite File B's 25.0
      expect(resA).toBeNull();
      expect(getSelectedAudioDurationSec()).toBe(25.0);
    });
  });

  describe("Test E, F, H, I, J, K, L, M, N: UI Progress & Result Rendering", () => {
    it("Test E & F: renders transcribing, aligning, and synthesizing progress", () => {
      acquireExecutionLock("multi", "run-1");
      setMultiAsrProgress({
        phase: "transcribing",
        currentEngineId: "kotoba-whisper",
        engineIndex: 0,
        totalEngines: 3,
        percent: 33,
        message: "1/3 Kotoba Whisper 文字起こし中...",
      });
      syncMultiAsrUiFromState();

      const progressSection = document.getElementById("multiAsrProgressSection")!;
      const textEl = progressSection.querySelector(".multi-asr-progress-text")!;
      const barEl = progressSection.querySelector(".multi-asr-progress-bar") as HTMLElement;

      expect(progressSection.style.display).toBe("");
      expect(textEl.textContent).toBe("1/3 Kotoba Whisper 文字起こし中...");
      expect(barEl.style.width).toBe("33%");
    });

    it("Test I: renders Staging Card for success with proposals > 0", () => {
      const doc = createMockDocument("C:/test.wav", "test.wav", [
        { id: "s1", start: 0, end: 4, text: "こんにちは" },
      ]);
      const session: MultiEngineSession = {
        sessionId: "s-1",
        mediaPath: "C:/test.wav",
        mediaFileName: "test.wav",
        expectedDurationSec: 10,
        anchorEngineId: "kotoba-whisper",
        results: {
          "kotoba-whisper": {
            engineId: "kotoba-whisper",
            displayName: "Kotoba Whisper",
            document: doc,
            durationSec: 10,
            completedAt: "2026-09-28T00:00:00Z",
            timingGranularity: "segment",
          },
        },
        createdAt: "2026-09-28T00:00:00Z",
      };
      const alignment: MultiEngineAlignmentResult = {
        sessionId: "s-1",
        anchorEngineId: "kotoba-whisper",
        groups: [
          {
            anchorSegment: doc.segments[0],
            candidates: [
              {
                engineId: "mock-engine",
                sourceSegmentId: "m1",
                timeRange: { start: 0, end: 4 },
                text: "こんにちは世界",
                metrics: { overlapDurationSec: 4, anchorCoverage: 1, candidateCoverage: 1, iou: 1 },
              },
            ],
          },
        ],
        unalignedSources: [],
        warnings: [],
      };
      const proposal: SynthesisProposal = {
        id: "prop-1",
        kind: "multi_asr_synthesis",
        segmentId: "s1",
        originalText: "こんにちは",
        correctedText: "こんにちは、世界！",
        anchorEngineId: "kotoba-whisper",
        supportingSources: [{ engineId: "mock-engine", sourceSegmentId: "m1" }],
        evidence: [{ type: "context" }],
        explanation: "Punctuation and completeness",
      };

      const staging: StagedMultiAsrResult = {
        runId: "run-1",
        generation: 1,
        result: {
          status: "success",
          staging: {
            session,
            alignment,
            proposals: [proposal],
            engineRecords: [
              { engineId: "kotoba-whisper", displayName: "Kotoba Whisper", status: "success", timingGranularity: "segment" },
            ],
          },
        },
        createdAt: "2026-09-28T00:00:00Z",
      };

      setMultiAsrStaging(staging);
      syncMultiAsrUiFromState();

      const resultSection = document.getElementById("multiAsrResultSection")!;
      expect(resultSection.style.display).toBe("");
      expect(resultSection.innerHTML).toContain("Multi-ASR 統合補正完了 (1件の提案)");
      expect(resultSection.innerHTML).toContain("統合候補をレビュー");
    });

    it("Test J: renders Staging Card for success with proposals === 0 (Anchor supported)", () => {
      const doc = createMockDocument("C:/test.wav", "test.wav", [
        { id: "s1", start: 0, end: 4, text: "こんにちは" },
      ]);
      const session: MultiEngineSession = {
        sessionId: "s-1",
        mediaPath: "C:/test.wav",
        mediaFileName: "test.wav",
        expectedDurationSec: 10,
        anchorEngineId: "kotoba-whisper",
        results: {
          "kotoba-whisper": {
            engineId: "kotoba-whisper",
            displayName: "Kotoba Whisper",
            document: doc,
            durationSec: 10,
            completedAt: "2026-09-28T00:00:00Z",
            timingGranularity: "segment",
          },
        },
        createdAt: "2026-09-28T00:00:00Z",
      };

      const staging: StagedMultiAsrResult = {
        runId: "run-1",
        generation: 1,
        result: {
          status: "success",
          staging: {
            session,
            alignment: { sessionId: "s-1", anchorEngineId: "kotoba-whisper", groups: [], unalignedSources: [], warnings: [] },
            proposals: [], // 0 proposals
            engineRecords: [
              { engineId: "kotoba-whisper", displayName: "Kotoba Whisper", status: "success", timingGranularity: "segment" },
            ],
          },
        },
        createdAt: "2026-09-28T00:00:00Z",
      };

      setMultiAsrStaging(staging);
      syncMultiAsrUiFromState();

      const resultSection = document.getElementById("multiAsrResultSection")!;
      expect(resultSection.innerHTML).toContain("Multi-ASR 完了 (補正なし)");
      expect(resultSection.innerHTML).toContain("正本エディターで開く");
    });

    it("Test K, L, M: renders partial_asr_only cards with specific reason messages", () => {
      const doc = createMockDocument("C:/test.wav", "test.wav", []);
      const session: MultiEngineSession = {
        sessionId: "s-1",
        mediaPath: "C:/test.wav",
        mediaFileName: "test.wav",
        expectedDurationSec: 10,
        anchorEngineId: "kotoba-whisper",
        results: {
          "kotoba-whisper": {
            engineId: "kotoba-whisper",
            displayName: "Kotoba Whisper",
            document: doc,
            durationSec: 10,
            completedAt: "2026-09-28T00:00:00Z",
            timingGranularity: "segment",
          },
        },
        createdAt: "2026-09-28T00:00:00Z",
      };

      // no_aligned_candidates
      const stagingNoCand: StagedMultiAsrResult = {
        runId: "run-1",
        generation: 1,
        result: {
          status: "partial_asr_only",
          reason: "no_aligned_candidates",
          session,
          engineRecords: [],
        },
        createdAt: "2026-09-28T00:00:00Z",
      };

      setMultiAsrStaging(stagingNoCand);
      syncMultiAsrUiFromState();

      const resultSection = document.getElementById("multiAsrResultSection")!;
      expect(resultSection.innerHTML).toContain("照合候補なし (統合スキップ)");
      expect(resultSection.innerHTML).toContain("ASR結果を開く (kotoba-whisper)");
    });

    it("Test N: renders failed card when lastFailedResult is set", () => {
      setMultiAsrLastFailed({
        error: "All ASR engines failed: Docker daemon not running",
        engineRecords: [
          { engineId: "kotoba-whisper", displayName: "Kotoba Whisper", status: "failed", error: "Connection error" },
        ],
      });
      syncMultiAsrUiFromState();

      const resultSection = document.getElementById("multiAsrResultSection")!;
      expect(resultSection.innerHTML).toContain("Multi-ASR 処理エラー");
      expect(resultSection.innerHTML).toContain("Docker daemon not running");
    });
  });

  describe("Test O, P, Q, R, S: Editor Handoff & Atomic Transaction", () => {
    it("Test O & P: aborts handoff when editor is dirty and user cancels discard confirm", async () => {
      vi.spyOn(editorModule, "isEditorDirty").mockReturnValue(true);
      vi.spyOn(editorModule, "confirmDiscardChanges").mockResolvedValue(false);

      const setDocWithProps = vi.fn();
      const setDoc = vi.fn();
      const renderEd = vi.fn();
      const navigateTo = vi.fn().mockResolvedValue("completed");

      const doc = createMockDocument("C:/test.wav", "test.wav", [{ id: "s1", start: 0, end: 4, text: "A" }]);
      const staging: StagedMultiAsrResult = {
        runId: "run-1",
        generation: 1,
        result: {
          status: "partial_asr_only",
          reason: "single_engine_only",
          session: {
            sessionId: "s1",
            mediaPath: "C:/test.wav",
            mediaFileName: "test.wav",
            expectedDurationSec: 10,
            anchorEngineId: "kotoba-whisper",
            results: {
              "kotoba-whisper": {
                engineId: "kotoba-whisper",
                displayName: "Kotoba",
                document: doc,
                durationSec: 10,
                completedAt: "2026-09-28T00:00:00Z",
                timingGranularity: "segment",
              },
            },
            createdAt: "2026-09-28T00:00:00Z",
          },
          engineRecords: [],
        },
        createdAt: "2026-09-28T00:00:00Z",
      };
      setMultiAsrStaging(staging);

      const res = await executeEditorHandoff(staging, navigateTo, setDocWithProps, setDoc, renderEd);
      expect(res).toBe(false);
      expect(navigateTo).not.toHaveBeenCalled();
      expect(setDoc).not.toHaveBeenCalled();
      // Staging must NOT be cleared
      expect(getMultiAsrStaging()).toBe(staging);
    });

    it("Test Q: atomically hands off document and clears staging when navigation completes", async () => {
      vi.spyOn(editorModule, "isEditorDirty").mockReturnValue(false);

      const setDocWithProps = vi.fn();
      const setDoc = vi.fn();
      const renderEd = vi.fn();
      const navigateTo = vi.fn().mockResolvedValue("completed");

      const doc = createMockDocument("C:/test.wav", "test.wav", [{ id: "s1", start: 0, end: 4, text: "A" }]);
      const proposal: SynthesisProposal = {
        id: "prop-1",
        kind: "multi_asr_synthesis",
        segmentId: "s1",
        originalText: "A",
        correctedText: "A+",
        anchorEngineId: "kotoba-whisper",
        supportingSources: [],
        evidence: [{ type: "context" }],
        explanation: "Fix",
      };

      const staging: StagedMultiAsrResult = {
        runId: "run-1",
        generation: 1,
        result: {
          status: "success",
          staging: {
            session: {
              sessionId: "s1",
              mediaPath: "C:/test.wav",
              mediaFileName: "test.wav",
              expectedDurationSec: 10,
              anchorEngineId: "kotoba-whisper",
              results: {
                "kotoba-whisper": {
                  engineId: "kotoba-whisper",
                  displayName: "Kotoba",
                  document: doc,
                  durationSec: 10,
                  completedAt: "2026-09-28T00:00:00Z",
                  timingGranularity: "segment",
                },
              },
              createdAt: "2026-09-28T00:00:00Z",
            },
            alignment: { sessionId: "s1", anchorEngineId: "kotoba-whisper", groups: [], unalignedSources: [], warnings: [] },
            proposals: [proposal],
            engineRecords: [],
          },
        },
        createdAt: "2026-09-28T00:00:00Z",
      };
      setMultiAsrStaging(staging);

      const res = await executeEditorHandoff(staging, navigateTo, setDocWithProps, setDoc, renderEd);
      expect(res).toBe(true);
      expect(navigateTo).toHaveBeenCalledWith("editor");
      expect(setDocWithProps).toHaveBeenCalledTimes(1);
      expect(renderEd).toHaveBeenCalledTimes(1);
      // Staging must be cleared
      expect(getMultiAsrStaging()).toBeNull();
    });

    it("Test S: new success atomically replaces old staging", () => {
      const staging1: StagedMultiAsrResult = {
        runId: "run-1",
        generation: 1,
        result: {
          status: "partial_asr_only",
          reason: "single_engine_only",
          session: {
            sessionId: "s1",
            mediaPath: "C:/test.wav",
            mediaFileName: "test.wav",
            expectedDurationSec: 10,
            anchorEngineId: "kotoba-whisper",
            results: {},
            createdAt: "2026-09-28T00:00:00Z",
          },
          engineRecords: [],
        },
        createdAt: "2026-09-28T00:00:00Z",
      };
      const staging2: StagedMultiAsrResult = {
        runId: "run-2",
        generation: 2,
        result: {
          status: "partial_asr_only",
          reason: "no_aligned_candidates",
          session: {
            sessionId: "s2",
            mediaPath: "C:/test.wav",
            mediaFileName: "test.wav",
            expectedDurationSec: 10,
            anchorEngineId: "kotoba-whisper",
            results: {},
            createdAt: "2026-09-28T00:00:00Z",
          },
          engineRecords: [],
        },
        createdAt: "2026-09-28T00:00:00Z",
      };

      setMultiAsrStaging(staging1);
      expect(getMultiAsrStaging()?.runId).toBe("run-1");

      setMultiAsrStaging(staging2);
      expect(getMultiAsrStaging()?.runId).toBe("run-2");
    });

    it("Test T: renders both failed notice and staging card when both are in state", () => {
      const staging: StagedMultiAsrResult = {
        runId: "run-1",
        generation: 1,
        result: {
          status: "partial_asr_only",
          reason: "single_engine_only",
          session: {
            sessionId: "s1",
            mediaPath: "C:/test.wav",
            mediaFileName: "test.wav",
            expectedDurationSec: 10,
            anchorEngineId: "kotoba-whisper",
            results: {},
            createdAt: "2026-09-28T00:00:00Z",
          },
          engineRecords: [],
        },
        createdAt: "2026-09-28T00:00:00Z",
      };
      setMultiAsrStaging(staging);
      setMultiAsrLastFailed({
        error: "Subsequent run failed",
        engineRecords: [],
      });
      syncMultiAsrUiFromState();

      const resultSection = document.getElementById("multiAsrResultSection");
      expect(resultSection?.style.display).not.toBe("none");
      expect(resultSection?.innerHTML).toContain("card-error");
      expect(resultSection?.innerHTML).toContain("card-warning");
      expect(resultSection?.innerHTML).toContain("Subsequent run failed");
    });

    it("Test U: resets cancel button label in DOM state updates", () => {
      const cancelBtn = document.getElementById("cancelMultiAsrBtn") as HTMLButtonElement;
      cancelBtn.innerHTML = `<span>icon</span><span>中止中...</span>`;
      
      acquireExecutionLock("multi", "run-1");
      expect(cancelBtn.querySelector("span:last-child")?.textContent).toBe("Multi-ASR中止");

      releaseExecutionLock("run-1");
      expect(cancelBtn.style.display).toBe("none");
    });

    it.each([
      { modeInput: "minimal", expectedMode: "minimal" as const },
      { modeInput: "standard", expectedMode: "standard" as const },
      { modeInput: "aggressive", expectedMode: "aggressive" as const },
      { modeInput: undefined, expectedMode: "standard" as const },
      { modeInput: "invalid_mode", expectedMode: "standard" as const },
    ])("Test V: Mode propagation through startMultiAsrFromUi ($modeInput -> $expectedMode)", async ({ modeInput, expectedMode }) => {
      const orchestratorModule = await import("./multi-asr-orchestrator");
      const orchSpy = vi.spyOn(orchestratorModule, "runMultiAsrOrchestration");

      const doc = createMockDocument("C:/test.wav", "test.wav", [
        { id: "s1", start: 0, end: 4, text: "テスト音声" },
      ]);
      const mockEngine = {
        engineId: "kotoba-whisper",
        displayName: "Kotoba Whisper",
        timingGranularity: "segment" as const,
        runTranscription: vi.fn().mockResolvedValue(doc),
      };

      const mockInvoke = vi.fn().mockImplementation(async (cmd: string) => {
        if (cmd === "load_api_settings") {
          return {
            providers: {
              ollama: {
                base_url: "http://localhost:11434",
                default_model: "qwen2.5:7b-instruct",
              },
            },
            correction_model: "qwen2.5:7b-instruct",
            correction_mode: modeInput,
            correction_use_dictionary: false,
            correction_use_background: false,
          };
        }
        if (cmd === "get_context_files") {
          return [];
        }
        return null;
      });

      setSelectedAudioDurationSecForTest(10);

      // Execute through the real UI trigger path startMultiAsrFromUi
      await startMultiAsrFromUi({
        targetFilePath: "C:/test.wav",
        duration: 10,
        invokeFn: mockInvoke,
        engines: [mockEngine],
        useDictionary: false,
        useBackground: false,
      });

      // Verify that runMultiAsrOrchestration was invoked with mode resolved to expectedMode
      expect(orchSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: expectedMode,
          mediaPath: "C:/test.wav",
        })
      );

      // Verify staging was populated through the real UI entrypoint
      const staging = getMultiAsrStaging();
      expect(staging).not.toBeNull();
      expect(staging?.result.status).toBe("partial_asr_only");

      orchSpy.mockRestore();
    });
  });
});


