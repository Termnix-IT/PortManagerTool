# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Commands

```bash
npm start          # アプリ起動 (npx electron .)
```

テストフレームワーク・リンター・ビルドツールは未導入。

## Architecture

Windows専用のElectronデスクトップアプリ。ビルドステップなし、Vanilla JS (CommonJS)、Tailwind CSS (CDN)。

### Process boundary

- **Main process** (`main.js`): IPC handler登録、ダイアログ表示、デスクトップ通知、監視ループ起動。すべてのシステムコマンド実行はmainプロセス側で行う。
- **Preload** (`preload.js`): `contextBridge`で`window.portManager` APIをrendererに公開。IPCチャネル名は`ports:scan`, `favorites:list`等のnamespaced形式。
- **Renderer** (`renderer/`): DOM操作のみ。`window.portManager.*`経由でmainと通信。フレームワーク不使用。

### Renderer UI

Codexデスクトップアプリ風の暗色UI。画面遷移はサイドバーで管理し、上部バーは操作補助に限定する。

- **サイドバー**: `ダッシュボード`, `ポート一覧`, `お気に入り`, `監視`, `設定` のナビゲーションを担当。
- **上部バー**: サイドバー開閉、戻る、進む、検索、更新のみを配置。ビュー切替タブは置かない。
- **サイドバー状態**: 折りたたみ状態と幅はrenderer側で`localStorage`に保存する。
- **サイドバー幅調整**: サイドバー右端のresize handleでドラッグ調整する。最小/最大幅はrenderer JS側で制限する。
- **ビュー履歴**: renderer内で履歴stackを持ち、戻る/進むボタンを制御する。履歴永続化はしない。
- **メイン領域**: 黒〜濃グレー基調のCodex風配色。文字は小さめ、補助テキストは低コントラストにする。
- **ダッシュボード**: KPI、ポート一覧、右側の詳細/推移/イベントを表示する。取得できない情報を擬似表示しない。
- **ポート一覧ナビ**: 独立ビューではなく、ダッシュボード内のポート一覧へフォーカスする扱い。

### src/ modules

| Module | Role |
|---|---|
| `port-scanner.js` | PowerShell (`Get-NetTCPConnection` / `Get-NetUDPEndpoint`) でポート情報取得。`execFile`で実行しJSON parse。`scanPorts()`（全ポート）と`checkPorts(ports)`（指定ポートのみ、監視用）を提供。 |
| `port-killer.js` | `taskkill /PID {pid} /F` でプロセス停止。 |
| `store.js` | `electron-store` v8 (CJS互換) でfavorites/monitors/settingsを永続化。 |
| `monitor.js` | `setInterval`で定期ポーリング。状態変化検出時にコールバック発火→main.jsが通知とrendererへのpushを担当。 |

### Key constraints

- **Windows only**: PowerShell cmdlet (`Get-NetTCPConnection`) と `taskkill` に依存。
- **electron-store v8**: v9+はESMのみでCJSプロジェクトでは`require`不可。v8を維持すること。
- **UIの言語は日本語**: ユーザー向けテキスト（ボタン、メッセージ、通知）はすべて日本語。
- ポート検出に`netstat`は使わない（日本語ロケールでのパース困難のため、PowerShellを採用）。
- Electron標準タイトルバーは維持する。アプリ内の上部バーを「タイトルバー相当」の操作領域として扱う。
- `window.portManager` API、IPCチャネル、永続化スキーマは必要がない限り変更しない。
- rendererではNode APIを直接使わない。システム操作はmain process経由にする。

## Verification

```bash
node --check renderer/app.js
npm start
```

- `npm start` はElectron GUIを起動するため、確認後は起動したプロセスを終了すること。
- 自動テスト、リンター、ビルドは未導入。UI変更は起動確認と目視確認を基本にする。
