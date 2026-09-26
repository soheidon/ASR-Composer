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

  it("Case O: Mock correction button in toolbar generates mock proposals and updates DOM", async () => {
    const doc = createSampleDocument(2);
    setEditorDocument(doc, "C:\\test.asrc.json");

    document.body.innerHTML = renderEditorPage();
    bindEditorEvents();

    expect(document.querySelectorAll(".proposal-card").length).toBe(0);

    const mockBtn = document.getElementById("btnEditorMockCorrection") as HTMLButtonElement;
    expect(mockBtn).not.toBeNull();

    mockBtn.click();
    await Promise.resolve();

    // 提案カードがDOMにレンダリングされる
    const proposalCards = document.querySelectorAll(".proposal-card");
    expect(proposalCards.length).toBeGreaterThan(0);
    expect(getActiveProposals().size).toBeGreaterThan(0);
  });

  it("Case Q: 11-step E2E Correction Workflow Scenario (Steps 1-11)", async () => {
    // 準備: 2セグメントの保存済みドキュメント
    const doc = createSampleDocument(2);
    setEditorDocument(doc, "C:\\test.asrc.json");

    const mockInvoke = vi.fn().mockResolvedValue(true);
    setEditorInvoke(mockInvoke);

    document.body.innerHTML = renderEditorPage();
    bindEditorEvents();

    // Step 1: 正本エディターで「補正候補テスト」を押す
    const mockBtn = document.getElementById("btnEditorMockCorrection") as HTMLButtonElement;
    mockBtn.click();
    await Promise.resolve();

    // Step 2: 提案カードが表示される
    const proposalCards = document.querySelectorAll(".proposal-card");
    expect(proposalCards.length).toBeGreaterThanOrEqual(2);

    // Step 3: 根拠バッジと簡易diffが見える
    const badge = document.querySelector(".evidence-badge");
    const diff = document.querySelector(".proposal-diff");
    expect(badge).not.toBeNull();
    expect(diff).not.toBeNull();
    expect(diff!.innerHTML).toContain("diff-");

    // セグメント0に2件の提案をセットして複数提案の挙動を検証
    const seg0 = getEditorDocument()!.segments[0];
    const seg1 = getEditorDocument()!.segments[1];
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

    setActiveProposalsForTest(new Map([
      [seg0.id, [prop0A, prop0B]],
      [seg1.id, [prop1A]],
    ]));

    document.body.innerHTML = renderEditorPage();
    bindEditorEvents();

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
  });
});


