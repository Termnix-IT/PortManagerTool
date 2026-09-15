# リリース手順

## 通常のリリース

1. `package.json` の `version` を上げる（例: `1.0.0` → `1.1.0`）

   ```bash
   npm version minor --no-git-tag-version
   ```

2. 変更をコミットして `main` に push する
3. バージョンと同じ名前のタグを作成して push する

   ```bash
   git tag v1.1.0
   git push origin v1.1.0
   ```

4. GitHub Actions の **Release** ワークフローが次を行う
   - タグと `package.json` の `version` が一致するか確認
   - Lint とテスト
   - インストーラー・ポータブル版のビルドと、GitHub Releases への**下書き**としてのアップロード
5. GitHub の Releases 画面で下書きの内容（リリースノート）を確認し、**Publish release** で公開する

公開した時点で、インストール版のアプリは起動 15 秒後（以降 6 時間ごと）の確認、または設定画面の「アップデートを確認」で新しいバージョンを検出し、バックグラウンドでダウンロードします。アプリの終了時、または「再起動して更新」でインストールされます。

### 自動アップデートの対象

| 形態 | 自動アップデート |
|---|---|
| インストーラー版（`PortManagerTool-Setup-*.exe`） | 対応 |
| ポータブル版（`PortManagerTool-Portable-*.exe`） | 非対応（リリースページから新しいファイルを入手） |
| `npm start` | 非対応 |

更新の判定には、リリースに添付される `latest.yml` を使います。リリースからこのファイルを削除しないでください。

### 手元でのビルド

```bash
npm run pack   # dist/win-unpacked（インストーラーなし、動作確認用）
npm run dist   # dist/ にインストーラーとポータブル版（アップロードしない）
```

`npm run release` は GitHub にアップロードするため、通常は GitHub Actions からのみ実行します（`GH_TOKEN` が必要）。

## コード署名

現在の配布物は署名していないため、初回起動時に Windows SmartScreen の警告が表示されます。署名するには証明書を用意し、次のいずれかを設定します。証明書ファイルやパスワードはリポジトリにコミットせず、GitHub の Secrets に登録してください。

### A. コード署名証明書（.pfx）を使う

1. 認証局から OV コード署名証明書を購入し、`.pfx` 形式で書き出す
2. `.pfx` を Base64 に変換する

   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("cert.pfx")) | Set-Clipboard
   ```

3. リポジトリの **Settings → Secrets and variables → Actions** に登録する
   - `WIN_CSC_LINK`: 手順 2 の Base64 文字列
   - `WIN_CSC_KEY_PASSWORD`: `.pfx` のパスワード
4. 以降の Release ワークフローで自動的に署名される（`.github/workflows/release.yml` で環境変数として渡している）

注意: 近年発行される証明書の多くはハードウェアトークン（HSM）での保管が必須で、`.pfx` として書き出せません。その場合は B を検討してください。

### B. Azure Trusted Signing を使う

Microsoft のクラウド署名サービスです。個人・小規模でも利用しやすい料金体系です。

1. Azure で Trusted Signing アカウントと証明書プロファイルを作成し、本人確認を完了する
2. 署名に使うアプリ登録（サービスプリンシパル）を作成し、署名のロールを付与する
3. `package.json` の `build.win` に追加する

   ```json
   "azureSignOptions": {
     "publisherName": "<証明書の発行先名>",
     "endpoint": "https://<region>.codesigning.azure.net",
     "codeSigningAccountName": "<アカウント名>",
     "certificateProfileName": "<証明書プロファイル名>"
   }
   ```

4. Secrets に `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` を登録し、`release.yml` の `env` に渡す

### C. SignPath Foundation（オープンソース向け）

公開リポジトリのオープンソースプロジェクトは、審査に通れば無償で署名を受けられます。GitHub Actions との連携手順は SignPath のドキュメントに従ってください。

### 署名を始めたら

自動アップデートで、署名者が一致するインストーラーだけを受け付けるよう、`build.win` に発行先名を設定します（A の場合）。

```json
"signtoolOptions": {
  "publisherName": "<証明書の発行先名（CN）>"
}
```

未署名のバージョンから署名済みのバージョンへの更新は、この設定を追加する前の最初の署名済みリリースで行ってください（未署名版は発行先名を検証しないため）。
