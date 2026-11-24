export type GoogleAuthConnectionState =
  | "disconnected"
  | "connected"
  | "reauth_required"
  | "revoking";

export type GoogleApiErrorKind =
  | "not_authenticated"
  | "oauth_user_cancelled"
  | "oauth_consent_denied"
  | "oauth_state_mismatch"
  | "oauth_callback_timeout"
  | "oauth_admin_policy_enforced"
  | "oauth_scope_not_granted"
  | "oauth_invalid_grant"
  | "oauth_refresh_token_missing"
  | "token_refresh_failed"
  | "network_error"
  | "project_list_permission_denied"
  | "project_not_accessible"
  | "speech_api_disabled"
  | "service_usage_api_disabled"
  | "service_usage_permission_denied"
  | "service_usage_operation_failed"
  | "service_usage_operation_timeout"
  | "billing_disabled"
  | "speech_permission_denied"
  | "recognizer_not_found"
  | "recognizer_permission_denied"
  | "quota_or_resource_exhausted"
  | "invalid_config"
  | "http_error";

export interface GoogleApiError {
  kind: GoogleApiErrorKind;
  message: string;
  httpStatus?: number;
  apiStatus?: string;
  reason?: string;
  targetService?: string;
  consumerProject?: string;
  authGeneration?: number;
  sub?: string;
  oauthClientIdFingerprint?: string;
}

export type ProjectSource = "default" | "user_selected";

export type GoogleOnboardingOutcome =
  | "ready"
  | "already_ready_user_project"
  | "needs_api_enable_consent"
  | "project_access_denied"
  | "reauth_required"
  | "workspace_denied"
  | "billing_or_quota_error"
  | "network_or_timeout"
  | "configuration_error"
  | "cancelled_or_stale"
  | "error";

export interface GoogleAuthStatus {
  state: GoogleAuthConnectionState;
  authGeneration: number;
  authSessionId?: string;
  oauthClientIdFingerprint: string;
  oauthClientConfigured: boolean;
  email?: string;
  sub?: string;
  hostedDomain?: string;
  canonicalScopes: string[];
  projectId?: string;
  projectVerified: boolean;
  projectSource?: ProjectSource;
  defaultProjectId?: string;
  legacyProjectCandidate?: string;
  lastError?: GoogleApiError;
}

export interface GoogleOnboardingResult {
  outcome: GoogleOnboardingOutcome;
  message: string;
  projectId?: string;
  email?: string;
  requiredPermission?: string;
  targetService?: string;
  consumerProject?: string;
  authGeneration: number;
  authSessionId: string;
  sub?: string;
  oauthClientIdFingerprint: string;
  status: GoogleAuthStatus;
}

export function shouldAutoRunDefaultOnboarding(
  status: GoogleAuthStatus | null | undefined,
  attemptedSessionIds: ReadonlySet<string>,
): boolean {
  if (!status || status.state !== "connected") return false;
  if (!status.oauthClientConfigured) return false;
  if (!status.email || !hasRequiredGoogleScopes(status.canonicalScopes)) return false;
  if (!status.defaultProjectId?.trim()) return false;
  if (status.projectVerified) return false;
  if (status.projectSource === "user_selected" && status.projectId?.trim()) return false;
  if (!status.authSessionId || attemptedSessionIds.has(status.authSessionId)) return false;
  return true;
}

export interface GoogleAuthRevokeResult {
  loggedOut: boolean;
  revokedOnGoogle: boolean;
  message: string;
  status: GoogleAuthStatus;
}

export interface GoogleCloudListProjectsResult {
  projects: Array<{ projectId: string; name: string }>;
  authGeneration: number;
  sub: string;
  oauthClientIdFingerprint: string;
}

export const REQUIRED_CANONICAL_SCOPES = [
  "identity:openid",
  "identity:email",
  "google_cloud_api",
] as const;

export function hasRequiredGoogleScopes(canonicalScopes: string[]): boolean {
  return REQUIRED_CANONICAL_SCOPES.every((req) => canonicalScopes.includes(req));
}

export function isGoogleSttAvailableForTranscribe(
  authStatus: GoogleAuthStatus | null | undefined,
  savedLocation?: string,
): boolean {
  if (!authStatus || authStatus.state !== "connected") {
    return false;
  }
  if (!hasRequiredGoogleScopes(authStatus.canonicalScopes)) {
    return false;
  }
  if (!authStatus.projectId?.trim()) {
    return false;
  }
  if (savedLocation !== undefined && !savedLocation.trim()) {
    return false;
  }
  return true;
}

export function isGoogleAuthResponseCurrent(
  current: GoogleAuthStatus | null | undefined,
  meta: {
    authGeneration?: number;
    sub?: string;
    oauthClientIdFingerprint?: string;
  },
): boolean {
  if (!current || current.state !== "connected") {
    return false;
  }
  if (
    meta.authGeneration !== undefined &&
    meta.authGeneration !== current.authGeneration
  ) {
    return false;
  }
  if (meta.sub !== undefined && meta.sub !== current.sub) {
    return false;
  }
  if (
    meta.oauthClientIdFingerprint !== undefined &&
    meta.oauthClientIdFingerprint !== current.oauthClientIdFingerprint
  ) {
    return false;
  }
  return true;
}

export interface SpeechApiEnableStateResult {
  projectId: string;
  serviceName: string;
  state: string;
  authGeneration: number;
  sub: string;
  oauthClientIdFingerprint: string;
}

export interface EnableSpeechApiResult {
  projectId: string;
  serviceName: string;
  status: string;
  operationName?: string;
  authGeneration: number;
  sub: string;
  oauthClientIdFingerprint: string;
}

export function buildGoogleCloudSpeechConsoleUrl(projectId: string): string {
  return `https://console.cloud.google.com/apis/library/speech.googleapis.com?project=${encodeURIComponent(projectId.trim())}`;
}

export function canPromptSpeechApiEnable(
  parsed: {
    kind?: string;
    targetService?: string;
    consumerProject?: string;
  },
  selectedProjectId: string,
): boolean {
  const pid = selectedProjectId.trim();
  if (!pid) return false;
  return (
    parsed.kind === "speech_api_disabled" &&
    parsed.targetService === "speech.googleapis.com" &&
    parsed.consumerProject === pid
  );
}

export function parseGoogleApiError(error: unknown): {
  kind?: string;
  message: string;
  isUserCancel: boolean;
  targetService?: string;
  consumerProject?: string;
  authGeneration?: number;
  sub?: string;
  oauthClientIdFingerprint?: string;
} {
  if (typeof error === "string") {
    return { message: error, isUserCancel: false };
  }
  if (error instanceof Error) {
    return { message: error.message, isUserCancel: false };
  }
  if (error && typeof error === "object") {
    const rec = error as Record<string, unknown>;
    const kind = typeof rec.kind === "string" ? rec.kind : undefined;
    const message =
      typeof rec.message === "string" ? rec.message : JSON.stringify(error);
    return {
      kind,
      message,
      isUserCancel: kind === "oauth_user_cancelled",
      targetService: typeof rec.targetService === "string" ? rec.targetService : undefined,
      consumerProject: typeof rec.consumerProject === "string" ? rec.consumerProject : undefined,
      authGeneration:
        typeof rec.authGeneration === "number" ? rec.authGeneration : undefined,
      sub: typeof rec.sub === "string" ? rec.sub : undefined,
      oauthClientIdFingerprint:
        typeof rec.oauthClientIdFingerprint === "string"
          ? rec.oauthClientIdFingerprint
          : undefined,
    };
  }
  return { message: String(error), isUserCancel: false };
}

export function applyGoogleAuthStatusToSection(
  section: HTMLElement,
  status: GoogleAuthStatus,
  options: { restoreProjectControls?: boolean } = {},
): void {
  const isRevoking = status.state === "revoking";
  const isConnected =
    status.state === "connected" &&
    Boolean(status.email) &&
    hasRequiredGoogleScopes(status.canonicalScopes);

  section.dataset.googleAuthState = status.state;
  section.dataset.googleAuthGeneration = String(status.authGeneration);
  section.dataset.googleAuthSub = status.sub ?? "";
  section.dataset.googleAuthFingerprint = status.oauthClientIdFingerprint;
  section.dataset.googleProjectId = status.projectId ?? "";
  section.dataset.googleProjectVerified = String(status.projectVerified);
  section.dataset.googleProjectSource = status.projectSource ?? "";

  const stateEl = section.querySelector<HTMLElement>('[data-field="auth-state"]');
  const accountEl = section.querySelector<HTMLElement>('[data-field="auth-account"]');
  const authErrorEl = section.querySelector<HTMLElement>('[data-field="auth-error"]');
  const loginBtn = section.querySelector<HTMLButtonElement>(".btn-google-auth-login");
  const retryConsentBtn = section.querySelector<HTMLButtonElement>(".btn-google-auth-retry-consent");
  const switchBtn = section.querySelector<HTMLButtonElement>(".btn-google-auth-switch");
  const logoutBtn = section.querySelector<HTMLButtonElement>(".btn-google-auth-logout");
  const revokeBtn = section.querySelector<HTMLButtonElement>(".btn-google-auth-revoke");
  const refreshBtn = section.querySelector<HTMLButtonElement>(".btn-google-stt-refresh-projects");
  const confirmProjectBtn = section.querySelector<HTMLButtonElement>(".btn-google-stt-confirm-project");
  const builtinTestBtn = section.querySelector<HTMLButtonElement>(".btn-google-stt-builtin-test");
  const selectFileBtn = section.querySelector<HTMLButtonElement>(".btn-google-stt-select-file");
  const projectSelect = section.querySelector<HTMLSelectElement>('[data-field="project-id-select"]');
  const projectInput = section.querySelector<HTMLInputElement>('[data-field="project-id-input"]');
  const projectStateEl = section.querySelector<HTMLElement>('[data-field="diag-project-state"]');
  const setupGuidanceEl = section.querySelector<HTMLElement>('[data-field="setup-guidance"]');
  const enableConfirmPanel = section.querySelector<HTMLElement>('[data-field="api-enable-confirm-panel"]');
  const fallbackPanel = section.querySelector<HTMLElement>('[data-field="api-fallback-panel"]');
  const legacyBanner = section.querySelector<HTMLElement>('[data-field="legacy-project-banner"]');
  const legacyValueEl = section.querySelector<HTMLElement>('[data-field="legacy-project-value"]');

  if (stateEl) {
    if (isRevoking) {
      stateEl.textContent = "Googleアクセス権を取り消し中...";
    } else if (isConnected && status.projectVerified) {
      stateEl.textContent = "Googleアカウント: 利用可能";
    } else if (isConnected) {
      stateEl.textContent = "Googleアカウント: 接続済み";
    } else if (status.state === "reauth_required") {
      stateEl.textContent = "再ログインが必要です";
    } else {
      stateEl.textContent = "Googleに未接続";
    }
  }

  if (accountEl) {
    if (isConnected && status.email) {
      const domainSuffix = status.hostedDomain ? ` (${status.hostedDomain})` : "";
      accountEl.textContent = `接続中: ${status.email}${domainSuffix}`;
      accountEl.hidden = false;
    } else {
      accountEl.textContent = "";
      accountEl.hidden = true;
    }
  }

  if (authErrorEl) {
    if (status.lastError && (!isConnected || status.lastError.kind === "oauth_refresh_token_missing")) {
      authErrorEl.textContent =
        status.lastError.kind === "oauth_scope_not_granted"
          ? `${status.lastError.message} (${status.lastError.kind})`
          : status.lastError.message;
      authErrorEl.style.display = "";
    } else {
      authErrorEl.textContent = "";
      authErrorEl.style.display = "none";
    }
  }

  if (loginBtn) {
    loginBtn.hidden = isConnected;
    loginBtn.disabled = isRevoking || !status.oauthClientConfigured;
  }
  if (retryConsentBtn) {
    const showRetry = status.lastError?.kind === "oauth_refresh_token_missing";
    retryConsentBtn.hidden = !showRetry;
    retryConsentBtn.disabled = isRevoking || !status.oauthClientConfigured;
  }
  if (switchBtn) {
    switchBtn.hidden = !isConnected;
    switchBtn.disabled = isRevoking;
  }
  if (logoutBtn) {
    logoutBtn.hidden = !isConnected;
    logoutBtn.disabled = isRevoking;
  }
  if (revokeBtn) {
    revokeBtn.hidden = !isConnected;
    revokeBtn.disabled = isRevoking;
  }

  const apiDisabled = !isConnected || isRevoking;
  if (refreshBtn) refreshBtn.disabled = apiDisabled;
  if (confirmProjectBtn) confirmProjectBtn.disabled = apiDisabled;
  if (builtinTestBtn) builtinTestBtn.disabled = apiDisabled;
  if (selectFileBtn) selectFileBtn.disabled = apiDisabled;
  if (projectSelect) projectSelect.disabled = apiDisabled;
  if (projectInput) projectInput.disabled = apiDisabled;

  // The persisted Project is authoritative. Restore the controls whenever status is
  // refreshed so a rejected/stale confirmation cannot leave a different candidate shown.
  if (options.restoreProjectControls && projectSelect && status.projectId) {
    const persistedProjectId = status.projectId.trim();
    if ([...projectSelect.options].some((option) => option.value === persistedProjectId)) {
      projectSelect.value = persistedProjectId;
    } else {
      projectSelect.value = "";
    }
  } else if (options.restoreProjectControls && projectSelect) {
    projectSelect.value = "";
  }
  if (options.restoreProjectControls && projectInput) {
    projectInput.value = status.projectId ?? "";
  }

  if (projectStateEl) {
    if (!isConnected) {
      projectStateEl.textContent = "選択Project ID: 未接続";
    } else if (!status.projectId) {
      projectStateEl.textContent = "選択Project ID: 未選択";
    } else if (status.projectVerified) {
      projectStateEl.textContent = `選択Project ID: ${status.projectId}（確認済み）`;
    } else {
      projectStateEl.textContent = `選択Project ID: ${status.projectId}（現在のアカウントで未確認）`;
    }
  }

  if (legacyBanner && legacyValueEl) {
    if (status.legacyProjectCandidate && !status.projectId) {
      legacyValueEl.textContent = status.legacyProjectCandidate;
      legacyBanner.hidden = false;
    } else {
      legacyValueEl.textContent = "";
      legacyBanner.hidden = true;
    }
  }

  if (setupGuidanceEl) {
    if (!status.oauthClientConfigured) {
      setupGuidanceEl.textContent = "アプリの Google Cloud 設定が不完全です。提供元の設定を確認してください。";
    } else if (!isConnected) {
      setupGuidanceEl.textContent = "「Googleにログイン」を押して Google アカウントを選択してください。";
    } else if (status.projectVerified) {
      setupGuidanceEl.textContent = `利用可能: ${status.email} / Project ${status.projectId} で Google Speech-to-Text を利用できます。`;
    } else if (status.projectSource === "user_selected" && status.projectId) {
      setupGuidanceEl.textContent = "詳細設定で選択した Project の接続テストを実行してください。";
    } else {
      setupGuidanceEl.textContent = "Google Cloud の接続準備を確認しています…";
    }
  }

  if (enableConfirmPanel) {
    enableConfirmPanel.hidden = true;
  }
  if (fallbackPanel) {
    fallbackPanel.hidden = true;
  }
}
