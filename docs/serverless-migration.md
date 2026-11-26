# サーバーレス構成への移行とEC2構成の撤去

更新日: 2026-11-26

## 現在の状態

Web配信、文字起こしのセッション発行、ノート分析、Laravel API、Python要約はサーバーレスで動作します。
公開サイトは `https://takajirou.app` です。
EC2インスタンスは削除済みです。EC2へ戻すために保持していたコードと手順も撤去しました。

## 実行経路

- Web: ブラウザ → CloudFront → 非公開S3のNext.js静的ファイル。
- 文字起こしの準備: `/api/transcribe-session` → API Gateway → Lambda → STS。
- 音声: ブラウザ → Amazon Transcribe Streaming。アプリのサーバーで中継しません。
- ノート分析: `/api/analyze` → API Gateway → Lambda → Gemini API。
- 認証・要約: `/api/*` → API Gateway → Laravel Lambda。要約はLaravelから非公開のPython Lambdaを呼びます。

セッション発行とノート分析はDynamoDBでIP・時間ごとの利用回数を制限します。
CloudFrontからAPIへのリクエストには検証用ヘッダーを付加し、直アクセスを制限します。
静的配信にはS3 Origin Access Controlを使用し、S3バケットは公開しません。

## 継続して使うデプロイ定義

| 場所 | 管理対象 |
| --- | --- |
| `serverless/bootstrap.yaml` | Lambdaデプロイ成果物用S3 |
| `serverless/template.yaml` | CloudFront、静的S3、共有HTTP API、セッション発行・ノート分析Lambda |
| `serverless/frontend-deploy-policy.yaml` | フロント配信用OIDCロール |
| `serverless/backend-deploy-policy.yaml` | Laravel・要約Lambdaのデプロイ用ロール |
| `../backend/serverless.yml` | Laravel Lambdaとマイグレーション実行用Lambda |
| `../backend/summarizer/serverless.yml` | Python要約Lambda |
| `../backend/summarizer/serverless.ml.yml` | 承認済み学習モデルを含む別のPython Lambda用イメージ定義 |

初回セットアップと共有インフラの更新は [README](../README.md) の手順を使います。
アプリの更新はfrontend・backendそれぞれのGitHub Actionsで実行します。

## 撤去したもの

- KubernetesのDeployment、Service、Ingress、Kustomize設定。
- Traefik、cert-manager、名前空間のセットアップ。
- EC2へSystems Managerで適用する旧GitHub Actionsワークフロー。
- EC2用マニフェスト生成・転送・コンテナイメージタグ更新スクリプト。
- LaravelのEC2向けFrankenPHP Dockerfile、Caddy設定、起動スクリプト。
- フロントの本番コンテナ、standalone出力、EC2中継用WebSocketサーバーとクライアント。
- 直接接続と中継接続を選ぶ環境変数、旧デプロイ・ロールバック手順。

音声キューと話者別整形はブラウザの直接接続でも使うため、フロントの録音機能のライブラリへ移しました。
Docker Composeによるローカル開発と、Python Lambda用のコンテナ定義は継続して使います。
`k3s` というリポジトリ名とフォルダ名は、他リポジトリからの参照を維持するため変更していません。

## 復旧とAWSリソース

配信の復旧は以前のGit revisionから再ビルド・再デプロイします。EC2へのロールバックはできません。
本番ビルドは `npm run build` で `out/` を生成し、`NEXT_STATIC_EXPORT` や
`NEXT_PUBLIC_TRANSCRIBE_TRANSPORT` の指定は不要です。

この変更はローカルのコード整理です。AWS上のEBS、スナップショット、ECRイメージ、旧IAMロール、
GitHubの旧Variables/Secretsの削除は実行していません。ECRはPython Lambdaのイメージにも使うため、
一括削除せず、用途ごとに判断してください。
