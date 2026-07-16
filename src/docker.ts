// ---- Docker Types & Pure Functions ----

export interface DockerStatus {
  cliFound: boolean;
  cliVersion: string | null;
  daemonRunning: boolean;
  serverVersion: string | null;
  desktopFound: boolean;
  cliPath: string | null;
  desktopPath: string | null;
  errorKind: string | null;
  errorMessage: string | null;
}

export type DockerUiState = "checking" | "not-installed" | "cli-missing" | "stopped" | "ready" | "error";

export function getDockerUiState(status: DockerStatus | null): DockerUiState {
  if (!status) return "checking";
  if (!status.cliFound && !status.desktopFound) return "not-installed";
  if (!status.cliFound && status.desktopFound) return "cli-missing";
  if (!status.daemonRunning) {
    if (status.errorKind === "permission_denied") return "error";
    return "stopped";
  }
  return "ready";
}

export function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

export function renderDockerStatusContent(status: DockerStatus | null): string {
  const state = getDockerUiState(status);

  switch (state) {
    case "checking":
      return `
        <div class="docker-status-card docker-status-checking">
          <div class="docker-status-row">
            <span class="material-symbols-outlined spin" style="color: var(--color-text-secondary);">progress_activity</span>
            <span>Dockerの状態を確認しています…</span>
          </div>
        </div>`;

    case "not-installed":
      return `
        <div class="docker-status-card docker-status-error">
          <div class="docker-status-row">
            <span class="material-symbols-outlined" style="color: var(--color-error, #ef4444);">error</span>
            <span>Docker Desktopが見つかりません</span>
          </div>
          <p class="docker-status-desc">ローカルASRを使用するには、Docker Desktop for Windowsのインストールが必要です。</p>
          <ol class="docker-install-steps">
            <li>「Docker Desktop公式ページを開く」を押します</li>
            <li>Windows版のDocker Desktopをダウンロードします</li>
            <li>ダウンロードしたインストーラーを実行します</li>
            <li>インストール後、Docker Desktopを起動します</li>
            <li>この画面に戻り「状態を再確認」を押します</li>
          </ol>
          <p class="docker-install-note">※ インストール中にWindowsの確認画面や再起動の案内が表示される場合があります。</p>
          <div class="docker-status-actions">
            <button class="btn-docker-download" type="button">
              <span class="material-symbols-outlined">open_in_new</span>
              Docker Desktop公式ページを開く
            </button>
            <button class="btn-docker-refresh" type="button">
              <span class="material-symbols-outlined">refresh</span>
              状態を再確認
            </button>
          </div>
        </div>`;

    case "cli-missing":
      return `
        <div class="docker-status-card docker-status-warning">
          <div class="docker-status-row">
            <span class="material-symbols-outlined" style="color: var(--color-warning, #f59e0b);">warning</span>
            <span>Docker CLIを検出できませんでした</span>
          </div>
          <p class="docker-status-desc">Docker Desktopは見つかりましたが、Docker CLIを検出できませんでした。Docker Desktopを起動し、状態を再確認してください。</p>
          <div class="docker-status-actions">
            <button class="btn-docker-start" type="button">
              <span class="material-symbols-outlined">play_arrow</span>
              Docker Desktopを起動
            </button>
            <button class="btn-docker-refresh" type="button">
              <span class="material-symbols-outlined">refresh</span>
              状態を再確認
            </button>
          </div>
        </div>`;

    case "stopped":
      return `
        <div class="docker-status-card docker-status-warning">
          <div class="docker-status-row">
            <span class="material-symbols-outlined" style="color: var(--color-warning, #f59e0b);">warning</span>
            <span>Docker Engineは起動していません</span>
          </div>
          ${status?.errorMessage ? `<p class="docker-status-desc">${escapeHtml(status.errorMessage)}</p>` : '<p class="docker-status-desc">Docker Desktopを起動して、Docker Engineを開始してください。</p>'}
          <div class="docker-status-actions">
            <button class="btn-docker-start" type="button">
              <span class="material-symbols-outlined">play_arrow</span>
              Docker Desktopを起動
            </button>
            <button class="btn-docker-refresh" type="button">
              <span class="material-symbols-outlined">refresh</span>
              状態を再確認
            </button>
          </div>
        </div>`;

    case "ready":
      return `
        <div class="docker-status-card docker-status-ready">
          <div class="docker-status-row">
            <span class="material-symbols-outlined" style="color: var(--color-success, #22c55e);">check_circle</span>
            <span>Docker Desktopは利用可能です</span>
          </div>
          <div class="docker-status-details">
            ${status?.cliVersion ? `<p class="docker-detail-item"><strong>CLI:</strong> ${escapeHtml(status.cliVersion)}</p>` : ""}
            ${status?.serverVersion ? `<p class="docker-detail-item"><strong>Docker Engine:</strong> v${escapeHtml(status.serverVersion)}</p>` : ""}
          </div>
          <div class="docker-status-actions">
            <button class="btn-docker-refresh" type="button">
              <span class="material-symbols-outlined">refresh</span>
              状態を再確認
            </button>
          </div>
        </div>`;

    case "error":
      return `
        <div class="docker-status-card docker-status-error">
          <div class="docker-status-row">
            <span class="material-symbols-outlined" style="color: var(--color-error, #ef4444);">error</span>
            <span>状態確認中にエラーが発生しました</span>
          </div>
          ${status?.errorMessage ? `<p class="docker-status-desc">${escapeHtml(status.errorMessage)}</p>` : ""}
          <div class="docker-status-actions">
            <button class="btn-docker-refresh" type="button">
              <span class="material-symbols-outlined">refresh</span>
              状態を再確認
            </button>
          </div>
        </div>`;
  }
}

// ---- HuggingFace Token ----

export interface HuggingFaceTokenStatus {
  configured: boolean;
  maskedValue: string | null;
}

export interface HuggingFaceTokenSaveResult {
  success: boolean;
  message: string;
}

export function renderHuggingFaceTokenSection(status: HuggingFaceTokenStatus | null): string {
  if (!status || !status.configured) {
    return `
      <div class="docker-status-card">
        <div class="api-field-group">
          <label class="api-field-label">アクセストークン</label>
          <div class="hf-token-input-row">
            <div class="api-key-input-wrap">
              <input type="password" class="api-key-input hf-token-input"
                     placeholder="hf_..." autocomplete="new-password"
                     spellcheck="false" data-field="hf-token" />
              <button class="api-visibility-btn hf-token-visibility" type="button" title="表示切替">
                <span class="material-symbols-outlined">visibility</span>
              </button>
            </div>
            <button class="btn-docker-start btn-hf-token-save" type="button">
              <span class="material-symbols-outlined">save</span>
              保存
            </button>
          </div>
          <p class="hf-token-hint">環境変数: HF_TOKEN</p>
        </div>
      </div>`;
  }

  return `
    <div class="docker-status-card docker-status-ready">
      <div class="hf-token-status-row">
        <span class="material-symbols-outlined" style="color: var(--color-success, #22c55e); font-size: 18px;">check_circle</span>
        <span>HF_TOKENは設定済みです</span>
      </div>
      <div class="hf-token-detail">
        <code class="hf-token-masked">${escapeHtml(status.maskedValue ?? "設定済み")}</code>
        <span class="hf-token-env-label">環境変数: HF_TOKEN</span>
      </div>
      <div class="docker-status-actions">
        <button class="btn-docker-refresh btn-hf-token-edit" type="button">
          <span class="material-symbols-outlined">edit</span>
          トークンを変更
        </button>
        <button class="btn-docker-refresh btn-hf-token-delete" type="button">
          <span class="material-symbols-outlined">delete</span>
          削除
        </button>
      </div>
    </div>`;
}

// ---- Local ASR Engine ----

export interface LocalAsrEngineStatus {
  engine: string;
  displayName: string;
  installed: boolean;
  imageName: string;
  imageId: string | null;
  environmentVersion: string | null;
  modelName: string | null;
  dockerAvailable: boolean;
  dockerRunning: boolean;
  errorKind: string | null; // "daemon-unavailable" | "inspect-error" | null
  errorMessage: string | null;
}

export type LocalAsrUiState =
  | "loading"
  | "no-docker"
  | "docker-stopped"
  | "daemon-unavailable"
  | "inspect-error"
  | "installing"
  | "install-succeeded"
  | "install-failed"
  | "not-installed"
  | "installed";

export interface LocalAsrInstallState {
  engine: string;
  status: "installing" | "succeeded" | "failed";
  progress: number;
  message: string;
}

export interface LocalAsrProgress {
  engine: string;
  stage: string;
  message: string;
}

export function getLocalAsrUiState(
  status: LocalAsrEngineStatus | null,
  installState?: LocalAsrInstallState,
): LocalAsrUiState {
  // Docker異常は常に最優先
  if (status && !status.dockerAvailable) return "no-docker";
  if (status && !status.dockerRunning) return "docker-stopped";
  if (status?.errorKind === "daemon-unavailable") return "daemon-unavailable";
  if (status?.errorKind === "inspect-error") return "inspect-error";

  // インストール状態（loading より優先）
  if (installState?.status === "installing") return "installing";
  if (installState?.status === "succeeded") {
    return status?.installed ? "installed" : "install-succeeded";
  }
  if (installState?.status === "failed") return "install-failed";

  // 通常判定
  if (!status) return "loading";
  if (!status.installed) return "not-installed";
  return "installed";
}

export interface LocalAsrProgressDisplay {
  percent: number;
  message: string;
}

const LOCAL_ASR_STAGES: Record<string, LocalAsrProgressDisplay> = {
  "checking": { percent: 5, message: "Docker環境を確認しています" },
  "resolving-resources": { percent: 10, message: "ローカルASRファイルを確認しています" },
  "building-base-start": { percent: 15, message: "ベースイメージの構築を開始しています" },
  "installing-system-packages": { percent: 25, message: "Python・FFmpegなどをインストールしています" },
  "building-base-export": { percent: 35, message: "ベースイメージを書き出しています" },
  "building-engine-start": { percent: 40, message: "ReazonSpeech環境の構築を開始しています" },
  "installing-diar-torch": { percent: 50, message: "話者分離用PyTorchをインストールしています" },
  "installing-pyannote": { percent: 60, message: "pyannoteをインストールしています" },
  "installing-asr-torch": { percent: 67, message: "音声認識用PyTorchをインストールしています" },
  "installing-reazonspeech": { percent: 78, message: "ReazonSpeech・ESPnetをインストールしています" },
  "rebuilding-ctc": { percent: 84, message: "ctc-segmentationを再構築しています" },
  "checking-dependencies": { percent: 88, message: "依存関係を確認しています" },
  "exporting-engine-image": { percent: 94, message: "ReazonSpeechイメージを書き出しています" },
  "verifying-image": { percent: 98, message: "作成したイメージを確認しています" },
  "completed": { percent: 100, message: "インストールが完了しました" },
};

export function getLocalAsrProgressDisplay(stage: string): LocalAsrProgressDisplay {
  return LOCAL_ASR_STAGES[stage] ?? { percent: 0, message: "処理を開始しています" };
}

export type LocalAsrSectionState =
  | { kind: "loading" }
  | { kind: "docker-unavailable" }
  | { kind: "docker-stopped" }
  | { kind: "load-error"; message: string }
  | { kind: "engines"; statuses: LocalAsrEngineStatus[]; installStates?: ReadonlyMap<string, LocalAsrInstallState> };

export function renderLocalAsrSection(state: LocalAsrSectionState): string {
  switch (state.kind) {
    case "loading":
      return `
        <div class="local-asr-engine-card">
          <div class="docker-status-row">
            <span class="material-symbols-outlined spin" style="font-size: 18px; color: var(--color-text-secondary);">progress_activity</span>
            <span>状態を確認しています…</span>
          </div>
        </div>`;
    case "docker-unavailable":
      return `
        <div class="local-asr-engine-card">
          <div class="docker-status-row">
            <span class="material-symbols-outlined" style="font-size: 18px; color: var(--color-error, #ef4444);">error</span>
            <span>Dockerがインストールされていません</span>
          </div>
          <p class="docker-status-desc">ローカルASRを使用するには、Docker Desktopのインストールが必要です。上の「Docker Desktop」セクションを確認してください。</p>
          <div class="docker-status-actions">
            <button class="btn-docker-refresh" type="button" data-local-asr-refresh>
              <span class="material-symbols-outlined">refresh</span>
              状態を再確認
            </button>
          </div>
        </div>`;
    case "docker-stopped":
      return `
        <div class="local-asr-engine-card">
          <div class="docker-status-row">
            <span class="material-symbols-outlined" style="font-size: 18px; color: var(--color-warning, #f59e0b);">warning</span>
            <span>Docker Desktopが起動していません</span>
          </div>
          <p class="docker-status-desc">Docker Desktopを起動してから、状態を再確認してください。</p>
          <div class="docker-status-actions">
            <button class="btn-docker-refresh" type="button" data-local-asr-refresh>
              <span class="material-symbols-outlined">refresh</span>
              状態を再確認
            </button>
          </div>
        </div>`;
    case "load-error":
      return `
        <div class="local-asr-engine-card">
          <div class="docker-status-row">
            <span class="material-symbols-outlined" style="font-size: 18px; color: var(--color-error, #ef4444);">error</span>
            <span>${escapeHtml(state.message)}</span>
          </div>
          <div class="docker-status-actions">
            <button class="btn-docker-refresh" type="button" data-local-asr-refresh>
              <span class="material-symbols-outlined">refresh</span>
              状態を再確認
            </button>
          </div>
        </div>`;
    case "engines": {
      if (state.statuses.length === 0) {
        // ステータスが空でもactiveなinstall状態があれば描画
        if (state.installStates && state.installStates.size > 0) {
          return renderLocalAsrInstallCache([...state.installStates.values()]);
        }
        return `
          <div class="local-asr-engine-card">
            <div class="docker-status-row">
              <span class="material-symbols-outlined" style="font-size: 18px; color: var(--color-text-secondary);">info</span>
              <span>エンジンが定義されていません</span>
            </div>
          </div>`;
      }
      return state.statuses.map(e =>
        renderLocalAsrEngineCard(e, state.installStates?.get(e.engine))
      ).join("");
    }
  }
}

/** キャッシュされたinstall状態だけから最低限のカードを描画するフォールバック */
export function renderLocalAsrInstallCache(installStates: LocalAsrInstallState[]): string {
  return installStates
    .filter(s => s.status === "installing" || s.status === "succeeded")
    .map(s => `
      <div class="local-asr-engine-card">
        <div class="local-asr-engine-header">
          <span class="local-asr-engine-name">${escapeHtml(s.engine)}</span>
          <span class="local-asr-engine-desc">日本語音声認識</span>
        </div>
        <div class="local-asr-engine-status" data-install-engine-status="${escapeHtml(s.engine)}">
          ${renderLocalAsrProgressBar(s.progress, s.message)}
        </div>
      </div>`)
    .join("");
}

export function renderLocalAsrProgressBar(percent: number, message: string): string {
  return `
    <div class="local-asr-install-progress">
      <div class="local-asr-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}">
        <div class="local-asr-progress-fill" style="width: ${percent}%"></div>
      </div>
      <div class="local-asr-progress-percent">${percent}%</div>
      <div class="local-asr-progress-message">${escapeHtml(message)}</div>
    </div>`;
}

function renderLocalAsrEngineCard(e: LocalAsrEngineStatus, installState?: LocalAsrInstallState): string {
  const state = getLocalAsrUiState(e, installState);

  let statusHtml: string;
  switch (state) {
    case "loading":
      statusHtml = `
        <div class="docker-status-row">
          <span class="material-symbols-outlined spin" style="font-size: 18px; color: var(--color-text-secondary);">progress_activity</span>
          <span>状態を確認しています…</span>
        </div>`;
      break;
    case "no-docker":
      statusHtml = `
        <div class="docker-status-row">
          <span class="material-symbols-outlined" style="font-size: 18px; color: var(--color-error, #ef4444);">error</span>
          <span>Dockerがインストールされていません</span>
        </div>
        <p class="docker-status-desc">ローカルASRを使用するには、Docker Desktopのインストールが必要です。上の「Docker Desktop」セクションを確認してください。</p>
        <div class="docker-status-actions">
          <button class="btn-docker-refresh" type="button" data-local-asr-refresh>
            <span class="material-symbols-outlined">refresh</span>
            状態を再確認
          </button>
        </div>`;
      break;
    case "docker-stopped":
      statusHtml = `
        <div class="docker-status-row">
          <span class="material-symbols-outlined" style="font-size: 18px; color: var(--color-warning, #f59e0b);">warning</span>
          <span>Docker Desktopが起動していません</span>
        </div>
        <p class="docker-status-desc">Docker Desktopを起動してから、状態を再確認してください。</p>
        <div class="docker-status-actions">
          <button class="btn-docker-refresh" type="button" data-local-asr-refresh>
            <span class="material-symbols-outlined">refresh</span>
            状態を再確認
          </button>
        </div>`;
      break;
    case "installing":
      statusHtml = `
        <div class="local-asr-engine-status" data-install-engine-status="${escapeHtml(e.engine)}">
          ${renderLocalAsrProgressBar(installState?.progress ?? 0, installState?.message ?? "インストールを準備しています…")}
        </div>`;
      break;
    case "install-succeeded":
      statusHtml = `
        <div class="docker-status-row">
          <span class="material-symbols-outlined" style="font-size: 18px; color: var(--color-success, #22c55e);">check_circle</span>
          <span>インストール完了。状態を確認しています…</span>
        </div>
        <div class="docker-status-actions">
          <button class="btn-docker-refresh" type="button" data-local-asr-refresh>
            <span class="material-symbols-outlined">refresh</span>
            状態を再確認
          </button>
        </div>`;
      break;
    case "install-failed":
      statusHtml = `
        <div class="docker-status-row">
          <span class="material-symbols-outlined" style="font-size: 18px; color: var(--color-error, #ef4444);">error</span>
          <span>${escapeHtml(installState?.message ?? "インストールに失敗しました")}</span>
        </div>
        <div class="docker-status-actions">
          <button class="btn-docker-start btn-local-asr-install" type="button" data-install-engine="${escapeHtml(e.engine)}">
            再試行
          </button>
        </div>`;
      break;
    case "not-installed":
      statusHtml = `
        <div class="docker-status-row">
          <span class="material-symbols-outlined" style="font-size: 18px; color: var(--outline);">info</span>
          <span>未インストール</span>
        </div>
        <div class="docker-status-actions">
          <button class="btn-docker-start btn-local-asr-install" type="button" data-install-engine="${escapeHtml(e.engine)}">
            <span class="material-symbols-outlined">download</span>
            インストール
          </button>
          <button class="btn-docker-refresh" type="button" data-local-asr-refresh>
            <span class="material-symbols-outlined">refresh</span>
            状態を再確認
          </button>
        </div>`;
      break;
    case "installed": {
      const details: string[] = [];
      if (e.environmentVersion) details.push(`環境バージョン: ${escapeHtml(e.environmentVersion)}`);
      if (e.modelName) details.push(`モデル: ${escapeHtml(e.modelName)}`);
      statusHtml = `
        <div class="docker-status-row">
          <span class="material-symbols-outlined" style="font-size: 18px; color: var(--color-success, #22c55e);">check_circle</span>
          <span>インストール済み</span>
        </div>
        ${details.length > 0 ? `<div class="local-asr-details">${details.map(d => `<p class="docker-detail-item">${d}</p>`).join("")}</div>` : ""}
        <div class="docker-status-actions">
          <button class="btn-docker-refresh" type="button" data-local-asr-refresh>
            <span class="material-symbols-outlined">refresh</span>
            状態を再確認
          </button>
          <button class="btn-danger-outline" type="button" data-uninstall-engine="${escapeHtml(e.engine)}">
            削除
          </button>
        </div>`;
      break;
    }
    case "daemon-unavailable":
      statusHtml = `
        <div class="docker-status-row">
          <span class="material-symbols-outlined" style="font-size: 18px; color: var(--color-warning, #f59e0b);">warning</span>
          <span>Docker Engineへ接続できませんでした</span>
        </div>
        <p class="docker-status-desc">Docker Desktopの起動完了後に再確認してください。</p>
        <div class="docker-status-actions">
          <button class="btn-docker-refresh" type="button" data-local-asr-refresh>
            <span class="material-symbols-outlined">refresh</span>
            状態を再確認
          </button>
        </div>`;
      break;
    case "inspect-error":
      statusHtml = `
        <div class="docker-status-row">
          <span class="material-symbols-outlined" style="font-size: 18px; color: var(--color-error, #ef4444);">error</span>
          <span>インストール状態を確認できませんでした</span>
        </div>
        <p class="docker-status-desc">しばらく待ってから再確認してください。</p>
        <div class="docker-status-actions">
          <button class="btn-docker-refresh" type="button" data-local-asr-refresh>
            <span class="material-symbols-outlined">refresh</span>
            状態を再確認
          </button>
        </div>`;
      break;
  }

  return `
    <div class="local-asr-engine-card">
      <div class="local-asr-engine-header">
        <span class="local-asr-engine-name">${escapeHtml(e.displayName)}</span>
        <span class="local-asr-engine-desc">日本語音声認識</span>
      </div>
      <div class="local-asr-engine-status">
        ${statusHtml}
      </div>
    </div>`;
}
