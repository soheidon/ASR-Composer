// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  setEditorDocument,
  getEditorDocument,
  getSavedBaselineDoc,
  getEditorFilePath,
  isEditorDirty,
  discardEditorChanges,
  renderEditorPage,
  formatTimestamp,
  confirmDiscardChanges,
  handleOpenFile,
  setEditorInvoke,
  getActiveProposals,
  clearActiveProposalsForTest,
  setActiveProposalsForTest,
  bindEditorEvents,
  getEditorDocumentSessionId,
  setCorrectionProviderForTest,
  runLlmCorrection,
  cancelActiveCorrectionRunAndResetUi,
  renderEditor,
} from "./editor";
import { deriveSegmentStatus, type TranscriptDocument } from "./transcript";
import type { CorrectionProposal } from "./correction";
import * as statusModule from "./status";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

import { open as mockOpenDialog } from "@tauri-apps/plugin-dialog";

function createSampleDocument(segmentCount = 3): TranscriptDocument {
  return {
    schemaVersion: 1,
    mediaPath: "C:\\audio\\sample.wav",
    mediaFileName: "sample.wav",
    createdAt: "2026-09-26T20:00:00Z",
    updatedAt: "2026-09-26T20:00:00Z",
    language: "ja",
    sourceEngine: "reazonspeech",
    sourceRunId: "job-001",
    segments: Array.from({ length: segmentCount }, (_, i) => ({
      id: `seg-${(i + 1).toString().padStart(6, "0")}`,
      start: i * 5.0,
      end: (i + 1) * 5.0,
      speaker: `SPEAKER_${(i % 2).toString().padStart(2, "0")}`,
      originalSpeaker: `SPEAKER_${(i % 2).toString().padStart(2, "0")}`,
      text: `これはセグメント ${i + 1} のテキストです。`,
      originalText: `これはセグメント ${i + 1} のテキストです。`,
      sourceEngine: "reazonspeech",
      sourceSegmentId: (i + 1).toString(),
      sourceRunId: "job-001",
      status: "raw",
    })),
  };
}

describe("Canonical Editor", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setEditorDocument(null);
    setEditorInvoke(null);
  });

  it("formats timestamps properly", () => {
    expect(formatTimestamp(0)).toBe("00:00:00.000");
    expect(formatTimestamp(65.123)).toBe("00:01:05.123");
    expect(formatTimestamp(3661.5)).toBe("01:01:01.500");
  });

  it("renders empty state when no document is loaded", () => {
    setEditorDocument(null);
    const html = renderEditorPage();
    expect(html).toContain("正本データがありません");
    expect(html).toContain("btnEditorOpenFile");
  });

  it("Case A: ASR完了直後 (filePath === null) -> status: raw, dirty: true (未保存)", () => {
    const doc = createSampleDocument(1);
    setEditorDocument(doc, null);

    const active = getEditorDocument()!;
    expect(active.segments[0].status).toBe("raw");
    expect(getEditorFilePath()).toBeNull();
    expect(isEditorDirty()).toBe(true);

    const html = renderEditorPage();
    expect(html).toContain("未保存");
    expect(html).toContain("segment-status-raw");
  });

  it("Case B: 初回保存後 (filePath 設定) -> status: raw, dirty: false (保存済み)", () => {
    const doc = createSampleDocument(1);
    setEditorDocument(doc, "C:\\test.asrc.json");

    const active = getEditorDocument()!;
    expect(active.segments[0].status).toBe("raw");
    expect(getEditorFilePath()).toBe("C:\\test.asrc.json");
    expect(isEditorDirty()).toBe(false);

    const html = renderEditorPage();
    expect(html).toContain("保存済み");
  });

  it("Case C: 本文変更 -> status: edited, dirty: true (未保存)", () => {
    const doc = createSampleDocument(1);
    setEditorDocument(doc, "C:\\test.asrc.json");
    expect(isEditorDirty()).toBe(false);

    const active = getEditorDocument()!;
    active.segments[0].text = "編集された本文";
    active.segments[0].status = deriveSegmentStatus(active.segments[0]);

    expect(active.segments[0].status).toBe("edited");
    expect(isEditorDirty()).toBe(true);
  });

  it("Case D: 変更した本文をASR原文へ戻すが、ディスクの保存内容と異なる場合 -> status: raw, dirty: true", () => {
    const savedDoc = createSampleDocument(1);
    savedDoc.segments[0].text = "保存済みの修正本文";
    savedDoc.segments[0].status = "edited";

    setEditorDocument(savedDoc, "C:\\test.asrc.json");
    expect(isEditorDirty()).toBe(false);

    const active = getEditorDocument()!;
    active.segments[0].text = active.segments[0].originalText;
    active.segments[0].status = deriveSegmentStatus(active.segments[0]);

    expect(active.segments[0].status).toBe("raw");
    expect(isEditorDirty()).toBe(true);
  });

  it("Case E: その状態を保存 -> status: raw, dirty: false", () => {
    const doc = createSampleDocument(1);
    setEditorDocument(doc, "C:\\test.asrc.json");

    const active = getEditorDocument()!;
    expect(active.segments[0].status).toBe("raw");
    expect(isEditorDirty()).toBe(false);
  });

  it("Case F: .asrc.json から既に edited 状態の Document を読み込む -> status: edited, dirty: false", () => {
    const loadedDoc = createSampleDocument(1);
    loadedDoc.segments[0].text = "既に校正済みの正本文";
    loadedDoc.segments[0].status = "edited";

    setEditorDocument(loadedDoc, "C:\\saved.asrc.json");

    const active = getEditorDocument()!;
    expect(active.segments[0].status).toBe("edited");
    expect(isEditorDirty()).toBe(false);

    const html = renderEditorPage();
    expect(html).toContain("保存済み");
    expect(html).toContain("segment-status-edited");
  });

  it("evaluates performance with 1000 segments rendering", () => {
    const doc1000 = createSampleDocument(1000);
    const start = performance.now();
    setEditorDocument(doc1000, "C:\\test.asrc.json");
    const html = renderEditorPage();
    const duration = performance.now() - start;

    expect(html).toContain("seg-001000");
    expect(html).toContain("1000 セグメント");
    expect(duration).toBeLessThan(100);
  });

  // ---- Cases 1 to 4: Navigation & Guards ----

  it("Case 1: transcribe -> create new TranscriptDocument -> open editor without confirmation prompt", async () => {
    const confirmSpy = vi.spyOn(statusModule, "showAppConfirm");
    const newDoc = createSampleDocument(1);

    // Initial state: editor is empty (not dirty)
    expect(isEditorDirty()).toBe(false);

    // Click "正本編集を開く": set new doc and enter editor
    setEditorDocument(newDoc, null);

    // confirmDiscardChanges was not called
    expect(confirmSpy).not.toHaveBeenCalled();

    // Editor state
    const active = getEditorDocument()!;
    expect(active.segments[0].status).toBe("raw");
    expect(getEditorFilePath()).toBeNull();
    expect(isEditorDirty()).toBe(true); // Unsaved
  });

  it("Case 2: editor with unsaved changes -> navigate away prompts confirm; cancel stays, approve discards", async () => {
    const doc = createSampleDocument(1);
    setEditorDocument(doc, "C:\\saved.asrc.json");

    const active = getEditorDocument()!;
    active.segments[0].text = "未保存の編集";
    expect(isEditorDirty()).toBe(true);

    // Cancel departure
    const confirmSpy = vi.spyOn(statusModule, "showAppConfirm").mockResolvedValue(false);
    const approved1 = await confirmDiscardChanges();
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(approved1).toBe(false);
    expect(isEditorDirty()).toBe(true); // still dirty

    // Approve departure
    confirmSpy.mockResolvedValue(true);
    const approved2 = await confirmDiscardChanges();
    expect(approved2).toBe(true);

    // When approved, discardEditorChanges resets dirty state
    discardEditorChanges();
    expect(isEditorDirty()).toBe(false);
    expect(getEditorDocument()!.segments[0].text).toBe("これはセグメント 1 のテキストです。");
  });

  it("Case 3: editor with unsaved changes -> open another file prompts confirm", async () => {
    const doc = createSampleDocument(1);
    setEditorDocument(doc, "C:\\saved.asrc.json");
    getEditorDocument()!.segments[0].text = "未保存";
    expect(isEditorDirty()).toBe(true);

    const confirmSpy = vi.spyOn(statusModule, "showAppConfirm").mockResolvedValue(false);
    await handleOpenFile();
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(mockOpenDialog).not.toHaveBeenCalled();
  });

  it("Case 4: editor with unsaved changes -> close window / Alt+F4 is guarded by isEditorDirty", () => {
    const doc = createSampleDocument(1);
    setEditorDocument(doc, null);
    expect(isEditorDirty()).toBe(true);
  });

  // ---- Cases 5A, 5B, 5C: Discard & Lifecycle ----

  it("Case 5A: editor with unsaved changes -> navigate to transcribe -> approve discard clears dirty state", () => {
    // Unsaved fresh doc
    const newDoc = createSampleDocument(1);
    setEditorDocument(newDoc, null);
    expect(isEditorDirty()).toBe(true);

    discardEditorChanges();

    expect(getEditorDocument()).toBeNull();
    expect(getSavedBaselineDoc()).toBeNull();
    expect(getEditorFilePath()).toBeNull();
    expect(isEditorDirty()).toBe(false);
  });

  it("Case 5B: after Case 5A, new transcription completes -> click open editor opens without duplicate prompt", () => {
    // Start after discard (clean state)
    expect(isEditorDirty()).toBe(false);

    const confirmSpy = vi.spyOn(statusModule, "showAppConfirm");
    const nextDoc = createSampleDocument(2);

    // openEditorBtn logic:
    if (isEditorDirty()) {
      // should not enter
      void confirmDiscardChanges();
    }
    setEditorDocument(nextDoc, null);

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(getEditorDocument()!.segments.length).toBe(2);
    expect(getEditorDocument()!.segments[0].status).toBe("raw");
    expect(isEditorDirty()).toBe(true); // new doc is unsaved
  });

  it("Case 5C: dirty editor document -> direct replace prompts confirm; cancel keeps old doc, approve replaces", async () => {
    const initialDoc = createSampleDocument(1);
    setEditorDocument(initialDoc, null);
    getEditorDocument()!.segments[0].text = "old dirty text";

    const newDoc = createSampleDocument(2);

    // User cancels
    const confirmSpy = vi.spyOn(statusModule, "showAppConfirm").mockResolvedValue(false);
    let approved = await confirmDiscardChanges();
    expect(approved).toBe(false);
    expect(getEditorDocument()!.segments[0].text).toBe("old dirty text");

    // User approves
    confirmSpy.mockResolvedValue(true);
    approved = await confirmDiscardChanges();
    expect(approved).toBe(true);
    setEditorDocument(newDoc, null);
    expect(getEditorDocument()!.segments.length).toBe(2);
    expect(getEditorDocument()!.segments[0].text).toBe("これはセグメント 1 のテキストです。");
  });

  // ---- Cases 6A, 6B, 6C: Transactional handleOpenFile ----

  it("Case 6A: dirty editor -> open -> approve discard -> cancel file dialog preserves existing doc and edits", async () => {
    const doc = createSampleDocument(1);
    setEditorDocument(doc, "C:\\existing.asrc.json");
    getEditorDocument()!.segments[0].text = "ユーザーの未保存編集";
    expect(isEditorDirty()).toBe(true);

    vi.spyOn(statusModule, "showAppConfirm").mockResolvedValue(true);
    (mockOpenDialog as any).mockResolvedValue(null); // user cancelled dialog

    await handleOpenFile();

    expect(getEditorDocument()!.segments[0].text).toBe("ユーザーの未保存編集");
    expect(getEditorFilePath()).toBe("C:\\existing.asrc.json");
    expect(isEditorDirty()).toBe(true);
  });

  it("Case 6B: dirty editor -> open -> approve discard -> corrupt file load error preserves existing doc and edits", async () => {
    const doc = createSampleDocument(1);
    setEditorDocument(doc, "C:\\existing.asrc.json");
    getEditorDocument()!.segments[0].text = "ユーザーの未保存編集";
    expect(isEditorDirty()).toBe(true);

    vi.spyOn(statusModule, "showAppConfirm").mockResolvedValue(true);
    const dialogSpy = vi.spyOn(statusModule, "showAppDialog").mockResolvedValue();
    (mockOpenDialog as any).mockResolvedValue("C:\\corrupt.asrc.json");

    setEditorInvoke(async <T>(cmd: string): Promise<T> => {
      if (cmd === "load_transcript_document") {
        throw new Error("Invalid schemaVersion: 99");
      }
      return null as T;
    });

    await handleOpenFile();

    expect(dialogSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: "読み込みエラー", type: "error" }),
    );
    expect(getEditorDocument()!.segments[0].text).toBe("ユーザーの未保存編集");
    expect(getEditorFilePath()).toBe("C:\\existing.asrc.json");
    expect(isEditorDirty()).toBe(true);
  });

  it("Case 6C: dirty editor -> open -> approve discard -> valid file loads and replaces document", async () => {
    const doc = createSampleDocument(1);
    setEditorDocument(doc, "C:\\existing.asrc.json");
    getEditorDocument()!.segments[0].text = "ユーザーの未保存編集";
    expect(isEditorDirty()).toBe(true);

    const loadedDoc = createSampleDocument(2);
    loadedDoc.mediaFileName = "loaded.wav";

    vi.spyOn(statusModule, "showAppConfirm").mockResolvedValue(true);
    (mockOpenDialog as any).mockResolvedValue("C:\\valid.asrc.json");

    setEditorInvoke(async <T>(cmd: string): Promise<T> => {
      if (cmd === "load_transcript_document") {
        return loadedDoc as T;
      }
      return null as T;
    });

    const navigateSpy = vi.fn().mockResolvedValue(undefined);
    await handleOpenFile(navigateSpy);

    expect(getEditorDocument()!.mediaFileName).toBe("loaded.wav");
    expect(getEditorFilePath()).toBe("C:\\valid.asrc.json");
    expect(isEditorDirty()).toBe(false);
    expect(navigateSpy).toHaveBeenCalledWith("editor");
  });

  it("Case 6D: Same-Page Open File DOM Re-rendering: 同一エディター画面内で開く成功後、ヘッダー・セグメント数・本文・dirty表示が新Documentへ即座に再描画される", async () => {
    // 1. Doc A を準備し DOM に描画
    const docA = createSampleDocument(2);
    docA.mediaFileName = "docA.wav";
    docA.segments[0].text = "Doc A セグメント 1 のテキスト";
    docA.segments[1].text = "Doc A セグメント 2 のテキスト";
    setEditorDocument(docA, "C:\\docA.asrc.json");

    // Doc A 用に補正提案を付与
    const propA: CorrectionProposal = {
      id: "prop-docA-1",
      segmentId: docA.segments[0].id,
      originalText: docA.segments[0].text,
      correctedText: "Doc A 補正後テキスト",
      evidence: [{ type: "context" }],
      explanation: "提案A",
    };
    setActiveProposalsForTest(new Map([[docA.segments[0].id, [propA]]]));

    document.body.innerHTML = renderEditorPage();
    bindEditorEvents();

    // 初期状態の確認
    expect(document.querySelector(".editor-filename")?.textContent).toBe("docA.wav");
    expect(document.querySelector(".editor-subtitle")?.textContent).toContain("2 セグメント");
    expect(document.querySelectorAll(".segment-card")).toHaveLength(2);
    expect(document.body.innerHTML).toContain("Doc A セグメント 1");
    expect(document.body.innerHTML).toContain("補正候補 (1件)");

    // 2. Doc B の準備
    const docB = createSampleDocument(3);
    docB.mediaFileName = "docB.wav";
    docB.segments[0].id = "seg-b-1";
    docB.segments[0].text = "Doc B セグメント 1";
    docB.segments[1].id = "seg-b-2";
    docB.segments[1].text = "Doc B セグメント 2";
    docB.segments[2].id = "seg-b-3";
    docB.segments[2].text = "Doc B セグメント 3";

    vi.spyOn(statusModule, "showAppConfirm").mockResolvedValue(true);
    (mockOpenDialog as any).mockResolvedValue("C:\\docB.asrc.json");

    setEditorInvoke(async <T>(cmd: string): Promise<T> => {
      if (cmd === "load_transcript_document") {
        return docB as T;
      }
      return null as T;
    });

    // 3. 開くを実行
    const openBtn = document.getElementById("btnEditorOpenFile") as HTMLButtonElement;
    openBtn.click();

    // 非同期処理の完了を待機
    await new Promise((r) => setTimeout(r, 0));

    // 4. 検証: DOM 全体が Doc B に再描画されていること
    expect(document.querySelector(".editor-filename")?.textContent).toBe("docB.wav");
    expect(document.querySelector(".editor-subtitle")?.textContent).toContain("3 セグメント");
    expect(document.querySelector(".editor-subtitle")?.textContent).toContain("C:\\docB.asrc.json");
    expect(document.querySelectorAll(".segment-card")).toHaveLength(3);

    const textareas = document.querySelectorAll<HTMLTextAreaElement>(".segment-text-input");
    expect(textareas[0].value).toBe("Doc B セグメント 1");
    expect(textareas[1].value).toBe("Doc B セグメント 2");
    expect(textareas[2].value).toBe("Doc B セグメント 3");

    // Doc A の内容が DOM に残っていないこと
    expect(document.body.innerHTML).not.toContain("docA.wav");
    expect(document.body.innerHTML).not.toContain("Doc A セグメント 1");
    expect(document.body.innerHTML).not.toContain("Doc A セグメント 2");
    expect(document.body.innerHTML).not.toContain("補正候補");

    // 内部状態の検証
    expect(getEditorDocument()!.mediaFileName).toBe("docB.wav");
    expect(getEditorFilePath()).toBe("C:\\docB.asrc.json");
    expect(isEditorDirty()).toBe(false);
    expect(getActiveProposals().size).toBe(0);

    // イベントが再バインドされていること（セグメント編集で dirty になる）
    textareas[0].value = "Doc B 編集済みテキスト";
    textareas[0].dispatchEvent(new Event("input", { bubbles: true }));
    expect(isEditorDirty()).toBe(true);
    expect(document.querySelector(".editor-status-badge")?.textContent).toContain("未保存");
  });

  it("Case 6E: Same-Page Open File during active LLM Correction: 補正実行中に別ファイルを開いた場合、旧RunがキャンセルされUIがアイドル化しDoc Bが描画される", async () => {
    const docA = createSampleDocument(2);
    docA.mediaFileName = "docA.wav";
    setEditorDocument(docA, "C:\\docA.asrc.json");

    let resolveProvider: (proposals: CorrectionProposal[]) => void = () => {};
    const deferredProvider = {
      correct: vi.fn().mockImplementation(() => {
        return new Promise<CorrectionProposal[]>((resolve) => {
          resolveProvider = resolve;
        });
      }),
    };
    setCorrectionProviderForTest(deferredProvider as any);

    document.body.innerHTML = renderEditorPage();
    bindEditorEvents();

    const btnLlm = document.getElementById("btnEditorLlmCorrection") as HTMLButtonElement;
    const btnCancel = document.getElementById("btnEditorCancelCorrection") as HTMLButtonElement;

    // 1. Doc A 上で補正を開始
    const p1 = runLlmCorrection();
    expect(btnLlm.disabled).toBe(true);
    expect(btnCancel.style.display).toBe("inline-flex");

    // 2. 補正実行中に Doc B を開く
    const docB = createSampleDocument(1);
    docB.mediaFileName = "docB.wav";
    docB.segments[0].text = "Doc B 単一セグメント";

    vi.spyOn(statusModule, "showAppConfirm").mockResolvedValue(true);
    (mockOpenDialog as any).mockResolvedValue("C:\\docB.asrc.json");

    setEditorInvoke(async <T>(cmd: string): Promise<T> => {
      if (cmd === "load_transcript_document") {
        return docB as T;
      }
      return null as T;
    });

    const openBtn = document.getElementById("btnEditorOpenFile") as HTMLButtonElement;
    openBtn.click();
    await new Promise((r) => setTimeout(r, 0));

    // 3. UI が Doc B に切り替わり、補正UIもアイドル化していること
    expect(document.querySelector(".editor-filename")?.textContent).toBe("docB.wav");
    const reloadedLlmBtn = document.getElementById("btnEditorLlmCorrection") as HTMLButtonElement;
    const reloadedCancelBtn = document.getElementById("btnEditorCancelCorrection") as HTMLButtonElement;
    expect(reloadedLlmBtn.disabled).toBe(false);
    expect(reloadedCancelBtn.style.display).toBe("none");

    // 4. 旧プロバイダーが後から解決しても Doc B は一切影響を受けない
    resolveProvider([
      {
        id: "prop-docA-late",
        segmentId: docA.segments[0].id,
        originalText: docA.segments[0].text,
        correctedText: "遅延提案",
        evidence: [{ type: "context" }],
        explanation: "late",
      },
    ]);
    await p1;

    expect(getActiveProposals().size).toBe(0);
    expect(document.body.innerHTML).not.toContain("遅延提案");
    expect(document.body.innerHTML).not.toContain("補正候補");

    setCorrectionProviderForTest(null);
  });

  it("renderEditor: 現在の currentDoc を用いて .editor-container を明示的に再描画しイベントを再バインドする", () => {
    const doc = createSampleDocument(1);
    doc.mediaFileName = "re-render-test.wav";
    setEditorDocument(doc, "C:\\re-render.asrc.json");

    document.body.innerHTML = `<div class="editor-container">旧コンテンツ</div>`;

    renderEditor();

    expect(document.querySelector(".editor-filename")?.textContent).toBe("re-render-test.wav");
    expect(document.querySelector(".segment-card")).not.toBeNull();
  });

  // ---- Cases 7A, 7B, 7C: Aliasing & Deep Cloning ----

  it("Case 7A: setEditorDocument(source, null) clones source independently (source not mutated)", () => {
    const source = createSampleDocument(1);
    const originalText = source.segments[0].text;

    setEditorDocument(source, null);

    const active = getEditorDocument()!;
    active.segments[0].text = "エディターで編集された本文";

    expect(active.segments[0].text).toBe("エディターで編集された本文");
    expect(source.segments[0].text).toBe(originalText);
    expect(active).not.toBe(source);
    expect(active.segments[0]).not.toBe(source.segments[0]);
  });

  it("Case 7B: setEditorDocument(savedDoc, path) clones savedBaselineDoc independently", () => {
    const savedDoc = createSampleDocument(1);
    const originalText = savedDoc.segments[0].text;

    setEditorDocument(savedDoc, "C:\\test.asrc.json");

    const active = getEditorDocument()!;
    const baseline = getSavedBaselineDoc()!;

    active.segments[0].text = "エディターで編集された本文";

    expect(active.segments[0].text).toBe("エディターで編集された本文");
    expect(baseline.segments[0].text).toBe(originalText);
    expect(active).not.toBe(savedDoc);
    expect(baseline).not.toBe(savedDoc);
    expect(active).not.toBe(baseline);
    expect(isEditorDirty()).toBe(true);
  });

  it("Case 7C: edit, discard, and reopen lastTranscriptionDocument opens clean ASR initial state", () => {
    const lastTranscription = createSampleDocument(1);
    const originalText = lastTranscription.segments[0].text;

    // 1st open
    setEditorDocument(lastTranscription, null);
    const active1 = getEditorDocument()!;
    active1.segments[0].text = "前回の未保存編集";
    expect(active1.segments[0].text).toBe("前回の未保存編集");

    // Discard
    discardEditorChanges();

    // 2nd open from same lastTranscriptionDocument object
    setEditorDocument(lastTranscription, null);
    const active2 = getEditorDocument()!;

    expect(active2.segments[0].text).toBe(originalText);
    expect(active2.segments[0].status).toBe("raw");
    expect(active2).not.toBe(lastTranscription);
    expect(isEditorDirty()).toBe(true); // new unsaved document
  });
});

describe("Phase 1 LLM Correction UI Integration", () => {
  beforeEach(() => {
    clearActiveProposalsForTest();
    document.body.innerHTML = "";
  });

  it("Case H: Multiple proposals for same segment - adopting 1 proposal applies text, status=edited, dirty=true, and clears all proposals for that segment", async () => {
    const doc = createSampleDocument(1);
    setEditorDocument(doc, "C:\\test.asrc.json");

    const seg = getEditorDocument()!.segments[0];
    const initialOrigText = seg.originalText;

    const prop1: CorrectionProposal = {
      id: "prop-1",
      segmentId: seg.id,
      originalText: seg.text,
      correctedText: "採用された第一補正テキスト",
      evidence: [
        { type: "dictionary", sourceId: "d-1", description: "医学辞書" },
      ],
      explanation: "第一候補",
      confidence: 0.95,
    };
    const prop2: CorrectionProposal = {
      id: "prop-2",
      segmentId: seg.id,
      originalText: seg.text,
      correctedText: "却下される第二補正テキスト",
      evidence: [{ type: "context", description: "前後文脈" }],
      explanation: "第二候補",
      confidence: 0.8,
    };

    const map = new Map<string, CorrectionProposal[]>();
    map.set(seg.id, [prop1, prop2]);
    setActiveProposalsForTest(map);

    document.body.innerHTML = renderEditorPage();
    bindEditorEvents();

    const applyBtns = document.querySelectorAll<HTMLButtonElement>(".btn-apply-proposal");
    expect(applyBtns.length).toBe(2);

    // 1件目を採用クリック
    applyBtns[0].click();

    // segment.text が更新される
    expect(seg.text).toBe("採用された第一補正テキスト");
    // originalText は絶対に不変
    expect(seg.originalText).toBe(initialOrigText);
    // status は edited
    expect(seg.status).toBe("edited");
    // dirty は自然に true
    expect(isEditorDirty()).toBe(true);
    // 当該セグメントの全 proposal がクリアされていること
    expect(getActiveProposals().has(seg.id)).toBe(false);
    // DOM上の proposal-card も除去されていること
    expect(document.querySelectorAll(".proposal-card").length).toBe(0);
  });

  it("Case I: Multiple proposals for same segment - rejecting 1 proposal removes only that proposal and keeps others", () => {
    const doc = createSampleDocument(1);
    setEditorDocument(doc, "C:\\test.asrc.json");
    const seg = getEditorDocument()!.segments[0];

    const prop1: CorrectionProposal = {
      id: "prop-1",
      segmentId: seg.id,
      originalText: seg.text,
      correctedText: "候補1",
      evidence: [{ type: "dictionary" }],
      explanation: "説明1",
    };
    const prop2: CorrectionProposal = {
      id: "prop-2",
      segmentId: seg.id,
      originalText: seg.text,
      correctedText: "候補2",
      evidence: [{ type: "context" }],
      explanation: "説明2",
    };

    const map = new Map<string, CorrectionProposal[]>();
    map.set(seg.id, [prop1, prop2]);
    setActiveProposalsForTest(map);

    document.body.innerHTML = renderEditorPage();
    bindEditorEvents();

    const rejectBtns = document.querySelectorAll<HTMLButtonElement>(".btn-reject-proposal");
    expect(rejectBtns.length).toBe(2);

    // 1件目を却下クリック
    rejectBtns[0].click();

    // prop1 は消え、prop2 だけが維持される
    const remaining = getActiveProposals().get(seg.id);
    expect(remaining).toHaveLength(1);
    expect(remaining![0].id).toBe("prop-2");

    // ドキュメントは一切不変
    expect(seg.text).toBe("これはセグメント 1 のテキストです。");
    expect(seg.status).toBe("raw");
    expect(isEditorDirty()).toBe(false);
  });

  it("Case J: Manual text edit in textarea marks proposal as stale and disables apply button", () => {
    const doc = createSampleDocument(1);
    setEditorDocument(doc, "C:\\test.asrc.json");
    const seg = getEditorDocument()!.segments[0];

    const prop: CorrectionProposal = {
      id: "prop-1",
      segmentId: seg.id,
      originalText: seg.text,
      correctedText: "補正テキスト",
      evidence: [{ type: "dictionary" }],
      explanation: "説明",
    };

    const map = new Map<string, CorrectionProposal[]>();
    map.set(seg.id, [prop]);
    setActiveProposalsForTest(map);

    document.body.innerHTML = renderEditorPage();
    bindEditorEvents();

    const textarea = document.querySelector<HTMLTextAreaElement>(".segment-text-input")!;
    const applyBtnBefore = document.querySelector<HTMLButtonElement>(".btn-apply-proposal")!;
    expect(applyBtnBefore.disabled).toBe(false);

    // ユーザーが手動編集
    textarea.value = "手動で書き直した文章";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));

    // proposal card が再描画されて Stale 表示になり、ボタンが無効化されること
    const staleTag = document.querySelector<HTMLElement>(".proposal-stale-tag");
    expect(staleTag).not.toBeNull();
    expect(staleTag!.textContent).toContain("Stale");

    const applyBtnAfter = document.querySelector<HTMLButtonElement>(".btn-apply-proposal")!;
    expect(applyBtnAfter.disabled).toBe(true);

    // 無効化されたボタンをクリックしても採用されないこと
    applyBtnAfter.click();
    expect(seg.text).toBe("手動で書き直した文章");
    expect(getActiveProposals().has(seg.id)).toBe(true);
  });

  it("Case L: HTML escaping - untrusted strings in proposals cannot execute or inject raw tags into DOM", () => {
    const doc = createSampleDocument(1);
    setEditorDocument(doc, "C:\\test.asrc.json");
    const seg = getEditorDocument()!.segments[0];

    const xssProposal: CorrectionProposal = {
      id: "prop-xss",
      segmentId: seg.id,
      originalText: seg.text,
      correctedText: "<img src=x onerror=alert(1)>危険テキスト",
      evidence: [
        { type: "dictionary", sourceId: "<script>alert(2)</script>", description: "<b>危険説明</b>" },
      ],
      explanation: "<script>alert('xss')</script>説明文",
    };

    const map = new Map<string, CorrectionProposal[]>();
    map.set(seg.id, [xssProposal]);
    setActiveProposalsForTest(map);

    document.body.innerHTML = renderEditorPage();

    // DOM内に script タグや onerror 属性を持つ img タグが存在しないこと
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("img[onerror]")).toBeNull();

    // テキストとして安全にエスケープされてレンダリングされていること
    expect(document.body.innerHTML).toContain("&lt;script&gt;alert('xss')&lt;/script&gt;");
    expect(document.body.innerHTML).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(document.body.innerHTML).toContain("&lt;b&gt;危険説明&lt;/b&gt;");
  });

  it("Case P: Attribute quote breakout defense - proposal.id payloads cannot create new attributes or inject handlers", () => {
    const doc = createSampleDocument(1);
    setEditorDocument(doc, "C:\\test.asrc.json");
    const seg = getEditorDocument()!.segments[0];

    const breakoutProposal1: CorrectionProposal = {
      id: 'abc" onmouseover="alert(1)',
      segmentId: seg.id,
      originalText: seg.text,
      correctedText: "安全な補正テキスト1",
      evidence: [{ type: "dictionary" }],
      explanation: "説明1",
    };

    const breakoutProposal2: CorrectionProposal = {
      id: "'><img src=x onerror=alert(1)>",
      segmentId: seg.id,
      originalText: seg.text,
      correctedText: "安全な補正テキスト2",
      evidence: [{ type: "context" }],
      explanation: "説明2",
    };

    const map = new Map<string, CorrectionProposal[]>();
    map.set(seg.id, [breakoutProposal1, breakoutProposal2]);
    setActiveProposalsForTest(map);

    document.body.innerHTML = renderEditorPage();
    bindEditorEvents();

    // 1. 新規属性（onmouseover）が作られていないこと
    const elementsWithMouseOver = document.querySelectorAll("[onmouseover]");
    expect(elementsWithMouseOver.length).toBe(0);

    // 2. img / script タグが生成されていないこと
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("script")).toBeNull();

    // 3. dataset / 属性を通じて安全に proposal.id が取得でき、採用処理が正常に動作すること
    const applyBtns = document.querySelectorAll<HTMLButtonElement>(".btn-apply-proposal");
    expect(applyBtns.length).toBe(2);

    // 1件目 (abc" onmouseover="alert(1)) の採用ボタンをクリック
    applyBtns[0].click();

    expect(seg.text).toBe("安全な補正テキスト1");
    expect(getActiveProposals().has(seg.id)).toBe(false);
  });

  it("Case N: Lifecycle - setEditorDocument and discardEditorChanges clear active proposals, but Save preserves them", async () => {
    const doc = createSampleDocument(1);
    setEditorDocument(doc, "C:\\test.asrc.json");
    const seg = doc.segments[0];

    const prop: CorrectionProposal = {
      id: "prop-1",
      segmentId: seg.id,
      originalText: seg.text,
      correctedText: "補正テキスト",
      evidence: [{ type: "dictionary" }],
      explanation: "説明",
    };

    const map = new Map<string, CorrectionProposal[]>();
    map.set(seg.id, [prop]);
    setActiveProposalsForTest(map);
    expect(getActiveProposals().size).toBe(1);

    // 1. setEditorDocument でクリアされる
    setEditorDocument(doc, "C:\\new.asrc.json");
    expect(getActiveProposals().size).toBe(0);

    // 2. discardEditorChanges でクリアされる
    setActiveProposalsForTest(new Map([[seg.id, [prop]]]));
    expect(getActiveProposals().size).toBe(1);
    discardEditorChanges();
    expect(getActiveProposals().size).toBe(0);

    // 3. 通常の保存 (Save) では保持される
    setEditorDocument(doc, "C:\\test.asrc.json");
    setActiveProposalsForTest(new Map([[seg.id, [prop]]]));

    const mockInvoke = vi.fn().mockResolvedValue(true);
    setEditorInvoke(mockInvoke);

    document.body.innerHTML = renderEditorPage();
    bindEditorEvents();

    const saveBtn = document.getElementById("btnEditorSave") as HTMLButtonElement;
    saveBtn.click();
    await Promise.resolve();

    expect(getActiveProposals().size).toBe(1);
    expect(getActiveProposals().get(seg.id)![0].id).toBe("prop-1");
  });

  it("Case O: LLM correction button in toolbar triggers correction and updates DOM", async () => {
    const doc = createSampleDocument(2);
    setEditorDocument(doc, "C:\\test.asrc.json");

    const seg0 = doc.segments[0];
    const mockProvider = {
      correct: vi.fn().mockResolvedValue([
        {
          id: "prop-ollama-1",
          segmentId: seg0.id,
          originalText: seg0.text,
          correctedText: "補正後のセグメント1テキスト",
          evidence: [{ type: "context", description: "文脈" }],
          explanation: "LLM補正",
        },
      ]),
    };
    setCorrectionProviderForTest(mockProvider as any);

    document.body.innerHTML = renderEditorPage();
    bindEditorEvents();

    expect(document.querySelectorAll(".proposal-card").length).toBe(0);

    const llmBtn = document.getElementById("btnEditorLlmCorrection") as HTMLButtonElement;
    expect(llmBtn).not.toBeNull();

    llmBtn.click();
    await Promise.resolve();

    expect(mockProvider.correct).toHaveBeenCalled();
    const proposalCards = document.querySelectorAll(".proposal-card");
    expect(proposalCards.length).toBe(1);
    expect(getActiveProposals().size).toBe(1);
    expect(getActiveProposals().get(seg0.id)![0].correctedText).toBe("補正後のセグメント1テキスト");

    setCorrectionProviderForTest(null);
  });

  it("Case Q: 11-step E2E Correction Workflow Scenario (Steps 1-11)", async () => {
    // 準備: 2セグメントの保存済みドキュメント
    const doc = createSampleDocument(2);
    setEditorDocument(doc, "C:\\test.asrc.json");

    const mockInvoke = vi.fn().mockResolvedValue(true);
    setEditorInvoke(mockInvoke);

    const current = getEditorDocument()!;
    const seg0 = current.segments[0];
    const seg1 = current.segments[1];
    const initialOrigText0 = seg0.originalText;

    const prop0A: CorrectionProposal = {
      id: "prop-0A",
      segmentId: seg0.id,
      originalText: seg0.text,
      correctedText: "セグメント0補正テキストA",
      evidence: [{ type: "dictionary", description: "辞書A" }],
      explanation: "説明A",
    };
    const prop0B: CorrectionProposal = {
      id: "prop-0B",
      segmentId: seg0.id,
      originalText: seg0.text,
      correctedText: "セグメント0補正テキストB",
      evidence: [{ type: "context" }],
      explanation: "説明B",
    };
    const prop1A: CorrectionProposal = {
      id: "prop-1A",
      segmentId: seg1.id,
      originalText: seg1.text,
      correctedText: "セグメント1補正テキストA",
      evidence: [{ type: "background" }],
      explanation: "説明1A",
    };

    const mockProvider = {
      correct: vi.fn().mockResolvedValue([prop0A, prop0B, prop1A]),
    };
    setCorrectionProviderForTest(mockProvider as any);

    document.body.innerHTML = renderEditorPage();
    bindEditorEvents();

    // Step 1: 正本エディターで「LLM補正」を押す
    const llmBtn = document.getElementById("btnEditorLlmCorrection") as HTMLButtonElement;
    llmBtn.click();
    await Promise.resolve();

    // Step 2: 提案カードが表示される
    const proposalCards = document.querySelectorAll(".proposal-card");
    expect(proposalCards.length).toBe(3);

    // Step 3: 根拠バッジと簡易diffが見える
    const badge = document.querySelector(".evidence-badge");
    const diff = document.querySelector(".proposal-diff");
    expect(badge).not.toBeNull();
    expect(diff).not.toBeNull();
    expect(diff!.innerHTML).toContain("diff-");

    // Step 4: 1件を採用する (prop-0A)
    const applyBtn0A = document.querySelector<HTMLButtonElement>(`button.btn-apply-proposal[data-proposal-id="prop-0A"]`)!;
    applyBtn0A.click();

    // Step 5: segment.textが変わり、そのセグメントがedited
    expect(seg0.text).toBe("セグメント0補正テキストA");
    expect(seg0.originalText).toBe(initialOrigText0);
    expect(seg0.status).toBe("edited");

    // Step 6: 全体が未保存になる
    expect(isEditorDirty()).toBe(true);
    expect(document.getElementById("editorStatusContainer")?.textContent).toContain("未保存");

    // Step 7: 同一セグメントの他proposal (prop-0B) が消える
    expect(getActiveProposals().has(seg0.id)).toBe(false);
    expect(document.querySelectorAll(`[data-proposal-id="prop-0B"]`).length).toBe(0);

    // Step 8: 別のproposal (prop-1A) を却下して本文が変わらない
    const initialText1 = seg1.text;
    const rejectBtn1A = document.querySelector<HTMLButtonElement>(`button.btn-reject-proposal[data-proposal-id="prop-1A"]`)!;
    rejectBtn1A.click();
    expect(seg1.text).toBe(initialText1);
    expect(getActiveProposals().has(seg1.id)).toBe(false);

    // Step 9: proposal表示中に本文を手動編集してStale表示・採用不可になる
    const propStaleTest: CorrectionProposal = {
      id: "prop-stale-test",
      segmentId: seg1.id,
      originalText: seg1.text,
      correctedText: "新しい提案",
      evidence: [{ type: "context" }],
      explanation: "説明",
    };
    setActiveProposalsForTest(new Map([[seg1.id, [propStaleTest]]]));
    document.body.innerHTML = renderEditorPage();
    bindEditorEvents();

    const textarea1 = document.querySelectorAll<HTMLTextAreaElement>(".segment-text-input")[1];
    textarea1.value = "手動変更した文章";
    textarea1.dispatchEvent(new Event("input", { bubbles: true }));

    const staleTag = document.querySelector(".proposal-stale-tag");
    expect(staleTag).not.toBeNull();
    expect(staleTag!.textContent).toContain("Stale");

    const staleApplyBtn = document.querySelector<HTMLButtonElement>(`button.btn-apply-proposal[data-proposal-id="prop-stale-test"]`)!;
    expect(staleApplyBtn.disabled).toBe(true);
    staleApplyBtn.click();
    expect(seg1.text).toBe("手動変更した文章"); // 上書きされない

    // Step 10: 保存してもproposalが保持される
    const saveBtn = document.getElementById("btnEditorSave") as HTMLButtonElement;
    saveBtn.click();
    await Promise.resolve();
    expect(getActiveProposals().size).toBe(1);
    expect(getActiveProposals().has(seg1.id)).toBe(true);

    // Step 11: Document切替または破棄でproposalが消える
    discardEditorChanges();
    expect(getActiveProposals().size).toBe(0);

    setCorrectionProviderForTest(null);
  });

  it("Case R: Document Session Guard: 非同期実行中にDocumentが切り替わった場合、旧セッションの提案は安全に破棄される", async () => {
    const docA = createSampleDocument(2);
    setEditorDocument(docA, "C:\\docA.asrc.json");

    let resolveProvider: (proposals: CorrectionProposal[]) => void = () => {};
    const delayedProvider = {
      correct: vi.fn().mockImplementation(() => {
        return new Promise<CorrectionProposal[]>((resolve) => {
          resolveProvider = resolve;
        });
      }),
    };
    setCorrectionProviderForTest(delayedProvider as any);

    document.body.innerHTML = renderEditorPage();
    bindEditorEvents();

    // 非同期補正リクエストを開始（docA）
    const initialSession = getEditorDocumentSessionId();
    const correctionPromise = runLlmCorrection();

    // 途中でユーザーが別のドキュメント docB をロード
    const docB = createSampleDocument(3);
    setEditorDocument(docB, "C:\\docB.asrc.json");
    expect(getEditorDocumentSessionId()).toBeGreaterThan(initialSession);

    // 旧 docA のプロポーザルが遅れて到着
    resolveProvider([
      {
        id: "prop-delayed-docA",
        segmentId: docA.segments[0].id,
        originalText: docA.segments[0].text,
        correctedText: "遅延到着テキスト",
        evidence: [{ type: "context" }],
        explanation: "旧ドキュメント用提案",
      },
    ]);

    await correctionPromise;

    // 現在の activeProposals に旧ドキュメントの提案が混入していないことを検証
    expect(getActiveProposals().size).toBe(0);

    setCorrectionProviderForTest(null);
  });

  it("Case S: Logical Cancellation: ユーザーがキャンセルした場合、後続処理を中断し結果を破棄する", async () => {
    const doc = createSampleDocument(2);
    setEditorDocument(doc, "C:\\test.asrc.json");

    let resolveProvider: (proposals: CorrectionProposal[]) => void = () => {};
    const delayedProvider = {
      correct: vi.fn().mockImplementation(() => {
        return new Promise<CorrectionProposal[]>((resolve) => {
          resolveProvider = resolve;
        });
      }),
    };
    setCorrectionProviderForTest(delayedProvider as any);

    document.body.innerHTML = renderEditorPage();
    bindEditorEvents();

    const correctionPromise = runLlmCorrection();

    const cancelBtn = document.getElementById("btnEditorCancelCorrection") as HTMLButtonElement;
    expect(cancelBtn.style.display).toBe("inline-flex");

    // キャンセルボタンをクリック
    cancelBtn.click();
    expect(cancelBtn.style.display).toBe("none");

    // その後プロバイダーが結果を返しても破棄される
    resolveProvider([
      {
        id: "prop-cancelled",
        segmentId: doc.segments[0].id,
        originalText: doc.segments[0].text,
        correctedText: "キャンセル後テキスト",
        evidence: [{ type: "context" }],
        explanation: "キャンセル後",
      },
    ]);

    await correctionPromise;
    expect(getActiveProposals().size).toBe(0);

    setCorrectionProviderForTest(null);
  });

  it("Case T: Error Boundary: プロバイダーがエラーを投げても既存の activeProposals は保持される", async () => {
    const doc = createSampleDocument(2);
    setEditorDocument(doc, "C:\\test.asrc.json");

    const seg0 = doc.segments[0];
    const existingProp: CorrectionProposal = {
      id: "prop-existing",
      segmentId: seg0.id,
      originalText: seg0.text,
      correctedText: "既存の有効提案",
      evidence: [{ type: "dictionary" }],
      explanation: "既存提案",
    };
    setActiveProposalsForTest(new Map([[seg0.id, [existingProp]]]));

    const dialogSpy = vi.spyOn(statusModule, "showAppDialog").mockResolvedValue();

    const failingProvider = {
      correct: vi.fn().mockRejectedValue(new Error("Ollama connection refused (HTTP 500)")),
    };
    setCorrectionProviderForTest(failingProvider as any);

    document.body.innerHTML = renderEditorPage();
    bindEditorEvents();

    await runLlmCorrection();

    // エラーダイアログが表示される
    expect(dialogSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "LLM補正エラー",
        type: "error",
      })
    );

    // 既存の提案は消去されずに保持される
    expect(getActiveProposals().size).toBe(1);
    expect(getActiveProposals().get(seg0.id)![0].id).toBe("prop-existing");

    setCorrectionProviderForTest(null);
  });

  it("Case U: Ollama Settings Connection & Model Presence Validation", async () => {
    const doc = createSampleDocument(2);
    setEditorDocument(doc, "C:\\test.asrc.json");

    const dialogSpy = vi.spyOn(statusModule, "showAppDialog").mockResolvedValue();

    // 1. モデル未設定の場合 -> 実行中止 & ダイアログ表示
    setEditorInvoke((async <T>(cmd: string): Promise<T> => {
      if (cmd === "load_api_settings") {
        return { providers: { ollama: { base_url: "http://localhost:11434", default_model: "" } } } as unknown as T;
      }
      throw new Error(`Unexpected command: ${cmd}`);
    }));

    document.body.innerHTML = renderEditorPage();
    bindEditorEvents();

    await runLlmCorrection();
    expect(dialogSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Ollamaモデル未設定",
        type: "info",
      })
    );

    // 2. モデル設定済みの場合 -> call_ollama_chat に渡る
    let capturedChatInput: any = null;
    setEditorInvoke((async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
      if (cmd === "load_api_settings") {
        return {
          providers: {
            ollama: {
              base_url: "http://192.168.1.50:11434",
              default_model: "my-custom-qwen:9b",
            },
          },
        } as unknown as T;
      }
      if (cmd === "call_ollama_chat") {
        capturedChatInput = args;
        return {
          message: {
            role: "assistant",
            content: JSON.stringify({ proposals: [] }),
          },
        } as unknown as T;
      }
      throw new Error(`Unexpected command: ${cmd}`);
    }));

    await runLlmCorrection();
    expect(capturedChatInput).not.toBeNull();
    expect(capturedChatInput.input).toBeDefined();
    expect(capturedChatInput.input.baseUrl).toBe("http://192.168.1.50:11434");
    expect(capturedChatInput.input.model).toBe("my-custom-qwen:9b");
  });

  it("Case V: Transactional Replace: 成功した新RunのProposal集合でactiveProposalsを完全置換する", async () => {
    const doc = createSampleDocument(2);
    setEditorDocument(doc, "C:\\test.asrc.json");

    const seg0 = doc.segments[0];
    const oldProp: CorrectionProposal = {
      id: "prop-old",
      segmentId: seg0.id,
      originalText: seg0.text,
      correctedText: "旧バージョンの補正候補",
      evidence: [{ type: "context" }],
      explanation: "旧",
    };
    setActiveProposalsForTest(new Map([[seg0.id, [oldProp]]]));
    expect(getActiveProposals().get(seg0.id)![0].id).toBe("prop-old");

    const newProp: CorrectionProposal = {
      id: "prop-new",
      segmentId: seg0.id,
      originalText: seg0.text,
      correctedText: "新バージョンの補正候補",
      evidence: [{ type: "dictionary" }],
      explanation: "新",
    };

    const mockProvider = {
      correct: vi.fn().mockResolvedValue([newProp]),
    };
    setCorrectionProviderForTest(mockProvider as any);

    document.body.innerHTML = renderEditorPage();
    bindEditorEvents();

    await runLlmCorrection();

    // 古い提案はマージされず、新しい提案セットだけで完全に置換されている
    expect(getActiveProposals().size).toBe(1);
    const props = getActiveProposals().get(seg0.id)!;
    expect(props).toHaveLength(1);
    expect(props[0].id).toBe("prop-new");
    expect(props[0].correctedText).toBe("新バージョンの補正候補");

    setCorrectionProviderForTest(null);
  });

  it("Case W: Run Generation UI Guard: Run A キャンセル直後に Run B が開始された場合、遅れて完了した Run A の finally が Run B の UI を壊さない", async () => {
    const doc = createSampleDocument(2);
    setEditorDocument(doc, "C:\\test.asrc.json");

    let resolveRunA: (proposals: CorrectionProposal[]) => void = () => {};
    let resolveRunB: (proposals: CorrectionProposal[]) => void = () => {};

    let callCount = 0;
    const multiRunProvider = {
      correct: vi.fn().mockImplementation(() => {
        callCount++;
        const currentCount = callCount;
        return new Promise<CorrectionProposal[]>((resolve) => {
          if (currentCount === 1) {
            resolveRunA = resolve;
          } else {
            resolveRunB = resolve;
          }
        });
      }),
    };
    setCorrectionProviderForTest(multiRunProvider as any);

    document.body.innerHTML = renderEditorPage();
    bindEditorEvents();

    const btnLlm = document.getElementById("btnEditorLlmCorrection") as HTMLButtonElement;
    const btnCancel = document.getElementById("btnEditorCancelCorrection") as HTMLButtonElement;

    // 1. Run A を開始
    const promiseA = runLlmCorrection();
    expect(btnLlm.disabled).toBe(true);
    expect(btnCancel.style.display).toBe("inline-flex");

    // 2. キャンセルをクリック
    btnCancel.click();
    expect(btnLlm.disabled).toBe(false);
    expect(btnCancel.style.display).toBe("none");

    // 3. すぐに Run B を開始
    const promiseB = runLlmCorrection();
    expect(btnLlm.disabled).toBe(true);
    expect(btnCancel.style.display).toBe("inline-flex");

    // 4. Run A が遅れて完了（resolve）
    resolveRunA([
      {
        id: "prop-run-A",
        segmentId: doc.segments[0].id,
        originalText: doc.segments[0].text,
        correctedText: "Run A の遅延提案",
        evidence: [{ type: "context" }],
        explanation: "A",
      },
    ]);
    await promiseA;

    // Run A の finally が実行された後も、実行中である Run B の UI（disabled, cancel表示）が維持されていること！
    expect(btnLlm.disabled).toBe(true);
    expect(btnCancel.style.display).toBe("inline-flex");

    // 5. Run B が正常完了
    resolveRunB([
      {
        id: "prop-run-B",
        segmentId: doc.segments[0].id,
        originalText: doc.segments[0].text,
        correctedText: "Run B の正当提案",
        evidence: [{ type: "dictionary" }],
        explanation: "B",
      },
    ]);
    await promiseB;

    // Run B 完了後は正常にアイドル状態へリセット
    expect(btnLlm.disabled).toBe(false);
    expect(btnCancel.style.display).toBe("none");
    expect(getActiveProposals().get(doc.segments[0].id)![0].id).toBe("prop-run-B");

    setCorrectionProviderForTest(null);
  });

  it("Case X: 設定読み込み待ち中の二重起動防止 (Double-invocation Guard): load_api_settings 非同期待機中の多重呼び出しを確実に拒否する", async () => {
    const doc = createSampleDocument(2);
    setEditorDocument(doc, "C:\\test.asrc.json");

    let resolveSettings: (val: any) => void = () => {};
    let callCount = 0;

    setEditorInvoke(vi.fn().mockImplementation((cmd: string) => {
      if (cmd === "load_api_settings") {
        callCount++;
        return new Promise((resolve) => {
          resolveSettings = resolve;
        });
      }
      if (cmd === "call_ollama_chat") {
        return Promise.resolve({
          message: {
            role: "assistant",
            content: JSON.stringify({ proposals: [] }),
          },
        });
      }
      throw new Error(`Unexpected command: ${cmd}`);
    }));

    document.body.innerHTML = renderEditorPage();
    bindEditorEvents();

    const btnLlm = document.getElementById("btnEditorLlmCorrection") as HTMLButtonElement;
    const btnCancel = document.getElementById("btnEditorCancelCorrection") as HTMLButtonElement;

    // 1. 初回呼び出し開始（設定読み込み待ち）
    const p1 = runLlmCorrection();
    expect(btnLlm.disabled).toBe(true);
    expect(btnCancel.style.display).toBe("inline-flex");
    expect(callCount).toBe(1);

    // 2. 設定読み込み待ち中に二重呼び出し
    const p2 = runLlmCorrection();
    expect(callCount).toBe(1); // 2回目の load_api_settings は呼ばれない

    // 3. 設定を解決して完了させる
    resolveSettings({
      providers: {
        ollama: {
          base_url: "http://localhost:11434",
          default_model: "qwen2.5:7b",
        },
      },
    });

    await p1;
    await p2;

    expect(btnLlm.disabled).toBe(false);
    expect(btnCancel.style.display).toBe("none");
  });

  it("Case Y: 設定読み込み待ち中のドキュメント切替: load_api_settings 待機中に別Docへ切り替わった場合、応答は破棄され新Docを汚染しない", async () => {
    const docA = createSampleDocument(2);
    const docB = createSampleDocument(2);
    docB.segments[0].id = "seg-doc-b-001";
    docB.segments[0].text = "ドキュメントBのテキスト";
    setEditorDocument(docA, "C:\\docA.asrc.json");

    let resolveSettings: (val: any) => void = () => {};
    let ollamaChatCalled = false;

    setEditorInvoke(vi.fn().mockImplementation((cmd: string) => {
      if (cmd === "load_api_settings") {
        return new Promise((resolve) => {
          resolveSettings = resolve;
        });
      }
      if (cmd === "call_ollama_chat") {
        ollamaChatCalled = true;
        return Promise.resolve({
          message: {
            role: "assistant",
            content: JSON.stringify({
              proposals: [
                {
                  segmentId: docA.segments[0].id,
                  originalText: docA.segments[0].text,
                  correctedText: "ドキュメントAの補正提案",
                  evidence: [{ type: "context" }],
                  explanation: "test",
                },
              ],
            }),
          },
        });
      }
      throw new Error(`Unexpected command: ${cmd}`);
    }));

    document.body.innerHTML = renderEditorPage();
    bindEditorEvents();

    // 1. Doc A で補正開始
    const p1 = runLlmCorrection();

    // 2. 設定読み込み待機中に Doc B へ切替
    setEditorDocument(docB, "C:\\docB.asrc.json");

    // 3. 設定読み込みが完了
    resolveSettings({
      providers: {
        ollama: {
          base_url: "http://localhost:11434",
          default_model: "qwen2.5:7b",
        },
      },
    });

    await p1;

    // Doc B の提案は空のままで、Provider も呼び出されない
    expect(ollamaChatCalled).toBe(false);
    expect(getActiveProposals().size).toBe(0);
  });

  it("Case Z: 実行中ドキュメント切替時のUIリセット: 補正実行中に setEditorDocument が呼ばれた場合、UIが即座にアイドル状態へ戻る", async () => {
    const docA = createSampleDocument(2);
    const docB = createSampleDocument(2);
    setEditorDocument(docA, "C:\\docA.asrc.json");

    let resolveProvider: (proposals: CorrectionProposal[]) => void = () => {};
    const deferredProvider = {
      correct: vi.fn().mockImplementation(() => {
        return new Promise<CorrectionProposal[]>((resolve) => {
          resolveProvider = resolve;
        });
      }),
    };
    setCorrectionProviderForTest(deferredProvider as any);

    document.body.innerHTML = renderEditorPage();
    bindEditorEvents();

    const btnLlm = document.getElementById("btnEditorLlmCorrection") as HTMLButtonElement;
    const btnCancel = document.getElementById("btnEditorCancelCorrection") as HTMLButtonElement;

    // 1. 補正開始
    const p1 = runLlmCorrection();
    expect(btnLlm.disabled).toBe(true);
    expect(btnCancel.style.display).toBe("inline-flex");

    // 2. 実行中に setEditorDocument で別ファイルを開く
    setEditorDocument(docB, "C:\\docB.asrc.json");

    // UI が即座にリセットされていること
    expect(btnLlm.disabled).toBe(false);
    expect(btnCancel.style.display).toBe("none");

    // 3. 旧プロバイダーが後から解決しても何もしない
    resolveProvider([
      {
        id: "prop-stale",
        segmentId: docA.segments[0].id,
        originalText: docA.segments[0].text,
        correctedText: "遅延提案",
        evidence: [{ type: "context" }],
        explanation: "stale",
      },
    ]);
    await p1;

    expect(getActiveProposals().size).toBe(0);
    setCorrectionProviderForTest(null);
  });

  it("Case AA: 実行中未保存変更破棄 (discardEditorChanges): 補正実行中に破棄された場合、UIが即座にリセットされ提案もクリアされる", async () => {
    const doc = createSampleDocument(2);
    setEditorDocument(doc, "C:\\test.asrc.json");

    // セグメントを変更して dirty にする
    doc.segments[0].text = "編集後のテキスト";

    let resolveProvider: (proposals: CorrectionProposal[]) => void = () => {};
    const deferredProvider = {
      correct: vi.fn().mockImplementation(() => {
        return new Promise<CorrectionProposal[]>((resolve) => {
          resolveProvider = resolve;
        });
      }),
    };
    setCorrectionProviderForTest(deferredProvider as any);

    document.body.innerHTML = renderEditorPage();
    bindEditorEvents();

    const btnLlm = document.getElementById("btnEditorLlmCorrection") as HTMLButtonElement;
    const btnCancel = document.getElementById("btnEditorCancelCorrection") as HTMLButtonElement;

    // 1. 補正開始
    const p1 = runLlmCorrection();
    expect(btnLlm.disabled).toBe(true);
    expect(btnCancel.style.display).toBe("inline-flex");

    // 2. 変更を破棄
    discardEditorChanges();

    // UI が即座にアイドルへリセットされていること
    expect(btnLlm.disabled).toBe(false);
    expect(btnCancel.style.display).toBe("none");

    resolveProvider([]);
    await p1;

    expect(getActiveProposals().size).toBe(0);
    setCorrectionProviderForTest(null);
  });

  it("Case AB: エラー時の既存Proposal保持 (Transactional Replace): 補正処理中にエラーが発生した場合、既存のactiveProposalsが100%保持される", async () => {
    const doc = createSampleDocument(2);
    setEditorDocument(doc, "C:\\test.asrc.json");

    const seg0 = doc.segments[0];
    const existingProp: CorrectionProposal = {
      id: "prop-existing-1",
      segmentId: seg0.id,
      originalText: seg0.text,
      correctedText: "既存の補正提案",
      evidence: [{ type: "context" }],
      explanation: "既存",
    };
    setActiveProposalsForTest(new Map([[seg0.id, [existingProp]]]));

    const failingProvider = {
      correct: vi.fn().mockRejectedValue(new Error("Ollama connection failed (HTTP 500)")),
    };
    setCorrectionProviderForTest(failingProvider as any);

    const dialogSpy = vi.spyOn(statusModule, "showAppDialog").mockResolvedValue();

    document.body.innerHTML = renderEditorPage();
    bindEditorEvents();

    await runLlmCorrection();

    // エラーダイアログが表示されたこと
    expect(dialogSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "LLM補正エラー",
        type: "error",
      })
    );

    // 既存の提案が削除・置換されずに完全に保持されていること
    expect(getActiveProposals().size).toBe(1);
    const props = getActiveProposals().get(seg0.id)!;
    expect(props[0].id).toBe("prop-existing-1");
    expect(props[0].correctedText).toBe("既存の補正提案");

    setCorrectionProviderForTest(null);
  });

  it("Case AC: キャンセル時の既存Proposal保持 (Transactional Replace): 補正実行を途中でキャンセルした場合、既存のactiveProposalsが100%保持される", async () => {
    const doc = createSampleDocument(2);
    setEditorDocument(doc, "C:\\test.asrc.json");

    const seg0 = doc.segments[0];
    const existingProp: CorrectionProposal = {
      id: "prop-existing-1",
      segmentId: seg0.id,
      originalText: seg0.text,
      correctedText: "既存の補正提案",
      evidence: [{ type: "context" }],
      explanation: "既存",
    };
    setActiveProposalsForTest(new Map([[seg0.id, [existingProp]]]));

    let resolveProvider: (proposals: CorrectionProposal[]) => void = () => {};
    const deferredProvider = {
      correct: vi.fn().mockImplementation(() => {
        return new Promise<CorrectionProposal[]>((resolve) => {
          resolveProvider = resolve;
        });
      }),
    };
    setCorrectionProviderForTest(deferredProvider as any);

    document.body.innerHTML = renderEditorPage();
    bindEditorEvents();

    const btnCancel = document.getElementById("btnEditorCancelCorrection") as HTMLButtonElement;

    // 1. 補正開始
    const p1 = runLlmCorrection();

    // 2. キャンセル実行
    btnCancel.click();

    // 3. プロバイダーが遅れて完了
    resolveProvider([
      {
        id: "prop-new-discarded",
        segmentId: seg0.id,
        originalText: seg0.text,
        correctedText: "破棄されるべき新提案",
        evidence: [{ type: "dictionary" }],
        explanation: "new",
      },
    ]);
    await p1;

    // キャンセルされたため、既存提案がそのまま残っていること
    expect(getActiveProposals().size).toBe(1);
    const props = getActiveProposals().get(seg0.id)!;
    expect(props[0].id).toBe("prop-existing-1");
    expect(props[0].correctedText).toBe("既存の補正提案");

    setCorrectionProviderForTest(null);
  });

  it("cancelActiveCorrectionRunAndResetUi: 呼び出し時に実行IDを0にし、UI要素をアイドル状態に復元する", () => {
    document.body.innerHTML = `
      <button id="btnEditorLlmCorrection" disabled>補正中...</button>
      <button id="btnEditorCancelCorrection" style="display: inline-flex;">キャンセル</button>
    `;

    cancelActiveCorrectionRunAndResetUi();

    const btnLlm = document.getElementById("btnEditorLlmCorrection") as HTMLButtonElement;
    const btnCancel = document.getElementById("btnEditorCancelCorrection") as HTMLButtonElement;

    expect(btnLlm.disabled).toBe(false);
    expect(btnLlm.innerHTML).toContain("LLM補正");
    expect(btnCancel.style.display).toBe("none");
  });
});



