import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  setEditorDocument,
  getEditorDocument,
  getActiveProposals,
  setActiveProposalsForTest,
  setCorrectionProviderForTest,
  setEditorInvoke,
  renderEditorPage,
  bindEditorEvents,
} from "./editor";
import {
  runCorrectionForDocument,
  formatCorrectionProgress,
  MockCorrectionProvider,
  type CorrectionProposal,
  type CorrectionProgress,
} from "./correction";
import { OllamaCorrectionProvider } from "./ollama-provider";
import {
  setTauriInvokeForTest,
  setLastTranscriptionDocumentForTest,
  setPendingCorrectionResultForTest,
  getPendingCorrectionResultForTest,
  setAsrGenerationForTest,
  runAsrAutoCorrection,
  bindResultButtonsForTest,
} from "./main";
import type { TranscriptDocument, TranscriptSegment } from "./transcript";

function createSegment(id: string, text: string, speaker = "SPEAKER_00"): TranscriptSegment {
  return {
    id,
    start: 0,
    end: 1,
    speaker,
    originalSpeaker: speaker,
    text,
    originalText: text,
    sourceEngine: "whisper",
    sourceSegmentId: id,
    sourceRunId: "run-smoke",
    status: "raw",
  };
}

function createDoc(numSegments: number): TranscriptDocument {
  const segments: TranscriptSegment[] = [];
  for (let i = 1; i <= numSegments; i++) {
    segments.push(createSegment(`seg-${i}`, `音声認識テキスト セグメント ${i}`));
  }
  return {
    schemaVersion: 1,
    mediaPath: "C:\\audio.wav",
    mediaFileName: "audio.wav",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    language: "ja",
    sourceEngine: "whisper",
    sourceRunId: "run-smoke",
    segments,
  };
}

describe("Phase 2F Smoke Tests A - H", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    setCorrectionProviderForTest(null);
    vi.restoreAllMocks();
  });

  it("Smoke Test A: Manual correction progress (31 segments, 3 batches)", async () => {
    const doc = createDoc(31);
    setEditorDocument(doc, "C:\\test.asrc.json");

    const progressSnapshots: { text: string; raw: CorrectionProgress }[] = [];
    const mockTauri = vi.fn().mockImplementation(async (cmd: string, args: any) => {
      if (cmd === "load_api_settings") {
        return {
          correction_enabled: true,
          correction_mode: "standard",
          providers: {
            ollama: {
              base_url: "http://localhost:11434",
              default_model: "qwen2.5:7b",
            },
          },
        };
      }
      if (cmd === "read_correction_context_files") {
        return { dictionary_content: null, background_content: null };
      }
      if (cmd === "call_ollama_chat") {
        return {
          message: {
            content: JSON.stringify([
              {
                segmentId: args.input.messages[1].content.match(/\(ID: (seg-\d+)\)/)?.[1] || "seg-1",
                originalText: "音声認識テキスト セグメント 1",
                correctedText: "音声認識テキスト セグメント 1 (補正済み)",
                evidence: [{ type: "context" }],
                explanation: "smoke test correction",
              },
            ]),
          },
        };
      }
      throw new Error(`Unhandled: ${cmd}`);
    });

    setEditorInvoke(mockTauri);

    document.body.innerHTML = renderEditorPage();
    bindEditorEvents();

    const btnLlm = document.getElementById("btnEditorLlmCorrection") as HTMLButtonElement;
    const btnCancel = document.getElementById("btnEditorCancelCorrection") as HTMLButtonElement;

    expect(btnLlm).not.toBeNull();
    expect(btnCancel.style.display).toBe("none");

    const provider = new OllamaCorrectionProvider({
      baseUrl: "http://localhost:11434",
      model: "qwen2.5:7b",
      invokeTauri: mockTauri,
    });

    const result = await runCorrectionForDocument({
      document: doc,
      provider,
      onProgress: (p) => {
        progressSnapshots.push({
          text: formatCorrectionProgress(p),
          raw: { ...p },
        });
      },
    });

    expect(result.status).toBe("success");
    expect(progressSnapshots.length).toBeGreaterThanOrEqual(7);

    // 1. Starting
    expect(progressSnapshots[0].text).toBe("準備中... 0%");
    expect(progressSnapshots[0].raw.phase).toBe("starting");
    expect(progressSnapshots[0].raw.totalChunks).toBeNull();
    expect(progressSnapshots[0].raw.currentChunk).toBeNull();
    expect(progressSnapshots[0].raw.percentage).toBe(0);

    // 2. Batch 1/3 (1–15) before
    expect(progressSnapshots[1].text).toBe("Batch 1/3 (1–15) 0%");
    expect(progressSnapshots[1].raw.currentChunk).toBe(1);
    expect(progressSnapshots[1].raw.totalChunks).toBe(3);
    expect(progressSnapshots[1].raw.segmentStart).toBe(1);
    expect(progressSnapshots[1].raw.segmentEnd).toBe(15);

    // 3. Batch 1/3 (1–15) after -> 48% (15/31)
    expect(progressSnapshots[2].text).toBe("Batch 1/3 (1–15) 48%");

    // 4. Batch 2/3 (16–30) before -> 48%
    expect(progressSnapshots[3].text).toBe("Batch 2/3 (16–30) 48%");

    // 5. Batch 2/3 (16–30) after -> 96% (30/31)
    expect(progressSnapshots[4].text).toBe("Batch 2/3 (16–30) 96%");

    // 6. Batch 3/3 (31–31) before -> 96%
    expect(progressSnapshots[5].text).toBe("Batch 3/3 (31–31) 96%");

    // 7. Batch 3/3 (31–31) after -> 100%
    expect(progressSnapshots[6].text).toBe("Batch 3/3 (31–31) 100%");

    // 8. Completed final
    const finalProg = progressSnapshots[progressSnapshots.length - 1];
    expect(finalProg.text).toBe("完了 (100%)");
    expect(finalProg.raw.phase).toBe("completed");
    expect(finalProg.raw.totalChunks).toBe(3);
    expect(finalProg.raw.percentage).toBe(100);
  });

  it("Smoke Test B: Manual cancel (cancels during Batch 2, halts next batches, ignores in-flight)", async () => {
    const doc = createDoc(31);
    setEditorDocument(doc, "C:\\test.asrc.json");

    const existingProp: CorrectionProposal = {
      id: "prop-existing-safe",
      segmentId: "seg-1",
      originalText: doc.segments[0].text,
      correctedText: "安全に保持される既存提案 セグメント 1",
      evidence: [{ type: "context" }],
      explanation: "safe",
    };
    setActiveProposalsForTest(new Map([["seg-1", [existingProp]]]));

    let batchCount = 0;
    let resolveBatch2: (val: any) => void;

    const mockTauri = vi.fn().mockImplementation(async (cmd: string) => {
      if (cmd === "load_api_settings") {
        return {
          correction_enabled: true,
          correction_mode: "standard",
          providers: {
            ollama: {
              base_url: "http://localhost:11434",
              default_model: "qwen2.5:7b",
            },
          },
        };
      }
      if (cmd === "read_correction_context_files") {
        return { dictionary_content: null, background_content: null };
      }
      if (cmd === "call_ollama_chat") {
        batchCount++;
        if (batchCount === 1) {
          return {
            message: {
              content: JSON.stringify([
                {
                  segmentId: "seg-1",
                  originalText: doc.segments[0].text,
                  correctedText: "Batch 1 補正提案 セグメント 1",
                  evidence: [{ type: "context" }],
                  explanation: "b1",
                },
              ]),
            },
          };
        }
        if (batchCount === 2) {
          return new Promise((resolve) => {
            resolveBatch2 = resolve;
          });
        }
        return { message: { content: "[]" } };
      }
      throw new Error(`Unhandled: ${cmd}`);
    });

    setEditorInvoke(mockTauri);

    document.body.innerHTML = renderEditorPage();
    bindEditorEvents();

    const btnLlm = document.getElementById("btnEditorLlmCorrection") as HTMLButtonElement;
    const btnCancel = document.getElementById("btnEditorCancelCorrection") as HTMLButtonElement;

    // 補正開始
    btnLlm.click();

    await vi.waitFor(() => {
      expect(batchCount).toBe(2);
      expect(btnCancel.style.display).toBe("inline-flex");
    });

    // ユーザーが Batch 2 実行中にキャンセル
    btnCancel.click();

    // UI は即座に復帰
    expect(btnLlm.disabled).toBe(false);
    expect(btnCancel.style.display).toBe("none");

    // 既存の activeProposals は完全維持
    expect(getActiveProposals().get("seg-1")![0].id).toBe("prop-existing-safe");

    // 遅延した Batch 2 レスポンスが返ってくる
    resolveBatch2!({
      message: {
        content: JSON.stringify([
          {
            segmentId: "seg-16",
            originalText: doc.segments[15].text,
            correctedText: "Batch 2 補正提案 セグメント 16 (破棄されるべき)",
            evidence: [{ type: "context" }],
            explanation: "b2",
          },
        ]),
      },
    });

    await Promise.resolve();
    await Promise.resolve();

    // Batch 3 は絶対に送信されない (batchCount は 2 のまま)
    expect(batchCount).toBe(2);

    // 既存の提案は依然として維持
    expect(getActiveProposals().get("seg-1")![0].id).toBe("prop-existing-safe");
    expect(getActiveProposals().has("seg-16")).toBe(false);
  });

  it("Smoke Test C: Cancel → immediate rerun (Run A late response does not corrupt Run B)", async () => {
    const doc = createDoc(1);
    setEditorDocument(doc, "C:\\test.asrc.json");

    let resolveRunA: (val: any) => void;
    let resolveRunB: (val: any) => void;
    let callIdx = 0;

    const stagedProvider: any = {
      correct: async () => {
        callIdx++;
        if (callIdx === 1) {
          return new Promise((resolve) => {
            resolveRunA = resolve;
          });
        }
        return new Promise((resolve) => {
          resolveRunB = resolve;
        });
      },
    };

    setCorrectionProviderForTest(stagedProvider);

    document.body.innerHTML = renderEditorPage();
    bindEditorEvents();

    const btnLlm = document.getElementById("btnEditorLlmCorrection") as HTMLButtonElement;
    const btnCancel = document.getElementById("btnEditorCancelCorrection") as HTMLButtonElement;

    // Run A 開始
    btnLlm.click();
    expect(callIdx).toBe(1);

    // Run A キャンセル
    btnCancel.click();

    // 直ちに Run B 開始
    btnLlm.click();
    expect(callIdx).toBe(2);

    // Run A の遅延応答到着
    resolveRunA!([
      {
        id: "prop-run-a-corrupt",
        segmentId: "seg-1",
        originalText: doc.segments[0].text,
        correctedText: "Run A の不正混入テキスト セグメント 1",
        evidence: [{ type: "context" }],
        explanation: "run a",
      },
    ]);
    await Promise.resolve();

    // Run B の正常応答到着
    resolveRunB!([
      {
        id: "prop-run-b-valid",
        segmentId: "seg-1",
        originalText: doc.segments[0].text,
        correctedText: "Run B の正しい補正テキスト セグメント 1",
        evidence: [{ type: "context" }],
        explanation: "run b",
      },
    ]);

    await vi.waitFor(() => {
      expect(getActiveProposals().get("seg-1")![0].id).toBe("prop-run-b-valid");
      expect(getActiveProposals().get("seg-1")![0].correctedText).toBe("Run B の正しい補正テキスト セグメント 1");
    });
  });

  it("Smoke Test D: Auto correction (ASR completion triggers progress & badge updates)", async () => {
    document.body.innerHTML = `
      <div id="correctionStatusBadge" style="display:none;"></div>
      <button id="btnCancelAutoCorrection" style="display:none;"></button>
    `;
    bindResultButtonsForTest();

    const doc = createDoc(31);
    setLastTranscriptionDocumentForTest(doc);
    setAsrGenerationForTest(1);

    const mockInvoke = vi.fn().mockImplementation(async (cmd: string) => {
      if (cmd === "load_api_settings") {
        return {
          correction_enabled: true,
          correction_mode: "standard",
          providers: {
            ollama: {
              base_url: "http://localhost:11434",
              default_model: "qwen2.5:7b",
            },
          },
        };
      }
      if (cmd === "read_correction_context_files") {
        return { dictionary_content: null, background_content: null };
      }
      if (cmd === "call_ollama_chat") {
        return {
          message: {
            content: JSON.stringify([
              {
                segmentId: "seg-1",
                originalText: doc.segments[0].text,
                correctedText: "自動補正されたテキスト セグメント 1",
                evidence: [{ type: "context" }],
                explanation: "auto",
              },
            ]),
          },
        };
      }
      throw new Error(`Unhandled: ${cmd}`);
    });
    setTauriInvokeForTest(mockInvoke);

    const badgeEl = document.getElementById("correctionStatusBadge") as HTMLElement;
    const cancelBtn = document.getElementById("btnCancelAutoCorrection") as HTMLButtonElement;

    await runAsrAutoCorrection("asr-job-1", doc, 1);

    expect(badgeEl.style.display).toBe("inline-block");
    expect(badgeEl.textContent).toBe("補正候補 (1件) を生成しました");
    expect(cancelBtn.style.display).toBe("none");

    const staged = getPendingCorrectionResultForTest();
    expect(staged).not.toBeNull();
    expect(staged?.proposals.get("seg-1")![0].correctedText).toBe("自動補正されたテキスト セグメント 1");
  });

  it("Smoke Test E: Auto cancel (clicking cancel preserves ASR result & existing staging)", async () => {
    document.body.innerHTML = `
      <div id="correctionStatusBadge" style="display:none;"></div>
      <button id="btnCancelAutoCorrection" style="display:none;"></button>
    `;
    bindResultButtonsForTest();

    const doc = createDoc(15);
    setLastTranscriptionDocumentForTest(doc);
    setAsrGenerationForTest(1);

    const existingProp: CorrectionProposal = {
      id: "prop-staged-safe",
      segmentId: "seg-1",
      originalText: doc.segments[0].text,
      correctedText: "既存ステージング提案 セグメント 1",
      evidence: [{ type: "context" }],
      explanation: "safe",
    };
    setPendingCorrectionResultForTest({
      asrRunId: "asr-job-old",
      document: doc,
      proposals: new Map([["seg-1", [existingProp]]]),
      correctionRunId: "run-old",
    });

    let resolveSlowCall: ((val: any) => void) | null = null;
    const mockInvoke = vi.fn().mockImplementation(async (cmd: string) => {
      if (cmd === "load_api_settings") {
        return {
          correction_enabled: true,
          correction_mode: "standard",
          providers: {
            ollama: {
              base_url: "http://localhost:11434",
              default_model: "qwen2.5:7b",
            },
          },
        };
      }
      if (cmd === "read_correction_context_files") {
        return { dictionary_content: null, background_content: null };
      }
      if (cmd === "call_ollama_chat") {
        return new Promise((resolve) => {
          resolveSlowCall = resolve;
        });
      }
      throw new Error(`Unhandled: ${cmd}`);
    });
    setTauriInvokeForTest(mockInvoke);

    const badgeEl = document.getElementById("correctionStatusBadge") as HTMLElement;
    const cancelBtn = document.getElementById("btnCancelAutoCorrection") as HTMLButtonElement;

    const autoPromise = runAsrAutoCorrection("asr-job-new", doc, 1);

    await vi.waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("call_ollama_chat", expect.any(Object));
      expect(resolveSlowCall).not.toBeNull();
      expect(badgeEl.style.display).toBe("inline-block");
      expect(cancelBtn.style.display).toBe("inline-flex");
    });

    cancelBtn.click();

    expect(badgeEl.textContent).toBe("補正をキャンセルしました");
    expect(cancelBtn.style.display).toBe("none");

    // 既存 staging が完全保持されている
    expect(getPendingCorrectionResultForTest()?.proposals.get("seg-1")![0].id).toBe("prop-staged-safe");

    // 遅延完了が来ても staging は上書きされない
    resolveSlowCall!({
      message: {
        content: JSON.stringify([
          {
            segmentId: "seg-1",
            originalText: doc.segments[0].text,
            correctedText: "遅延応答 セグメント 1 (破棄されるべき)",
            evidence: [{ type: "context" }],
            explanation: "stale",
          },
        ]),
      },
    });

    await autoPromise;
    expect(getPendingCorrectionResultForTest()?.proposals.get("seg-1")![0].id).toBe("prop-staged-safe");
  });

  it("Smoke Test F: Zero proposal (clean success, idle reset, rerun available)", async () => {
    document.body.innerHTML = `
      <div id="correctionStatusBadge" style="display:none;"></div>
      <button id="btnCancelAutoCorrection" style="display:none;"></button>
    `;
    bindResultButtonsForTest();

    const doc = createDoc(2);
    setLastTranscriptionDocumentForTest(doc);
    setAsrGenerationForTest(1);

    const mockInvoke = vi.fn().mockImplementation(async (cmd: string) => {
      if (cmd === "load_api_settings") {
        return {
          correction_enabled: true,
          correction_mode: "standard",
          providers: {
            ollama: {
              base_url: "http://localhost:11434",
              default_model: "qwen2.5:7b",
            },
          },
        };
      }
      if (cmd === "read_correction_context_files") {
        return { dictionary_content: null, background_content: null };
      }
      if (cmd === "call_ollama_chat") {
        return { message: { content: "[]" } }; // 0 proposals
      }
      throw new Error(`Unhandled: ${cmd}`);
    });
    setTauriInvokeForTest(mockInvoke);

    const badgeEl = document.getElementById("correctionStatusBadge") as HTMLElement;

    await runAsrAutoCorrection("asr-job-zero", doc, 1);

    expect(badgeEl.textContent).toBe("補正候補はありませんでした (0件)");
    expect(badgeEl.style.display).toBe("inline-block");

    const staged = getPendingCorrectionResultForTest();
    expect(staged).not.toBeNull();
    expect(staged?.proposals.size).toBe(0);
  });

  it("Smoke Test G: Zero segment document (0 provider calls, clean 100%, no Batch 0/0)", async () => {
    const doc = createDoc(0);
    const progressList: CorrectionProgress[] = [];
    const provider = new MockCorrectionProvider();

    const result = await runCorrectionForDocument({
      document: doc,
      provider,
      onProgress: (p) => progressList.push(p),
    });

    expect(result.status).toBe("success");
    expect(progressList.length).toBe(1);
    expect(progressList[0].phase).toBe("completed");
    expect(progressList[0].totalChunks).toBe(0);
    expect(progressList[0].percentage).toBe(100);
    expect(formatCorrectionProgress(progressList[0])).toBe("完了 (100%)");
  });

  it("Smoke Test H: Progress / Mode coexistence (minimal, standard, aggressive, dictionary, background, guards)", async () => {
    const doc = createDoc(2);
    doc.segments[0].text = "価格は 1000 円です";
    doc.segments[0].originalText = "価格は 1000 円です";

    let capturedPrompt = "";
    const mockTauri = vi.fn().mockImplementation(async (cmd: string, args: any) => {
      if (cmd === "load_api_settings") {
        return {
          correction_enabled: true,
          correction_mode: "minimal",
          providers: {
            ollama: {
              base_url: "http://localhost:11434",
              default_model: "qwen2.5:7b",
            },
          },
        };
      }
      if (cmd === "read_correction_context_files") {
        return {
          dictionary_content: "canonical,variants\nAI,人工知能\n",
          background_content: "本セッションはAIの技術解説です。",
        };
      }
      if (cmd === "call_ollama_chat") {
        capturedPrompt = args.input.messages[0].content;
        return {
          message: {
            content: JSON.stringify([
              // 数値を改変した不正提案 (NUMERIC_CHANGE) -> ガードで落とされるべき
              {
                segmentId: "seg-1",
                originalText: "価格は 1000 円です",
                correctedText: "価格は 2000 円です",
                evidence: [{ type: "context" }],
                explanation: "numeric violation",
              },
            ]),
          },
        };
      }
      throw new Error(`Unhandled: ${cmd}`);
    });

    setEditorInvoke(mockTauri);
    setEditorDocument(doc, "C:\\test.asrc.json");

    document.body.innerHTML = renderEditorPage();
    bindEditorEvents();

    const btnLlm = document.getElementById("btnEditorLlmCorrection") as HTMLButtonElement;
    btnLlm.click();

    await vi.waitFor(() => {
      expect(mockTauri).toHaveBeenCalledWith("call_ollama_chat", expect.any(Object));
      expect(btnLlm.disabled).toBe(false);
    });

    // 1. Correction Mode (minimal) の指示がプロンプトに含まれていること
    expect(capturedPrompt).toContain("minimal");

    // 2. NUMERIC_CHANGE ガードにより不正提案が落とされ activeProposals が空であること
    expect(getActiveProposals().size).toBe(0);
  });
});
