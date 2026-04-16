# Port Manager Tool

Windows 向けのポート管理デスクトップアプリケーションです。  
開発時に使用するポート番号の確認・停止・登録・監視をひとつのツールで行えます。

![Electron](https://img.shields.io/badge/Electron-41.x-47848F?logo=electron&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-Windows-0078D6?logo=windows&logoColor=white)
![License](https://img.shields.io/badge/License-ISC-blue)

## Features

### 使用中ポートの一覧表示
- TCP / UDP の使用中ポートをリアルタイムにスキャン
- ポート番号・プロセス名・PID・状態・ローカルアドレスを表示
- テキスト検索、プロトコル、状態によるフィルタリング
- カラムヘッダーのクリックでソート

### プロセスの停止
- 指定ポートを使用しているプロセスをワンクリックで停止
- 確認ダイアログによる誤操作防止

### お気に入りポートの登録・管理
- よく使うポートをラベル・説明付きで登録
- 登録ポートの現在の状態（使用中 / 空き）を自動表示
- アプリ再起動後もデータを保持

### ポート監視・デスクトップ通知
- 指定ポートの状態を定期的にポーリング監視
- ポートの使用開始時・解放時にデスクトップ通知を送信
- 監視間隔のカスタマイズ（1〜60秒）
- ポートごとの監視ON/OFF切替

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
git clone https://github.com/<your-username>/PortMangerTool.git
cd PortMangerTool

# 依存パッケージのインストール
npm install

# アプリの起動
npm start
```

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
PortMangerTool/
├── main.js              # Electron メインプロセス（IPC handler・通知・ウィンドウ管理）
├── preload.js           # contextBridge によるレンダラー向け API 公開
├── package.json
├── src/
│   ├── port-scanner.js  # PowerShell によるポート検出
│   ├── port-killer.js   # taskkill によるプロセス停止
│   ├── store.js         # electron-store による永続化
│   └── monitor.js       # ポーリング監視・状態変化検出
├── renderer/
│   ├── index.html       # メインウィンドウ（3タブ構成）
│   ├── style.css        # カスタムCSS
│   └── app.js           # レンダラー側ロジック（DOM操作・IPC呼び出し）
└── assets/
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
│  ┌─────────┐ ┌────────────┐ ┌──────┐               │
│  │使用中    │ │お気に入り   │ │ 監視 │  ← 3タブUI    │
│  │ポート    │ │            │ │      │               │
│  └─────────┘ └────────────┘ └──────┘               │
└─────────────────────────────────────────────────────┘
```

## License

[ISC](LICENSE)
