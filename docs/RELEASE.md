# リリース手順

## 通常のリリース

1. `package.json` と `src-tauri/Cargo.toml` の `version` を上げる（例: `1.0.0` → `1.1.0`）。アプリのバージョンは `package.json` の値が使われ、`Cargo.toml` はワークフローで一致を確認する

   ```bash
   npm version minor --no-git-tag-version
   ```

   `Cargo.toml` を書き換えたら `npm run test:rust` などで一度ビルドして `src-tauri/Cargo.lock` を更新し、一緒にコミットする（CI は `--locked` で実行するため、更新漏れは失敗する）

2. 変更をコミットして `main` に push する
3. バージョンと同じ名前のタグを作成して push する

   ```bash
   git tag v1.1.0
   git push origin v1.1.0
   ```

4. GitHub Actions の **Release** ワークフローが次を行う
   - タグと `package.json`・`Cargo.toml` の `version` が一致するか確認
   - Lint とテスト（JavaScript と Rust）
   - インストーラーと単体の実行ファイルのビルド、自動アップデート用の署名（`.sig`）と `latest.json` の作成
   - GitHub Releases への**下書き**としてのアップロード
5. GitHub の Releases 画面で下書きの内容（リリースノート）を確認し、**Publish release** で公開する

公開した時点で、インストール版のアプリは起動 15 秒後（以降 6 時間ごと）の確認、または設定画面の「アップデートを確認」で新しいバージョンを検出し、バックグラウンドでダウンロードします。アプリの終了時、または「再起動して更新」でインストールされます。

### 自動アップデートの対象

| 形態 | 自動アップデート |
|---|---|
| インストーラー版（`PortManagerTool-Setup-*.exe`） | 対応 |
| 単体の実行ファイル（`PortManagerTool-Portable-*.exe`） | 非対応（リリースページから新しいファイルを入手） |
| `npm start` | 非対応 |
| v1.0.0（Electron 版） | 非対応（移行手順は README の「v1.0.0（Electron 版）からの移行」） |

アプリは `https://github.com/Termnix-IT/PortManagerTool/releases/latest/download/latest.json`（公開済みの最新リリースの `latest.json`）で更新を判定し、そこに書かれたインストーラーをダウンロードして `.sig` の署名を検証します。リリースから `latest.json` やインストーラーを削除・改名しないでください。下書きとプレリリースは `latest` に含まれないため、利用者には届きません。

### 手元でのビルド

```bash
npm run build
```

`src-tauri/target/release/bundle/nsis/` にインストーラー、`src-tauri/target/release/port-manager-tool.exe` に単体の実行ファイルが作られます（アップロードはしません）。自動アップデート用の `.sig` は、署名鍵を渡すワークフローでのみ作ります。

## アップデートの署名鍵（必須）

自動アップデートは、インストーラーが改ざんされていないことを minisign 形式の署名で確認します。公開鍵は `src-tauri/tauri.conf.json` の `plugins.updater.pubkey` に入っています。秘密鍵はリポジトリに置かず、GitHub の Secrets から Release ワークフローに渡します。

1. 鍵がなければ作成する（パスワードの入力を求められる）。秘密鍵はリポジトリの外に保存する

   ```bash
   npx tauri signer generate -w ~/.tauri/port-manager-tool.key
   ```

   作成した `~/.tauri/port-manager-tool.key.pub` の内容を `plugins.updater.pubkey` に設定する

2. リポジトリの **Settings → Secrets and variables → Actions** に登録する（`gh` を使う場合の例）

   ```bash
   gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/port-manager-tool.key
   gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD
   ```

   - `TAURI_SIGNING_PRIVATE_KEY`: 秘密鍵ファイルの内容
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: 鍵のパスワード

秘密鍵を失うか公開鍵を差し替えると、それより前のバージョンのアプリは新しい鍵で署名された更新を検証できず、自動アップデートが止まります（手動で入れ直す必要があります）。秘密鍵とパスワードはパスワードマネージャーなどにバックアップしてください。

## コード署名

アップデートの署名とは別に、実行ファイル自体（Authenticode）は署名していないため、初回起動時に Windows SmartScreen の警告が表示されます。署名するには証明書を用意し、次のいずれかを設定します。証明書ファイルやパスワードはリポジトリにコミットせず、GitHub の Secrets に登録してください。

### A. コード署名証明書（.pfx）を使う

1. 認証局から OV コード署名証明書を購入し、`.pfx` 形式で書き出す
2. `.pfx` を Base64 に変換し、Secrets に `WIN_CSC_LINK`（Base64 文字列）と `WIN_CSC_KEY_PASSWORD`（`.pfx` のパスワード）として登録する

   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("cert.pfx")) | Set-Clipboard
   ```

3. `release.yml` の Build の前に、Secrets から `.pfx` を復元して `Import-PfxCertificate` で `Cert:\CurrentUser\My` に取り込むステップを追加する
4. `src-tauri/tauri.conf.json` の `bundle.windows` に証明書の拇印などを設定する

   ```json
   "certificateThumbprint": "<証明書の拇印>",
   "digestAlgorithm": "sha256",
   "timestampUrl": "http://timestamp.digicert.com"
   ```

注意: 近年発行される証明書の多くはハードウェアトークン（HSM）での保管が必須で、`.pfx` として書き出せません。その場合は B を検討してください。

### B. Azure Trusted Signing を使う

Microsoft のクラウド署名サービスです。個人・小規模でも利用しやすい料金体系です。

1. Azure で Trusted Signing アカウントと証明書プロファイルを作成し、本人確認を完了する
2. 署名に使うアプリ登録（サービスプリンシパル）を作成し、署名のロールを付与する
3. ワークフローで `cargo install trusted-signing-cli` を実行し、`bundle.windows.signCommand` に署名コマンドを設定する（`%1` が署名するファイルに置き換わる）

   ```json
   "signCommand": "trusted-signing-cli -e https://<region>.codesigning.azure.net -a <アカウント名> -c <証明書プロファイル名> %1"
   ```

4. Secrets に `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` を登録し、`release.yml` の Build の `env` に渡す

### C. SignPath Foundation（オープンソース向け）

公開リポジトリのオープンソースプロジェクトは、審査に通れば無償で署名を受けられます。GitHub Actions との連携手順は SignPath のドキュメントに従ってください。
