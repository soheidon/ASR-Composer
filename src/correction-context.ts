import type { CorrectionDictionaryEntry, CorrectionContext } from "./correction";
import type { InvokeFn } from "./ollama-provider";

export interface CorrectionContextFilesResponse {
  dictionary_content: string | null;
  background_content: string | null;
}

export interface CsvSyntaxError {
  line: number;
  message: string;
}

export type CsvParseResult =
  | { ok: true; rows: string[][] }
  | { ok: false; errors: CsvSyntaxError[] };

export type ParseDictionaryResult =
  | {
      ok: true;
      entries: CorrectionDictionaryEntry[];
      warnings: string[];
    }
  | {
      ok: false;
      status: "syntax_error" | "missing_canonical_header";
      errors: CsvSyntaxError[];
      message: string;
    };

export type CorrectionContextLoadResult =
  | {
      status: "success";
      dictionary: CorrectionDictionaryEntry[];
      context: CorrectionContext;
      warnings: string[];
    }
  | {
      status: "dictionary_syntax_error";
      errors: CsvSyntaxError[];
      message: string;
    }
  | {
      status: "read_error";
      message: string;
    };

/**
 * RFC 4180準拠の厳格なCSVパーサー
 * - 引用符（"）、引用符内のエスケープ（""）、カンマ、改行を処理
 * - 未閉じ引用符、引用符後の不正文字などの構文エラーを検出し { ok: false, errors } を返す
 */
export function parseCsv(text: string): CsvParseResult {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = "";
  let inQuotes = false;
  let quoteStartLine = 1;
  let justClosedQuote = false;
  let currentLine = 1;
  const errors: CsvSyntaxError[] = [];
  let i = 0;

  // BOMの除去
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }

  while (i < text.length) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          currentField += '"';
          i += 2;
          continue;
        } else {
          inQuotes = false;
          justClosedQuote = true;
          i++;
          continue;
        }
      } else if (char === "\r") {
        if (i + 1 < text.length && text[i + 1] === "\n") {
          i++;
        }
        currentLine++;
        currentField += "\n";
        i++;
        continue;
      } else if (char === "\n") {
        currentLine++;
        currentField += "\n";
        i++;
        continue;
      } else {
        currentField += char;
        i++;
        continue;
      }
    } else {
      if (justClosedQuote) {
        if (char === "," || char === "\r" || char === "\n") {
          justClosedQuote = false;
        } else if (char === " " || char === "\t") {
          // 閉じ引用符の後の空白は無視
          i++;
          continue;
        } else {
          errors.push({
            line: currentLine,
            message: "閉じ引用符（\"）の後に不正な文字があります。",
          });
          justClosedQuote = false;
        }
      }

      if (char === '"') {
        if (currentField.trim().length === 0) {
          inQuotes = true;
          quoteStartLine = currentLine;
          currentField = "";
          i++;
          continue;
        } else {
          errors.push({
            line: currentLine,
            message: "フィールドの途中に不正な引用符（\"）があります。",
          });
          inQuotes = true;
          quoteStartLine = currentLine;
          i++;
          continue;
        }
      } else if (char === ",") {
        currentRow.push(currentField);
        currentField = "";
        justClosedQuote = false;
        i++;
        continue;
      } else if (char === "\r") {
        if (i + 1 < text.length && text[i + 1] === "\n") {
          i++;
        }
        currentRow.push(currentField);
        currentField = "";
        rows.push(currentRow);
        currentRow = [];
        justClosedQuote = false;
        currentLine++;
        i++;
        continue;
      } else if (char === "\n") {
        currentRow.push(currentField);
        currentField = "";
        rows.push(currentRow);
        currentRow = [];
        justClosedQuote = false;
        currentLine++;
        i++;
        continue;
      } else {
        currentField += char;
        i++;
        continue;
      }
    }
  }

  if (inQuotes) {
    errors.push({
      line: quoteStartLine,
      message: "引用符（\"）が閉じられていません。",
    });
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField);
    rows.push(currentRow);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, rows };
}

/**
 * dictionary.csv の内容を CorrectionDictionaryEntry[] へ変換する
 * - CSV構文エラー時: 全体を拒否し { ok: false, status: "syntax_error", errors, message } を返す
 * - 行セマンティックエラー時 (canonical空など): 当該行のみスキップして warnings に記録
 */
export function parseDictionaryCsv(csvContent: string): ParseDictionaryResult {
  if (!csvContent || csvContent.trim().length === 0) {
    return { ok: true, entries: [], warnings: [] };
  }

  const parseRes = parseCsv(csvContent);
  if (!parseRes.ok) {
    const errorDetails = parseRes.errors.map((e) => `行 ${e.line}: ${e.message}`).join("; ");
    return {
      ok: false,
      status: "syntax_error",
      errors: parseRes.errors,
      message: `dictionary.csv の形式に問題があります: ${errorDetails}`,
    };
  }

  const rows = parseRes.rows;
  if (rows.length === 0) {
    return { ok: true, entries: [], warnings: [] };
  }

  // 1行目をヘッダーとして解析（小文字・トリム比較）
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const canonicalIdx = header.indexOf("canonical");
  const variantsIdx = header.indexOf("variants");
  const categoryIdx = header.indexOf("category");
  const noteIdx = header.indexOf("note");

  if (canonicalIdx === -1) {
    return {
      ok: false,
      status: "missing_canonical_header",
      errors: [{ line: 1, message: "必須列 'canonical' が見つかりません。" }],
      message: "dictionary.csv に必須列 'canonical' が見つかりません。",
    };
  }

  const warnings: string[] = [];
  const entries: CorrectionDictionaryEntry[] = [];
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    // 空行スキップ
    if (row.length === 0 || (row.length === 1 && row[0].trim() === "")) {
      continue;
    }

    const canonical = (row[canonicalIdx] ?? "").trim();
    if (!canonical) {
      warnings.push(`行 ${rowIndex + 1}: 'canonical' が空のためスキップしました。`);
      continue;
    }

    const rawVariants = variantsIdx !== -1 ? (row[variantsIdx] ?? "") : "";
    const variants = rawVariants
      .split("|")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);

    const category = categoryIdx !== -1 ? (row[categoryIdx] ?? "").trim() : undefined;
    const note = noteIdx !== -1 ? (row[noteIdx] ?? "").trim() : undefined;

    entries.push({
      id: `dict-${entries.length + 1}`,
      canonical,
      variants,
      category: category || undefined,
      note: note || undefined,
    });
  }

  return { ok: true, entries, warnings };
}

async function defaultInvokeTauri<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return null as any;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

export interface LoadCorrectionContextOptions {
  useDictionary?: boolean;
  useBackground?: boolean;
  invokeFn?: InvokeFn;
}

/**
 * 辞書CSVと背景TXTを読み込み、Correction用のデータ構造に変換する共通ローダー
 */
export async function loadCorrectionContext(
  optionsOrInvokeFn?: LoadCorrectionContextOptions | InvokeFn,
): Promise<CorrectionContextLoadResult> {
  let useDictionary = true;
  let useBackground = true;
  let invokeFn: InvokeFn | undefined;

  if (typeof optionsOrInvokeFn === "function") {
    invokeFn = optionsOrInvokeFn;
  } else if (optionsOrInvokeFn) {
    useDictionary = optionsOrInvokeFn.useDictionary ?? true;
    useBackground = optionsOrInvokeFn.useBackground ?? true;
    invokeFn = optionsOrInvokeFn.invokeFn;
  }

  const effectiveInvoke =
    invokeFn ??
    (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
      ? defaultInvokeTauri
      : null);

  if (!effectiveInvoke) {
    return {
      status: "success",
      dictionary: [],
      context: { backgroundText: "" },
      warnings: [],
    };
  }

  let files: CorrectionContextFilesResponse;
  try {
    files = await effectiveInvoke<CorrectionContextFilesResponse>(
      "read_correction_context_files",
      {
        useDictionary,
        useBackground,
      },
    );
  } catch (err) {
    return {
      status: "read_error",
      message: `コンテキストファイルの読み込みに失敗しました: ${String(err)}`,
    };
  }

  let parsedDict: CorrectionDictionaryEntry[] = [];
  const warnings: string[] = [];

  if (useDictionary && files?.dictionary_content) {
    const dictRes = parseDictionaryCsv(files.dictionary_content);
    if (!dictRes.ok) {
      return {
        status: "dictionary_syntax_error",
        errors: dictRes.errors,
        message: dictRes.message,
      };
    }
    parsedDict = dictRes.entries;
    warnings.push(...dictRes.warnings);
  }

  const backgroundText =
    useBackground && files?.background_content ? files.background_content.trim() : "";

  return {
    status: "success",
    dictionary: parsedDict,
    context: {
      backgroundText,
    },
    warnings,
  };
}

export async function openCorrectionFolder(
  invokeFn: InvokeFn = defaultInvokeTauri,
): Promise<void> {
  await invokeFn("open_correction_folder");
}

export async function openCorrectionFile(
  fileType: "dictionary" | "background",
  invokeFn: InvokeFn = defaultInvokeTauri,
): Promise<void> {
  await invokeFn("open_correction_file", { fileType });
}
