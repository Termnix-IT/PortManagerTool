# Port Manager Tool

Windows 向けのポート管理デスクトップアプリケーションです。  
開発時に使用するポート番号の確認・停止・登録・監視をひとつの軽量な作業画面で行えます。

![Tauri](https://img.shields.io/badge/Tauri-2.x-24C8DB?logo=tauri&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-2021-000000?logo=rust&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-Windows-0078D6?logo=windows&logoColor=white)
![License](https://img.shields.io/badge/License-ISC-blue)

## Features

### 使用中ポートの一覧表示
- TCP / UDP の使用中ポートをリアルタイムにスキャン
- ポート番号・プロセス名・PID・状態・ローカルアドレスを表示
- テキスト検索、プロトコル、状態によるフィルタリング
- カラムヘッダーのクリックでソート
- 行クリックまたは確認ボタンでポート詳細を右側インスペクターに表示

### プロセスの停止
- 待受中の TCP ポートまたは UDP ポートを使用しているプロセスを停止
- 通常停止 / 強制停止を選択（コンソールアプリが通常停止に応じない場合は強制停止を提案）
- 子プロセスをまとめて停止するかを選択
- OS の重要プロセスやこのアプリ自身は停止不可、サービスや別ユーザーのプロセスは追加確認
- 停止直前にプロセスとポートの状態を再確認し、表示が古い場合は中止
- TCP の Established 接続は誤停止防止のため停止不可として表示

### ポート競合診断
- 同じ TCP ポートを別々のプロセスが待ち受けている状態を検出（IPv4 / IPv6 で別プロセス、ワイルドカードと特定アドレスの混在など、原因の種類と対処のヒントを表示）
- 指定したポートが使えるかを確認（使用中のプロセス、Windows の予約ポート範囲）
- Hyper-V / WSL / Docker 等が予約していて、空いていても使えないポート範囲を一覧表示

### ポートの使用履歴
- アプリ起動中は 10 秒ごとに TCP の待受を確認し、使用開始・解放をプロセス名・コマンドライン・プロセス開始時刻とともに記録
- アプリを閉じていた間の変化は、次回起動時に前回の状態と比較して記録
- アプリから停止した操作（通常停止 / 強制停止）も記録
- 種別・開発 / DB プロセス・テキストで絞り込み。履歴は 30 日分（最大 2,000 件）を保持

### 開発 / DB プロセスの表示モード
- `すべて / 開発 / DB` の切替で、開発サーバーや DB が使用しているポートだけを表示
- Vite・Django・PostgreSQL などの推定ラベルとコマンドラインを表示

### お気に入りポートの登録・管理
- よく使うポートをラベル・説明付きで登録
- 登録ポートの現在の状態（使用中 / 空き）を自動表示
- アプリ再起動後もデータを保持
- 同じポート・プロトコルの重複登録を抑制

### ポート監視・デスクトップ通知
- TCP / UDP の指定ポート状態を定期的にポーリング監視
- ポートの使用開始時・解放時にデスクトップ通知を送信
- 監視間隔のカスタマイズ（1〜60秒）
- ポートごとの監視ON/OFF切替
- 同じポート・プロトコルの重複監視を抑制

### 軽量ダッシュボードUI
- 左側サイドバーで `ダッシュボード`, `ポート一覧`, `お気に入り`, `監視`, `診断`, `履歴`, `設定` を移動
- 上部バーに戻る / 進む / 検索 / 更新を集約
- ダッシュボードは一覧密度を優先し、概要はコンパクトなステータス行で表示
- 右側インスペクターにポート詳細・スキャン推移・最近のイベントを統合表示

## Screenshot

<!-- スクリーンショットを追加する場合は以下のコメントを置き換えてください -->
<!-- ![Screenshot](assets/screenshot.png) -->

## Install

[Releases](https://github.com/Termnix-IT/PortManagerTool/releases) から次のどちらかをダウンロードします（手元でビルドする場合は `npm run build` で `src-tauri/target/release/` に出力されます）。

| ファイル | 内容 |
|---|---|
| `PortManagerTool-Setup-<version>.exe` | インストーラー（ユーザー単位でインストール。インストール先の変更、スタートメニュー / デスクトップのショートカット作成に対応）。**自動アップデート対応** |
| `PortManagerTool-Portable-<version>.exe` | インストール不要の単体の実行ファイル（自動アップデート非対応） |

- インストーラー版は、起動 15 秒後と 6 時間ごと（または設定画面の「アップデートを確認」）に新しいバージョンを確認し、バックグラウンドでダウンロードします。アプリの終了時、または設定画面の「再起動して更新」でインストールされます。
- 画面の表示には Microsoft Edge WebView2 ランタイムを使います。Windows 11 と最新の Windows 10 には標準で入っています。入っていない環境では、インストーラー版はインストール時に自動で導入し、ポータブル版は起動できません。
- 実行ファイルはコード署名していないため、初回起動時に Windows SmartScreen の警告が表示されることがあります（「詳細情報」→「実行」で起動できます）。
- 管理者権限は不要です。管理者権限で動作しているプロセス（Windows サービスとして動く DB など）は、コマンドラインの取得や停止ができない場合があります。
- お気に入り・監視・設定・履歴は `%APPDATA%\port-manager-tool` に保存されます。インストール版・ポータブル版・`npm start` で共通です。

### v1.0.0（Electron 版）からの移行

v1.0.0 は Electron で作られており、Rust（Tauri）版へは自動アップデートで移行できません。Windows の「設定 → アプリ」で旧版をアンインストールしてから、新しいインストーラーで導入してください（両方のショートカット名が同じため、先に旧版を削除します）。お気に入り・監視・設定・履歴は同じ保存先を使うため引き継がれます。サイドバーの幅や一覧の表示モードなど画面の状態は引き継がれず、初期状態に戻ります。

## Requirements

- **OS**: Windows 10 / 11（x64）
- 開発時: **Node.js** v18 以上（npm を含む）、**Rust** 1.85 以上（`rustup` の stable、MSVC ツールチェーン）、Visual Studio Build Tools（C++ によるデスクトップ開発）

## Getting Started

```bash
# リポジトリをクローン
git clone https://github.com/Termnix-IT/PortManagerTool.git
cd PortManagerTool

# 依存パッケージ（Tauri CLI と Lint 用）のインストール
npm install

# アプリの起動（初回は Rust のビルドに数分かかります）
npm start
```

## Development

```bash
npm test            # renderer の純粋関数のテスト（node:test）
npm run test:rust   # Rust のテスト（cargo test）
npm run lint        # ESLint
npm run lint:rust   # cargo fmt --check と clippy（警告をエラーとして扱う）
npm run build       # インストーラーと実行ファイルを src-tauri/target/release/ に作成（アップロードしない）
npm run icon        # build/icon.svg から src-tauri/icons/ のアイコンを再生成
```

- `main` への push と Pull Request では GitHub Actions（CI）が Lint とテスト（JavaScript と Rust）を実行します。
- リリースは `v<version>` タグの push で GitHub Actions がビルドし、Releases に下書きとしてアップロードします。手順と署名の設定は [docs/RELEASE.md](docs/RELEASE.md) を参照してください。
- Rust のテストは、検証・分類・停止の判断・監視・履歴などのロジックを偽物のシステム情報やダイアログに差し替えて確認します。ポート一覧やプロセス情報を取得する Win32 API の部分は、テスト中に実際のソケットや子プロセスを作って確認します。
- 画面の変更は `npm start` で起動して目視確認してください。利用者の履歴・設定を汚さずに確認したい場合は、`npx tauri dev -- -- --user-data-dir=<一時フォルダ>` のように保存先を指定して起動します（この指定がある間は多重起動の防止も無効になります）。

## Tech Stack

| 技術 | 用途 |
|---|---|
| [Tauri](https://tauri.app/) v2 | デスクトップアプリフレームワーク（WebView2 で画面を表示） |
| Rust（`src-tauri/`） | ポート検出・プロセス停止・監視・履歴・保存など、画面以外のすべての処理 |
| [windows](https://github.com/microsoft/windows-rs) crate | Win32 API（`GetExtendedTcpTable` / `GetExtendedUdpTable`、プロセス情報、TaskDialog など） |
| Vanilla JS（ES モジュール） | 画面（ビルドステップなし） |
| CSS（`renderer/style.css`） | UIスタイリング（ダークテーマ）。外部リソースは読み込まない |
| [tauri-plugin-updater](https://v2.tauri.app/plugin/updater/) | GitHub Releases の `latest.json` を使った自動アップデート |
| netsh / taskkill | 予約ポート範囲の取得・プロセス停止 |

## Project Structure

```
PortManagerTool/
├── src-tauri/                 # Rust（Tauri）側
│   ├── tauri.conf.json        # アプリ設定（CSP・インストーラー・アップデート）
│   ├── capabilities/          # 画面に許可する Tauri の権限
│   ├── icons/                 # アプリアイコン（npm run icon で生成）
│   └── src/
│       ├── lib.rs             # 起動処理（ウィンドウ・監視/履歴のループ・アップデート・多重起動の防止）
│       ├── commands.rs        # 画面から呼ぶコマンド（引数は validation.rs で検証）
│       ├── validation.rs      # コマンド引数の検証
│       ├── scanner.rs         # ポート検出
│       ├── excluded_ports.rs  # Windows の予約ポート範囲の取得
│       ├── classifier.rs      # 開発 / DB プロセスの分類
│       ├── port_history.rs    # ポートの使用開始 / 解放の検出
│       ├── history_storage.rs # 履歴の保存（JSONL）
│       ├── process_safety.rs  # 停止前の危険度判定・再検証
│       ├── kill_flow.rs       # 停止の確認ダイアログと通常/強制停止の流れ
│       ├── killer.rs          # プロセス情報の取得と taskkill
│       ├── monitor.rs         # ポーリング監視・状態変化検出
│       ├── store.rs           # お気に入り・監視・設定の保存（config.json）
│       ├── updater.rs         # 自動アップデートの状態管理
│       ├── notify.rs          # デスクトップ通知
│       └── win/               # Win32 API の呼び出し
├── renderer/
│   ├── index.html             # メインウィンドウ
│   ├── style.css
│   └── js/                    # 画面（ES モジュール）
│       ├── bridge.js          # window.portManager（Rust のコマンドとイベントへの橋渡し）
│       ├── main.js            # エントリーポイント
│       ├── state.js           # 画面間で共有する状態
│       ├── lib/               # DOM に依存しない純粋関数（テスト対象）
│       └── ui/                # 画面ごとのモジュール
├── build/icon.svg             # アプリアイコンの元画像
├── docs/RELEASE.md            # リリース手順・署名
├── .github/workflows/         # CI（Lint・テスト）とリリース
└── test/renderer/             # node:test によるテスト
```

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Rust (src-tauri/)                                  │
│  ┌──────────────┐  ┌────────────┐  ┌─────────────┐  │
│  │   scanner    │  │ kill_flow  │  │   monitor   │  │
│  │ (Win32 API)  │  │ (taskkill) │  │  (thread)   │  │
│  └──────────────┘  └────────────┘  └─────────────┘  │
│  ┌──────────────┐  ┌────────────┐                   │
│  │    store     │  │port_history│ ← JSON / JSONL    │
│  └──────────────┘  └────────────┘                   │
├──────── Tauri IPC (invoke / event) ─────────────────┤
│  renderer/js/bridge.js → window.portManager         │
├─────────────────────────────────────────────────────┤
│  WebView2 (renderer/)                               │
│  ┌──────────────┐ ┌──────────────────────────────┐  │
│  │ Sidebar      │ │ Dashboard                     │  │
│  │ Navigation   │ │ Port list + Inspector         │  │
│  └──────────────┘ └──────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

## License

[ISC](LICENSE)
