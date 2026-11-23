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
  createMultiAsrEnginesByOrder,
  renderStagingCardHtml,
  prepareHandoffData,
  buildCompareExportPayload,
  type StagedMultiAsrResult,
} from "./multi-asr-ui";
import * as editorModule from "./editor";
import { runMultiAsrOrchestration } from "./multi-asr-orchestrator";

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

  it("runs configured cloud ASR engines sequentially and treats their text-only output as untimed", async () => {
    const calls: string[] = [];
    const invoke = (async <T>(command: string, _args?: Record<string, unknown>): Promise<T> => {
      calls.push(command);
      if (command === "load_api_settings") {
        return {
          providers: {
            google_stt: { options: { project_id: "project", location: "us-central1" } },
            xiaomi_mimo_asr: { env_name: "XIAOMI_API_KEY", base_url: "https://api.xiaomimimo.com/v1" },
          },
        } as T;
      }
      if (command === "google_stt_recognize") return { transcript: "Google result" } as T;
      if (command === "xiaomi_mimo_asr_recognize") return { transcript: "Xiaomi result" } as T;
      throw new Error(`unexpected command ${command}`);
    }) as <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
    const engines = createMultiAsrEnginesByOrder(
      ["cloud:google_stt", "cloud:xiaomi_mimo_asr"], invoke, undefined, "ja",
    );
    const result = await runMultiAsrOrchestration({
      mediaPath: "C:/audio.wav",
      mediaFileName: "audio.wav",
      expectedDurationSec: 20,
      engines,
      executionMode: "compare",
    });

    expect(calls.filter((command) => command.endsWith("recognize"))).toEqual([
      "google_stt_recognize",
      "xiaomi_mimo_asr_recognize",
    ]);
    expect(result.status).toBe("compare_ready");
    if (result.status === "compare_ready") {
      expect(result.anchorUnavailableReason).toBe("no_segment_timing_anchor");
      expect(result.session.results["cloud:google_stt"].document.transcriptTextWithoutTiming).toBe("Google result");
      expect(result.session.results["cloud:xiaomi_mimo_asr"].document.transcriptTextWithoutTiming).toBe("Xiaomi result");
      expect(result.session.results["cloud:google_stt"].document.segments).toEqual([]);
      expect(result.session.results["cloud:google_stt"].timingGranularity).toBe("segment");
      const staging = {
        runId: "cloud-compare",
        generation: 1,
        createdAt: new Date().toISOString(),
        result,
      } as StagedMultiAsrResult;
      const html = renderStagingCardHtml(staging);
      expect(html).toContain("[時間情報なし]");
      expect(html).not.toContain('id="btnOpenMultiAsrInEditor"');
      expect(prepareHandoffData(staging)).toBeNull();
    }
    expect(calls.indexOf("google_stt_recognize")).toBeLessThan(calls.indexOf("xiaomi_mimo_asr_recognize"));
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

  describe("Compare Mode UI & Export", () => {
    it("Test UI-CMP-1: Compare mode runs without LLM provider configured and preserves engine order", async () => {
      const invokedEngines: string[] = [];
      const mockInvoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "load_api_settings") {
          // LLM未設定状態
          return {
            providers: {},
            asr_mode: "local",
            asr_engine: "kotoba-whisper",
            asr_languages: {},
            speaker_diarization: false,
            num_speakers: "auto",
            output_path: "",
            correction_enabled: false,
            correction_provider: "ollama",
            correction_model: "",
          };
        }
        if (cmd === "local_asr_transcribe") {
          const eng = String(args?.engine ?? "");
          invokedEngines.push(eng);
          return {
            document: {
              schemaVersion: 1,
              mediaPath: "C:/test.wav",
              mediaFileName: "test.wav",
              segments: [
                {
                  id: `${eng}-1`,
                  start: 0.0,
                  end: eng === "kotoba-whisper" ? 2.5 : 10.0,
                  speaker: null,
                  text: `${eng} raw output`,
                },
              ],
            },
          };
        }
        if (cmd === "call_ollama_chat") {
          throw new Error("LLM must not be called in compare mode");
        }
        return null;
      });

      setSelectedAudioDurationSecForTest(10);

      await startMultiAsrFromUi({
        targetFilePath: "C:/test.wav",
        duration: 10,
        executionMode: "compare",
        engineOrder: ["reazonspeech", "kotoba-whisper"],
        invokeFn: mockInvoke as any,
      });

      expect(invokedEngines).toEqual(["reazonspeech", "kotoba-whisper"]);
      expect(mockInvoke).not.toHaveBeenCalledWith("call_ollama_chat", expect.anything());

      const staging = getMultiAsrStaging();
      expect(staging).not.toBeNull();
      expect(staging?.result.status).toBe("compare_ready");
      if (staging && staging.result.status === "compare_ready") {
        expect(staging.result.designatedAnchorEngineId).toBe("local:reazonspeech");
        expect(staging.result.anchorAvailable).toBe(false);
        expect(staging.result.anchorUnavailableReason).toBe("no_segment_timing_anchor");

        const html = renderStagingCardHtml(staging);
        expect(html).toContain("ReazonSpeech v2.0");
        expect(html).toContain("Kotoba Whisper v2.0");
        expect(html).toContain("reazonspeech raw output");
        expect(html).toContain("kotoba-whisper raw output");
      }
    });

    it("renders AI 1 as the fixed timestamp anchor", () => {
      const staging = {
        runId: "run-anchor-2",
        generation: 1,
        createdAt: new Date().toISOString(),
        result: {
          status: "compare_ready" as const,
          engineOrder: ["local:reazonspeech", "cloud:google_stt"],
          designatedAnchorEngineId: "local:reazonspeech",
          anchorAvailable: true,
          engineRecords: [
            { engineId: "local:reazonspeech", displayName: "ReazonSpeech", status: "success" as const, timingGranularity: "whole_audio" as const },
            { engineId: "cloud:google_stt", displayName: "Google STT", status: "success" as const, timingGranularity: "segment" as const },
          ],
          session: {
            sessionId: "anchor-2",
            mediaPath: "C:/test.wav",
            mediaFileName: "test.wav",
            expectedDurationSec: 10,
            anchorEngineId: "local:reazonspeech",
            results: {
              "local:reazonspeech": { engineId: "local:reazonspeech", displayName: "ReazonSpeech", durationSec: 10, completedAt: new Date().toISOString(), timingGranularity: "whole_audio" as const, document: { schemaVersion: 1, mediaPath: "C:/test.wav", mediaFileName: "test.wav", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), language: "ja", sourceEngine: "reazonspeech", sourceRunId: "a", segments: [], transcriptTextWithoutTiming: "local result" } },
              "cloud:google_stt": { engineId: "cloud:google_stt", displayName: "Google STT", durationSec: 10, completedAt: new Date().toISOString(), timingGranularity: "segment" as const, document: { schemaVersion: 1, mediaPath: "C:/test.wav", mediaFileName: "test.wav", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), language: "ja", sourceEngine: "google_stt", sourceRunId: "b", segments: [{ id: "g1", start: 0, end: 2, text: "api result", speaker: null, originalSpeaker: null, originalText: "api result", sourceEngine: "google_stt", sourceSegmentId: "g1", sourceRunId: "b", status: "raw" as const }] } },
            },
            createdAt: new Date().toISOString(),
          },
        },
      } as StagedMultiAsrResult;
      const html = renderStagingCardHtml(staging);
      expect(html).toContain("基準エンジン: ASRエンジン 1");
      expect(html).toContain("ASRエンジン 1 (基準)");
      expect(html).toContain("Google単語タイムスタンプ");
    });

    it("Test UI-CMP-2: Compare export payload and failed-anchor rendering do not promote 2nd engine", async () => {
      const staging = {
        runId: "run-cmp",
        generation: 1,
        createdAt: "2026-11-23T00:00:00.000Z",
        result: {
          status: "compare_ready" as const,
          engineOrder: ["kotoba-whisper", "reazonspeech"],
          designatedAnchorEngineId: "kotoba-whisper",
          anchorAvailable: false,
          anchorUnavailableReason: "first_engine_failed" as const,
          engineRecords: [
            { engineId: "kotoba-whisper", displayName: "Kotoba Whisper v2.0", status: "failed" as const, error: "OOM" },
            { engineId: "reazonspeech", displayName: "ReazonSpeech v2.0", status: "success" as const, timingGranularity: "whole_audio" as const },
          ],
          session: {
            sessionId: "sess-1",
            mediaPath: "C:/test.wav",
            mediaFileName: "test.wav",
            expectedDurationSec: 10,
            anchorEngineId: "",
            results: {
              reazonspeech: {
                engineId: "reazonspeech",
                displayName: "ReazonSpeech v2.0",
                durationSec: 10,
                completedAt: "2026-11-23T00:00:00.000Z",
                timingGranularity: "whole_audio" as const,
                document: {
                  schemaVersion: 1 as const,
                  mediaPath: "C:/test.wav",
                  mediaFileName: "test.wav",
                  createdAt: "2026-11-23T00:00:00.000Z",
                  updatedAt: "2026-11-23T00:00:00.000Z",
                  language: "ja",
                  sourceEngine: "reazonspeech",
                  sourceRunId: "run-cmp",
                  segments: [
                    {
                      id: "r1",
                      start: 0,
                      end: 10,
                      speaker: null,
                      text: "Reazon only",
                      originalSpeaker: null,
                      originalText: "Reazon only",
                      sourceEngine: "reazonspeech",
                      sourceSegmentId: "r1",
                      sourceRunId: "run-cmp",
                      status: "raw" as const,
                    },
                  ],
                },
              },
            },
            createdAt: "2026-11-23T00:00:00.000Z",
          },
        },
      };

      const html = renderStagingCardHtml(staging);
      expect(html).toContain("もう一方を自動で基準へ切り替えず");
      expect(html).toContain("Reazon only");
      expect(html).toContain("OOM");

      const payload = buildCompareExportPayload(staging.result);
      expect(payload.mode).toBe("compare");
      expect(payload.anchorEngineId).toBe("kotoba-whisper");
      expect(payload.anchorAvailable).toBe(false);
      expect(payload.engineOrder).toEqual(["kotoba-whisper", "reazonspeech"]);
      expect(payload.results).toHaveLength(2);
    });

    it("Test UI-CMP-3: Invalid timestamps render as --:--.- and invalid_anchor_timestamps displays explicit warning", async () => {
      const { formatCompareTimestamp } = await import("./multi-asr-ui");
      expect(formatCompareTimestamp(-1)).toBe("--:--.-");
      expect(formatCompareTimestamp(Number.NaN)).toBe("--:--.-");
      expect(formatCompareTimestamp(12.3)).toBe("00:12.3");

      const invalidStaging = {
        runId: "run-inv",
        generation: 1,
        createdAt: "2026-11-23T00:00:00.000Z",
        result: {
          status: "compare_ready" as const,
          engineOrder: ["kotoba-whisper", "reazonspeech"],
          designatedAnchorEngineId: "kotoba-whisper",
          anchorAvailable: false,
          anchorUnavailableReason: "invalid_anchor_timestamps" as const,
          engineRecords: [
            { engineId: "kotoba-whisper", displayName: "Kotoba Whisper v2.0", status: "success" as const, timingGranularity: "segment" as const },
            { engineId: "reazonspeech", displayName: "ReazonSpeech v2.0", status: "success" as const, timingGranularity: "whole_audio" as const },
          ],
          session: {
            sessionId: "sess-inv",
            mediaPath: "C:/test.wav",
            mediaFileName: "test.wav",
            expectedDurationSec: 10,
            anchorEngineId: "",
            results: {
              "kotoba-whisper": {
                engineId: "kotoba-whisper",
                displayName: "Kotoba Whisper v2.0",
                durationSec: 10,
                completedAt: "2026-11-23T00:00:00.000Z",
                timingGranularity: "segment" as const,
                document: {
                  schemaVersion: 1 as const,
                  mediaPath: "C:/test.wav",
                  mediaFileName: "test.wav",
                  createdAt: "2026-11-23T00:00:00.000Z",
                  updatedAt: "2026-11-23T00:00:00.000Z",
                  language: "ja",
                  sourceEngine: "kotoba-whisper",
                  sourceRunId: "run-inv",
                  segments: [
                    {
                      id: "k1",
                      start: -2,
                      end: 3,
                      speaker: null,
                      text: "Bad timing",
                      originalSpeaker: null,
                      originalText: "Bad timing",
                      sourceEngine: "kotoba-whisper",
                      sourceSegmentId: "k1",
                      sourceRunId: "run-inv",
                      status: "raw" as const,
                    },
                  ],
                },
              },
            },
            createdAt: "2026-11-23T00:00:00.000Z",
          },
        },
      };
      const html = renderStagingCardHtml(invalidStaging);
      expect(html).toContain("基準利用不可 (タイムスタンプ不正)");
      expect(html).toContain("--:--.-");
      expect(html).toContain("タイムスタンプが不正");
      expect(html).not.toContain("基準結果を開く");
      expect(html).not.toContain("btnOpenMultiAsrInEditor");

      const { prepareHandoffData } = await import("./multi-asr-ui");
      expect(prepareHandoffData(invalidStaging)).toBeNull();
    });

    it("Test UI-CMP-4: renders partial failure notice with survivor handoff, and blocks handoff when LLM compare correction fails", async () => {
      const { prepareHandoffData } = await import("./multi-asr-ui");

      const sharedSession = {
        sessionId: "s-partial",
        mediaPath: "C:/test.wav",
        mediaFileName: "test.wav",
        expectedDurationSec: 10,
        anchorEngineId: "",
        results: {
          "local:reazonspeech": {
            engineId: "local:reazonspeech",
            displayName: "ReazonSpeech v2.0",
            durationSec: 10,
            completedAt: "2026-11-23T00:00:00.000Z",
            timingGranularity: "segment" as const,
            document: {
              schemaVersion: 1 as const,
              mediaPath: "C:/test.wav",
              mediaFileName: "test.wav",
              createdAt: "2026-11-23T00:00:00.000Z",
              updatedAt: "2026-11-23T00:00:00.000Z",
              language: "ja",
              sourceEngine: "local:reazonspeech",
              sourceRunId: "r-surv",
              segments: [
                {
                  id: "r1",
                  start: 0,
                  end: 2,
                  speaker: null,
                  text: "生存結果",
                  originalSpeaker: null,
                  originalText: "生存結果",
                  sourceEngine: "local:reazonspeech",
                  sourceSegmentId: "r1",
                  sourceRunId: "r-surv",
                  status: "raw" as const,
                },
              ],
            },
          },
        },
        createdAt: "2026-11-23T00:00:00.000Z",
      };

      const partialStaging: StagedMultiAsrResult = {
        runId: "run-partial",
        generation: 1,
        createdAt: "2026-11-23T00:00:00.000Z",
        result: {
          status: "compare_ready",
          engineOrder: ["local:kotoba-whisper", "local:reazonspeech"],
          designatedAnchorEngineId: "local:kotoba-whisper",
          anchorAvailable: false,
          anchorUnavailableReason: "first_engine_failed",
          correctionStatus: "skipped_partial_failure",
          partialAsrFailure: true,
          engineRecords: [
            { engineId: "local:kotoba-whisper", displayName: "Kotoba Whisper v2.0", status: "failed", error: "CUDA OOM" },
            { engineId: "local:reazonspeech", displayName: "ReazonSpeech v2.0", status: "success", timingGranularity: "segment" },
          ],
          session: sharedSession,
        },
      };

      const partialHtml = renderStagingCardHtml(partialStaging);
      expect(partialHtml).toContain("Kotoba Whisper v2.0");
      expect(partialHtml).toContain("CUDA OOM");
      expect(prepareHandoffData(partialStaging)?.document.segments[0].text).toBe("生存結果");

      // Google 基準自体が失敗した部分成功でも、生存側結果を保存・引き継ぎ可能
      const googleFailedPartialStaging: StagedMultiAsrResult = {
        runId: "run-google-partial",
        generation: 1,
        createdAt: "2026-11-23T00:00:00.000Z",
        result: {
          status: "compare_ready",
          engineOrder: ["cloud:google_stt", "local:reazonspeech"],
          designatedAnchorEngineId: "cloud:google_stt",
          anchorAvailable: false,
          anchorUnavailableReason: "first_engine_failed",
          correctionStatus: "skipped_partial_failure",
          partialAsrFailure: true,
          engineRecords: [
            { engineId: "cloud:google_stt", displayName: "Google Cloud Speech-to-Text", status: "failed", error: "403 Forbidden" },
            { engineId: "local:reazonspeech", displayName: "ReazonSpeech v2.0", status: "success", timingGranularity: "segment" },
          ],
          session: sharedSession,
        },
      };
      const googleFailedHtml = renderStagingCardHtml(googleFailedPartialStaging);
      expect(googleFailedHtml).toContain('id="btnOpenMultiAsrInEditor"');
      expect(prepareHandoffData(googleFailedPartialStaging)?.document.segments[0].text).toBe("生存結果");

      const failedLlmStaging: StagedMultiAsrResult = {
        runId: "run-llm-fail",
        generation: 1,
        createdAt: "2026-11-23T00:00:00.000Z",
        result: {
          status: "compare_ready",
          engineOrder: ["local:kotoba-whisper", "local:reazonspeech"],
          designatedAnchorEngineId: "local:kotoba-whisper",
          anchorAvailable: true,
          correctionStatus: "failed",
          correctionError: "Ollama model missing",
          engineRecords: [
            { engineId: "local:kotoba-whisper", displayName: "Kotoba Whisper v2.0", status: "success", timingGranularity: "segment" },
            { engineId: "local:reazonspeech", displayName: "ReazonSpeech v2.0", status: "success", timingGranularity: "segment" },
          ],
          session: sharedSession,
        },
      };
      const failedHtml = renderStagingCardHtml(failedLlmStaging);
      expect(failedHtml).toContain("Ollama model missing");
      expect(prepareHandoffData(failedLlmStaging)).toBeNull();
    });

    it.each([
      { modeInput: "minimal", expectedMode: "minimal" },
      { modeInput: "aggressive", expectedMode: "aggressive" },
    ])("Test UI-CMP-5: Compare mode propagates resolved correctionMode ($modeInput -> $expectedMode) through startMultiAsrFromUi", async ({ modeInput, expectedMode }) => {
      const doc1 = createMockDocument("C:/test.wav", "test.wav", [
        { id: "s1", start: 0, end: 2, text: "生結果1" },
      ]);
      const doc2 = createMockDocument("C:/test.wav", "test.wav", [
        { id: "s2", start: 0, end: 2, text: "生結果2" },
      ]);
      const engines = [
        {
          engineId: "local:kotoba-whisper",
          displayName: "Kotoba Whisper v2.0",
          timingGranularity: "segment" as const,
          runTranscription: vi.fn().mockResolvedValue(doc1),
        },
        {
          engineId: "local:reazonspeech",
          displayName: "ReazonSpeech v2.0",
          timingGranularity: "segment" as const,
          runTranscription: vi.fn().mockResolvedValue(doc2),
        },
      ];

      let capturedMode: string | undefined;
      const mockInvoke = vi.fn().mockImplementation(async (cmd: string, args?: any) => {
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
        if (cmd === "call_ollama_chat") {
          const userMsg = args?.messages?.find((m: any) => m.role === "user")?.content ?? "";
          capturedMode = JSON.parse(userMsg).mode;
          return {
            message: {
              content: JSON.stringify({
                corrections: [{ segmentId: "s1", correctedText: "補正済み" }],
              }),
            },
          };
        }
        return null;
      });

      setSelectedAudioDurationSecForTest(10);
      await startMultiAsrFromUi({
        targetFilePath: "C:/test.wav",
        duration: 10,
        executionMode: "compare",
        engines,
        invokeFn: mockInvoke,
        useDictionary: false,
        useBackground: false,
      });

      expect(capturedMode).toBe(expectedMode);
    });
  });
});


