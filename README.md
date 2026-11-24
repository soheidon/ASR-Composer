# ASR Composer

音声・動画ファイルから高精度な文字起こしを作成し、複数エンジンの比較・統合およびLLM補正・正本編集まで行えるWindowsデスクトップアプリケーションです。

> **開発中**: 本プロジェクトは現在開発中です。ローカルASR・Google Cloud Speech-to-Text（GUI OAuth）・2エンジン統合/比較・辞書/背景情報を用いたLLM補正・正本編集（`.asrc.json`）・多形式出力を実装していますが、仕様改善や検証を継続しています。

## 概要

ASR Composerは、ローカルASR（Docker + GPU）およびクラウドASR（Google Cloud Speech-to-Text V2）をGUIから統一的に操作し、話者分離・2エンジン比較/統合・辞書/背景情報を用いたLLM補正・正本エディター・多形式出力を備えた文字起こしツールです。ローカルASRのみを使う場合は音声データを外部に送信せず完結できます。

## 主な機能

### 文字起こし（1エンジン / 2エンジン実行）

- ドラッグ＆ドロップまたはファイル選択ダイアログで音声ファイルを読み込み
- **1エンジン実行**: ローカルASR（3種）またはクラウドASR（Google Cloud Speech-to-Text V2）を選択して実行
- **2エンジン実行**: 2つのASRエンジン（ローカル同士、またはGoogle STT + ローカルASR）を組み合わせた統合・比較実行
- 文字起こし実行中に中止ボタンで処理を中断可能
- 対応フォーマット: MP3, WAV, MP4, M4A, FLAC

### ASRエンジン

| 区分 | エンジン | 特徴 |
|---|---|---|
| ローカル | ReazonSpeech (ESPnet v3.0.0) | 日本語特化、高精度 |
| ローカル | Kotoba Whisper (v2.2) | 日本語特化、高速 |
| ローカル | Qwen3 ASR (Qwen3-ASR-1.7B) | 多言語対応（30言語） |
| クラウド | Google Cloud Speech-to-Text V2 (Chirp 2) | GUI OAuth 2.0ログインで連携、単語単位タイムスタンプ対応 |

### 出力形式

文字起こし結果を以下の形式で保存できます。チェックボックスで必要な形式を選択してください。

| 形式 | 拡張子 | 用途 |
|---|---|---|
| テキスト | `.txt` | プレーンテキスト、話者ラベル付き |
| JSON | `.json` | 構造化データ、プログラム連携 |
| Markdown | `.md` | 文書作成、GitHub等 |
| SRT | `.srt` | 字幕ファイル、動画編集ソフト対応 |
| CSV | `.csv` | 表計算ソフト対応（UTF-8 BOM付き） |
| VTT | `.vtt` | WebVTT字幕、HTML5動画対応 |

### 話者分離

- pyannote speaker-diarizationによる自動話者分離
- 話者数の自動検出または手動指定（1〜8人）
- 話者分離のON/OFF切替

### 言語選択

- エンジンごとに最適な言語候補を表示
- Qwen3 ASRは30言語に対応
- 自動検出もサポート

### 補正・編集・その他の機能

- **LLM補正・比較レビュー**: Ollama（ローカルLLM）やクラウドLLM（OpenAI / Anthropic / Gemini 等）を使った誤認識補正と並べて比較レビュー
- **辞書・背景情報コンテキスト**: 固有名詞辞書や背景情報を参照した補正
- **正本編集（エディター）**: `.asrc.json` 正本データの読み込み・編集・保存
- 保存先フォルダの指定（未指定時はDownloadsフォルダ）
- 保存先パスの記憶（次回起動時に復元）
- 文字起こし結果のコピー・手動保存
- Google Cloud Speech-to-Text の GUI OAuth 2.0 ログイン・自動接続確認・詳細Project設定
- APIプロバイダー（LLM / ASR）の設定と接続テスト

## 技術構成

| レイヤー | 技術 |
|---|---|
| フロントエンド | TypeScript + Vite |
| デスクトップ基盤 | Tauri v2 |
| バックエンド | Rust |
| ローカルASR | Docker + Python |
| UI | Material Symbols Outlined |

## 動作環境

- **OS**: Windows 10/11（64ビット）
- **GPU**: NVIDIA GPU（CUDA 12.6対応推奨）
- **Docker**: Docker Desktop（ローカルASRエンジン使用時）
- **ディスク容量**: 各エンジンのDockerイメージで約10〜20GB

## インストール

### setup.exeによるインストール

1. [リリースページ](https://github.com/soheidon/ASR-Composer/releases)から最新の `ASR.Composer_0.5.0_x64-setup.exe`（Windows NSIS インストーラー）をダウンロード
2. setup.exeを実行してインストール
3. スタートメニューまたはデスクトップからASR Composerを起動

### ローカルASRエンジンのセットアップ

1. ASR Composerを起動し、設定画面の「Docker設定」を開く
2. Docker Desktopが未インストールの場合は、画面内の案内に従ってインストールし、起動する
3. 使用するエンジンの「インストール」ボタンを押してDockerイメージをビルド
4. インストール完了後、文字起こしページでエンジンを選択して使用

## 使い方

1. **音声ファイルを選択**: ドロップゾーンにファイルをドラッグするか、「ファイルを選択」ボタンをクリック
2. **ASRエンジンを選択**: API（クラウド）またはローカルを選択し、エンジンを指定
3. **出力設定**: 保存先と出力形式（TXT, SRT等）を選択
4. **文字起こしを開始**: 「文字起こしを開始」ボタンをクリック
5. **中止する場合**: 実行中に「中止」ボタンで処理を中断可能
6. **結果を確認**: 文字起こし結果が画面に表示され、選択した形式で保存先に書き出されます

## 開発

### ビルド要件

- Node.js 18以上
- Rust 1.77以上
- Docker Desktop

### 開発手順

```bash
# 依存関係のインストール
npm install

# 開発サーバー起動
npm run tauri dev

# リリースビルド
npm run tauri build
```

### Google OAuth 設定（開発・リリース共通）

Google Cloud Speech-to-Text の GUI ログインを利用するビルドでは、リポジトリ直下に Git 管理対象外の `oauth-client.dev.json` を 1 つ作成してください（[oauth-client.dev.example.json](oauth-client.dev.example.json) をコピーして値を設定）。開発ビルド（debug）とリリースビルド（release）の両方がこの単一ファイルを入力として使用します。

```json
{
  "client_id": "YOUR_DESKTOP_CLIENT_ID.apps.googleusercontent.com",
  "client_secret": "YOUR_DESKTOP_CLIENT_SECRET",
  "secret_mode": "required",
  "default_project_id": "amed-512123"
}
```

- `secret_mode` には `"required"`（Client Secret を送信する Desktop クライアント）または `"none"`（Secret を送信しない設定）を指定します。
- `default_project_id` にはログイン後に自動接続確認する既定の Google Cloud Project ID（`amed-512123`）を指定します。
- `oauth-client.dev.json` が未作成でも開発ビルド（debug）では他機能が動作します（Google ログイン時のみ設定不足が表示されます）。リリースビルド時は `oauth-client.dev.json` が必須ですが、生成されたインストーラーには設定 JSON ファイル自体は同梱されません。
- 開発ビルド（`dev`）とリリースビルド（`release`）では Credential Manager および認証メタデータの保存領域が分離されており、ログイン状態・token・Project 確認状態は相互に共有されません。

### テスト

```bash
# TypeScriptテスト
npx vitest run

# Rustテスト
cd src-tauri && cargo test
```

## ライセンス

[MIT License](LICENSE)

## 著者

井出草平
