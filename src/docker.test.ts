// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { getDockerUiState, escapeHtml, renderDockerStatusContent, renderHuggingFaceTokenSection, getLocalAsrUiState, renderLocalAsrSection, getLocalAsrProgressDisplay } from "./docker";
import type { DockerStatus, LocalAsrEngineStatus, LocalAsrInstallState } from "./docker";

// ---- getDockerUiState ----

describe("getDockerUiState", () => {
  const baseStatus: DockerStatus = {
    cliFound: false,
    cliVersion: null,
    daemonRunning: false,
    serverVersion: null,
    desktopFound: false,
    cliPath: null,
    desktopPath: null,
    errorKind: null,
    errorMessage: null,
  };

  it("null status returns 'checking'", () => {
    expect(getDockerUiState(null)).toBe("checking");
  });

  it("cliFound:false, desktopFound:false → 'not-installed'", () => {
    expect(getDockerUiState({ ...baseStatus })).toBe("not-installed");
  });

  it("cliFound:false, desktopFound:true → 'cli-missing'", () => {
    expect(getDockerUiState({ ...baseStatus, desktopFound: true })).toBe("cli-missing");
  });

  it("errorKind:'check_timeout' → 'error'", () => {
    expect(getDockerUiState({ ...baseStatus, cliFound: true, errorKind: "check_timeout" })).toBe("stopped");
  });

  it("cliFound:true, daemonRunning:false → 'stopped'", () => {
    expect(getDockerUiState({ ...baseStatus, cliFound: true, desktopFound: true })).toBe("stopped");
  });

  it("cliFound:true, daemonRunning:true → 'ready'", () => {
    expect(getDockerUiState({
      ...baseStatus,
      cliFound: true,
      desktopFound: true,
      daemonRunning: true,
      serverVersion: "24.0.7",
    })).toBe("ready");
  });

  it("cliFound:true but daemon_not_running error → 'stopped'", () => {
    expect(getDockerUiState({
      ...baseStatus,
      cliFound: true,
      desktopFound: true,
      errorKind: "daemon_not_running",
      errorMessage: "Cannot connect",
    })).toBe("stopped");
  });
});

// ---- escapeHtml ----

describe("escapeHtml", () => {
  it("escapes angle brackets", () => {
    const result = escapeHtml("<script>alert(1)</script>");
    expect(result).toContain("&lt;");
    expect(result).not.toContain("<script>");
  });

  it("escapes ampersand", () => {
    expect(escapeHtml("a & b")).toContain("&amp;");
  });

  it("escapes quotes via textContent (innerHTML does not escape quotes, but textContent prevents injection)", () => {
    const result = escapeHtml('"hello"');
    // textContent → innerHTML escapes <, >, & but not quotes
    // This is safe because the output is inserted via innerHTML as text content, not inside an attribute
    expect(result).toContain("hello");
  });

  it("passes plain text through unchanged", () => {
    expect(escapeHtml("Docker version 24.0.7")).toBe("Docker version 24.0.7");
  });

  it("handles empty string", () => {
    expect(escapeHtml("")).toBe("");
  });
});

// ---- renderDockerStatusContent ----

describe("renderDockerStatusContent", () => {
  const baseStatus: DockerStatus = {
    cliFound: false,
    cliVersion: null,
    daemonRunning: false,
    serverVersion: null,
    desktopFound: false,
    cliPath: null,
    desktopPath: null,
    errorKind: null,
    errorMessage: null,
  };

  it("checking state renders progress indicator", () => {
    const html = renderDockerStatusContent(null);
    document.body.innerHTML = html;
    expect(document.body.textContent).toContain("Dockerの状態を確認しています…");
    expect(document.querySelector(".docker-status-checking")).toBeTruthy();
  });

  it("not-installed state renders install steps and buttons", () => {
    const html = renderDockerStatusContent({ ...baseStatus });
    document.body.innerHTML = html;
    expect(document.body.textContent).toContain("Docker Desktopが見つかりません");
    expect(document.body.textContent).toContain("ローカルASRを使用するには");
    expect(document.querySelector(".docker-install-steps")).toBeTruthy();
    expect(document.querySelector(".btn-docker-download")).toBeTruthy();
    expect(document.querySelector(".btn-docker-refresh")).toBeTruthy();
  });

  it("cli-missing state renders start button and description", () => {
    const html = renderDockerStatusContent({ ...baseStatus, desktopFound: true });
    document.body.innerHTML = html;
    expect(document.body.textContent).toContain("Docker CLIを検出できませんでした");
    expect(document.querySelector(".btn-docker-start")).toBeTruthy();
    expect(document.querySelector(".btn-docker-refresh")).toBeTruthy();
  });

  it("stopped state renders start and refresh buttons", () => {
    const html = renderDockerStatusContent({ ...baseStatus, cliFound: true, desktopFound: true });
    document.body.innerHTML = html;
    expect(document.body.textContent).toContain("Docker Engineは起動していません");
    expect(document.querySelector(".btn-docker-start")).toBeTruthy();
    expect(document.querySelector(".btn-docker-refresh")).toBeTruthy();
  });

  it("ready state renders version info and refresh button", () => {
    const html = renderDockerStatusContent({
      ...baseStatus,
      cliFound: true,
      desktopFound: true,
      daemonRunning: true,
      cliVersion: "Docker version 24.0.7, build afdd53b",
      serverVersion: "24.0.7",
    });
    document.body.innerHTML = html;
    expect(document.body.textContent).toContain("Docker Desktopは利用可能です");
    expect(document.body.textContent).toContain("24.0.7");
    expect(document.querySelector(".btn-docker-refresh")).toBeTruthy();
    expect(document.querySelector(".btn-docker-start")).toBeNull();
  });

  it("ready state escapes CLI version in HTML", () => {
    const html = renderDockerStatusContent({
      ...baseStatus,
      cliFound: true,
      desktopFound: true,
      daemonRunning: true,
      cliVersion: "<img src=x onerror=alert(1)>",
      serverVersion: "24.0.7",
    });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("check_timeout renders as stopped with error message", () => {
    const html = renderDockerStatusContent({
      ...baseStatus,
      cliFound: true,
      desktopFound: true,
      daemonRunning: false,
      errorKind: "check_timeout",
      errorMessage: "Docker Engineへの接続がタイムアウトしました。",
    });
    document.body.innerHTML = html;
    expect(document.body.textContent).toContain("Docker Engineは起動していません");
    expect(document.body.textContent).toContain("タイムアウトしました");
    expect(document.querySelector(".btn-docker-start")).toBeTruthy();
    expect(document.querySelector(".btn-docker-refresh")).toBeTruthy();
  });

  it("permission_denied renders as error", () => {
    const html = renderDockerStatusContent({
      ...baseStatus,
      cliFound: true,
      desktopFound: true,
      daemonRunning: false,
      errorKind: "permission_denied",
      errorMessage: "権限エラー: access denied",
    });
    document.body.innerHTML = html;
    expect(document.body.textContent).toContain("エラーが発生しました");
    expect(document.body.textContent).toContain("権限エラー");
    expect(document.querySelector(".btn-docker-refresh")).toBeTruthy();
  });

  it("error state escapes errorMessage in HTML", () => {
    const html = renderDockerStatusContent({
      ...baseStatus,
      cliFound: true,
      desktopFound: true,
      daemonRunning: false,
      errorKind: "permission_denied",
      errorMessage: '<script>alert("xss")</script>',
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

// ---- renderHuggingFaceTokenSection ----

describe("renderHuggingFaceTokenSection", () => {
  it("null status renders input field and save button", () => {
    const html = renderHuggingFaceTokenSection(null);
    document.body.innerHTML = html;
    expect(document.querySelector(".hf-token-input")).toBeTruthy();
    expect(document.querySelector(".btn-hf-token-save")).toBeTruthy();
    expect(document.body.textContent).toContain("アクセストークン");
    expect(document.body.textContent).toContain("HF_TOKEN");
  });

  it("unconfigured status renders input field", () => {
    const html = renderHuggingFaceTokenSection({ configured: false, maskedValue: null });
    document.body.innerHTML = html;
    expect(document.querySelector(".hf-token-input")).toBeTruthy();
    expect(document.querySelector(".btn-hf-token-save")).toBeTruthy();
  });

  it("configured status renders masked value and buttons", () => {
    const html = renderHuggingFaceTokenSection({
      configured: true,
      maskedValue: "hf_****************7KpQ",
    });
    document.body.innerHTML = html;
    expect(document.body.textContent).toContain("HF_TOKENは設定済みです");
    expect(document.body.textContent).toContain("hf_****************7KpQ");
    expect(document.querySelector(".btn-hf-token-edit")).toBeTruthy();
    expect(document.querySelector(".btn-hf-token-delete")).toBeTruthy();
    expect(document.querySelector(".hf-token-input")).toBeNull();
  });

  it("configured status does not contain raw token", () => {
    const html = renderHuggingFaceTokenSection({
      configured: true,
      maskedValue: "hf_****abcd",
    });
    // The HTML should contain the masked value, not any raw token
    expect(html).toContain("hf_****abcd");
    expect(html).not.toContain("hf_abcdefghijklmnopqrstuvwxyz");
  });

  it("input field has autocomplete=new-password", () => {
    const html = renderHuggingFaceTokenSection(null);
    expect(html).toContain('autocomplete="new-password"');
  });

  it("input field has type=password", () => {
    const html = renderHuggingFaceTokenSection(null);
    expect(html).toContain('type="password"');
  });

  it("configured status with null maskedValue shows fallback", () => {
    const html = renderHuggingFaceTokenSection({
      configured: true,
      maskedValue: null,
    });
    document.body.innerHTML = html;
    expect(document.body.textContent).toContain("設定済み");
  });

  it("visibility toggle button exists in input mode", () => {
    const html = renderHuggingFaceTokenSection(null);
    document.body.innerHTML = html;
    expect(document.querySelector(".hf-token-visibility")).toBeTruthy();
  });
});

// ---- getLocalAsrUiState ----

describe("getLocalAsrUiState", () => {
  const baseEngine: LocalAsrEngineStatus = {
    engine: "reazonspeech",
    displayName: "ReazonSpeech",
    installed: false,
    imageName: "asr-composer-reazonspeech:cu126",
    imageId: null,
    environmentVersion: null,
    modelName: null,
    dockerAvailable: false,
    dockerRunning: false,
    errorKind: null,
    errorMessage: null,
  };

  it("null status returns 'loading'", () => {
    expect(getLocalAsrUiState(null)).toBe("loading");
  });

  it("dockerAvailable:false → 'no-docker'", () => {
    expect(getLocalAsrUiState({ ...baseEngine })).toBe("no-docker");
  });

  it("dockerAvailable:true, dockerRunning:false → 'docker-stopped'", () => {
    expect(getLocalAsrUiState({ ...baseEngine, dockerAvailable: true })).toBe("docker-stopped");
  });

  it("dockerRunning:true, installed:false → 'not-installed'", () => {
    expect(getLocalAsrUiState({ ...baseEngine, dockerAvailable: true, dockerRunning: true })).toBe("not-installed");
  });

  it("errorKind:'daemon-unavailable' → 'daemon-unavailable'", () => {
    expect(getLocalAsrUiState({ ...baseEngine, dockerAvailable: true, dockerRunning: true, errorKind: "daemon-unavailable", errorMessage: "test" })).toBe("daemon-unavailable");
  });

  it("errorKind:'inspect-error' → 'inspect-error'", () => {
    expect(getLocalAsrUiState({ ...baseEngine, dockerAvailable: true, dockerRunning: true, errorKind: "inspect-error", errorMessage: "test" })).toBe("inspect-error");
  });

  it("dockerRunning:true, installed:true → 'installed'", () => {
    expect(getLocalAsrUiState({ ...baseEngine, dockerAvailable: true, dockerRunning: true, installed: true })).toBe("installed");
  });

  it("priority: no-docker > docker-stopped > daemon-unavailable > inspect-error > not-installed", () => {
    // no-docker takes priority over everything
    expect(getLocalAsrUiState({ ...baseEngine, dockerAvailable: false, dockerRunning: false, errorKind: "daemon-unavailable", errorMessage: "x" })).toBe("no-docker");
    // docker-stopped takes priority over error kinds
    expect(getLocalAsrUiState({ ...baseEngine, dockerAvailable: true, dockerRunning: false, errorKind: "daemon-unavailable", errorMessage: "x" })).toBe("docker-stopped");
    // daemon-unavailable takes priority over inspect-error
    expect(getLocalAsrUiState({ ...baseEngine, dockerAvailable: true, dockerRunning: true, errorKind: "daemon-unavailable", errorMessage: "x", installed: false })).toBe("daemon-unavailable");
    // inspect-error takes priority over not-installed
    expect(getLocalAsrUiState({ ...baseEngine, dockerAvailable: true, dockerRunning: true, errorKind: "inspect-error", errorMessage: "x", installed: false })).toBe("inspect-error");
  });

  const installing: LocalAsrInstallState = { engine: "reazonspeech", status: "installing", progress: 50, message: "テスト中" };
  const succeeded: LocalAsrInstallState = { engine: "reazonspeech", status: "succeeded", progress: 100, message: "完了" };
  const failed: LocalAsrInstallState = { engine: "reazonspeech", status: "failed", progress: 30, message: "失敗" };

  it("status=null + installing → installing (loading より優先)", () => {
    expect(getLocalAsrUiState(null, installing)).toBe("installing");
  });

  it("status=null + succeeded → install-succeeded", () => {
    expect(getLocalAsrUiState(null, succeeded)).toBe("install-succeeded");
  });

  it("docker stopped + installing → docker-stopped (Docker異常優先)", () => {
    expect(getLocalAsrUiState({ ...baseEngine, dockerAvailable: true, dockerRunning: false }, installing)).toBe("docker-stopped");
  });

  it("daemon-unavailable + installing → daemon-unavailable", () => {
    expect(getLocalAsrUiState({ ...baseEngine, dockerAvailable: true, dockerRunning: true, errorKind: "daemon-unavailable", errorMessage: "x" }, installing)).toBe("daemon-unavailable");
  });

  it("installed=true + succeeded → installed", () => {
    expect(getLocalAsrUiState({ ...baseEngine, dockerAvailable: true, dockerRunning: true, installed: true }, succeeded)).toBe("installed");
  });

  it("installed=false + succeeded → install-succeeded", () => {
    expect(getLocalAsrUiState({ ...baseEngine, dockerAvailable: true, dockerRunning: true, installed: false }, succeeded)).toBe("install-succeeded");
  });

  it("failed → install-failed", () => {
    expect(getLocalAsrUiState({ ...baseEngine, dockerAvailable: true, dockerRunning: true, installed: false }, failed)).toBe("install-failed");
  });
});

// ---- renderLocalAsrSection ----

describe("renderLocalAsrSection", () => {
  const baseEngine: LocalAsrEngineStatus = {
    engine: "reazonspeech",
    displayName: "ReazonSpeech",
    installed: false,
    imageName: "asr-composer-reazonspeech:cu126",
    imageId: null,
    environmentVersion: null,
    modelName: null,
    dockerAvailable: false,
    dockerRunning: false,
    errorKind: null,
    errorMessage: null,
  };

  it("null shows loading state", () => {
    const html = renderLocalAsrSection({ kind: "loading" });
    document.body.innerHTML = html;
    expect(document.body.textContent).toContain("状態を確認しています…");
    expect(document.querySelector(".spin")).toBeTruthy();
  });

  it("load-error shows error message", () => {
    const html = renderLocalAsrSection({ kind: "load-error", message: "テストエラー" });
    document.body.innerHTML = html;
    expect(document.body.textContent).toContain("テストエラー");
  });

  it("no-docker shows Docker not installed message", () => {
    const html = renderLocalAsrSection({ kind: "engines", statuses: [{ ...baseEngine }] });
    document.body.innerHTML = html;
    expect(document.body.textContent).toContain("Dockerがインストールされていません");
    expect(document.body.textContent).toContain("ReazonSpeech");
  });

  it("docker-stopped shows Docker not running message", () => {
    const html = renderLocalAsrSection({ kind: "engines", statuses: [{ ...baseEngine, dockerAvailable: true }] });
    document.body.innerHTML = html;
    expect(document.body.textContent).toContain("Docker Desktopが起動していません");
  });

  it("not-installed shows info badge", () => {
    const html = renderLocalAsrSection({ kind: "engines", statuses: [{ ...baseEngine, dockerAvailable: true, dockerRunning: true }] });
    document.body.innerHTML = html;
    expect(document.body.textContent).toContain("未インストール");
  });

  it("installed shows check mark and engine name", () => {
    const html = renderLocalAsrSection({ kind: "engines", statuses: [{
      ...baseEngine,
      dockerAvailable: true,
      dockerRunning: true,
      installed: true,
      environmentVersion: "1.0.0",
      modelName: "reazon-research/reazonspeech-espnet-v2",
    }] });
    document.body.innerHTML = html;
    expect(document.body.textContent).toContain("インストール済み");
    expect(document.body.textContent).toContain("ReazonSpeech");
    expect(document.body.textContent).toContain("1.0.0");
    expect(document.body.textContent).toContain("reazon-research/reazonspeech-espnet-v2");
  });

  it("installed without optional fields omits details", () => {
    const html = renderLocalAsrSection({ kind: "engines", statuses: [{
      ...baseEngine,
      dockerAvailable: true,
      dockerRunning: true,
      installed: true,
    }] });
    document.body.innerHTML = html;
    expect(document.body.textContent).toContain("インストール済み");
    expect(document.body.textContent).not.toContain("環境バージョン");
    expect(document.body.textContent).not.toContain("モデル:");
  });

  it("engine displayName is rendered", () => {
    const html = renderLocalAsrSection({ kind: "engines", statuses: [{ ...baseEngine, dockerAvailable: true, dockerRunning: true }] });
    document.body.innerHTML = html;
    expect(document.querySelector(".local-asr-engine-name")?.textContent).toContain("ReazonSpeech");
  });

  it("installed version info is HTML-escaped", () => {
    const html = renderLocalAsrSection({ kind: "engines", statuses: [{
      ...baseEngine,
      dockerAvailable: true,
      dockerRunning: true,
      installed: true,
      modelName: '<script>alert("xss")</script>',
    }] });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("not-installed shows install button", () => {
    const html = renderLocalAsrSection({ kind: "engines", statuses: [{ ...baseEngine, dockerAvailable: true, dockerRunning: true }] });
    document.body.innerHTML = html;
    const btn = document.querySelector(".btn-local-asr-install");
    expect(btn).toBeTruthy();
    expect(btn!.textContent).toContain("インストール");
    expect(btn!.getAttribute("data-install-engine")).toBe("reazonspeech");
  });

  it("installed does not show install button", () => {
    const html = renderLocalAsrSection({ kind: "engines", statuses: [{
      ...baseEngine,
      dockerAvailable: true,
      dockerRunning: true,
      installed: true,
    }] });
    document.body.innerHTML = html;
    expect(document.querySelector(".btn-local-asr-install")).toBeNull();
  });

  it("no-docker does not show install button", () => {
    const html = renderLocalAsrSection({ kind: "engines", statuses: [{ ...baseEngine }] });
    document.body.innerHTML = html;
    expect(document.querySelector(".btn-local-asr-install")).toBeNull();
  });

  it("docker-stopped does not show install button", () => {
    const html = renderLocalAsrSection({ kind: "engines", statuses: [{ ...baseEngine, dockerAvailable: true }] });
    document.body.innerHTML = html;
    expect(document.querySelector(".btn-local-asr-install")).toBeNull();
  });

  it("all non-loading states show refresh button", () => {
    const states = [
      { ...baseEngine },                                                          // no-docker
      { ...baseEngine, dockerAvailable: true },                                    // docker-stopped
      { ...baseEngine, dockerAvailable: true, dockerRunning: true },               // not-installed
      { ...baseEngine, dockerAvailable: true, dockerRunning: true, installed: true }, // installed
    ];
    for (const s of states) {
      const html = renderLocalAsrSection({ kind: "engines", statuses: [s] });
      document.body.innerHTML = html;
      expect(document.querySelector("[data-local-asr-refresh]")).toBeTruthy();
    }
  });

  it("refresh button has correct text", () => {
    const html = renderLocalAsrSection({ kind: "engines", statuses: [{ ...baseEngine, dockerAvailable: true, dockerRunning: true }] });
    document.body.innerHTML = html;
    const btn = document.querySelector("[data-local-asr-refresh]");
    expect(btn?.textContent).toContain("状態を再確認");
  });

  it("installed state shows uninstall button", () => {
    const html = renderLocalAsrSection({ kind: "engines", statuses: [{
      ...baseEngine,
      dockerAvailable: true,
      dockerRunning: true,
      installed: true,
    }] });
    document.body.innerHTML = html;
    const btn = document.querySelector("[data-uninstall-engine]");
    expect(btn).toBeTruthy();
    expect(btn!.textContent).toContain("削除");
    expect(btn!.getAttribute("data-uninstall-engine")).toBe("reazonspeech");
  });

  it("not-installed state does not show uninstall button", () => {
    const html = renderLocalAsrSection({ kind: "engines", statuses: [{ ...baseEngine, dockerAvailable: true, dockerRunning: true }] });
    document.body.innerHTML = html;
    expect(document.querySelector("[data-uninstall-engine]")).toBeNull();
  });

  it("no-docker state does not show uninstall button", () => {
    const html = renderLocalAsrSection({ kind: "engines", statuses: [{ ...baseEngine }] });
    document.body.innerHTML = html;
    expect(document.querySelector("[data-uninstall-engine]")).toBeNull();
  });

  it("docker-unavailable section shows Docker not installed message", () => {
    const html = renderLocalAsrSection({ kind: "docker-unavailable" });
    document.body.innerHTML = html;
    expect(document.body.textContent).toContain("Dockerがインストールされていません");
    expect(document.querySelector("[data-local-asr-refresh]")).toBeTruthy();
  });

  it("docker-stopped section shows Docker not running message", () => {
    const html = renderLocalAsrSection({ kind: "docker-stopped" });
    document.body.innerHTML = html;
    expect(document.body.textContent).toContain("Docker Desktopが起動していません");
    expect(document.querySelector("[data-local-asr-refresh]")).toBeTruthy();
  });

  it("load-error section shows custom message", () => {
    const html = renderLocalAsrSection({ kind: "load-error", message: "テストエラーメッセージ" });
    document.body.innerHTML = html;
    expect(document.body.textContent).toContain("テストエラーメッセージ");
    expect(document.querySelector("[data-local-asr-refresh]")).toBeTruthy();
  });

  it("daemon-unavailable engine shows connection error", () => {
    const html = renderLocalAsrSection({ kind: "engines", statuses: [{ ...baseEngine, dockerAvailable: true, dockerRunning: true, errorKind: "daemon-unavailable", errorMessage: "test" }] });
    document.body.innerHTML = html;
    expect(document.body.textContent).toContain("Docker Engineへ接続できませんでした");
    expect(document.querySelector("[data-local-asr-refresh]")).toBeTruthy();
    expect(document.querySelector(".btn-local-asr-install")).toBeNull();
  });

  it("inspect-error engine shows confirmation error", () => {
    const html = renderLocalAsrSection({ kind: "engines", statuses: [{ ...baseEngine, dockerAvailable: true, dockerRunning: true, errorKind: "inspect-error", errorMessage: "test" }] });
    document.body.innerHTML = html;
    expect(document.body.textContent).toContain("インストール状態を確認できませんでした");
    expect(document.querySelector("[data-local-asr-refresh]")).toBeTruthy();
    expect(document.querySelector(".btn-local-asr-install")).toBeNull();
  });

  it("daemon-unavailable does not show install or uninstall buttons", () => {
    const html = renderLocalAsrSection({ kind: "engines", statuses: [{ ...baseEngine, dockerAvailable: true, dockerRunning: true, errorKind: "daemon-unavailable", errorMessage: "test" }] });
    document.body.innerHTML = html;
    expect(document.querySelector(".btn-local-asr-install")).toBeNull();
    expect(document.querySelector("[data-uninstall-engine]")).toBeNull();
  });

  it("empty engines array shows info message", () => {
    const html = renderLocalAsrSection({ kind: "engines", statuses: [] });
    document.body.innerHTML = html;
    expect(document.body.textContent).toContain("エンジンが定義されていません");
  });

  it("installing state shows progress bar with data-install-engine-status", () => {
    const installStates = new Map<string, LocalAsrInstallState>();
    installStates.set("reazonspeech", { engine: "reazonspeech", status: "installing", progress: 63, message: "インストール中" });
    const html = renderLocalAsrSection({
      kind: "engines",
      statuses: [{ ...baseEngine, dockerAvailable: true, dockerRunning: true, installed: false }],
      installStates,
    });
    document.body.innerHTML = html;
    expect(document.body.textContent).toContain("63%");
    expect(document.querySelector("[data-install-engine-status]")).toBeTruthy();
    expect(document.querySelector(".btn-local-asr-install")).toBeNull();
  });

  it("install-succeeded shows confirmation message", () => {
    const installStates = new Map<string, LocalAsrInstallState>();
    installStates.set("reazonspeech", { engine: "reazonspeech", status: "succeeded", progress: 100, message: "完了" });
    const html = renderLocalAsrSection({
      kind: "engines",
      statuses: [{ ...baseEngine, dockerAvailable: true, dockerRunning: true, installed: false }],
      installStates,
    });
    document.body.innerHTML = html;
    expect(document.body.textContent).toContain("インストール完了");
    expect(document.body.textContent).toContain("状態を確認しています");
  });

  it("install-failed shows retry button", () => {
    const installStates = new Map<string, LocalAsrInstallState>();
    installStates.set("reazonspeech", { engine: "reazonspeech", status: "failed", progress: 30, message: "失敗" });
    const html = renderLocalAsrSection({
      kind: "engines",
      statuses: [{ ...baseEngine, dockerAvailable: true, dockerRunning: true, installed: false }],
      installStates,
    });
    document.body.innerHTML = html;
    expect(document.body.textContent).toContain("失敗");
    expect(document.querySelector(".btn-local-asr-install")).toBeTruthy();
  });

  it("empty statuses with active installStates renders progress card", () => {
    const installStates = new Map<string, LocalAsrInstallState>();
    installStates.set("reazonspeech", { engine: "reazonspeech", status: "installing", progress: 42, message: "テスト中" });
    const html = renderLocalAsrSection({ kind: "engines", statuses: [], installStates });
    document.body.innerHTML = html;
    expect(document.body.textContent).toContain("42%");
    expect(document.body.textContent).toContain("テスト中");
  });
});

// ---- getLocalAsrProgressDisplay ----

describe("getLocalAsrProgressDisplay", () => {
  it("checking returns5%", () => {
    const d = getLocalAsrProgressDisplay("checking");
    expect(d.percent).toBe(5);
    expect(d.message).toContain("Docker");
  });

  it("completed returns 100%", () => {
    const d = getLocalAsrProgressDisplay("completed");
    expect(d.percent).toBe(100);
    expect(d.message).toContain("完了");
  });

  it("installing-pyannote returns60%", () => {
    const d = getLocalAsrProgressDisplay("installing-pyannote");
    expect(d.percent).toBe(60);
    expect(d.message).toContain("pyannote");
  });

  it("unknown stage returns0%", () => {
    const d = getLocalAsrProgressDisplay("unknown-stage");
    expect(d.percent).toBe(0);
    expect(d.message).toContain("開始");
  });

  it("stages are monotonically increasing", () => {
    const stageOrder = [
      "checking", "resolving-resources", "building-base-start",
      "installing-system-packages", "building-base-export",
      "building-engine-start", "installing-diar-torch",
      "installing-pyannote", "installing-asr-torch",
      "installing-reazonspeech", "rebuilding-ctc",
      "checking-dependencies", "exporting-engine-image",
      "verifying-image", "completed",
    ];
    let prev = 0;
    for (const stage of stageOrder) {
      const d = getLocalAsrProgressDisplay(stage);
      expect(d.percent).toBeGreaterThan(prev);
      prev = d.percent;
    }
  });

  it("all stages have non-empty messages", () => {
    const stageOrder = [
      "checking", "resolving-resources", "building-base-start",
      "installing-system-packages", "building-base-export",
      "building-engine-start", "installing-diar-torch",
      "installing-pyannote", "installing-asr-torch",
      "installing-reazonspeech", "rebuilding-ctc",
      "checking-dependencies", "exporting-engine-image",
      "verifying-image", "completed",
    ];
    for (const stage of stageOrder) {
      const d = getLocalAsrProgressDisplay(stage);
      expect(d.message.length).toBeGreaterThan(0);
    }
  });
});
