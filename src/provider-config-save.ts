/**
 * Provider config auto-save state and logic.
 *
 * Manages dirty tracking, revision numbers, and per-provider save queues.
 * Also provides DOM value reading and model-fetch pre-save preparation.
 */

export interface ProviderConfigValues {
  envName: string;
  baseUrl: string;
  defaultModel: string | null;
  options?: Record<string, string>;
}

export interface ProviderConfigState {
  markDirty(providerId: string): void;
  isDirty(providerId: string): boolean;
  getRevision(providerId: string): number;
  clearDirtyIfUnchanged(providerId: string, expectedRevision: number): boolean;
  queueSave(
    providerId: string,
    save: () => Promise<boolean>,
  ): Promise<boolean>;
  getPendingSave(providerId: string): Promise<boolean> | undefined;
}

export function createProviderConfigState(): ProviderConfigState {
  const dirty = new Set<string>();
  const revisions = new Map<string, number>();
  const queues = new Map<string, Promise<boolean>>();

  return {
    markDirty(providerId: string): void {
      dirty.add(providerId);
      revisions.set(providerId, (revisions.get(providerId) ?? 0) + 1);
    },

    isDirty(providerId: string): boolean {
      return dirty.has(providerId);
    },

    getRevision(providerId: string): number {
      return revisions.get(providerId) ?? 0;
    },

    clearDirtyIfUnchanged(
      providerId: string,
      expectedRevision: number,
    ): boolean {
      if ((revisions.get(providerId) ?? 0) === expectedRevision) {
        dirty.delete(providerId);
        return true;
      }
      return false;
    },

    queueSave(
      providerId: string,
      save: () => Promise<boolean>,
    ): Promise<boolean> {
      const previous = queues.get(providerId) ?? Promise.resolve(true);
      const next = previous
        .catch(() => false)
        .then(() => save())
        .catch(() => false)
        .finally(() => {
          if (queues.get(providerId) === next) {
            queues.delete(providerId);
          }
        });
      queues.set(providerId, next);
      return next;
    },

    getPendingSave(
      providerId: string,
    ): Promise<boolean> | undefined {
      return queues.get(providerId);
    },
  };
}

// ---- Google STT: Project list helpers ----

export interface GoogleSttProject {
  projectId: string;
  name: string;
}

export interface GoogleSttProjectOption {
  value: string;
  label: string;
  kind: "project" | "saved" | "manual";
}

export function buildGoogleSttProjectOptions(params: {
  projects: GoogleSttProject[];
  currentProject: string | null;
  savedProjectId: string | null;
}): {
  options: GoogleSttProjectOption[];
  selectedValue: string;
  selectedBy: "saved" | "current" | "none";
} {
  const options: GoogleSttProjectOption[] = [];
  let selectedValue = "";
  let selectedBy: "saved" | "current" | "none" = "none";

  // 保存済みproject_idがある場合
  if (params.savedProjectId) {
    const savedInList = params.projects.some(
      (p) => p.projectId === params.savedProjectId,
    );
    if (!savedInList) {
      // 一覧にない保存値は先頭に追加
      options.push({
        value: params.savedProjectId,
        label: params.savedProjectId,
        kind: "saved",
      });
    }
    selectedValue = params.savedProjectId;
    selectedBy = "saved";
  }

  // プロジェクト一覧
  for (const project of params.projects) {
    const isSelected =
      selectedBy === "none" &&
      params.currentProject != null &&
      project.projectId === params.currentProject;
    if (isSelected) {
      selectedValue = project.projectId;
      selectedBy = "current";
    }
    options.push({
      value: project.projectId,
      label: project.name,
      kind: "project",
    });
  }

  // 末尾に__manual__を追加
  options.push({ value: "__manual__", label: "手動入力...", kind: "manual" });

  return { options, selectedValue, selectedBy };
}

export function shouldAutoSaveProject(params: {
  selectedBy: "saved" | "current" | "none";
  savedProjectId: string | null;
}): boolean {
  return params.selectedBy === "current" && params.savedProjectId === null;
}

// ---- Google STT: DOM helpers ----

export function setGoogleSttAdvancedOpen(
  button: HTMLButtonElement,
  content: HTMLElement,
  open: boolean,
): void {
  content.hidden = !open;
  button.setAttribute("aria-expanded", String(open));
}

export function ensureSelectValue(
  select: HTMLSelectElement,
  value: string,
  label: string = value,
): void {
  const exists = Array.from(select.options).some(
    (option) => option.value === value,
  );
  if (!exists) {
    select.add(new Option(label, value));
  }
  select.value = value;
}

// ---- Google STT: status management ----

export type GoogleSttConnectionState =
  | "unconfigured"
  | "configured"
  | "verified"
  | "error";

export function getGoogleSttConfiguredState(
  section: Element,
): "unconfigured" | "configured" {
  const projectId = getGoogleSttProjectId(section);
  const location =
    section
      .querySelector<HTMLSelectElement>('[data-field="location"]')
      ?.value
      .trim() ?? "";

  return projectId && location ? "configured" : "unconfigured";
}

const GOOGLE_STT_STATUS_LABELS: Record<GoogleSttConnectionState, string> = {
  unconfigured: "未設定",
  configured: "設定済み",
  verified: "接続確認済み",
  error: "接続エラー",
};

export function setGoogleSttStatus(
  item: HTMLElement,
  state: GoogleSttConnectionState,
  setBadge: (el: HTMLElement, label: string) => void,
): void {
  const badge = item.querySelector<HTMLElement>("[data-status-badge]");
  if (!badge) return;

  badge.dataset.connectionState = state;
  setBadge(badge, GOOGLE_STT_STATUS_LABELS[state]);
}

export function invalidateGoogleSttVerification(
  item: HTMLElement,
  setBadge: (el: HTMLElement, label: string) => void,
): void {
  const configuredState = getGoogleSttConfiguredState(item);
  setGoogleSttStatus(item, configuredState, setBadge);
}

export function getGoogleSttProjectId(section: Element): string {
  const select = section.querySelector<HTMLSelectElement>(
    '[data-field="project-id-select"]',
  );
  const input = section.querySelector<HTMLInputElement>(
    '[data-field="project-id-input"]',
  );

  const selectIsUsable =
    select != null &&
    !select.hidden &&
    select.value !== "__manual__";

  if (selectIsUsable) {
    return select.value.trim();
  }

  return input?.value.trim() ?? "";
}

export function readProviderConfigFromSection(
  section: HTMLElement,
): ProviderConfigValues | null {
  const envInput = section.querySelector<HTMLInputElement>(".api-env-input");
  const baseUrlInput = section.querySelector<HTMLInputElement>(
    '[data-field="base-url"]',
  );
  const modelSelect = section.querySelector<HTMLSelectElement>(
    '[data-field="model"]',
  );
  const modelManualInput = section.querySelector<HTMLInputElement>(
    '[data-field="model-manual"]',
  );

  const envName = envInput?.value.trim() ?? "";
  if (!envName) return null;

  const baseUrl = baseUrlInput?.value.trim() ?? "";
  const selectedModel = modelSelect?.value.trim() ?? "";
  const defaultModelRaw =
    selectedModel === "__manual__"
      ? (modelManualInput?.value.trim() ?? "")
      : selectedModel;

  // Google STT options
  const options: Record<string, string> = {};
  const projectId = getGoogleSttProjectId(section);
  const locationInput = section.querySelector<HTMLSelectElement>('[data-field="location"]');
  const recognizerIdInput = section.querySelector<HTMLInputElement>('[data-field="recognizer-id"]');
  const languageCodeSelect = section.querySelector<HTMLSelectElement>('[data-field="language-code"]');

  if (projectId) options.project_id = projectId;
  if (locationInput) {
    const v = locationInput.value.trim();
    if (v) options.location = v;
  }
  if (recognizerIdInput) {
    const v = recognizerIdInput.value.trim();
    if (v) options.recognizer_id = v;
  }
  if (languageCodeSelect) {
    const v = languageCodeSelect.value.trim();
    if (v) options.language_code = v;
  }

  return {
    envName,
    baseUrl,
    defaultModel: defaultModelRaw || null,
    ...(Object.keys(options).length > 0 ? { options } : undefined),
  };
}

export async function saveDirtyProviderConfig(options: {
  providerId: string;
  section: HTMLElement;
  state: ProviderConfigState;
  saveConfig: (
    providerId: string,
    section: HTMLElement,
  ) => Promise<boolean>;
}): Promise<boolean> {
  const revisionAtStart = options.state.getRevision(options.providerId);
  const saved = await options.state.queueSave(options.providerId, () =>
    options.saveConfig(options.providerId, options.section),
  );
  if (saved) {
    options.state.clearDirtyIfUnchanged(
      options.providerId,
      revisionAtStart,
    );
  }
  return saved;
}

const maxSaveAttempts = 5;

export type PrepareResult =
  | { ok: true }
  | { ok: false; reason: "empty-env" | "save-failed" };

export async function prepareProviderForModelFetch(options: {
  providerId: string;
  section: HTMLElement;
  state: ProviderConfigState;
  saveConfig: (
    providerId: string,
    section: HTMLElement,
  ) => Promise<boolean>;
}): Promise<PrepareResult> {
  const parsed = readProviderConfigFromSection(options.section);
  if (!parsed) return { ok: false, reason: "empty-env" };

  const pending = options.state.getPendingSave(options.providerId);
  if (pending) {
    await pending.catch(() => false);
  }

  for (let attempt = 0; attempt < maxSaveAttempts; attempt += 1) {
    if (!options.state.isDirty(options.providerId)) {
      return { ok: true };
    }

    const saved = await saveDirtyProviderConfig({
      providerId: options.providerId,
      section: options.section,
      state: options.state,
      saveConfig: options.saveConfig,
    });

    if (!saved) {
      return { ok: false, reason: "save-failed" };
    }
  }

  return options.state.isDirty(options.providerId)
    ? { ok: false, reason: "save-failed" }
    : { ok: true };
}

// ---- Google STT: button loading state helpers ----

export interface ButtonLoadingState {
  originalHtml: string;
}

export function setButtonLoading(
  btn: HTMLButtonElement,
  loadingHtml: string,
): ButtonLoadingState {
  const state: ButtonLoadingState = { originalHtml: btn.innerHTML };
  btn.innerHTML = loadingHtml;
  btn.disabled = true;
  return state;
}

export function restoreButtonLoading(
  btn: HTMLButtonElement,
  state: ButtonLoadingState,
): void {
  btn.innerHTML = state.originalHtml;
  btn.disabled = false;
}
