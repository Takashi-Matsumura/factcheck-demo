# ローカルLLMファクトチェック・デモ

主張(クレーム)を入力すると、クラウドのAPIを一切使わずに、ローカルで常駐している LLM (llama.cpp) だけで

1. 主張をサブクレームに分解
2. Web検索・Wikipediaで根拠となりそうなソースを探索
3. ソース本文から根拠文を逐語で抽出(元テキストへの部分一致検証つき。要約・改変を破棄してハルシネーションを防止)
4. 該当箇所をハイライトしたスクリーンショットを撮影
5. 撮影した画像を**別のLLM(vision)が独立に読み取り**、主張を支持/否定/無関係のどれかを判定
6. テキスト側の判定と画像側の判定を突き合わせ、食い違えば「要確認」として提示
7. 総合判定(正しい/一部正しい/誤り/判断できない)を提示

まで一気通貫で行うデモアプリです。

進行状況は Server-Sent Events でリアルタイムに画面へストリーミングされます。

## 必要なもの

このアプリはローカルの [llama.cpp](https://github.com/ggml-org/llama.cpp) (`llama-server`) が以下のポートで常駐していることを前提にしています。

| ポート | 役割 | 例 |
| --- | --- | --- |
| `8080` | 主張の分解・根拠抽出・総合判定(テキスト専用モデル) | 12B クラス instruct モデル |
| `8081` | スクリーンショットの二次検証(vision対応モデル) | 4B クラス vision instruct モデル + mmproj |
| `8082` | 根拠文の類似度ランキング用 embeddings | bge-m3 等 |

ポート番号やモデル名は `lib/llm.ts` / `lib/embed.ts` で変更できます。

また、検索・スクリーンショット撮影に [Playwright](https://playwright.dev/) の Chromium を使うため、初回のみブラウザ本体のダウンロードが必要です(`npx playwright install chromium`)。

## セットアップ

```bash
npm install
npm run dev
```

[http://localhost:3000](http://localhost:3000) を開き、検証したい主張を入力してください。任意で、検証に使ってほしい参照URLを直接指定することもできます。

## アーキテクチャ

```
app/
  page.tsx                  入力フォーム + 結果表示(Client Component)
  api/factcheck/route.ts    パイプラインを SSE でストリーミング配信
  api/shots/[...path]/      撮影したスクリーンショットの配信
  components/                UI パーツ
lib/
  pipeline.ts                パイプライン全体のオーケストレーション
  llm.ts / embed.ts          ローカルLLMへの薄いクライアント
  search.ts                  実ブラウザ検索 + Wikipedia フォールバック
  extract.ts                 本文抽出・文分割
  capture.ts                 該当箇所のハイライト注入・スクリーンショット撮影
  url-safety.ts               SSRF対策(内部/プライベートアドレスへのアクセス拒否)
  store.ts                   実行(run)ごとの成果物の保存・配信パス管理
```

## セキュリティ上の注意

検索結果や、ユーザーが直接指定したURLはサーバー側の Playwright が開いてスクリーンショットを撮ります。`lib/url-safety.ts` でループバック・プライベートIP・リンクローカル(クラウドメタデータ含む)等への到達を DNS 解決した上でブロックしていますが、公開インターネットに向けたデプロイを想定した本格的な対策ではありません。あくまでローカル環境でのデモ用途を前提としています。

## ライセンス

[MIT](./LICENSE)
