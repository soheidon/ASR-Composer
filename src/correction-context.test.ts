import { describe, it, expect, vi } from "vitest";
import {
  parseCsv,
  parseDictionaryCsv,
  loadCorrectionContext,
  openCorrectionFolder,
  openCorrectionFile,
} from "./correction-context";

describe("Correction Context - CSV Parser & Loader", () => {
  describe("parseCsv", () => {
    it("基本的なカンマ区切りを正しくパースする (ok: true)", () => {
      const csv = "a,b,c\n1,2,3";
      const result = parseCsv(csv);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.rows).toEqual([
          ["a", "b", "c"],
          ["1", "2", "3"],
        ]);
      }
    });

    it("引用符付きのカンマや改行、エスケープ二重引用符を正しく処理する", () => {
      const csv = 'canonical,variants,category,note\n"統合失調症","統合,失調|病名","med","注記""正式""名"\n"rTMS","TMS|RTMS","med","line1\nline2"';
      const result = parseCsv(csv);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.rows.length).toBe(3);
        expect(result.rows[1]).toEqual(["統合失調症", "統合,失調|病名", "med", '注記"正式"名']);
        expect(result.rows[2]).toEqual(["rTMS", "TMS|RTMS", "med", "line1\nline2"]);
      }
    });

    it("UTF-8 BOM (\\uFEFF) を安全に除去する", () => {
      const csv = "\uFEFFcanonical,variants\nテスト,test";
      const result = parseCsv(csv);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.rows[0][0]).toBe("canonical");
        expect(result.rows[1]).toEqual(["テスト", "test"]);
      }
    });

    it("CRLF と LF の混在を正常に処理する", () => {
      const csv = "col1,col2\r\nval1,val2\nval3,val4\r\n";
      const result = parseCsv(csv);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.rows).toEqual([
          ["col1", "col2"],
          ["val1", "val2"],
          ["val3", "val4"],
        ]);
      }
    });

    it("未閉じ引用符がある場合は ok: false と行番号付きエラーを返す", () => {
      const csv = 'canonical,variants\n"統合失調症,病名\nrTMS,TMS';
      const result = parseCsv(csv);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors.some((e) => e.message.includes("閉じられていません"))).toBe(true);
      }
    });

    it("閉じ引用符の直後に不正な文字がある場合は構文エラーを検出する", () => {
      const csv = 'canonical,variants\n"term"invalid,variants';
      const result = parseCsv(csv);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.message.includes("閉じ引用符"))).toBe(true);
      }
    });
  });

  describe("parseDictionaryCsv", () => {
    it("標準スキーマ (canonical,variants,category,note) を正しくパースする (ok: true)", () => {
      const csv = `canonical,variants,category,note
統合失調症,"統合失調症候群|統合失調病",medical,
rTMS,"TMS|RTMS",medical,"正式表記"`;
      const res = parseDictionaryCsv(csv);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.warnings.length).toBe(0);
        expect(res.entries).toEqual([
          {
            id: "dict-1",
            canonical: "統合失調症",
            variants: ["統合失調症候群", "統合失調病"],
            category: "medical",
            note: undefined,
          },
          {
            id: "dict-2",
            canonical: "rTMS",
            variants: ["TMS", "RTMS"],
            category: "medical",
            note: "正式表記",
          },
        ]);
      }
    });

    it("大文字小文字のヘッダー名および余白を許容する", () => {
      const csv = ` Canonical , VARIANTS , Category 
テスト用語, " 類語1 | 類語2 " , IT `;
      const res = parseDictionaryCsv(csv);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.warnings.length).toBe(0);
        expect(res.entries.length).toBe(1);
        expect(res.entries[0].canonical).toBe("テスト用語");
        expect(res.entries[0].variants).toEqual(["類語1", "類語2"]);
        expect(res.entries[0].category).toBe("IT");
      }
    });

    it("空文字または空白のみの場合は空エントリを返す (ok: true)", () => {
      const res1 = parseDictionaryCsv("");
      expect(res1.ok).toBe(true);
      if (res1.ok) expect(res1.entries).toEqual([]);

      const res2 = parseDictionaryCsv("   \n\n  ");
      expect(res2.ok).toBe(true);
      if (res2.ok) expect(res2.entries).toEqual([]);
    });

    it("Test A: CSV構文エラー（未閉じquote）時は辞書全体を拒否し ok: false を返す", () => {
      const csv = `canonical,variants,category,note
"統合失調症,精神分裂病,medical,
rTMS,TMS,medical,
ADHD,注意欠如多動症,medical,`;
      const res = parseDictionaryCsv(csv);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe("syntax_error");
        expect(res.message).toContain("dictionary.csv の形式に問題があります");
      }
    });

    it("canonical 列が存在しない場合は ok: false (missing_canonical_header) を返す", () => {
      const csv = "term,synonyms\n統合失調症,病名";
      const res = parseDictionaryCsv(csv);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe("missing_canonical_header");
        expect(res.message).toContain("canonical");
      }
    });

    it("Test B: 行セマンティックエラー (canonical空) は当該行のみスキップし、他の正常行は使用する (ok: true)", () => {
      const csv = `canonical,variants
有効単語,alias
,invalid
別単語,alias2`;
      const res = parseDictionaryCsv(csv);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.entries.length).toBe(2);
        expect(res.entries[0].canonical).toBe("有効単語");
        expect(res.entries[1].canonical).toBe("別単語");
        expect(res.warnings.some((w) => w.includes("行 3"))).toBe(true);
      }
    });
  });

  describe("loadCorrectionContext", () => {
    it("辞書と背景情報の両方が存在する場合に正しくロードする (status: 'success')", async () => {
      const mockInvoke = vi.fn().mockImplementation(async (cmd: string) => {
        if (cmd === "read_correction_context_files") {
          return {
            dictionary_content: "canonical,variants\nAI,人工知能",
            background_content: "本対談は医療AIに関する議論です。\n",
          };
        }
        throw new Error(`Unhandled: ${cmd}`);
      });

      const res = await loadCorrectionContext(mockInvoke as any);
      expect(res.status).toBe("success");
      if (res.status === "success") {
        expect(res.warnings.length).toBe(0);
        expect(res.dictionary.length).toBe(1);
        expect(res.dictionary[0].canonical).toBe("AI");
        expect(res.dictionary[0].variants).toEqual(["人工知能"]);
        expect(res.context.backgroundText).toBe("本対談は医療AIに関する議論です。");
      }
    });

    it("辞書に構文エラーがある場合は status: 'dictionary_syntax_error' を返す", async () => {
      const mockInvoke = vi.fn().mockImplementation(async (cmd: string) => {
        if (cmd === "read_correction_context_files") {
          return {
            dictionary_content: 'canonical,variants\n"未閉じ引用符,病名',
            background_content: "背景情報テキスト",
          };
        }
        throw new Error(`Unhandled: ${cmd}`);
      });

      const res = await loadCorrectionContext(mockInvoke as any);
      expect(res.status).toBe("dictionary_syntax_error");
      if (res.status === "dictionary_syntax_error") {
        expect(res.message).toContain("dictionary.csv の形式に問題があります");
      }
    });

    it("ファイルが存在しない（null）場合は空で安全にフォールバックする (status: 'success')", async () => {
      const mockInvoke = vi.fn().mockImplementation(async (cmd: string) => {
        if (cmd === "read_correction_context_files") {
          return {
            dictionary_content: null,
            background_content: null,
          };
        }
        throw new Error(`Unhandled: ${cmd}`);
      });

      const res = await loadCorrectionContext(mockInvoke as any);
      expect(res.status).toBe("success");
      if (res.status === "success") {
        expect(res.warnings.length).toBe(0);
        expect(res.dictionary).toEqual([]);
        expect(res.context.backgroundText).toBe("");
      }
    });

    it("Dictionary OFF / Background ON: dictionary.csv が読めない状態でも background.txt だけで正常に成功する", async () => {
      const mockInvoke = vi.fn().mockImplementation(async (cmd: string, args?: any) => {
        if (cmd === "read_correction_context_files") {
          expect(args?.useDictionary).toBe(false);
          expect(args?.useBackground).toBe(true);
          // Rust側では dictionary.csv を読まないためエラーにならず None を返す
          return {
            dictionary_content: null,
            background_content: "背景情報テキストのみ",
          };
        }
        throw new Error(`Unhandled: ${cmd}`);
      });

      const res = await loadCorrectionContext({
        useDictionary: false,
        useBackground: true,
        invokeFn: mockInvoke as any,
      });

      expect(res.status).toBe("success");
      if (res.status === "success") {
        expect(res.dictionary).toEqual([]);
        expect(res.context.backgroundText).toBe("背景情報テキストのみ");
      }
    });

    it("Dictionary ON / Background OFF: background.txt が読めない状態でも dictionary.csv だけで正常に成功する", async () => {
      const mockInvoke = vi.fn().mockImplementation(async (cmd: string, args?: any) => {
        if (cmd === "read_correction_context_files") {
          expect(args?.useDictionary).toBe(true);
          expect(args?.useBackground).toBe(false);
          return {
            dictionary_content: "canonical,variants\nAI,人工知能",
            background_content: null,
          };
        }
        throw new Error(`Unhandled: ${cmd}`);
      });

      const res = await loadCorrectionContext({
        useDictionary: true,
        useBackground: false,
        invokeFn: mockInvoke as any,
      });

      expect(res.status).toBe("success");
      if (res.status === "success") {
        expect(res.dictionary.length).toBe(1);
        expect(res.dictionary[0].canonical).toBe("AI");
        expect(res.context.backgroundText).toBe("");
      }
    });

    it("両方OFF: Rust read commandに両方falseを渡し、どちらも読まずに成功する", async () => {
      const mockInvoke = vi.fn().mockImplementation(async (cmd: string, args?: any) => {
        if (cmd === "read_correction_context_files") {
          expect(args?.useDictionary).toBe(false);
          expect(args?.useBackground).toBe(false);
          return {
            dictionary_content: null,
            background_content: null,
          };
        }
        throw new Error(`Unhandled: ${cmd}`);
      });

      const res = await loadCorrectionContext({
        useDictionary: false,
        useBackground: false,
        invokeFn: mockInvoke as any,
      });

      expect(res.status).toBe("success");
      if (res.status === "success") {
        expect(res.dictionary).toEqual([]);
        expect(res.context.backgroundText).toBe("");
      }
    });

    it("Dictionary ON: dictionary read error 発生時は status: 'read_error' を返す", async () => {
      const mockInvoke = vi.fn().mockImplementation(async (cmd: string, args?: any) => {
        if (cmd === "read_correction_context_files") {
          expect(args?.useDictionary).toBe(true);
          throw new Error("dictionary.csv の読み込みに失敗しました: Permission denied");
        }
        throw new Error(`Unhandled: ${cmd}`);
      });

      const res = await loadCorrectionContext({
        useDictionary: true,
        useBackground: false,
        invokeFn: mockInvoke as any,
      });

      expect(res.status).toBe("read_error");
      if (res.status === "read_error") {
        expect(res.message).toContain("dictionary.csv の読み込みに失敗しました");
      }
    });

    it("Background ON: background read error 発生時は status: 'read_error' を返す", async () => {
      const mockInvoke = vi.fn().mockImplementation(async (cmd: string, args?: any) => {
        if (cmd === "read_correction_context_files") {
          expect(args?.useBackground).toBe(true);
          throw new Error("background.txt の読み込みに失敗しました: Permission denied");
        }
        throw new Error(`Unhandled: ${cmd}`);
      });

      const res = await loadCorrectionContext({
        useDictionary: false,
        useBackground: true,
        invokeFn: mockInvoke as any,
      });

      expect(res.status).toBe("read_error");
      if (res.status === "read_error") {
        expect(res.message).toContain("background.txt の読み込みに失敗しました");
      }
    });

    it("Dictionary OFF: dictionary.csv が malformed な場合でも syntax error にならず background だけで補正継続する", async () => {
      const mockInvoke = vi.fn().mockImplementation(async (cmd: string, args?: any) => {
        if (cmd === "read_correction_context_files") {
          expect(args?.useDictionary).toBe(false);
          expect(args?.useBackground).toBe(true);
          return {
            dictionary_content: null, // use_dict: falseによりRustは読まない
            background_content: "背景情報のみ",
          };
        }
        throw new Error(`Unhandled: ${cmd}`);
      });

      const res = await loadCorrectionContext({
        useDictionary: false,
        useBackground: true,
        invokeFn: mockInvoke as any,
      });

      expect(res.status).toBe("success");
      if (res.status === "success") {
        expect(res.dictionary).toEqual([]);
        expect(res.context.backgroundText).toBe("背景情報のみ");
      }
    });

    it("IPC例外発生時は status: 'read_error' を返す", async () => {
      const mockInvoke = vi.fn().mockImplementation(async () => {
        throw new Error("Disk IO failure");
      });

      const res = await loadCorrectionContext(mockInvoke as any);
      expect(res.status).toBe("read_error");
      if (res.status === "read_error") {
        expect(res.message).toContain("コンテキストファイルの読み込みに失敗しました");
      }
    });
  });

  describe("openCorrectionFolder & openCorrectionFile", () => {
    it("openCorrectionFolder が open_correction_folder コマンドを呼び出す", async () => {
      const mockInvoke = vi.fn().mockResolvedValue(undefined);
      await openCorrectionFolder(mockInvoke as any);
      expect(mockInvoke).toHaveBeenCalledWith("open_correction_folder");
    });

    it("openCorrectionFile が指定された fileType で open_correction_file を呼び出す", async () => {
      const mockInvoke = vi.fn().mockResolvedValue(undefined);
      await openCorrectionFile("dictionary", mockInvoke as any);
      expect(mockInvoke).toHaveBeenCalledWith("open_correction_file", { fileType: "dictionary" });

      await openCorrectionFile("background", mockInvoke as any);
      expect(mockInvoke).toHaveBeenCalledWith("open_correction_file", { fileType: "background" });
    });
  });
});
