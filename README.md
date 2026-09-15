# Port Manager Tool

Windows 向けのポート管理デスクトップアプリケーションです。  
開発時に使用するポート番号の確認・停止・登録・監視をひとつの軽量な作業画面で行えます。

![Electron](https://img.shields.io/badge/Electron-41.x-47848F?logo=electron&logoColor=white)
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
- 左側サイドバーで `ダッシュボード`, `ポート一覧`, `お気に入り`, `監視`, `設定` を移動
- 上部バーに戻る / 進む / 検索 / 更新を集約
- ダッシュボードは一覧密度を優先し、概要はコンパクトなステータス行で表示
- 右側インスペクターにポート詳細・スキャン推移・最近のイベントを統合表示

## Screenshot

<!-- スクリーンショットを追加する場合は以下のコメントを置き換えてください -->
<!-- ![Screenshot](assets/screenshot.png) -->

## Requirements

- **OS**: Windows 10 / 11
- **Node.js**: v18 以上
- **npm**: v9 以上

## Getting Started

```bash
# リポジトリをクローン
git clone https://github.com/<your-username>/PortManagerTool.git
cd PortManagerTool

# 依存パッケージのインストール
npm install

# アプリの起動
npm start
```

## Development

```bash
npm test        # テスト（node:test）
npm run lint    # ESLint
```

- テストは `src/` のロジックと `renderer/js/lib/` の純粋関数が対象です。PowerShell や electron-store は依存注入した偽物に差し替えるため、Electron を起動せずに実行できます。
- 画面の変更は `npm start` で起動して目視確認してください。

## Tech Stack

| 技術 | 用途 |
|---|---|
| [Electron](https://www.electronjs.org/) v41 | デスクトップアプリフレームワーク |
| Vanilla JS (CommonJS) | ビルドステップ不要の軽量構成 |
| [Tailwind CSS](https://tailwindcss.com/) (CDN) | UIスタイリング（ダークテーマ） |
| [electron-store](https://github.com/sindresorhus/electron-store) v8 | お気に入り・監視設定の永続化 |
| PowerShell | ポート検出（`Get-NetTCPConnection` / `Get-NetUDPEndpoint`） |

## Project Structure

```
PortManagerTool/
├── main.js                  # Electron メインプロセス（IPC handler・通知・ウィンドウ管理）
├── preload.js               # contextBridge によるレンダラー向け API 公開
├── src/                     # メインプロセス側のモジュール（Node.js / CommonJS）
│   ├── powershell.js        # PowerShell 実行の共通処理（エラーと0件の区別）
│   ├── port-scanner.js      # ポート検出
│   ├── excluded-ports.js    # Windows の予約ポート範囲の取得
│   ├── port-history.js      # ポートの使用開始 / 解放の検出
│   ├── history-storage.js   # 履歴の保存（JSONL）
│   ├── port-classifier.js   # 開発 / DB プロセスの分類
│   ├── port-killer.js       # プロセス情報の取得と taskkill
│   ├── process-safety.js    # 停止前の危険度判定・再検証
│   ├── kill-flow.js         # 停止の確認ダイアログと通常/強制停止の流れ
│   ├── validation.js        # IPC 引数の検証
│   ├── store.js             # electron-store による永続化
│   └── monitor.js           # ポーリング監視・状態変化検出
├── renderer/
│   ├── index.html           # メインウィンドウ
│   ├── style.css
│   └── js/                  # レンダラー（ES モジュール）
│       ├── main.js          # エントリーポイント
│       ├── state.js         # 画面間で共有する状態
│       ├── lib/             # DOM に依存しない純粋関数（テスト対象）
│       └── ui/              # 画面ごとのモジュール
└── test/                    # node:test によるテスト
```

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Main Process (main.js)                             │
│  ┌──────────────┐  ┌────────────┐  ┌─────────────┐  │
│  │ port-scanner │  │ port-killer│  │   monitor   │  │
│  │ (PowerShell) │  │ (taskkill) │  │ (setInterval│  │
│  └──────────────┘  └────────────┘  └─────────────┘  │
│  ┌──────────────┐                                   │
│  │    store     │  ← electron-store (JSON)          │
│  └──────────────┘                                   │
├─────────────── IPC (invoke/handle) ─────────────────┤
│  Preload (preload.js)                               │
│  └─ contextBridge → window.portManager              │
├─────────────────────────────────────────────────────┤
│  Renderer Process (renderer/)                       │
│  ┌──────────────┐ ┌──────────────────────────────┐  │
│  │ Sidebar      │ │ Dashboard                     │  │
│  │ Navigation   │ │ Port list + Inspector         │  │
│  └──────────────┘ └──────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

## License

[ISC](LICENSE)
