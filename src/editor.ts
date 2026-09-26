import {
  deriveSegmentStatus,
  isDocumentDirty,
  type TranscriptDocument,
  type TranscriptSegment,
} from "./transcript";
import { showAppConfirm, showAppDialog } from "./status";
import { escapeHtml } from "./docker";

// Tauri invokeラッパー型
type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

let invokeFn: InvokeFn | null = null;

export function setEditorInvoke(fn: InvokeFn | null): void {
  invokeFn = fn;
}

async function invokeTauri<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!invokeFn) {
    throw new Error("この操作はTauriアプリ内でのみ利用できます");
  }
  return invokeFn<T>(command, args);
}

// エディター状態
let currentDoc: TranscriptDocument | null = null;
let savedBaselineDoc: TranscriptDocument | null = null;
let currentFilePath: string | null = null;

function cloneTranscriptDocument<T>(doc: T): T {
  return typeof structuredClone === "function"
    ? structuredClone(doc)
    : (JSON.parse(JSON.stringify(doc)) as T);
}

export function getEditorDocument(): TranscriptDocument | null {
  return currentDoc;
}

export function getSavedBaselineDoc(): TranscriptDocument | null {
  return savedBaselineDoc;
}

export function getEditorFilePath(): string | null {
  return currentFilePath;
}

/**
 * 現在のドキュメントが最後に保存/ロードされた状態と差分があるか判定する。
 * ファイルとして保存されていない場合 (currentFilePath === null) は常に true (未保存)。
 */
export function isEditorDirty(): boolean {
  if (!currentDoc) return false;
  if (currentFilePath === null || savedBaselineDoc === null) {
    return true;
  }
  return isDocumentDirty(currentDoc, savedBaselineDoc);
}

/**
 * 未保存の変更がある場合に破棄確認ダイアログを表示する共通ガード。
 * 変更がない場合、またはユーザーが破棄を承認した場合は true を返す。
 */
export async function confirmDiscardChanges(): Promise<boolean> {
  if (!isEditorDirty()) {
    return true;
  }
  return showAppConfirm({
    title: "未保存の確認",
    message: "保存されていない変更があります。変更を破棄して続行しますか？",
    confirmText: "破棄する",
    cancelText: "キャンセル",
    variant: "danger",
  });
}

/**
 * メモリ上の未保存変更を破棄し、クリーンな状態へ復元する。
 * - 保存済みファイル: savedBaselineDoc のクローンへ復元（isDirty = false）
 * - 未保存の新規作成: エディター状態をすべて null へリセット（isDirty = false）
 */
export function discardEditorChanges(): void {
  if (currentFilePath !== null && savedBaselineDoc !== null) {
    currentDoc = cloneTranscriptDocument(savedBaselineDoc);
  } else {
    currentDoc = null;
    savedBaselineDoc = null;
    currentFilePath = null;
  }
}

/**
 * 新しいドキュメントをエディターにロードする。
 * 入力Documentは独立してディープクローンされ、参照共有を防止する。
 * filePath が null の場合は新規作成（未保存状態）、
 * filePath がある場合はディスクから読み込まれた保存済み状態とする。
 */
export function setEditorDocument(doc: TranscriptDocument | null, filePath: string | null = null): void {
  if (doc === null) {
    currentDoc = null;
    savedBaselineDoc = null;
    currentFilePath = null;
    return;
  }
  currentDoc = cloneTranscriptDocument(doc);
  currentFilePath = filePath;
  savedBaselineDoc = filePath !== null ? cloneTranscriptDocument(doc) : null;
}

/**
 * 秒数を HH:MM:SS.mmm 形式に変換
 */
export function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const sStr = s.toFixed(3).padStart(6, "0");
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${sStr}`;
}

/**
 * 正本エディターページのHTMLをレンダリングする
 */
export function renderEditorPage(): string {
  if (!currentDoc) {
    return `
      <div class="editor-empty-state">
        <span class="material-symbols-outlined editor-empty-icon">edit_document</span>
        <h2>正本データがありません</h2>
        <p>文字起こしを実行するか、既存の <code>.asrc.json</code> ファイルを開いてください。</p>
        <div class="editor-empty-actions">
          <button class="btn btn-primary" id="btnEditorOpenFile">
            <span class="material-symbols-outlined">folder_open</span>
            .asrc.json を開く
          </button>
        </div>
      </div>
    `;
  }

  const dirty = isEditorDirty();
  const dirtyBadge = dirty
    ? `<span class="editor-status-badge status-dirty"><span class="status-dot status-dot-dirty"></span>未保存</span>`
    : `<span class="editor-status-badge status-saved"><span class="status-dot status-dot-saved"></span>保存済み</span>`;

  const fileName = currentDoc.mediaFileName || "新規文字起こし";
  const segmentCount = currentDoc.segments.length;

  const segmentRows = currentDoc.segments
    .map((seg, idx) => renderSegmentCard(seg, idx))
    .join("");

  return `
    <div class="editor-container">
      <!-- ツールバー -->
      <div class="editor-header-card">
        <div class="editor-header-left">
          <div class="editor-title-wrap">
            <span class="material-symbols-outlined editor-icon">edit_note</span>
            <div class="editor-title-meta">
              <h2 class="editor-filename" title="${escapeHtml(fileName)}">${escapeHtml(fileName)}</h2>
              <span class="editor-subtitle">${segmentCount} セグメント ${currentFilePath ? `(${escapeHtml(currentFilePath)})` : "(未保存ファイル)"}</span>
            </div>
          </div>
        </div>
        <div class="editor-header-right">
          <div class="editor-status-container" id="editorStatusContainer">
            ${dirtyBadge}
          </div>
          <button class="btn btn-secondary" id="btnEditorOpenFile" type="button" title="別の正本ファイルを開く">
            <span class="material-symbols-outlined">folder_open</span>
            開く
          </button>
          <button class="btn btn-secondary" id="btnEditorSaveAs" type="button" title="名前を付けて保存">
            <span class="material-symbols-outlined">save_as</span>
            名前を付けて保存
          </button>
          <button class="btn btn-primary" id="btnEditorSave" type="button" title="正本を保存 (.asrc.json)">
            <span class="material-symbols-outlined">save</span>
            保存
          </button>
        </div>
      </div>

      <!-- セグメントリスト -->
      <div class="editor-segments-list" id="editorSegmentsList">
        ${segmentRows}
      </div>
    </div>
  `;
}

function renderSegmentCard(seg: TranscriptSegment, index: number): string {
  const timeRange = `${formatTimestamp(seg.start)} - ${formatTimestamp(seg.end)}`;
  const statusLabel = seg.status === "edited" ? "編集済" : "原文";
  const statusClass = seg.status === "edited" ? "segment-status-edited" : "segment-status-raw";
  const speakerValue = seg.speaker ?? "";

  return `
    <div class="segment-card" data-index="${index}" data-segment-id="${seg.id}">
      <div class="segment-card-header">
        <div class="segment-time-wrap">
          <span class="material-symbols-outlined segment-time-icon">schedule</span>
          <span class="segment-time-text">${timeRange}</span>
          <span class="segment-id-tag">${seg.id}</span>
        </div>
        <div class="segment-status-wrap">
          <span class="segment-status-badge ${statusClass}" data-segment-status>${statusLabel}</span>
        </div>
      </div>
      <div class="segment-card-body">
        <div class="segment-speaker-row">
          <label class="segment-field-label">話者</label>
          <input
            type="text"
            class="segment-speaker-input"
            value="${escapeHtml(speakerValue)}"
            placeholder="話者名（例: SPEAKER_00）"
            data-field="speaker"
          />
        </div>
        <div class="segment-text-row">
          <label class="segment-field-label">正本文</label>
          <textarea
            class="segment-text-input"
            rows="2"
            placeholder="文字起こしテキスト"
            data-field="text"
          >${escapeHtml(seg.text)}</textarea>
        </div>
      </div>
    </div>
  `;
}

/**
 * エディター画面のイベントリスナーをバインドする
 */
export function bindEditorEvents(onNavigate?: (page: any) => Promise<void>): void {
  const list = document.getElementById("editorSegmentsList");
  if (list) {
    // セグメント編集イベントの委譲
    list.addEventListener("input", (event) => {
      const target = event.target as HTMLElement;
      const card = target.closest<HTMLElement>(".segment-card");
      if (!card || !currentDoc) return;

      const index = parseInt(card.dataset.index ?? "-1", 10);
      if (index < 0 || index >= currentDoc.segments.length) return;

      const seg = currentDoc.segments[index];
      const field = target.dataset.field;

      if (field === "speaker") {
        const val = (target as HTMLInputElement).value.trim();
        seg.speaker = val === "" ? null : val;
      } else if (field === "text") {
        seg.text = (target as HTMLTextAreaElement).value;
      }

      // status を再計算
      const newStatus = deriveSegmentStatus(seg);
      seg.status = newStatus;

      // バッジのUI更新
      const badge = card.querySelector<HTMLElement>("[data-segment-status]");
      if (badge) {
        badge.className = `segment-status-badge ${newStatus === "edited" ? "segment-status-edited" : "segment-status-raw"}`;
        badge.textContent = newStatus === "edited" ? "編集済" : "原文";
      }

      // ドキュメントのDirtyバッジ更新
      updateDirtyBadge();
    });
  }

  // 保存ボタン
  document.getElementById("btnEditorSave")?.addEventListener("click", async () => {
    await handleSave();
  });

  // 名前を付けて保存ボタン
  document.getElementById("btnEditorSaveAs")?.addEventListener("click", async () => {
    await handleSaveAs();
  });

  // 開くボタン
  document.getElementById("btnEditorOpenFile")?.addEventListener("click", async () => {
    await handleOpenFile(onNavigate);
  });
}

function updateDirtyBadge(): void {
  const container = document.getElementById("editorStatusContainer");
  if (!container) return;
  const dirty = isEditorDirty();
  container.innerHTML = dirty
    ? `<span class="editor-status-badge status-dirty"><span class="status-dot status-dot-dirty"></span>未保存</span>`
    : `<span class="editor-status-badge status-saved"><span class="status-dot status-dot-saved"></span>保存済み</span>`;
}

/**
 * 保存処理（初回はダイアログ、2回目以降は上書き）
 */
async function handleSave(): Promise<boolean> {
  if (!currentDoc) return false;

  let targetPath = currentFilePath;
  if (!targetPath) {
    targetPath = await promptSaveDialog(currentDoc.mediaFileName);
    if (!targetPath) return false;
  }

  return executeSaveDocument(targetPath);
}

/**
 * 名前を付けて保存
 */
async function handleSaveAs(): Promise<boolean> {
  if (!currentDoc) return false;

  const targetPath = await promptSaveDialog(currentDoc.mediaFileName);
  if (!targetPath) return false;

  return executeSaveDocument(targetPath);
}

async function promptSaveDialog(mediaFileName: string): Promise<string | null> {
  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const stem = mediaFileName.replace(/\.[^/.]+$/, "") || "transcript";
    const selected = await save({
      defaultPath: `${stem}.asrc.json`,
      filters: [{ name: "ASR Composer 正本", extensions: ["asrc.json", "json"] }],
    });
    return selected;
  } catch (err) {
    console.error("保存ダイアログエラー:", err);
    await showAppDialog({ title: "ダイアログエラー", message: `ファイル保存ダイアログを開けませんでした: ${err}`, type: "error" });
    return null;
  }
}

async function executeSaveDocument(path: string): Promise<boolean> {
  if (!currentDoc) return false;

  try {
    // updatedAt を更新
    currentDoc.updatedAt = new Date().toISOString();

    await invokeTauri("save_transcript_document", {
      path,
      document: currentDoc,
    });

    currentFilePath = path;
    savedBaselineDoc = cloneTranscriptDocument(currentDoc);
    updateDirtyBadge();

    // サブタイトルのパス表示更新
    const subtitle = document.querySelector<HTMLElement>(".editor-subtitle");
    if (subtitle && currentDoc) {
      subtitle.textContent = `${currentDoc.segments.length} セグメント (${path})`;
    }

    await showAppDialog({ title: "保存完了", message: "正本ファイルを保存しました。", type: "success" });
    return true;
  } catch (err) {
    console.error("保存エラー:", err);
    await showAppDialog({ title: "保存エラー", message: `保存に失敗しました:\n${err}`, type: "error" });
    return false;
  }
}

/**
 * 既存の .asrc.json を開く
 */
export async function handleOpenFile(onNavigate?: (page: any) => Promise<void>): Promise<void> {
  const canDiscard = await confirmDiscardChanges();
  if (!canDiscard) return;

  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "ASR Composer 正本", extensions: ["asrc.json", "json"] }],
    });

    if (!selected || typeof selected !== "string") {
      return;
    }

    const doc = await invokeTauri<TranscriptDocument>("load_transcript_document", {
      path: selected,
    });

    setEditorDocument(doc, selected);
    if (onNavigate) {
      await onNavigate("editor");
    }
  } catch (err) {
    console.error("ファイル読み込みエラー:", err);
    await showAppDialog({ title: "読み込みエラー", message: `正本ファイルの読み込みに失敗しました:\n${err}`, type: "error" });
  }
}
