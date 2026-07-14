import { describe, it, expect, vi } from "vitest";
import {
  createProviderConfigState,
  readProviderConfigFromSection,
  saveDirtyProviderConfig,
  prepareProviderForModelFetch,
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
        { selector: '[data-field="project-id"]', value: "my-project-123" },
        { selector: '[data-field="recognizer-id"]', value: "_" },
        { selector: '[data-field="language-code"]', value: "ja-JP" },
      ],
      extraSelects: [
        { selector: '[data-field="location"]', value: "us-central1" },
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
        { selector: '[data-field="project-id"]', value: "test-proj" },
        { selector: '[data-field="recognizer-id"]', value: "" },
        { selector: '[data-field="language-code"]', value: "" },
      ],
      extraSelects: [
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
