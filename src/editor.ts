import {
  deriveSegmentStatus,
  isDocumentDirty,
  type TranscriptDocument,
  type TranscriptSegment,
} from "./transcript";
import { showAppConfirm, showAppDialog } from "./status";
import { escapeHtml } from "./docker";
import {
  applyProposal,
  rejectProposal,
  validateProposal,
  deriveTextChanges,
  cloneTranscriptDocument,
  escapeAttr,
  runCorrectionForDocument,
  type CorrectionProposal,
  type CorrectionProvider,
  type CorrectionDictionaryEntry,
  type CorrectionContext,
} from "./correction";
import { OllamaCorrectionProvider } from "./ollama-provider";
import { resolveCorrectionProvider } from "./correction-settings";
import { loadCorrectionContext } from "./correction-context";

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
let activeProposals = new Map<string, CorrectionProposal[]>();
let editorDocumentSessionId = 0;
let correctionRunGeneration = 0;
let currentActiveRunId = 0;

interface CorrectionRunToken {
  isCancelled: boolean;
}
let activeCorrectionRun: CorrectionRunToken | null = null;
let customCorrectionProvider: CorrectionProvider | null = null;

export function getEditorDocumentSessionId(): number {
  return editorDocumentSessionId;
}

export function getCurrentActiveRunId(): number {
  return currentActiveRunId;
}

export function setCorrectionProviderForTest(provider: CorrectionProvider | null): void {
  customCorrectionProvider = provider;
}

export function cancelActiveCorrectionRunAndResetUi(): void {
  currentActiveRunId = 0;
  if (activeCorrectionRun) {
    activeCorrectionRun.isCancelled = true;
    activeCorrectionRun = null;
  }
  const btnLlm = document.getElementById("btnEditorLlmCorrection") as HTMLButtonElement | null;
  const btnCancel = document.getElementById("btnEditorCancelCorrection") as HTMLButtonElement | null;
  if (btnLlm) {
    btnLlm.disabled = false;
    btnLlm.innerHTML = `<span class="material-symbols-outlined">auto_fix_high</span> LLM補正`;
  }
  if (btnCancel) {
    btnCancel.style.display = "none";
  }
}

export function cancelActiveCorrection(): void {
  cancelActiveCorrectionRunAndResetUi();
}

export function getActiveProposals(): Map<string, CorrectionProposal[]> {
  return activeProposals;
}

export function clearActiveProposalsForTest(): void {
  activeProposals.clear();
}

export function setActiveProposalsForTest(proposals: Map<string, CorrectionProposal[]>): void {
  activeProposals = proposals;
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
  activeProposals.clear();
  editorDocumentSessionId++;
  cancelActiveCorrection();
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
 * initialProposals が渡された場合、新ドキュメントのセグメントに適合する提案のみを atomic に activeProposals へ投入する。
 */
export function setEditorDocument(
  doc: TranscriptDocument | null,
  filePath: string | null = null,
  initialProposals?: Map<string, CorrectionProposal[]> | null,
): void {
  if (doc === null) {
    activeProposals.clear();
    editorDocumentSessionId++;
    cancelActiveCorrection();
    currentDoc = null;
    savedBaselineDoc = null;
    currentFilePath = null;
    return;
  }

  const newDoc = cloneTranscriptDocument(doc);
  const newBaseline = filePath !== null ? cloneTranscriptDocument(doc) : null;
  const newProposals = new Map<string, CorrectionProposal[]>();

  if (initialProposals && initialProposals.size > 0) {
    for (const [segId, props] of initialProposals.entries()) {
      const seg = newDoc.segments.find((s) => s.id === segId);
      if (seg) {
        const validProps = props.filter((p) => validateProposal(p, seg).valid);
        if (validProps.length > 0) {
          newProposals.set(segId, cloneTranscriptDocument(validProps));
        }
      }
    }
  }

  // アトミックにエディター状態を更新
  activeProposals = newProposals;
  editorDocumentSessionId++;
  cancelActiveCorrection();
  currentDoc = newDoc;
  currentFilePath = filePath;
  savedBaselineDoc = newBaseline;
}

/**
 * ドキュメントと事前生成された補正提案をアトミックにエディターへ投入する。
 */
export function setEditorDocumentWithProposals(
  doc: TranscriptDocument,
  proposals: Map<string, CorrectionProposal[]>,
  filePath: string | null = null,
): void {
  setEditorDocument(doc, filePath, proposals);
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
          <button class="btn btn-secondary" id="btnEditorLlmCorrection" type="button" title="ローカルLLM（Ollama）による音声誤認識補正">
            <span class="material-symbols-outlined">auto_fix_high</span>
            LLM補正
          </button>
          <button class="btn btn-secondary btn-editor-cancel-correction" id="btnEditorCancelCorrection" type="button" title="補正処理をキャンセル" style="display: none;">
            <span class="material-symbols-outlined">cancel</span>
            キャンセル
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

/**
 * セグメントの補正候補ボックスをレンダリングする
 * - HTML escaping: すべてのLLM由来文字列（originalText, correctedText, explanation, evidence, diff chunks）をエスケープ
 * - Validation & Stale: 描画時に validateProposal(prop, seg) を再評価し、Stale/Warning/Invalid を判定
 */
export function renderProposalBox(seg: TranscriptSegment): string {
  const proposals = activeProposals.get(seg.id);
  if (!proposals || proposals.length === 0) return "";

  const proposalItems = proposals.map((prop) => {
    const val = validateProposal(prop, seg);
    const isStale = prop.originalText !== seg.text;
    const changes = deriveTextChanges(prop.originalText, prop.correctedText);

    const evidenceBadges = prop.evidence.map((ev) => {
      const typeLabel = ev.type === "dictionary" ? "辞書" : ev.type === "background" ? "背景" : "文脈";
      const desc = ev.description ? `: ${escapeHtml(ev.description)}` : ev.sourceId ? `: ${escapeHtml(ev.sourceId)}` : "";
      return `<span class="evidence-badge evidence-badge-${escapeAttr(ev.type)}">[${typeLabel}${desc}]</span>`;
    }).join(" ");

    const diffHtml = changes.length > 0
      ? changes.map((ch) => {
          const delPart = ch.from ? `<del class="diff-del">${escapeHtml(ch.from)}</del>` : "";
          const insPart = ch.to ? `<ins class="diff-ins">${escapeHtml(ch.to)}</ins>` : "";
          return `<span class="diff-chunk">${delPart} &rarr; ${insPart}</span>`;
        }).join(" ")
      : `<span class="diff-chunk">&rarr; <ins class="diff-ins">${escapeHtml(prop.correctedText)}</ins></span>`;

    const warningBadges = val.warnings.map((w) => {
      const label = w === "LARGE_CHANGE" ? "⚠️ 変更大" : "⚠️ 曖昧な置換";
      return `<span class="proposal-warning-tag">${label}</span>`;
    }).join(" ");

    const explanationHtml = prop.explanation
      ? `<div class="proposal-explanation">${escapeHtml(prop.explanation)}</div>`
      : "";

    const staleHtml = isStale
      ? `<div class="proposal-stale-tag">⚠️ 本文が変更されたため無効 (Stale)</div>`
      : "";

    const applyDisabled = isStale || !val.valid ? "disabled" : "";

    return `
      <div class="proposal-card" data-proposal-id="${escapeAttr(prop.id)}">
        <div class="proposal-header">
          <div class="proposal-badges">
            ${evidenceBadges}
            ${warningBadges}
          </div>
          <div class="proposal-actions">
            <button class="btn btn-sm btn-primary btn-apply-proposal" type="button" data-proposal-id="${escapeAttr(prop.id)}" data-segment-id="${escapeAttr(seg.id)}" ${applyDisabled}>採用</button>
            <button class="btn btn-sm btn-secondary btn-reject-proposal" type="button" data-proposal-id="${escapeAttr(prop.id)}" data-segment-id="${escapeAttr(seg.id)}">却下</button>
          </div>
        </div>
        <div class="proposal-diff">
          ${diffHtml}
        </div>
        ${explanationHtml}
        ${staleHtml}
      </div>
    `;
  }).join("");

  return `
    <div class="segment-proposals-container">
      <div class="segment-proposals-header">
        <span class="material-symbols-outlined proposal-icon">tips_and_updates</span>
        <span class="proposal-header-title">補正候補 (${proposals.length}件)</span>
      </div>
      <div class="segment-proposals-list">
        ${proposalItems}
      </div>
    </div>
  `;
}

function refreshSegmentCardProposal(card: HTMLElement, seg: TranscriptSegment): void {
  const container = card.querySelector<HTMLElement>(".segment-proposals-container");
  const newHtml = renderProposalBox(seg);
  if (container) {
    if (newHtml) {
      container.outerHTML = newHtml;
    } else {
      container.remove();
    }
  } else if (newHtml) {
    card.querySelector(".segment-card-body")?.insertAdjacentHTML("beforeend", newHtml);
  }
}

export function renderSegmentsList(): void {
  const list = document.getElementById("editorSegmentsList");
  if (!list || !currentDoc) return;
  list.innerHTML = currentDoc.segments
    .map((seg, idx) => renderSegmentCard(seg, idx))
    .join("");
}

export function generateMockFixturesForDoc(doc: TranscriptDocument): CorrectionProposal[] {
  const fixtures: CorrectionProposal[] = [];
  if (doc.segments.length > 0) {
    const s0 = doc.segments[0];
    const text0 = s0.text;
    const corrected0 = text0.includes("です")
      ? text0.replace(/です/g, "でございます")
      : `${text0}（確認済）`;

    fixtures.push({
      id: `prop-${s0.id}-1`,
      segmentId: s0.id,
      originalText: text0,
      correctedText: corrected0,
      evidence: [
        { type: "dictionary", sourceId: "dict-sample", description: "標準敬語辞書" },
        { type: "context", description: "文末敬体の一貫性" },
      ],
      explanation: "丁寧表現および文脈に基づく補正候補（モック）",
      confidence: 0.95,
    });

    if (doc.segments.length > 1) {
      const s1 = doc.segments[1];
      const text1 = s1.text;
      fixtures.push({
        id: `prop-${s1.id}-1`,
        segmentId: s1.id,
        originalText: text1,
        correctedText: `${text1}（背景補正）`,
        evidence: [
          { type: "background", description: "面接概要資料" },
        ],
        explanation: "背景情報に基づく補正候補（モック）",
        confidence: 0.88,
      });
    }
  }
  return fixtures;
}

/**
 * LLM（Ollama）による補正処理を実行する
 */
export async function runLlmCorrection(): Promise<void> {
  if (!currentDoc || currentDoc.segments.length === 0) {
    await showAppDialog({
      title: "情報",
      message: "補正対象のセグメントがありません。",
      type: "info",
    });
    return;
  }

  if (currentActiveRunId !== 0) {
    return; // 既に実行中
  }

  // 1. Run ID・Session ID の即時確保と実行中登録
  const runId = ++correctionRunGeneration;
  const requestSessionId = editorDocumentSessionId;
  currentActiveRunId = runId;

  const runToken: CorrectionRunToken = { isCancelled: false };
  activeCorrectionRun = runToken;

  const isCancelled = () =>
    runId !== currentActiveRunId ||
    requestSessionId !== editorDocumentSessionId ||
    runToken.isCancelled;

  // 2. UI を即座に「補正中」状態へ移行
  const btnLlm = document.getElementById("btnEditorLlmCorrection") as HTMLButtonElement | null;
  const btnCancel = document.getElementById("btnEditorCancelCorrection") as HTMLButtonElement | null;

  if (btnLlm) {
    btnLlm.disabled = true;
    btnLlm.innerHTML = `<span class="material-symbols-outlined">sync</span> 補正中...`;
  }
  if (btnCancel) {
    btnCancel.style.display = "inline-flex";
  }

  try {
    // 3. 設定読み込み（Ollama設定・correction設定のsource of truthを一本化）
    let provider: CorrectionProvider;
    let dictionary: CorrectionDictionaryEntry[] | undefined;
    let context: CorrectionContext | undefined;

    if (customCorrectionProvider) {
      provider = customCorrectionProvider;
    } else {
      const resolved = await resolveCorrectionProvider(invokeFn || invokeTauri);

      if (isCancelled()) {
        return;
      }

      if (!resolved || !resolved.model) {
        await showAppDialog({
          title: "Ollamaモデル未設定",
          message: "Ollamaのモデルが選択されていません。設定画面でモデルを選択してください。",
          type: "info",
        });
        return;
      }

      provider = new OllamaCorrectionProvider({
        baseUrl: resolved.baseUrl,
        model: resolved.model,
        invokeTauri: invokeFn || undefined,
        isCancelled,
      });

      if (isCancelled()) {
        return;
      }

      const contextRes = await loadCorrectionContext({
        useDictionary: resolved.useDictionary,
        useBackground: resolved.useBackground,
        invokeFn: invokeFn || undefined,
      });

      if (isCancelled()) {
        return;
      }

      if (contextRes.status !== "success") {
        await showAppDialog({
          title: contextRes.status === "dictionary_syntax_error" ? "辞書ファイル形式エラー" : "コンテキスト読み込みエラー",
          message: contextRes.message,
          type: "error",
        });
        return;
      }

      dictionary = contextRes.dictionary;
      context = contextRes.context;
      if (contextRes.warnings.length > 0) {
        console.warn("Editor correction context warnings:", contextRes.warnings);
      }
    }

    if (isCancelled()) {
      return;
    }

    const result = await runCorrectionForDocument(
      {
        document: currentDoc,
        provider,
        dictionary,
        context,
        isCancelled,
        onProgress: (completed, total) => {
          if (isCancelled()) return;
          if (btnLlm && runId === currentActiveRunId) {
            btnLlm.innerHTML = `<span class="material-symbols-outlined">sync</span> 補正中 (${completed}/${total})...`;
          }
        },
      },
      (nextProposals) => {
        // 早期キャンセルまたはセッション不一致の確認
        if (isCancelled() || !currentDoc) {
          return; // 破棄（activeProposals は一切変更しない）
        }

        // Transactional Replace: 新提案セットで完全置換
        activeProposals = nextProposals;
        renderSegmentsList();
      },
    );

    if (result.status === "cancelled") {
      return;
    }
  } catch (err: unknown) {
    if (isCancelled()) {
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    await showAppDialog({
      title: "LLM補正エラー",
      message: `補正処理中にエラーが発生しました。\n${msg}`,
      type: "error",
    });
    // ※ 失敗時は既存の activeProposals を 100% 保持
  } finally {
    if (runId === currentActiveRunId) {
      cancelActiveCorrectionRunAndResetUi();
    }
  }
}

function renderSegmentCard(seg: TranscriptSegment, index: number): string {
  const timeRange = `${formatTimestamp(seg.start)} - ${formatTimestamp(seg.end)}`;
  const statusLabel = seg.status === "edited" ? "編集済" : "原文";
  const statusClass = seg.status === "edited" ? "segment-status-edited" : "segment-status-raw";
  const proposalsHtml = renderProposalBox(seg);

  const speakerRowHtml =
    seg.speaker !== null
      ? `
        <div class="segment-speaker-row">
          <label class="segment-field-label">話者</label>
          <input
            type="text"
            class="segment-speaker-input"
            value="${escapeAttr(seg.speaker)}"
            placeholder="話者名（例: SPEAKER_00）"
            data-field="speaker"
          />
        </div>`
      : "";

  return `
    <div class="segment-card" data-index="${index}" data-segment-id="${escapeAttr(seg.id)}">
      <div class="segment-card-header">
        <div class="segment-time-wrap">
          <span class="material-symbols-outlined segment-time-icon">schedule</span>
          <span class="segment-time-text">${timeRange}</span>
          <span class="segment-id-tag">${escapeHtml(seg.id)}</span>
        </div>
        <div class="segment-status-wrap">
          <span class="segment-status-badge ${statusClass}" data-segment-status>${statusLabel}</span>
        </div>
      </div>
      <div class="segment-card-body">
        ${speakerRowHtml}
        <div class="segment-text-row">
          <label class="segment-field-label">正本文</label>
          <textarea
            class="segment-text-input"
            rows="2"
            placeholder="文字起こしテキスト"
            data-field="text"
          >${escapeHtml(seg.text)}</textarea>
        </div>
        ${proposalsHtml}
      </div>
    </div>
  `;
}

/**
 * エディター画面のイベントリスナーをバインドする
 */
export function bindEditorEvents(onNavigate?: (page: any) => Promise<unknown>): void {
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

      // 補正候補の Stale 判定とボタン状態を更新
      refreshSegmentCardProposal(card, seg);

      // ドキュメントのDirtyバッジ更新
      updateDirtyBadge();
    });

    // 補正候補の採用・却下クリック
    list.addEventListener("click", async (event) => {
      const target = event.target as HTMLElement;
      const applyBtn = target.closest<HTMLElement>(".btn-apply-proposal");
      if (applyBtn && currentDoc) {
        const proposalId = applyBtn.dataset.proposalId;
        const segmentId = applyBtn.dataset.segmentId;
        if (!proposalId || !segmentId) return;

        const proposals = activeProposals.get(segmentId);
        const prop = proposals?.find((p) => p.id === proposalId);
        if (prop) {
          const res = applyProposal(prop, currentDoc, activeProposals);
          if (res.ok) {
            renderSegmentsList();
            updateDirtyBadge();
          } else {
            await showAppDialog({
              title: "採用不可",
              message: `補正候補を採用できませんでした: ${res.error}`,
              type: "error",
            });
          }
        }
        return;
      }

      const rejectBtn = target.closest<HTMLElement>(".btn-reject-proposal");
      if (rejectBtn) {
        const proposalId = rejectBtn.dataset.proposalId;
        const segmentId = rejectBtn.dataset.segmentId;
        if (!proposalId || !segmentId) return;

        rejectProposal(proposalId, segmentId, activeProposals);
        renderSegmentsList();
        return;
      }
    });
  }

  // LLM補正ボタン
  document.getElementById("btnEditorLlmCorrection")?.addEventListener("click", async () => {
    await runLlmCorrection();
  });

  // キャンセルボタン
  document.getElementById("btnEditorCancelCorrection")?.addEventListener("click", () => {
    cancelActiveCorrectionRunAndResetUi();
  });

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
 * エディターUIを現在の currentDoc で明示的に再描画し、イベントリスナーを再バインドする
 */
export function renderEditor(onNavigate?: (page: any) => Promise<unknown>): void {
  const pageContainer = document.getElementById("page-editor");
  if (pageContainer) {
    const editorEl = pageContainer.querySelector(".editor-container, .editor-empty-state");
    if (editorEl) {
      editorEl.outerHTML = renderEditorPage();
    } else {
      pageContainer.innerHTML = renderEditorPage();
    }
    bindEditorEvents(onNavigate);
    return;
  }
  const editorEl = document.querySelector(".editor-container, .editor-empty-state");
  if (editorEl) {
    editorEl.outerHTML = renderEditorPage();
    bindEditorEvents(onNavigate);
  }
}

/**
 * 既存の .asrc.json を開く
 */
export async function handleOpenFile(onNavigate?: (page: any) => Promise<unknown>): Promise<void> {
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
    renderEditor(onNavigate);
    if (onNavigate) {
      await onNavigate("editor");
    }
  } catch (err) {
    console.error("ファイル読み込みエラー:", err);
    await showAppDialog({ title: "読み込みエラー", message: `正本ファイルの読み込みに失敗しました:\n${err}`, type: "error" });
  }
}

