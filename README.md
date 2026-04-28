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
- 確認ダイアログによる誤操作防止
- TCP の Established 接続は誤停止防止のため停止不可として表示

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
├── main.js              # Electron メインプロセス（IPC handler・通知・ウィンドウ管理）
├── preload.js           # contextBridge によるレンダラー向け API 公開
├── package.json
├── src/
│   ├── port-scanner.js  # PowerShell によるポート検出
│   ├── port-killer.js   # taskkill によるプロセス停止
│   ├── store.js         # electron-store による永続化
│   └── monitor.js       # ポーリング監視・状態変化検出
├── renderer/
│   ├── index.html       # メインウィンドウ（サイドバー + ダッシュボード構成）
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
│  ┌──────────────┐ ┌──────────────────────────────┐  │
│  │ Sidebar      │ │ Dashboard                     │  │
│  │ Navigation   │ │ Port list + Inspector         │  │
│  └──────────────┘ └──────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

## License

[ISC](LICENSE)
