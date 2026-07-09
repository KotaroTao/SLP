# SLP エリア管理システム

スマイルライフ・プロジェクト（SLP）のエリア管理（データ基盤・空き状況チェッカー・全国マップ）。
プロジェクトルール・データ構造の詳細は [CLAUDE.md](./CLAUDE.md) を参照。

## 構成

| パス | 内容 |
| --- | --- |
| `data/contracts.json` | 契約マスタ（真実の唯一のソース・手編集対象） |
| `data/towns/{市区町村コード}.json` | 町丁目マスタ（fetch-towns.js が生成） |
| `lib/overlap.js` | 重複判定モジュール（コード集合の重複・半径円内の町丁目抽出） |
| `scripts/fetch-towns.js` | 町丁目マスタ取得スクリプト |
| `scripts/build.js` | 検証＋生成物ビルド |
| `templates/slp_map.template.html` | 全国エリアマップのソース（手編集はこちら。生成物は編集禁止） |
| `assets/japan-map.svg` | 都道府県SVG（geolonia/japanese-prefectures をベンダリング） |
| `public/slp_check.html` | エリア空き状況チェッカー（LP埋め込み用・一般公開） |
| `public/slp_admin.html` | 管理者専用コンソール（医院の登録・実施ON/OFF）。本番ではサーバー保存モードで動作し、**メンバー全員が同じデータを編集・保存できる**（保存と同時に公開データを自動再生成・アップロード作業不要）。api.php が無い環境では従来のローカルモード（ファイル読込→生成ダウンロード）で動く |
| `public/api.php` | 管理API（エックスサーバーのPHPで動作）。認証はサーバー側照合（失敗5回で60秒ロック）、契約データは `private/store.json` に保存（.htaccessでHTTP全拒否・バックアップ30世代）、保存時に build.js と同一仕様で taken/summary を再生成。楽観ロックで同時編集の上書きを防止。さらに外部公開API `publicClinicAreas`（稼働中医院の配布エリア）へのサーバーサイドプロキシ `action=clinics` を備える（APIキーはサーバー環境変数に隠蔽。公開向けは医院特定情報を除去した匿名データ、`full=1`＋管理者ログインで生データ） |
| `public/private/.htaccess` | 契約データ置き場のHTTPアクセス全拒否設定 |
| `public/slp_map.html` | 全国エリアマップ公開版（**当面は非公開運用**。医院名なし・noindex付き） |
| `internal/slp_map.html` | 全国エリアマップ内部版（営業・説明会・管理用。データ埋め込み済みで **file:// でダブルクリックしても動く**） |
| `public/data/taken.json` | 確保済み町丁目のSHA-256ハッシュ配列（公開・チェッカー用） |
| `public/data/summary.json` | 市区町村別サマリ（公開・マップ用。医院名なし） |
| `public/data/towns/` | 町丁目マスタの公開コピー＋索引（チェッカーの遅延ロード用） |
| `internal/data/internal.json` | 医院名込み全詳細（非公開・管理用） |

## 運用フロー（契約が入ったら）

**方法A（推奨・メンバー全員）**：`https://jdapo.jp/slp/slp_admin.html` を開いてログイン →
医院を登録／ON・OFF →「サーバーに保存して公開に反映」。これだけで完了
（公開データはサーバー上で自動再生成される。ファイルのダウンロード・アップロードは不要）。
他のメンバーが先に保存していた場合は競合が検出され、最新を読み込み直してから編集する。

**方法B（開発環境）**：
1. `data/contracts.json` に1ブロック追記（医院名・市区町村コード・町丁目コード配列）
   ※町丁目マスタは**全国1,886市区町村を取得済み**のため、通常 fetch-towns の実行は不要
2. `npm run build` を実行。**先行契約と町丁目が重複していればここでビルドが失敗し、
   どの契約同士がどの町丁目で衝突しているかが表示される**（＝契約前の最終チェック）
3. `public/data/` の生成物をサーバー（jdapo.jp）にアップロード

※本番（サーバーモード）のパスワード照合は api.php がサーバー側で行うため実効性のあるアクセス制御になっている
（さらに強化する場合はBasic認証を重ねられる）。api.php の無い環境でのローカルモードの照合は簡易ロック。

## 本番反映（GitHub Actions 自動デプロイ）

main ブランチの `public/**` に変更が入ると、`.github/workflows/deploy.yml` が
エックスサーバーへFTPSで自動デプロイする（手動アップロード不要）。

必要な GitHub Secrets（リポジトリ Settings → Secrets and variables → Actions）:

| Secret | 内容 |
| --- | --- |
| `XSERVER_FTP_HOST` | FTPホスト名（例 `sv12345.xserver.jp`。サーバーパネル「FTPアカウント設定」で確認） |
| `XSERVER_FTP_USER` | FTPユーザー名 |
| `XSERVER_FTP_PASSWORD` | FTPパスワード |
| `XSERVER_SLP_DIR` | デプロイ先（例 `/jdapo.jp/public_html/slp/`・末尾スラッシュ必須） |

サーバー上で実行時に生成されるデータ（`private/store.json`・バックアップ・`data/taken.json`・
`data/summary.json`）はデプロイの除外対象で、**上書き・削除されない**。

外部公開API `publicClinicAreas` のプロキシ（`api.php?action=clinics`）を使う場合は、エックスサーバー側で
環境変数 `PUBLIC_AREAS_API_KEY` にAPIキーを設定する（`.htaccess` の `SetEnv PUBLIC_AREAS_API_KEY <キー>` 等。
**キーはリポジトリにコミットしない**）。未設定なら `action=clinics` は 503 を返すだけで他機能に影響はない。
キー漏洩時はこの環境変数を差し替えれば即無効化できる。

町丁目マスタを最新化したい場合（年1回程度で十分）：
`node scripts/fetch-towns.js --all --refresh` → `npm run build`

## コマンド

```bash
npm run build                  # contracts.json から全生成物を再生成
npm test                       # ユニットテスト（重複判定・ハッシュ照合・スキーマ・漏洩検査）
npm run serve                  # ローカルプレビュー（http://localhost:8000）
npm run fetch-towns -- 14102   # 町丁目マスタ取得（例：横浜市神奈川区）
```

## データ出典

- 町丁目マスタ：[frogcat/japan-small-area](https://github.com/frogcat/japan-small-area)（MITライセンス）を加工して作成。
  元データは「政府統計の総合窓口（e-Stat）統計LOD」の平成27年国勢調査 小地域データ。
  公開ページには e-Stat の出典表記を入れること。
- 地図タイル：国土地理院 地理院タイル。出典表記必須。
- 都道府県SVG：[geolonia/japanese-prefectures](https://github.com/geolonia/japanese-prefectures)
  （原典: Wikipedia「日本地図.svg」・**GFDLライセンス**）。ページ内に出典＋ライセンスリンクを表記済み。
  将来、公開版マップのLP掲載時にGFDLが問題になる場合は、`data-code` 属性の構造を保った別SVGへの
  差し替えのみで対応可能（JS側の変更不要）。
