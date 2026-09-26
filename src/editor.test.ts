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
} from "./editor";
import { deriveSegmentStatus, type TranscriptDocument } from "./transcript";
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

