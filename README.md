# Connect5ive サーバーレス構成

このリポジトリはCloudFront・S3・API Gateway・Lambdaなどの共有インフラを管理します。
リポジトリ名は `k3s` のままですが、EC2インスタンスの削除に伴い、Kubernetesマニフェスト、
EC2への手動デプロイ、コンテナイメージ切り替えスクリプトは撤去しました。

## 現在の構成

```text
ブラウザ
  ├─ HTTPS → CloudFront → 非公開S3（Next.js静的ファイル）
  ├─ POST /api/transcribe-session → API Gateway → セッション発行Lambda
  │                                               ├─ STS短期認証情報
  │                                               └─ DynamoDBレート制限
  ├─ 短期認証情報 → Amazon Transcribe Streaming（音声を直接送信）
  ├─ POST /api/analyze → API Gateway → ノート分析Lambda → Gemini API
  └─ /api/* → API Gateway → Laravel Lambda → Python要約Lambda
                              └─ PostgreSQL
```

公開サイト: `https://takajirou.app`

詳細は [docs/serverless-migration.md](docs/serverless-migration.md) を参照してください。

## ファイル構成

```text
serverless/
  bootstrap.yaml                  # デプロイ成果物用S3
  template.yaml                   # 静的配信・共有API・文字起こし・ノート分析
  frontend-deploy-policy.yaml      # フロント用GitHub Actions OIDCロール
  backend-deploy-policy.yaml       # バックエンド用OIDC・CloudFormation実行ロール
  functions/                      # セッション発行・ノート分析Lambda
  tests/                          # Lambda・テンプレート・セットアップの検証
scripts/
  deploy-serverless.sh             # 共有インフラ・フロント配信を更新
  configure-backend-secrets.sh     # Laravel用SSM SecureStringを登録
.env.example                      # Laravelの本番設定の入力例
secrets/                          # Git管理対象外のローカル入力
```

LaravelとPython要約Lambdaのデプロイ定義は、隣接する `backend/` リポジトリで管理します。
`backend/summarizer/Dockerfile.ml` は機械学習モデルを含むLambdaイメージ用です。

## 共有インフラのデプロイ

前提: Node.js、npm、AWS CLI、対象アカウントのデプロイ権限、隣接する `frontend/`。
既定リージョンは `ap-southeast-2` です。

```bash
./scripts/deploy-serverless.sh
```

初回のノート分析セットアップ、またはGemini APIキーの更新時だけ、所有者のみが読めるファイルを指定します。

```bash
GEMINI_API_KEY_FILE=/path/to/protected/gemini-api-key.txt ./scripts/deploy-serverless.sh
```

独自ドメインを設定する場合は `CUSTOM_DOMAIN_NAME` と `CLOUDFRONT_CERTIFICATE_ARN` を両方指定します。
証明書はCloudFront用の `us-east-1` のACM証明書を使用します。
スクリプトは本番のCloudFormation、S3、CloudFrontを更新します。

## Laravelのシークレット設定

`.env.example` を `secrets/backend.env` へコピーし、実値を入力します。
既存環境の `APP_KEY` と `JWT_SECRET` を不用意に変更しないでください。

```bash
chmod 600 secrets/backend.env
(
  set -a
  source secrets/backend.env
  set +a
  ./scripts/configure-backend-secrets.sh
)
```

値は `/connect5ive/backend/prod/` 配下のSSM Parameter StoreにSecureStringとして登録されます。
CloudFrontの検証値はスクリプトがSecrets Managerから取得します。入力ファイルはコミットしないでください。

## アプリの自動デプロイ

- frontendの `main` 更新: テスト → 静的ビルド → S3同期 → CloudFrontキャッシュ更新。
- backendの `main` 更新: テスト → Python Lambda → Laravel Lambda → DBマイグレーション → 動作確認。
- GitHub Actionsは専用OIDCロールを使用します。各リポジトリのproduction環境で
  `AWS_ACCOUNT_ID` と `AWS_REGION` を設定します。

## 検証

```bash
node --test serverless/tests/*.test.mjs
bash -n scripts/deploy-serverless.sh scripts/configure-backend-secrets.sh
```

## 復旧

フロントは以前のGit revisionから静的ファイルを再ビルド・再配信します。
インフラは以前のCloudFormationテンプレート、Laravel・Pythonは以前のGit revisionで再デプロイします。
EC2へ戻すデプロイ経路はありません。

コードの撤去では、AWS上のEBS・スナップショット・ECRイメージ・IAMロールや
GitHubの旧Variables/Secretsは削除しません。不要な実リソースは用途と参照元を確認して別途整理してください。
