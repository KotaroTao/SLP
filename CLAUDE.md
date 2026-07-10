# CLAUDE.md — SLPエリア管理システム

## プロジェクト概要
スマイルライフ・プロジェクト（SLP）：JDAPO公式の歯科健康情報チラシ定期ポスティング事業。
同一エリアは1医院限定（先着順）。判定基準は「配布世帯の重複」＝町丁目単位のエリアの重なり。
本ディレクトリ（slp/）は以下の3つを管理する：
1. エリアデータ基盤（契約医院と確保済み町丁目のマスタ管理）— フェーズ1
2. エリア空き状況チェッカー `public/slp_check.html`（LP埋め込み用・一般公開）— フェーズ2
3. 全国エリアマップ `internal/slp_map.html`／`public/slp_map.html`（営業・管理用。将来公開に切り替え可能な設計）— フェーズ3

## 絶対に守るルール
- データの真実は data/contracts.json のみ。他のすべてのデータファイルはビルドスクリプトで生成する（手編集禁止）
- 公開用の生成物（public/ 配下）に医院名・医院を特定できる情報を絶対に含めない
- 管理データは町丁目コード（国勢調査 小地域コード・9〜11桁）単位で持つ。市区町村単位への集計は生成時に行う
- HTML出力ルール：絵文字は使用禁止。記号類（チェックマーク・矢印・三角など）はHTMLエンティティ（&#10003; &#8594; &#9651; など）で記述。価格はYen記号ではなく「6万6,000円」のような日本語表記
- 公開ページ（チェッカー・マップ）は単一HTMLファイル＋静的JSONで完結させる（サーバー処理に依存しない）。
  管理機能のみ最小のPHP API（public/api.php・エックスサーバーで動作）を使う。
  契約データはサーバーの private/store.json（.htaccessでHTTP全拒否）にのみ置く
- 外部APIはすべてクライアントサイドから直接呼ぶ（キー不要のものだけ使う）
- 出典表記を必ず入れる：地理院タイル、e-Stat由来の小地域データ、その他利用データのライセンスに従ったクレジット

## 技術スタック
- ビルドスクリプト：Node.js 22+（依存パッケージゼロ・ESM・node:test）
- フロント：Vanilla JS + Leaflet（CDN）。ビルドツール不使用、単一HTMLで完結
- 地図タイル：地理院タイル（https://maps.gsi.go.jp/development/ichiran.html で仕様確認）
- ジオコーディング：国土地理院 AddressSearch API（キー不要）。郵便番号はzipcloud API
- 町丁目マスタ：frogcat/japan-small-area（e-Stat統計LOD由来・2015年国勢調査小地域・GitHubホスト）。
  ポリゴン重心を代表点として scripts/fetch-towns.js が data/towns/ に変換保存する。
  ソースアダプタ方式のため、将来 2020年版（Geoshape「国勢調査町丁・字等別境界データセット」等）へ差し替え可能。
  ※Geolonia japanese-addresses は国勢調査小地域コード非収録のため不採用（調査済み・2026-07）
- 町丁目ポリゴン（フェーズ4以降・必要時）：e-Stat 国勢調査（2020）小地域境界データ。契約のある市区町村分のみ変換・保持

## データ構造
data/contracts.json（非公開・管理用マスタ）:
```
{
  "updated": "YYYY-MM-DD",
  "contracts": [
    {
      "id": "SLP-0001",
      "clinic": "（医院名。公開生成物には絶対に出力しない）",
      "status": "active",            // active | pending | paused | ended
      "municipality": "14102",       // 総務省 標準地域コード5桁
      "towns": ["14102018001", ...]  // 小地域（町丁目）コードの配列（9〜11桁）
    }
  ]
}
```

ステータスの意味（エリア確保と公開反映）:
- active : 実施中。taken/summary に反映（チェッカーで「重複あり」）＝エリア確保
- pending: 商談中。公開上は募集中扱い（taken/summary 非反映）だがエリアは確保＝他院登録をブロック
- paused : 停止。サポートポータル（seo.tao-dx.com）で停止設定された医院。公開上は募集中に戻し、
           エリアも解放＝他院が同一エリアを取得可能（＝停止中に他院が契約すると再開不可）。手動では slp_admin では設定せず、ポータル同期（api.php action=sync）で反映する
- ended  : 解約。公開・重複判定から完全に除外

## サポートポータル連携（参加ステータス同期）
- 参加/停止の「真実」はサポートポータル（seo.tao-dx.com のSLPタグ付き医院）が持つ。
  ポータルが api.php の `action=sync` に `{updates:[{id, status}]}`（status は active|paused のみ）を
  POST し、当APIは既存契約の status のみ更新（towns/municipality は不変）→ 検証 → taken/summary を再生成する。
- 認証は共有シークレット（ヘッダ `X-SLP-Sync-Secret` を SHA-256 照合）。サーバー側は環境変数
  `SLP_SYNC_SECRET`（優先）または api.php の定数 `SYNC_SECRET_SHA256` で期待値を設定する。未設定時は 503。
- ポータル側の医院⇄契約の対応付けは ClinicProfile.slpContractId（SLP-000X）で行う（SEOリポジトリ側）。
- エリア（町丁目）の作成・解約・商談中(pending)はこれまで通り slp_admin.html で管理する（ポータル同期は active/paused のみ触る）。

## 公開エリアAPI連携（外部Cloud Function → 当システムでプロキシ）
- 稼働中医院の配布エリア（住所・座標・部数）は外部の公開API `publicClinicAreas`
  （smile-life-project の Cloud Functions・GET・`X-API-Key` 認証）が持つ。
- APIキーは絶対にフロントのJSに書かない。api.php がサーバーサイドで取り込み、
  キーはサーバーの環境変数 `PUBLIC_AREAS_API_KEY` にのみ置く（未設定時は 503）。
  上流URLは既定で本番だが環境変数 `PUBLIC_AREAS_API_URL` で上書き可（テスト・切替用）。
- 取り込んだデータはサーバーに保存する（＝clinicsデータベース。毎回上流を叩かず保存済みを配信）:
  - `private/clinics.json` : 医院名込みの原本＋メタ（savedAt/generatedAt/count）。.htaccessでHTTP全拒否。
    契約の真実 `contracts.json` とは別系統（ポータルの配布エリア実績のスナップショット）。
  - `public/data/clinics.json` : 医院名を除いた匿名版（公開ページが直接読める生成物）。
  - どちらもサーバー実行時生成物。デプロイ除外・.gitignore 済み（コミットしない）。
- `POST action=clinics_save`：上流から取り込み、上記2ファイルへ保存＋直近30世代バックアップ。
  医院名を扱うため管理者ヘッダ＋ログイン必須。
- `GET action=clinics`（既定）：保存済みの**匿名データ**（配布エリアの都道府県/市区町村/町丁目/
  完全住所/緯度経度/部数のみ・医院名なし）を返す＝公開ページ用。5分キャッシュ可
  （`Cache-Control: public, max-age=300`）。未保存なら `stored:false`。
- `GET action=clinics&full=1`：保存済みの医院名込みデータを返す。管理者ヘッダ＋ログイン必須（内部用途のみ）。
- キー漏洩時はサーバーの `PUBLIC_AREAS_API_KEY` を差し替えるだけで即無効化できる（コミット物には含めない）。
- ポータル基準での契約反映：slp_admin.html は保存済み医院データの配布エリアを町丁目コードへ突合し
  （①住所名の一致を優先＝全角/漢数字を正規化、②外れたら座標で最寄り町丁目に割当＝要確認）、
  契約下書きを生成する。管理者が「未突合／要確認／重複」を確認してから反映すると、既存契約を
  ポータル基準に置き換えて taken/summary を再生成する（＝ポータルを真実として運用する経路）。
  突合ロジックは slp_admin.html の純ロジックブロックにあり test/admin-logic.test.js が検証する。

生成物（npm run build で出力）:
- public/data/taken.json     : active契約の全町丁目コードのSHA-256ハッシュ配列・辞書順ソート（チェッカー用。生コードを晒さない）
- public/data/summary.json   : 市区町村コード別の確保町丁目数・ステータス open/few/closed（マップ公開版用）
- internal/data/internal.json : 医院名込みの全詳細（マップ内部版用。public/ではなく internal/ に出力）

## テストフィクスチャ
モニター医院サンプル（実在の参加医院・匿名ID化して登録）：
- SLP-0001: 横浜市神奈川区（14102）、入江1丁目・2丁目を中心とする半径1.0km圏の22町丁目
  ※開発キット原本の「神奈川区=14103」は誤り。14103は横浜市西区。神奈川区は14102（修正済み・確認済み）
  入江一丁目=14102018001、入江二丁目=14102018002
テスト期待値：
- 「横浜市神奈川区入江1-13-25」でチェック → 重複あり判定
- 「兵庫県芦屋市」の任意住所でチェック → 募集中判定

## コマンド
- npm run build        : contracts.json から全生成物を再生成（契約重複があれば失敗し衝突箇所を表示）。
                         全国マップは templates/slp_map.template.html（手編集はこちら）から
                         internal/slp_map.html（データ埋め込み・file://可）と public/slp_map.html を生成
- npm test             : 判定ロジック・ハッシュ照合・生成物スキーマ・情報漏洩のユニットテスト
- npm run serve        : ローカルプレビュー（python3 -m http.server 8000）
- npm run fetch-towns -- <市区町村コード5桁> : 町丁目マスタを data/towns/ に取得
  （--all で全国一括取得。全国1,886市区町村を取得・コミット済みのため通常は実行不要）

## 環境メモ
- Claude Code リモート実行環境（プロキシ経由）では、fetch-towns.js 実行時に
  `NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt` を付ける。
  また同環境のネットワークポリシーはGitHub系ドメインのみ許可（e-Stat・地理院・zipcloudへはビルド時到達不可。
  クライアントサイドAPIは閲覧者のブラウザから呼ばれるため影響なし）
- 本番反映は .github/workflows/deploy.yml（main の public/** 変更でエックスサーバーへFTPS自動デプロイ）。
  サーバー実行時データ（private/store.json・data/taken.json・data/summary.json 等）は除外済みで上書きされない
