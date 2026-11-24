import { describe, it, expect } from "vitest";
import {
  applyGoogleAuthStatusToSection,
  buildGoogleCloudSpeechConsoleUrl,
  canPromptSpeechApiEnable,
  hasRequiredGoogleScopes,
  isGoogleAuthResponseCurrent,
  isGoogleSttAvailableForTranscribe,
  parseGoogleApiError,
  shouldAutoRunDefaultOnboarding,
  type GoogleAuthStatus,
} from "./google-auth";
import { getGoogleSttConfiguredState } from "./provider-config-save";

function makeGoogleSttCardHtml(): string {
  return `
    <div class="accordion-item" data-provider-id="google_stt">
      <span data-status-badge data-connection-state="unconfigured">未設定</span>
      <div class="google-stt-oauth-section">
        <span data-field="auth-state">Googleに未接続</span>
        <span data-field="auth-account" hidden></span>
        <p data-field="auth-error" style="display:none;"></p>
        <button class="btn-google-auth-login" type="button">Googleにログイン</button>
        <button class="btn-google-auth-retry-consent" type="button" hidden>同意を再取得してログイン</button>
        <button class="btn-google-auth-switch" type="button" hidden>アカウントを切り替える</button>
        <button class="btn-google-auth-logout" type="button" hidden>ログアウト</button>
        <button class="btn-google-auth-revoke" type="button" hidden>Google側のアクセス権も取り消す</button>
        <span data-field="diag-project-list">Project一覧: 未取得</span>
        <span data-field="diag-project-state">選択Project ID: 未接続</span>
        <div data-field="legacy-project-banner" hidden>
          <code data-field="legacy-project-value"></code>
          <button class="btn-google-stt-confirm-legacy-project" type="button">確定</button>
        </div>
      </div>
      <select data-field="project-id-select" disabled></select>
      <input data-field="project-id-input" hidden disabled />
      <button class="btn-google-stt-confirm-project" type="button" hidden disabled>確定</button>
      <button class="btn-google-stt-refresh-projects" type="button" disabled>再取得</button>
      <select data-field="location"><option value="us-central1" selected>us-central1</option></select>
      <button class="btn-google-stt-builtin-test" type="button" disabled>接続・認識テスト</button>
      <button class="btn-google-stt-select-file" type="button" disabled>別の音声ファイルで試す</button>
    </div>
  `;
}

function makeStatus(overrides: Partial<GoogleAuthStatus> = {}): GoogleAuthStatus {
  return {
    state: "disconnected",
    authGeneration: 1,
    oauthClientIdFingerprint: "fp-dev-001",
    oauthClientConfigured: true,
    canonicalScopes: [],
    projectVerified: false,
    ...overrides,
  };
}

describe("google-auth UI & state helpers", () => {
  it("renders disconnected UI without ADC/gcloud instructions", () => {
    document.body.innerHTML = makeGoogleSttCardHtml();
    const section = document.querySelector<HTMLElement>('[data-provider-id="google_stt"]')!;
    applyGoogleAuthStatusToSection(section, makeStatus());

    expect(section.querySelector('[data-field="auth-state"]')!.textContent).toBe("Googleに未接続");
    expect(section.querySelector<HTMLButtonElement>(".btn-google-auth-login")!.hidden).toBe(false);
    expect(section.querySelector<HTMLButtonElement>(".btn-google-auth-switch")!.hidden).toBe(true);
    expect(section.querySelector<HTMLButtonElement>(".btn-google-stt-builtin-test")!.disabled).toBe(true);
    expect(section.textContent).not.toContain("gcloud");
    expect(section.textContent).not.toContain("ADC");
  });

  it("renders oauth_scope_not_granted without marking connected", () => {
    document.body.innerHTML = makeGoogleSttCardHtml();
    const section = document.querySelector<HTMLElement>('[data-provider-id="google_stt"]')!;
    applyGoogleAuthStatusToSection(
      section,
      makeStatus({
        state: "disconnected",
        lastError: {
          kind: "oauth_scope_not_granted",
          message: "必要なGoogle OAuthスコープが付与されていません",
        },
      }),
    );

    const errEl = section.querySelector<HTMLElement>('[data-field="auth-error"]')!;
    expect(errEl.style.display).not.toBe("none");
    expect(errEl.textContent).toContain("oauth_scope_not_granted");
    expect(section.querySelector<HTMLButtonElement>(".btn-google-auth-login")!.hidden).toBe(false);
    expect(getGoogleSttConfiguredState(section)).toBe("unconfigured");
  });

  it("renders connected email, project state, and enables API controls", () => {
    document.body.innerHTML = makeGoogleSttCardHtml();
    const section = document.querySelector<HTMLElement>('[data-provider-id="google_stt"]')!;
    applyGoogleAuthStatusToSection(
      section,
      makeStatus({
        state: "connected",
        email: "user@example.com",
        sub: "sub-123",
        canonicalScopes: ["identity:openid", "identity:email", "google_cloud_api"],
        projectId: "proj-alpha",
        projectVerified: false,
      }),
    );

    expect(section.querySelector('[data-field="auth-account"]')!.textContent).toContain("user@example.com");
    expect(section.querySelector('[data-field="diag-project-state"]')!.textContent).toContain(
      "proj-alpha（現在のアカウントで未確認）",
    );
    expect(section.querySelector<HTMLButtonElement>(".btn-google-auth-switch")!.hidden).toBe(false);
    expect(section.querySelector<HTMLButtonElement>(".btn-google-stt-builtin-test")!.disabled).toBe(false);
    expect(getGoogleSttConfiguredState(section)).toBe("configured");
  });

  it("shows legacy_project_candidate only as unconfirmed candidate, never as configured project", () => {
    document.body.innerHTML = makeGoogleSttCardHtml();
    const section = document.querySelector<HTMLElement>('[data-provider-id="google_stt"]')!;
    applyGoogleAuthStatusToSection(
      section,
      makeStatus({
        state: "connected",
        email: "user@example.com",
        sub: "sub-123",
        canonicalScopes: ["identity:openid", "identity:email", "google_cloud_api"],
        legacyProjectCandidate: "legacy-proj-999",
      }),
    );

    const banner = section.querySelector<HTMLElement>('[data-field="legacy-project-banner"]')!;
    expect(banner.hidden).toBe(false);
    expect(section.querySelector('[data-field="legacy-project-value"]')!.textContent).toBe("legacy-proj-999");
    expect(getGoogleSttConfiguredState(section)).toBe("unconfigured");
  });

  it("disables all Google OAuth and API actions during revoking state", () => {
    document.body.innerHTML = makeGoogleSttCardHtml();
    const section = document.querySelector<HTMLElement>('[data-provider-id="google_stt"]')!;
    applyGoogleAuthStatusToSection(
      section,
      makeStatus({
        state: "revoking",
      }),
    );

    expect(section.querySelector('[data-field="auth-state"]')!.textContent).toContain("取り消し中");
    expect(section.querySelector<HTMLButtonElement>(".btn-google-auth-login")!.disabled).toBe(true);
    expect(section.querySelector<HTMLButtonElement>(".btn-google-stt-refresh-projects")!.disabled).toBe(true);
    expect(section.querySelector<HTMLButtonElement>(".btn-google-stt-builtin-test")!.disabled).toBe(true);
  });

  it("checks required canonical scopes and rejects stale async responses", () => {
    expect(
      hasRequiredGoogleScopes(["identity:openid", "identity:email", "google_cloud_api"]),
    ).toBe(true);
    expect(hasRequiredGoogleScopes(["identity:openid", "identity:email"])).toBe(false);

    const current = makeStatus({
      state: "connected",
      authGeneration: 5,
      sub: "sub-B",
      oauthClientIdFingerprint: "fp-dev",
    });

    expect(
      isGoogleAuthResponseCurrent(current, {
        authGeneration: 5,
        sub: "sub-B",
        oauthClientIdFingerprint: "fp-dev",
      }),
    ).toBe(true);
    expect(
      isGoogleAuthResponseCurrent(current, {
        authGeneration: 4,
        sub: "sub-B",
        oauthClientIdFingerprint: "fp-dev",
      }),
    ).toBe(false);
    expect(
      isGoogleAuthResponseCurrent(current, {
        authGeneration: 5,
        sub: "sub-A",
        oauthClientIdFingerprint: "fp-dev",
      }),
    ).toBe(false);
    expect(
      isGoogleAuthResponseCurrent(
        makeStatus({ state: "revoking", authGeneration: 5, sub: "sub-B" }),
        { authGeneration: 5, sub: "sub-B" },
      ),
    ).toBe(false);
  });

  it("distinguishes oauth_user_cancelled from auth failure", () => {
    const cancelled = parseGoogleApiError({
      kind: "oauth_user_cancelled",
      message: "Googleログインがキャンセルされました。",
    });
    expect(cancelled.isUserCancel).toBe(true);

    const denied = parseGoogleApiError({
      kind: "oauth_consent_denied",
      message: "拒否されました",
    });
    expect(denied.isUserCancel).toBe(false);
  });

  it("discards delayed error without metadata using captured request meta after switch or project change", () => {
    const capturedMeta = {
      authGeneration: 3,
      sub: "sub-A",
      oauthClientIdFingerprint: "fp-dev",
    };
    const parsedErr = parseGoogleApiError(new Error("delayed network timeout"));

    const afterSwitch = makeStatus({
      state: "connected",
      authGeneration: 4,
      sub: "sub-B",
      oauthClientIdFingerprint: "fp-dev",
    });
    expect(
      isGoogleAuthResponseCurrent(afterSwitch, {
        authGeneration: parsedErr.authGeneration ?? capturedMeta.authGeneration,
        sub: parsedErr.sub ?? capturedMeta.sub,
        oauthClientIdFingerprint:
          parsedErr.oauthClientIdFingerprint ?? capturedMeta.oauthClientIdFingerprint,
      }),
    ).toBe(false);

    const afterProjectChange = makeStatus({
      state: "connected",
      authGeneration: 4,
      sub: "sub-A",
      oauthClientIdFingerprint: "fp-dev",
      projectId: "new-proj",
    });
    expect(
      isGoogleAuthResponseCurrent(afterProjectChange, {
        authGeneration: parsedErr.authGeneration ?? capturedMeta.authGeneration,
        sub: parsedErr.sub ?? capturedMeta.sub,
        oauthClientIdFingerprint:
          parsedErr.oauthClientIdFingerprint ?? capturedMeta.oauthClientIdFingerprint,
      }),
    ).toBe(false);
  });

  it("evaluates transcribe availability from auth status and confirmed projectId only", () => {
    expect(isGoogleSttAvailableForTranscribe(null)).toBe(false);
    expect(isGoogleSttAvailableForTranscribe(makeStatus({ state: "disconnected" }))).toBe(false);
    expect(
      isGoogleSttAvailableForTranscribe(
        makeStatus({
          state: "connected",
          canonicalScopes: ["identity:openid", "identity:email", "google_cloud_api"],
        }),
      ),
    ).toBe(false);
    expect(
      isGoogleSttAvailableForTranscribe(
        makeStatus({
          state: "connected",
          canonicalScopes: ["identity:openid", "identity:email", "google_cloud_api"],
          projectId: "proj-123",
        }),
        "us-central1",
      ),
    ).toBe(true);
  });

  it("shows explicit consent retry button when oauth_refresh_token_missing occurs", () => {
    document.body.innerHTML = makeGoogleSttCardHtml();
    const section = document.querySelector<HTMLElement>('[data-provider-id="google_stt"]')!;
    applyGoogleAuthStatusToSection(
      section,
      makeStatus({
        state: "disconnected",
        lastError: {
          kind: "oauth_refresh_token_missing",
          message: "Googleからrefresh tokenが返却されませんでした。",
        },
      }),
    );
    const retryBtn = section.querySelector<HTMLButtonElement>(".btn-google-auth-retry-consent")!;
    expect(retryBtn.hidden).toBe(false);
    expect(retryBtn.disabled).toBe(false);
  });

  it("verifies consumerProject and targetService strictly before prompting API enablement", () => {
    expect(
      canPromptSpeechApiEnable(
        {
          kind: "speech_api_disabled",
          targetService: "speech.googleapis.com",
          consumerProject: "amed-512123",
        },
        "amed-512123",
      ),
    ).toBe(true);
    expect(
      canPromptSpeechApiEnable(
        {
          kind: "speech_api_disabled",
          targetService: "speech.googleapis.com",
          consumerProject: undefined,
        },
        "amed-512123",
      ),
    ).toBe(false);
    expect(
      canPromptSpeechApiEnable(
        {
          kind: "speech_api_disabled",
          targetService: "speech.googleapis.com",
          consumerProject: "other-project",
        },
        "amed-512123",
      ),
    ).toBe(false);
    expect(
      canPromptSpeechApiEnable(
        {
          kind: "speech_api_disabled",
          targetService: "cloudresourcemanager.googleapis.com",
          consumerProject: "amed-512123",
        },
        "amed-512123",
      ),
    ).toBe(false);
    expect(buildGoogleCloudSpeechConsoleUrl("amed-512123")).toBe(
      "https://console.cloud.google.com/apis/library/speech.googleapis.com?project=amed-512123",
    );
  });

  it("evaluates shouldAutoRunDefaultOnboarding for fresh login, duplicate session, verified project, and user_selected upgrade", () => {
    const baseConnected = makeStatus({
      state: "connected",
      email: "u@example.com",
      sub: "sub-1",
      authSessionId: "sess-1",
      canonicalScopes: ["identity:openid", "identity:email", "google_cloud_api"],
      defaultProjectId: "amed-512123",
      projectVerified: false,
    });
    expect(shouldAutoRunDefaultOnboarding(baseConnected, new Set())).toBe(true);
    expect(shouldAutoRunDefaultOnboarding(baseConnected, new Set(["sess-1"]))).toBe(false);
    expect(
      shouldAutoRunDefaultOnboarding(
        { ...baseConnected, projectVerified: true, projectId: "amed-512123", projectSource: "default" },
        new Set(),
      ),
    ).toBe(false);
    expect(
      shouldAutoRunDefaultOnboarding(
        { ...baseConnected, projectId: "custom-proj", projectSource: "user_selected" },
        new Set(),
      ),
    ).toBe(false);
    expect(
      shouldAutoRunDefaultOnboarding(
        { ...baseConnected, defaultProjectId: undefined },
        new Set(),
      ),
    ).toBe(false);
  });
});
