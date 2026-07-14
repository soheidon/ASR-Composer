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
  const projectIdInput = section.querySelector<HTMLInputElement>('[data-field="project-id"]');
  const locationInput = section.querySelector<HTMLSelectElement>('[data-field="location"]');
  const recognizerIdInput = section.querySelector<HTMLInputElement>('[data-field="recognizer-id"]');
  const languageCodeInput = section.querySelector<HTMLInputElement>('[data-field="language-code"]');

  if (projectIdInput) {
    const v = projectIdInput.value.trim();
    if (v) options.project_id = v;
  }
  if (locationInput) {
    const v = locationInput.value.trim();
    if (v) options.location = v;
  }
  if (recognizerIdInput) {
    const v = recognizerIdInput.value.trim();
    if (v) options.recognizer_id = v;
  }
  if (languageCodeInput) {
    const v = languageCodeInput.value.trim();
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
