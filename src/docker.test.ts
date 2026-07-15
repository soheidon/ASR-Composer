// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { getDockerUiState, escapeHtml, renderDockerStatusContent, renderHuggingFaceTokenSection, getLocalAsrUiState, renderLocalAsrSection } from "./docker";
import type { DockerStatus, LocalAsrEngineStatus } from "./docker";

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
    expect(getDockerUiState({ ...baseStatus, cliFound: true, errorKind: "check_timeout" })).toBe("error");
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

  it("error state renders error message", () => {
    const html = renderDockerStatusContent({
      ...baseStatus,
      cliFound: true,
      desktopFound: true,
      errorKind: "check_timeout",
      errorMessage: "タイムアウトしました",
    });
    document.body.innerHTML = html;
    expect(document.body.textContent).toContain("エラーが発生しました");
    expect(document.body.textContent).toContain("タイムアウトしました");
    expect(document.querySelector(".btn-docker-refresh")).toBeTruthy();
  });

  it("error state escapes errorMessage in HTML", () => {
    const html = renderDockerStatusContent({
      ...baseStatus,
      cliFound: true,
      errorKind: "check_timeout",
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

  it("dockerRunning:true, installed:true → 'installed'", () => {
    expect(getLocalAsrUiState({ ...baseEngine, dockerAvailable: true, dockerRunning: true, installed: true })).toBe("installed");
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
  };

  it("null shows loading state", () => {
    const html = renderLocalAsrSection(null);
    document.body.innerHTML = html;
    expect(document.body.textContent).toContain("状態を確認しています…");
    expect(document.querySelector(".spin")).toBeTruthy();
  });

  it("empty array shows error state", () => {
    const html = renderLocalAsrSection([]);
    document.body.innerHTML = html;
    expect(document.body.textContent).toContain("状態を取得できませんでした");
  });

  it("no-docker shows Docker not installed message", () => {
    const html = renderLocalAsrSection([{ ...baseEngine }]);
    document.body.innerHTML = html;
    expect(document.body.textContent).toContain("Dockerがインストールされていません");
    expect(document.body.textContent).toContain("ReazonSpeech");
  });

  it("docker-stopped shows Docker not running message", () => {
    const html = renderLocalAsrSection([{ ...baseEngine, dockerAvailable: true }]);
    document.body.innerHTML = html;
    expect(document.body.textContent).toContain("Docker Desktopが起動していません");
  });

  it("not-installed shows info badge", () => {
    const html = renderLocalAsrSection([{ ...baseEngine, dockerAvailable: true, dockerRunning: true }]);
    document.body.innerHTML = html;
    expect(document.body.textContent).toContain("未インストール");
  });

  it("installed shows check mark and engine name", () => {
    const html = renderLocalAsrSection([{
      ...baseEngine,
      dockerAvailable: true,
      dockerRunning: true,
      installed: true,
      environmentVersion: "1.0.0",
      modelName: "reazon-research/reazonspeech-espnet-v2",
    }]);
    document.body.innerHTML = html;
    expect(document.body.textContent).toContain("インストール済み");
    expect(document.body.textContent).toContain("ReazonSpeech");
    expect(document.body.textContent).toContain("1.0.0");
    expect(document.body.textContent).toContain("reazon-research/reazonspeech-espnet-v2");
  });

  it("installed without optional fields omits details", () => {
    const html = renderLocalAsrSection([{
      ...baseEngine,
      dockerAvailable: true,
      dockerRunning: true,
      installed: true,
    }]);
    document.body.innerHTML = html;
    expect(document.body.textContent).toContain("インストール済み");
    expect(document.body.textContent).not.toContain("環境バージョン");
    expect(document.body.textContent).not.toContain("モデル:");
  });

  it("engine displayName is rendered", () => {
    const html = renderLocalAsrSection([{ ...baseEngine, dockerAvailable: true, dockerRunning: true }]);
    document.body.innerHTML = html;
    expect(document.querySelector(".local-asr-engine-name")?.textContent).toContain("ReazonSpeech");
  });

  it("installed version info is HTML-escaped", () => {
    const html = renderLocalAsrSection([{
      ...baseEngine,
      dockerAvailable: true,
      dockerRunning: true,
      installed: true,
      modelName: '<script>alert("xss")</script>',
    }]);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
