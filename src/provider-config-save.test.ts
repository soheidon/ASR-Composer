// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import {
  createProviderConfigState,
  readProviderConfigFromSection,
  saveDirtyProviderConfig,
  prepareProviderForModelFetch,
  getGoogleSttProjectId,
  buildGoogleSttProjectOptions,
  shouldAutoSaveProject,
  setGoogleSttAdvancedOpen,
  ensureSelectValue,
  getGoogleSttConfiguredState,
  setGoogleSttStatus,
  invalidateGoogleSttVerification,
  setButtonLoading,
  restoreButtonLoading,
  type ProviderConfigValues,
} from "./provider-config-save";

// ---- createProviderConfigState / dirty management ----

describe("createProviderConfigState", () => {
  it("new state is clean", () => {
    const state = createProviderConfigState();
    expect(state.isDirty("openai")).toBe(false);
  });

  it("markDirty adds to dirty set", () => {
    const state = createProviderConfigState();
    state.markDirty("openai");
    expect(state.isDirty("openai")).toBe(true);
  });

  it("markDirty starts revision at 1", () => {
    const state = createProviderConfigState();
    state.markDirty("openai");
    expect(state.getRevision("openai")).toBe(1);
  });

  it("markDirty accumulates revision", () => {
    const state = createProviderConfigState();
    state.markDirty("openai");
    state.markDirty("openai");
    expect(state.getRevision("openai")).toBe(2);
  });

  it("different providers have independent revisions", () => {
    const state = createProviderConfigState();
    state.markDirty("openai");
    state.markDirty("anthropic");
    expect(state.getRevision("openai")).toBe(1);
    expect(state.getRevision("anthropic")).toBe(1);
  });

  it("clearDirtyIfUnchanged clears on revision match", () => {
    const state = createProviderConfigState();
    state.markDirty("openai");
    const cleared = state.clearDirtyIfUnchanged("openai", 1);
    expect(cleared).toBe(true);
    expect(state.isDirty("openai")).toBe(false);
  });

  it("clearDirtyIfUnchanged keeps dirty on revision mismatch", () => {
    const state = createProviderConfigState();
    state.markDirty("openai");
    state.markDirty("openai");
    const cleared = state.clearDirtyIfUnchanged("openai", 1);
    expect(cleared).toBe(false);
    expect(state.isDirty("openai")).toBe(true);
  });

  it("getPendingSave returns undefined when no save queued", () => {
    const state = createProviderConfigState();
    expect(state.getPendingSave("openai")).toBeUndefined();
  });
});

// ---- queueSave ----

describe("queueSave", () => {
  it("returns true on save success", async () => {
    const state = createProviderConfigState();
    const result = await state.queueSave("openai", async () => true);
    expect(result).toBe(true);
  });

  it("returns false on save failure", async () => {
    const state = createProviderConfigState();
    const result = await state.queueSave("openai", async () => false);
    expect(result).toBe(false);
  });

  it("runs next save even if previous returned false", async () => {
    const state = createProviderConfigState();
    const calls: number[] = [];
    const p1 = state.queueSave("openai", async () => {
      calls.push(1);
      return false;
    });
    const p2 = state.queueSave("openai", async () => {
      calls.push(2);
      return true;
    });
    await p1;
    const r2 = await p2;
    expect(calls).toEqual([1, 2]);
    expect(r2).toBe(true);
  });

  it("runs next save even if previous threw", async () => {
    const state = createProviderConfigState();
    const calls: number[] = [];
    const p1 = state.queueSave("openai", async () => {
      calls.push(1);
      throw new Error("boom");
    });
    const p2 = state.queueSave("openai", async () => {
      calls.push(2);
      return true;
    });
    await p1;
    const r2 = await p2;
    expect(calls).toEqual([1, 2]);
    expect(r2).toBe(true);
  });

  it("saves execute in insertion order (no out-of-order completion)", async () => {
    const state = createProviderConfigState();
    const order: number[] = [];
    const p1 = state.queueSave("openai", async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push(1);
      return true;
    });
    const p2 = state.queueSave("openai", async () => {
      order.push(2);
      return true;
    });
    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });

  it("pending save clears after all saves complete", async () => {
    const state = createProviderConfigState();
    const p = state.queueSave("openai", async () => true);
    expect(state.getPendingSave("openai")).toBe(p);
    await p;
    expect(state.getPendingSave("openai")).toBeUndefined();
  });

  it("getPendingSave returns the same promise as queueSave", async () => {
    const state = createProviderConfigState();
    const p = state.queueSave("openai", () =>
      new Promise<boolean>((r) => setTimeout(() => r(true), 5)),
    );
    const pending = state.getPendingSave("openai");
    expect(pending).toBe(p);
    const result = await pending!;
    expect(result).toBe(true);
  });
});

// ---- readProviderConfigFromSection ----

function makeSection(fields: {
  env?: string;
  baseUrl?: string;
  model?: string;
  manual?: string;
  extraInputs?: { selector: string; value: string }[];
  extraSelects?: { selector: string; value: string }[];
}): HTMLElement {
  const section = document.createElement("div");
  if (fields.env !== undefined) {
    const input = document.createElement("input");
    input.className = "api-env-input";
    input.value = fields.env;
    section.appendChild(input);
  }
  if (fields.baseUrl !== undefined) {
    const input = document.createElement("input");
    input.setAttribute("data-field", "base-url");
    input.value = fields.baseUrl;
    section.appendChild(input);
  }
  if (fields.model !== undefined) {
    const select = document.createElement("select");
    select.setAttribute("data-field", "model");
    const opt = document.createElement("option");
    opt.value = fields.model;
    opt.selected = true;
    select.appendChild(opt);
    section.appendChild(select);
  }
  if (fields.manual !== undefined) {
    const input = document.createElement("input");
    input.setAttribute("data-field", "model-manual");
    input.value = fields.manual;
    section.appendChild(input);
  }
  for (const extra of fields.extraInputs ?? []) {
    const match = extra.selector.match(/\[data-field="([^"]+)"\]/);
    if (match) {
      const input = document.createElement("input");
      input.setAttribute("data-field", match[1]);
      input.value = extra.value;
      section.appendChild(input);
    }
  }
  for (const extra of fields.extraSelects ?? []) {
    const match = extra.selector.match(/\[data-field="([^"]+)"\]/);
    if (match) {
      const sel = document.createElement("select");
      sel.setAttribute("data-field", match[1]);
      const opt = document.createElement("option");
      opt.value = extra.value;
      opt.selected = true;
      sel.appendChild(opt);
      section.appendChild(sel);
    }
  }
  return section;
}

describe("readProviderConfigFromSection", () => {
  it("returns full object when all fields present", () => {
    const section = makeSection({
      env: "MY_KEY",
      baseUrl: "https://api.example.com",
      model: "gpt-4",
    });
    expect(readProviderConfigFromSection(section)).toEqual<ProviderConfigValues>({
      envName: "MY_KEY",
      baseUrl: "https://api.example.com",
      defaultModel: "gpt-4",
    });
  });

  it("returns null when envName is empty", () => {
    const section = makeSection({ env: "" });
    expect(readProviderConfigFromSection(section)).toBeNull();
  });

  it("returns null when envName is whitespace only", () => {
    const section = makeSection({ env: "   " });
    expect(readProviderConfigFromSection(section)).toBeNull();
  });

  it("returns null when env input is missing", () => {
    const section = makeSection({ model: "gpt-4" });
    expect(readProviderConfigFromSection(section)).toBeNull();
  });

  it("trims envName", () => {
    const section = makeSection({ env: "  MY_KEY  " });
    expect(readProviderConfigFromSection(section)!.envName).toBe("MY_KEY");
  });

  it("trims baseUrl", () => {
    const section = makeSection({
      env: "KEY",
      baseUrl: "  https://x.com  ",
    });
    expect(readProviderConfigFromSection(section)!.baseUrl).toBe("https://x.com");
  });

  it("uses manual input when select is __manual__", () => {
    const section = makeSection({
      env: "KEY",
      model: "__manual__",
      manual: "custom-model",
    });
    expect(readProviderConfigFromSection(section)!.defaultModel).toBe("custom-model");
  });

  it("returns null defaultModel when __manual__ and manual is empty", () => {
    const section = makeSection({
      env: "KEY",
      model: "__manual__",
      manual: "",
    });
    expect(readProviderConfigFromSection(section)!.defaultModel).toBeNull();
  });

  it("returns null defaultModel when regular model is empty string", () => {
    const section = makeSection({ env: "KEY" });
    expect(readProviderConfigFromSection(section)!.defaultModel).toBeNull();
  });

  it("includes options when all Google STT option fields are present", () => {
    const section = makeSection({
      env: "GOOGLE_APPLICATION_CREDENTIALS",
      model: "chirp_2",
      extraInputs: [
        { selector: '[data-field="recognizer-id"]', value: "_" },
      ],
      extraSelects: [
        { selector: '[data-field="project-id-select"]', value: "my-project-123" },
        { selector: '[data-field="location"]', value: "us-central1" },
        { selector: '[data-field="language-code"]', value: "ja-JP" },
      ],
    });
    const result = readProviderConfigFromSection(section);
    expect(result!.options).toEqual({
      project_id: "my-project-123",
      location: "us-central1",
      recognizer_id: "_",
      language_code: "ja-JP",
    });
  });

  it("includes only non-empty options", () => {
    const section = makeSection({
      env: "GOOGLE_APPLICATION_CREDENTIALS",
      model: "chirp_2",
      extraInputs: [
        { selector: '[data-field="recognizer-id"]', value: "" },
      ],
      extraSelects: [
        { selector: '[data-field="project-id-select"]', value: "test-proj" },
        { selector: '[data-field="location"]', value: "europe-west4" },
      ],
    });
    const result = readProviderConfigFromSection(section);
    expect(result!.options).toEqual({
      project_id: "test-proj",
      location: "europe-west4",
    });
  });

  it("returns undefined options when no option fields exist in DOM", () => {
    const section = makeSection({ env: "KEY", model: "gpt-4o" });
    const result = readProviderConfigFromSection(section);
    expect(result!.options).toBeUndefined();
  });
});

// ---- saveDirtyProviderConfig ----

describe("saveDirtyProviderConfig", () => {
  it("clears dirty on save success with matching revision", async () => {
    const state = createProviderConfigState();
    state.markDirty("openai");
    const section = makeSection({ env: "KEY" });
    const saved = await saveDirtyProviderConfig({
      providerId: "openai",
      section,
      state,
      saveConfig: async () => true,
    });
    expect(saved).toBe(true);
    expect(state.isDirty("openai")).toBe(false);
  });

  it("keeps dirty on save success with mismatched revision", async () => {
    const state = createProviderConfigState();
    state.markDirty("openai");
    const section = makeSection({ env: "KEY" });
    const saved = await saveDirtyProviderConfig({
      providerId: "openai",
      section,
      state,
      saveConfig: async () => {
        state.markDirty("openai"); // simulate concurrent edit during save
        return true;
      },
    });
    expect(saved).toBe(true);
    expect(state.isDirty("openai")).toBe(true);
    expect(state.getRevision("openai")).toBe(2);
  });

  it("keeps dirty on save failure", async () => {
    const state = createProviderConfigState();
    state.markDirty("openai");
    const section = makeSection({ env: "KEY" });
    const saved = await saveDirtyProviderConfig({
      providerId: "openai",
      section,
      state,
      saveConfig: async () => false,
    });
    expect(saved).toBe(false);
    expect(state.isDirty("openai")).toBe(true);
  });

  it("returns false when saveConfig throws", async () => {
    const state = createProviderConfigState();
    state.markDirty("openai");
    const section = makeSection({ env: "KEY" });
    const saved = await saveDirtyProviderConfig({
      providerId: "openai",
      section,
      state,
      saveConfig: async () => {
        throw new Error("invoke failed");
      },
    });
    expect(saved).toBe(false);
    expect(state.isDirty("openai")).toBe(true);
  });
});

// ---- prepareProviderForModelFetch ----

describe("prepareProviderForModelFetch", () => {
  it("returns ok without saving when clean", async () => {
    const state = createProviderConfigState();
    const section = makeSection({ env: "KEY" });
    const saveConfig = vi.fn(async () => true);
    const result = await prepareProviderForModelFetch({
      providerId: "openai",
      section,
      state,
      saveConfig,
    });
    expect(result).toEqual({ ok: true });
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it("returns ok after saving when dirty", async () => {
    const state = createProviderConfigState();
    state.markDirty("openai");
    const section = makeSection({ env: "KEY" });
    const result = await prepareProviderForModelFetch({
      providerId: "openai",
      section,
      state,
      saveConfig: async () => true,
    });
    expect(result).toEqual({ ok: true });
    expect(state.isDirty("openai")).toBe(false);
  });

  it("returns save-failed when save fails", async () => {
    const state = createProviderConfigState();
    state.markDirty("openai");
    const section = makeSection({ env: "KEY" });
    const result = await prepareProviderForModelFetch({
      providerId: "openai",
      section,
      state,
      saveConfig: async () => false,
    });
    expect(result).toEqual({ ok: false, reason: "save-failed" });
  });

  it("returns ok when pending save failed but no dirty remains", async () => {
    const state = createProviderConfigState();
    // Queue a failing save
    state.queueSave("openai", async () => false);
    const section = makeSection({ env: "KEY" });
    const result = await prepareProviderForModelFetch({
      providerId: "openai",
      section,
      state,
      saveConfig: async () => true,
    });
    expect(result).toEqual({ ok: true });
  });

  it("returns empty-env when envName is empty", async () => {
    const state = createProviderConfigState();
    const section = makeSection({ env: "" });
    const saveConfig = vi.fn(async () => true);
    const result = await prepareProviderForModelFetch({
      providerId: "openai",
      section,
      state,
      saveConfig,
    });
    expect(result).toEqual({ ok: false, reason: "empty-env" });
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it("re-saves when dirty after pending failure", async () => {
    const state = createProviderConfigState();
    state.markDirty("openai");
    let pendingReject!: (e: Error) => void;
    state.queueSave(
      "openai",
      () => new Promise<boolean>((_, rej) => { pendingReject = rej; }),
    );
    const section = makeSection({ env: "KEY" });
    // Resolve pending save as failed, then the for-loop re-saves
    setTimeout(() => pendingReject(new Error("network")), 5);
    const result = await prepareProviderForModelFetch({
      providerId: "openai",
      section,
      state,
      saveConfig: async () => true,
    });
    expect(result).toEqual({ ok: true });
  });

  it("returns save-failed when re-save also fails", async () => {
    const state = createProviderConfigState();
    state.markDirty("openai");
    state.queueSave("openai", async () => false);
    const section = makeSection({ env: "KEY" });
    const result = await prepareProviderForModelFetch({
      providerId: "openai",
      section,
      state,
      saveConfig: async () => false,
    });
    expect(result).toEqual({ ok: false, reason: "save-failed" });
  });

  it("does not clear dirty on save failure", async () => {
    const state = createProviderConfigState();
    state.markDirty("openai");
    const section = makeSection({ env: "KEY" });
    await prepareProviderForModelFetch({
      providerId: "openai",
      section,
      state,
      saveConfig: async () => false,
    });
    expect(state.isDirty("openai")).toBe(true);
  });

  it("exits loop on successful save with matching revision", async () => {
    const state = createProviderConfigState();
    state.markDirty("openai");
    const section = makeSection({ env: "KEY" });
    const saveConfig = vi.fn(async () => true);
    const result = await prepareProviderForModelFetch({
      providerId: "openai",
      section,
      state,
      saveConfig,
    });
    expect(result).toEqual({ ok: true });
    expect(saveConfig).toHaveBeenCalledTimes(1);
  });

  it("saves twice when concurrent edit changes revision", async () => {
    const state = createProviderConfigState();
    state.markDirty("openai");
    const section = makeSection({ env: "KEY" });
    let callCount = 0;
    const result = await prepareProviderForModelFetch({
      providerId: "openai",
      section,
      state,
      saveConfig: async () => {
        callCount += 1;
        if (callCount === 1) {
          state.markDirty("openai");
        }
        return true;
      },
    });
    expect(result).toEqual({ ok: true });
    expect(callCount).toBe(2);
  });

  it("saves when pending succeeded but dirty remains", async () => {
    const state = createProviderConfigState();
    state.markDirty("openai");
    state.queueSave("openai", async () => true);
    const section = makeSection({ env: "KEY" });
    const saveConfig = vi.fn(async () => true);
    const result = await prepareProviderForModelFetch({
      providerId: "openai",
      section,
      state,
      saveConfig,
    });
    expect(result).toEqual({ ok: true });
    expect(saveConfig).toHaveBeenCalled();
  });

  it("returns false when saveConfig throws (via queueSave normalization)", async () => {
    const state = createProviderConfigState();
    state.markDirty("openai");
    const section = makeSection({ env: "KEY" });
    const result = await prepareProviderForModelFetch({
      providerId: "openai",
      section,
      state,
      saveConfig: async () => {
        throw new Error("invoke failed");
      },
    });
    expect(result).toEqual({ ok: false, reason: "save-failed" });
  });

  it("exits ok when 5th save clears dirty (boundary condition)", async () => {
    const state = createProviderConfigState();
    for (let i = 0; i < 4; i++) {
      state.markDirty("openai");
    }
    const section = makeSection({ env: "KEY" });
    let callCount = 0;
    const result = await prepareProviderForModelFetch({
      providerId: "openai",
      section,
      state,
      saveConfig: async () => {
        callCount += 1;
        // Each save "interrupted" by a new markDirty, except on the 5th call
        if (callCount < 5) {
          state.markDirty("openai");
        }
        return true;
      },
    });
    expect(result).toEqual({ ok: true });
    expect(callCount).toBe(5);
    expect(state.isDirty("openai")).toBe(false);
  });

  it("returns save-failed when all 5 attempts leave dirty", async () => {
    const state = createProviderConfigState();
    state.markDirty("openai");
    const section = makeSection({ env: "KEY" });
    let callCount = 0;
    const result = await prepareProviderForModelFetch({
      providerId: "openai",
      section,
      state,
      saveConfig: async () => {
        callCount += 1;
        state.markDirty("openai");
        return true;
      },
    });
    expect(result).toEqual({ ok: false, reason: "save-failed" });
    expect(callCount).toBe(5);
    expect(state.isDirty("openai")).toBe(true);
  });
});

// ---- getGoogleSttProjectId ----

describe("getGoogleSttProjectId", () => {
  it("returns value from visible select", () => {
    const section = document.createElement("div");
    const select = document.createElement("select");
    select.setAttribute("data-field", "project-id-select");
    const opt = document.createElement("option");
    opt.value = "my-project";
    opt.selected = true;
    select.appendChild(opt);
    section.appendChild(select);
    expect(getGoogleSttProjectId(section)).toBe("my-project");
  });

  it("returns input value when select is __manual__", () => {
    const section = document.createElement("div");
    const select = document.createElement("select");
    select.setAttribute("data-field", "project-id-select");
    const opt = document.createElement("option");
    opt.value = "__manual__";
    opt.selected = true;
    select.appendChild(opt);
    section.appendChild(select);
    const input = document.createElement("input");
    input.setAttribute("data-field", "project-id-input");
    input.value = "manual-project";
    section.appendChild(input);
    expect(getGoogleSttProjectId(section)).toBe("manual-project");
  });

  it("returns input value when select is hidden even if it has a value", () => {
    const section = document.createElement("div");
    const select = document.createElement("select");
    select.setAttribute("data-field", "project-id-select");
    select.hidden = true;
    const opt = document.createElement("option");
    opt.value = "old-project";
    opt.selected = true;
    select.appendChild(opt);
    section.appendChild(select);
    const input = document.createElement("input");
    input.setAttribute("data-field", "project-id-input");
    input.value = "fallback-project";
    section.appendChild(input);
    expect(getGoogleSttProjectId(section)).toBe("fallback-project");
  });

  it("returns empty string when neither select nor input exists", () => {
    const section = document.createElement("div");
    expect(getGoogleSttProjectId(section)).toBe("");
  });
});

// ---- readProviderConfigFromSection: Google STT options ----

describe("readProviderConfigFromSection: Google STT options", () => {
  function makeSection(html: string): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = html.trim();
    const el = wrapper.firstElementChild;
    if (!(el instanceof HTMLElement)) {
      throw new Error("Test section element is not an HTMLElement");
    }
    return el;
  }

  function googleSttSectionHtml(opts: {
    projectId?: string;
    projectIdHidden?: boolean;
    projectInput?: string;
    location?: string;
    recognizerId?: string;
    languageCode?: string;
    model?: string;
  }): string {
    const projectSelectHidden = opts.projectIdHidden ?? false;
    const projectInputHidden = !projectSelectHidden;
    const projectSelectValue = opts.projectId ?? "";
    const projectInputValue = opts.projectInput ?? "";
    return `
      <div>
        <input class="api-env-input" value="_" />
        <select data-field="project-id-select"${projectSelectHidden ? " hidden" : ""}>
          <option value="${projectSelectValue}" selected>${projectSelectValue}</option>
        </select>
        <input data-field="project-id-input" value="${projectInputValue}"${projectInputHidden ? " hidden" : ""} />
        <select data-field="location">
          <option value="${opts.location ?? "us-central1"}" selected>${opts.location ?? "us-central1"}</option>
        </select>
        <input data-field="recognizer-id" value="${opts.recognizerId ?? "_"}" />
        <select data-field="language-code">
          <option value="${opts.languageCode ?? "ja-JP"}" selected>${opts.languageCode ?? "ja-JP"}</option>
        </select>
        <select data-field="model" disabled>
          <option value="${opts.model ?? "chirp_2"}" selected>${opts.model ?? "chirp_2"}</option>
        </select>
      </div>`;
  }

  it("reads project_id from visible select", () => {
    const section = makeSection(googleSttSectionHtml({ projectId: "my-project" }));
    const result = readProviderConfigFromSection(section);
    expect(result?.options?.project_id).toBe("my-project");
  });

  it("reads project_id from input when select is hidden", () => {
    const section = makeSection(googleSttSectionHtml({
      projectId: "old-project",
      projectIdHidden: true,
      projectInput: "manual-project",
    }));
    const result = readProviderConfigFromSection(section);
    expect(result?.options?.project_id).toBe("manual-project");
  });

  it("reads location from select", () => {
    const section = makeSection(googleSttSectionHtml({ location: "asia-southeast1" }));
    const result = readProviderConfigFromSection(section);
    expect(result?.options?.location).toBe("asia-southeast1");
  });

  it("reads recognizer_id from input", () => {
    const section = makeSection(googleSttSectionHtml({ recognizerId: "custom-recognizer" }));
    const result = readProviderConfigFromSection(section);
    expect(result?.options?.recognizer_id).toBe("custom-recognizer");
  });

  it("reads language_code from select", () => {
    const section = makeSection(googleSttSectionHtml({ languageCode: "en-US" }));
    const result = readProviderConfigFromSection(section);
    expect(result?.options?.language_code).toBe("en-US");
  });

  it("reads defaultModel from disabled chirp_2 select", () => {
    const section = makeSection(googleSttSectionHtml({ model: "chirp_2" }));
    const result = readProviderConfigFromSection(section);
    expect(result?.defaultModel).toBe("chirp_2");
  });

  it("skips empty project_id", () => {
    const section = makeSection(googleSttSectionHtml({ projectId: "" }));
    const result = readProviderConfigFromSection(section);
    expect(result?.options?.project_id).toBeUndefined();
  });

  it("skips __manual__ project_id from select", () => {
    const section = makeSection(googleSttSectionHtml({
      projectId: "__manual__",
      projectInput: "manual-project",
    }));
    const result = readProviderConfigFromSection(section);
    expect(result?.options?.project_id).toBe("manual-project");
  });
});

// ---- buildGoogleSttProjectOptions ----

describe("buildGoogleSttProjectOptions", () => {
  const PROJ_A = { projectId: "proj-a", name: "Project A" };
  const PROJ_B = { projectId: "proj-b", name: "Project B" };

  it("saved project_id takes priority over current_project", () => {
    const result = buildGoogleSttProjectOptions({
      projects: [PROJ_A, PROJ_B],
      currentProject: "proj-a",
      savedProjectId: "proj-b",
    });
    expect(result.selectedValue).toBe("proj-b");
    expect(result.selectedBy).toBe("saved");
  });

  it("saved project_id not in list is added as 'saved' option", () => {
    const result = buildGoogleSttProjectOptions({
      projects: [PROJ_A],
      currentProject: "proj-a",
      savedProjectId: "ext-project",
    });
    expect(result.selectedValue).toBe("ext-project");
    expect(result.selectedBy).toBe("saved");
    const savedOpt = result.options.find(o => o.value === "ext-project");
    expect(savedOpt).toBeDefined();
    expect(savedOpt!.kind).toBe("saved");
    // saved option should come before project options
    expect(result.options[0].value).toBe("ext-project");
  });

  it("current_project auto-selected when no saved value", () => {
    const result = buildGoogleSttProjectOptions({
      projects: [PROJ_A, PROJ_B],
      currentProject: "proj-b",
      savedProjectId: null,
    });
    expect(result.selectedValue).toBe("proj-b");
    expect(result.selectedBy).toBe("current");
  });

  it("no selection when neither saved nor current match", () => {
    const result = buildGoogleSttProjectOptions({
      projects: [PROJ_A, PROJ_B],
      currentProject: null,
      savedProjectId: null,
    });
    expect(result.selectedValue).toBe("");
    expect(result.selectedBy).toBe("none");
  });

  it("current_project not in list does not get selected", () => {
    const result = buildGoogleSttProjectOptions({
      projects: [PROJ_A],
      currentProject: "other-project",
      savedProjectId: null,
    });
    expect(result.selectedValue).toBe("");
    expect(result.selectedBy).toBe("none");
  });

  it("__manual__ option is always last", () => {
    const result = buildGoogleSttProjectOptions({
      projects: [PROJ_A],
      currentProject: null,
      savedProjectId: null,
    });
    const last = result.options[result.options.length - 1];
    expect(last.value).toBe("__manual__");
    expect(last.kind).toBe("manual");
  });

  it("saved project_id in list is not duplicated", () => {
    const result = buildGoogleSttProjectOptions({
      projects: [PROJ_A, PROJ_B],
      currentProject: null,
      savedProjectId: "proj-a",
    });
    const savedOptions = result.options.filter(o => o.value === "proj-a");
    expect(savedOptions).toHaveLength(1);
  });

  it("empty projects with saved value still works", () => {
    const result = buildGoogleSttProjectOptions({
      projects: [],
      currentProject: "proj-a",
      savedProjectId: "saved-proj",
    });
    expect(result.selectedValue).toBe("saved-proj");
    expect(result.selectedBy).toBe("saved");
    expect(result.options).toHaveLength(2); // saved + manual
  });
});

// ---- shouldAutoSaveProject ----

describe("shouldAutoSaveProject", () => {
  it("returns true when current auto-selected and no saved value", () => {
    expect(shouldAutoSaveProject({ selectedBy: "current", savedProjectId: null })).toBe(true);
  });

  it("returns false when saved value was used", () => {
    expect(shouldAutoSaveProject({ selectedBy: "saved", savedProjectId: "proj-a" })).toBe(false);
  });

  it("returns false when none selected", () => {
    expect(shouldAutoSaveProject({ selectedBy: "none", savedProjectId: null })).toBe(false);
  });

  it("returns false when current selected but saved value exists", () => {
    // This shouldn't happen in practice, but verify it's false
    expect(shouldAutoSaveProject({ selectedBy: "current", savedProjectId: "proj-a" })).toBe(false);
  });
});

// ---- setGoogleSttAdvancedOpen ----

describe("setGoogleSttAdvancedOpen", () => {
  it("sets hidden=false and aria-expanded=true when open", () => {
    const btn = document.createElement("button") as HTMLButtonElement;
    const content = document.createElement("div") as HTMLElement;
    content.hidden = true;
    setGoogleSttAdvancedOpen(btn, content, true);
    expect(content.hidden).toBe(false);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
  });

  it("sets hidden=true and aria-expanded=false when closed", () => {
    const btn = document.createElement("button") as HTMLButtonElement;
    const content = document.createElement("div") as HTMLElement;
    content.hidden = false;
    setGoogleSttAdvancedOpen(btn, content, false);
    expect(content.hidden).toBe(true);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
  });

  it("hidden and aria-expanded always match", () => {
    const btn = document.createElement("button") as HTMLButtonElement;
    const content = document.createElement("div") as HTMLElement;
    // Toggle twice
    setGoogleSttAdvancedOpen(btn, content, true);
    expect(content.hidden).toBe(false);
    expect(btn.getAttribute("aria-expanded")).toBe("true");

    setGoogleSttAdvancedOpen(btn, content, false);
    expect(content.hidden).toBe(true);
    expect(btn.getAttribute("aria-expanded")).toBe("false");

    setGoogleSttAdvancedOpen(btn, content, true);
    expect(content.hidden).toBe(false);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
  });

  it("initial state is false when content is hidden", () => {
    const btn = document.createElement("button") as HTMLButtonElement;
    const content = document.createElement("div") as HTMLElement;
    content.hidden = true;
    setGoogleSttAdvancedOpen(btn, content, false);
    expect(content.hidden).toBe(true);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
  });
});

// ---- ensureSelectValue ----

describe("ensureSelectValue", () => {
  it("sets value on existing option", () => {
    const select = document.createElement("select") as HTMLSelectElement;
    select.add(new Option("日本語（ja-JP）", "ja-JP"));
    select.add(new Option("英語（en-US）", "en-US"));
    ensureSelectValue(select, "en-US");
    expect(select.value).toBe("en-US");
    expect(select.options).toHaveLength(2); // no duplicate
  });

  it("adds new option when value not found", () => {
    const select = document.createElement("select") as HTMLSelectElement;
    select.add(new Option("日本語（ja-JP）", "ja-JP"));
    ensureSelectValue(select, "en-GB", "英語（en-GB）");
    expect(select.value).toBe("en-GB");
    expect(select.options).toHaveLength(2);
    const addedOpt = Array.from(select.options).find(o => o.value === "en-GB");
    expect(addedOpt).toBeDefined();
    expect(addedOpt!.textContent).toBe("英語（en-GB）");
  });

  it("uses value as label when label not provided", () => {
    const select = document.createElement("select") as HTMLSelectElement;
    select.add(new Option("日本語（ja-JP）", "ja-JP"));
    ensureSelectValue(select, "custom-lang");
    expect(select.value).toBe("custom-lang");
    const addedOpt = Array.from(select.options).find(o => o.value === "custom-lang");
    expect(addedOpt!.textContent).toBe("custom-lang");
  });
});

// ---- getGoogleSttConfiguredState ----

describe("getGoogleSttConfiguredState", () => {
  it("returns unconfigured when no project_id or location", () => {
    document.body.innerHTML = '<div></div>';
    expect(getGoogleSttConfiguredState(document.body)).toBe("unconfigured");
  });

  it("returns unconfigured when only project_id present", () => {
    document.body.innerHTML = `
      <div>
        <select data-field="project-id-select"><option value="proj" selected>proj</option></select>
      </div>`;
    expect(getGoogleSttConfiguredState(document.body)).toBe("unconfigured");
  });

  it("returns unconfigured when only location present", () => {
    document.body.innerHTML = `
      <div>
        <select data-field="location"><option value="us-central1" selected>us-central1</option></select>
      </div>`;
    expect(getGoogleSttConfiguredState(document.body)).toBe("unconfigured");
  });

  it("returns configured when both project_id and location present", () => {
    document.body.innerHTML = `
      <div>
        <select data-field="project-id-select"><option value="proj" selected>proj</option></select>
        <select data-field="location"><option value="us-central1" selected>us-central1</option></select>
      </div>`;
    expect(getGoogleSttConfiguredState(document.body)).toBe("configured");
  });

  it("returns configured with project-id-input (manual fallback)", () => {
    document.body.innerHTML = `
      <div>
        <input data-field="project-id-input" value="manual-proj" />
        <select data-field="location"><option value="us-central1" selected>us-central1</option></select>
      </div>`;
    expect(getGoogleSttConfiguredState(document.body)).toBe("configured");
  });

  it("returns configured without env_name (Google STT specific)", () => {
    document.body.innerHTML = `
      <div>
        <select data-field="project-id-select"><option value="proj" selected>proj</option></select>
        <select data-field="location"><option value="us-central1" selected>us-central1</option></select>
      </div>`;
    // No .api-env-input → still configured
    expect(getGoogleSttConfiguredState(document.body)).toBe("configured");
  });
});

// ---- setGoogleSttStatus ----

describe("setGoogleSttStatus", () => {
  it("sets connectionState and label on badge element", () => {
    document.body.innerHTML = '<div><span data-status-badge>未設定</span></div>';
    const mockSetBadge = vi.fn();

    setGoogleSttStatus(document.body.firstElementChild as HTMLElement, "verified", mockSetBadge);

    const badge = document.querySelector("[data-status-badge]") as HTMLElement;
    expect(badge.dataset.connectionState).toBe("verified");
    expect(mockSetBadge).toHaveBeenCalledWith(badge, "接続確認済み");
  });

  it("all four states set correct labels", () => {
    const states: Array<{ state: import("./provider-config-save").GoogleSttConnectionState; label: string }> = [
      { state: "unconfigured", label: "未設定" },
      { state: "configured", label: "設定済み" },
      { state: "verified", label: "接続確認済み" },
      { state: "error", label: "接続エラー" },
    ];

    for (const { state, label } of states) {
      document.body.innerHTML = '<div><span data-status-badge>old</span></div>';
      const mockSetBadge = vi.fn();
      setGoogleSttStatus(document.body.firstElementChild as HTMLElement, state, mockSetBadge);
      expect(mockSetBadge).toHaveBeenCalledWith(
        document.querySelector("[data-status-badge]"),
        label,
      );
    }
  });

  it("does nothing when badge is missing", () => {
    document.body.innerHTML = '<div></div>';
    const mockSetBadge = vi.fn();
    setGoogleSttStatus(document.body.firstElementChild as HTMLElement, "verified", mockSetBadge);
    expect(mockSetBadge).not.toHaveBeenCalled();
  });
});

// ---- invalidateGoogleSttVerification ----

describe("invalidateGoogleSttVerification", () => {
  it("demotes verified to configured when settings are complete", () => {
    document.body.innerHTML = `
      <div>
        <select data-field="project-id-select"><option value="proj" selected>proj</option></select>
        <select data-field="location"><option value="us-central1" selected>us-central1</option></select>
        <span data-status-badge data-connection-state="verified">接続確認済み</span>
      </div>`;
    const mockSetBadge = vi.fn();

    invalidateGoogleSttVerification(document.body.firstElementChild as HTMLElement, mockSetBadge);

    expect(mockSetBadge).toHaveBeenCalledWith(
      document.querySelector("[data-status-badge]"),
      "設定済み",
    );
  });

  it("demotes verified to unconfigured when settings are missing", () => {
    document.body.innerHTML = `
      <div>
        <span data-status-badge data-connection-state="verified">接続確認済み</span>
      </div>`;
    const mockSetBadge = vi.fn();

    invalidateGoogleSttVerification(document.body.firstElementChild as HTMLElement, mockSetBadge);

    expect(mockSetBadge).toHaveBeenCalledWith(
      document.querySelector("[data-status-badge]"),
      "未設定",
    );
  });

  it("does not change error state if still configured", () => {
    document.body.innerHTML = `
      <div>
        <select data-field="project-id-select"><option value="proj" selected>proj</option></select>
        <select data-field="location"><option value="us-central1" selected>us-central1</option></select>
        <span data-status-badge data-connection-state="error">接続エラー</span>
      </div>`;
    const mockSetBadge = vi.fn();

    invalidateGoogleSttVerification(document.body.firstElementChild as HTMLElement, mockSetBadge);

    expect(mockSetBadge).toHaveBeenCalledWith(
      document.querySelector("[data-status-badge]"),
      "設定済み",
    );
  });
});

// ---- setButtonLoading / restoreButtonLoading ----

describe("setButtonLoading and restoreButtonLoading", () => {
  it("setButtonLoading disables and changes innerHTML", () => {
    document.body.innerHTML = '<button id="btn">元の文言</button>';
    const btn = document.getElementById("btn") as HTMLButtonElement;
    const state = setButtonLoading(btn, "ローディング...");
    expect(btn.disabled).toBe(true);
    expect(btn.innerHTML).toBe("ローディング...");
    expect(state.originalHtml).toBe("元の文言");
  });

  it("restoreButtonLoading re-enables and restores", () => {
    document.body.innerHTML = '<button id="btn2">元の文言</button>';
    const btn = document.getElementById("btn2") as HTMLButtonElement;
    btn.disabled = true;
    btn.innerHTML = "ローディング...";
    restoreButtonLoading(btn, { originalHtml: "元の文言" });
    expect(btn.disabled).toBe(false);
    expect(btn.innerHTML).toBe("元の文言");
  });
});
