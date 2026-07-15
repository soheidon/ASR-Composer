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
  if (status.errorKind === "check_timeout") return "error";
  if (!status.daemonRunning) return "stopped";
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
          <p class="docker-status-desc">Docker Desktopを起動して、Docker Engineを開始してください。</p>
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
}

export type LocalAsrUiState = "loading" | "error" | "no-docker" | "docker-stopped" | "not-installed" | "installed";

export function getLocalAsrUiState(status: LocalAsrEngineStatus | null): LocalAsrUiState {
  if (!status) return "loading";
  if (!status.dockerAvailable) return "no-docker";
  if (!status.dockerRunning) return "docker-stopped";
  if (!status.installed) return "not-installed";
  return "installed";
}

export function renderLocalAsrSection(engines: LocalAsrEngineStatus[] | null): string {
  if (engines === null) {
    return `
      <div class="local-asr-engine-card">
        <div class="docker-status-row">
          <span class="material-symbols-outlined spin" style="font-size: 18px; color: var(--color-text-secondary);">progress_activity</span>
          <span>状態を確認しています…</span>
        </div>
      </div>`;
  }

  if (engines.length === 0) {
    return `
      <div class="local-asr-engine-card">
        <div class="docker-status-row">
          <span class="material-symbols-outlined" style="font-size: 18px; color: var(--color-error, #ef4444);">error</span>
          <span>状態を取得できませんでした</span>
        </div>
      </div>`;
  }

  return engines.map(e => renderLocalAsrEngineCard(e)).join("");
}

function renderLocalAsrEngineCard(e: LocalAsrEngineStatus): string {
  const state = getLocalAsrUiState(e);

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
        <p class="docker-status-desc">ローカルASRを使用するには、Docker Desktopのインストールが必要です。上の「Docker Desktop」セクションを確認してください。</p>`;
      break;
    case "docker-stopped":
      statusHtml = `
        <div class="docker-status-row">
          <span class="material-symbols-outlined" style="font-size: 18px; color: var(--color-warning, #f59e0b);">warning</span>
          <span>Docker Desktopが起動していません</span>
        </div>
        <p class="docker-status-desc">Docker Desktopを起動してから、ページを再読み込みしてください。</p>`;
      break;
    case "not-installed":
      statusHtml = `
        <div class="docker-status-row">
          <span class="material-symbols-outlined" style="font-size: 18px; color: var(--outline);">info</span>
          <span>未インストール</span>
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
        ${details.length > 0 ? `<div class="local-asr-details">${details.map(d => `<p class="docker-detail-item">${d}</p>`).join("")}</div>` : ""}`;
      break;
    }
    case "error":
      statusHtml = `
        <div class="docker-status-row">
          <span class="material-symbols-outlined" style="font-size: 18px; color: var(--color-error, #ef4444);">error</span>
          <span>状態を取得できませんでした</span>
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
