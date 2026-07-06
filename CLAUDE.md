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
- サーバーサイド不要の構成にする（jdapo.jp は静的ホスティング）。チェッカー・マップは単一HTMLファイル＋静的JSONで完結させる
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
      "status": "active",            // active | pending | ended
      "municipality": "14102",       // 総務省 標準地域コード5桁
      "towns": ["14102018001", ...]  // 小地域（町丁目）コードの配列（9〜11桁）
    }
  ]
}
```

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

## 環境メモ
- Claude Code リモート実行環境（プロキシ経由）では、fetch-towns.js 実行時に
  `NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt` を付ける。
  また同環境のネットワークポリシーはGitHub系ドメインのみ許可（e-Stat・地理院・zipcloudへはビルド時到達不可。
  クライアントサイドAPIは閲覧者のブラウザから呼ばれるため影響なし）
- リポジトリルートの .github/workflows/deploy.yml は dental-seo-tool/** のみ対象のため、slp/ の変更でデプロイは走らない
