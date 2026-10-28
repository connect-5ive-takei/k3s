# サーバーレスWeb配信への移行記録

更新日: 2026-10-27

## 結論

Web画面とリアルタイム文字起こしの入口を、EC2/k3sの常時稼働を必要としない構成へ移した。
既存EC2、EBS、ECR、k3s Deployment、Laravelバックエンドは削除していないため、旧構成へ戻せる。

公開確認用URL:

- `https://takajirou.app`
- ヘルスチェック: `https://takajirou.app/healthz`
- `https://d1f7tqilrla6q1.cloudfront.net`

`takajirou.app` はus-east-1のACM証明書をCloudFrontへ設定し、Cloudflare DNSからCloudFrontへ
向けている。AWS管理のCloudFrontホスト名は、DNS障害時の切り分けと直接確認用に残す。

## アーキテクチャ

```text
Browser
  ├─ HTTPS ─> CloudFront ─> private S3 (Next.js static export)
  ├─ POST /api/transcribe-session
  │            └─ API Gateway HTTP API ─> Lambda ─> STS AssumeRole
  │                                             └─ DynamoDB rate limit
  └─ temporary credentials ─> Amazon Transcribe Streaming
```

フロントはCloudFront/S3で常時配信する。文字起こし開始時だけLambdaを実行し、ブラウザへ短期認証情報を
返す。音声はアプリのサーバーを経由せず、ブラウザからAmazon Transcribeへ直接送る。

## AWSで作成したもの

CloudFormationスタック:

- `connect5ive-serverless-bootstrap`
  - Lambdaデプロイ成果物用の非公開・暗号化・バージョニング有効S3バケット
  - 現行成果物は90日、非現行バージョンは30日で削除
- `connect5ive-serverless`
  - 静的サイト用S3バケット
  - CloudFront DistributionとOrigin Access Control
  - CloudFront FunctionによるNext.js静的ルート変換とAPI用クライアントIP設定
  - セキュリティレスポンスヘッダー、静的/API別キャッシュポリシー
  - API Gateway HTTP API
  - セッション発行Lambda
  - 時間/IP別レート制限用DynamoDBテーブル
  - CloudFront―Lambda間の検証値を生成するSecrets Manager Secret
  - Lambda実行ロール、ブラウザ用Transcribe限定ロール
  - CloudWatch Logs（14日保持）
- `connect5ive-serverless-frontend-deploy-policy`
  - frontendのproduction環境だけを信頼するGitHub Actions OIDCロール
  - 対象スタックの出力参照、静的サイトS3への同期、対象CloudFrontのinvalidationだけを許可
  - 誤削除を避けるためスタックのTermination Protectionを有効化

主要設定:

- Lambda: Node.js 22、arm64、128MB、タイムアウト10秒、オンデマンド
- API Gateway: 毎秒1リクエスト、バースト2
- セッション発行: 同一IPにつきUTC 1時間6回まで
- クライアントIP: API用CloudFront Functionが `event.viewer.ip` から設定し、Lambdaへ転送
- STS認証情報: 15分で失効
- Transcribe開始権限: HTTP/2とWebSocketの開始だけを許可し、新しい接続を開始できる時間は発行後60秒まで
- フロント側文字起こし: 1セッション最大300秒
- S3: 全パブリックアクセス遮断、AES-256暗号化、TLS必須、CloudFront OAC経由だけ読み取り可能
- DynamoDB: On-Demand、暗号化有効、レート制限レコードはTTLで約2時間後に削除
- API Gateway直アクセス: CloudFrontだけが付加する共有ヘッダーがなければ403
- 共有ヘッダー値: CloudFormationの平文パラメータではなくSecrets Manager動的参照

IAMの `transcribe:StartStreamTranscription` と `transcribe:StartStreamTranscriptionWebSocket` は、
サービス仕様上Resource ARNへ限定できないためResourceは `*` とする。専用ロールとSTSセッション
ポリシーはこの2アクションだけを許可し、セッションポリシーで新規接続を開始できる期限を追加制限する。
接続元IPはCloudFrontとTranscribeへの通信経路で異なる場合があるためセッションポリシーでは固定せず、セッション
発行API側のIPレート制限に利用する。

## フロントエンド変更

- `NEXT_STATIC_EXPORT=true` のときだけNext.js `output: "export"` を使う。
- 静的出力時は、非対応のCache ComponentsとPartial Prefetchingを無効化する。
- `NEXT_PUBLIC_TRANSCRIBE_TRANSPORT=direct` でブラウザからTranscribe Streamingへ直接接続する。
- セッションAPIのレスポンスをZodで検証する。
- AWS SDKは文字起こし開始時にdynamic importし、初期ページロードへ常時含めない。
- 音声キューを10秒分に制限し、過剰バッファを防ぐ。
- `/healthz` はRoute Handlerから `public/healthz` の静的JSONへ変更した。
- 従来k3s用のWebSocketゲートウェイは削除せず、通常ビルドでは従来方式を維持する。

静的配信用ビルド:

```bash
NEXT_STATIC_EXPORT=true \
NEXT_PUBLIC_TRANSCRIBE_TRANSPORT=direct \
NEXT_PUBLIC_TRANSCRIBE_SESSION_ENDPOINT=/api/transcribe-session \
npm run build
```

従来k3s用ビルドは、追加環境変数なしの `npm run build` を使う。

## k3sリポジトリ変更

- `serverless/bootstrap.yaml`: パッケージ保存用スタック
- `serverless/template.yaml`: アプリ本体スタック
- `serverless/functions/session-broker/`: Lambda実装とロック済み依存関係
- `serverless/tests/`: セッションポリシー、IP解析、レート制限キーのテスト
- `scripts/deploy-serverless.sh`: ビルド、パッケージ、CloudFormation、S3同期、CloudFront invalidation

既存の `base/`、`overlays/production/`、Traefik、cert-managerは変更していない。
frontendの `main` 更新時はGitHub Actionsが静的ビルド、S3同期、CloudFront invalidation、ヘルスチェックを
実行する。従来のEC2/k3s用Workflowは自動トリガーを外し、明示的な `workflow_dispatch` による
手動ロールバック専用とした。LambdaやCloudFormationのインフラ変更は引き続き上記スクリプトで適用する。

GitHub Actionsには `serverless/frontend-deploy-policy.yaml` で専用OIDCロールを作成し、対象の
CloudFormation出力参照、静的サイトS3への同期、対象CloudFront Distributionのinvalidationだけを許可する。
従来のECR pushロールは組織SCP上も用途が限定されているため流用せず、EC2、SSM、ECR、IAM変更権限を
サーバーレス配信ロールへ追加していない。

## バックエンド変更

LaravelのコードとAWSリソースは変更していない。現行フロントはLaravel APIを使用していないため、
常時表示と文字起こし機能には影響しない。ただし、将来 `/api/user` 等を新フロントから使う場合は、
LaravelをLambda対応にするか、別のオンデマンドAPIとして移行する必要がある。

新構成にはLaravelのデプロイ先がないため、backendリポジトリの `main` 更新時はテストだけを実行し、
ECRへのpushとEC2/k3sへの自動デプロイ要求は停止した。バックエンド機能を再利用する際は、先に
オンデマンドAPIとしての移行先を設計してから自動デプロイを追加する。

## 影響と注意事項

### 利点

- EC2を停止してもCloudFront URLのページは表示される。
- Web配信、API待機、文字起こしゲートウェイのアイドル計算費用がなくなる。
- 音声が中継サーバーを通らないため、EC2帯域とゲートウェイCPUを使用しない。
- S3バージョニングと既存k3sを残しているためロールバック可能。

### 変更された挙動

- 初回文字起こし開始時にLambda/STS取得とTranscribe接続の待ち時間が加わる。
- 同一IPからの開始は1時間6回まで。学校・会社等でNATを共有する利用者は同じ枠を共有する。
- 文字起こしはブラウザからTranscribeへ直接送られる。
- フロント側の300秒制限は通常クライアントには有効だが、意図的に改変されたクライアントの接続済み
  ストリームをAWS側から300秒で強制切断するものではない。発行回数、IP、開始期限、APIスロットルで
  悪用範囲を抑えている。
- 静的出力ではSSR、Server Actions、動的Route Handler、Next.js標準画像最適化は利用できない。

### コストへの影響

- 固定費のEC2コンピュート、EBS、Public IPv4は新構成の配信には不要。
- S3、CloudFront、HTTP API、Lambda、DynamoDBは使用量課金で、低トラフィック時は無料枠内に
  収まりやすい。
- 主な変動費はAmazon Transcribeの音声時間。
- Secrets Managerは約$0.40/月の固定費が発生するが、検証値を平文デプロイパラメータへ保存しないため採用。
- AWSコンソール上のアクティブなクレジット残高は0表示だったため、クレジット継続を前提にしない。

## デプロイとロールバック

デプロイ:

```bash
cd /Users/jirou/Desktop/3/comit5ive/k3s
./scripts/deploy-serverless.sh
```

CloudFront―Lambda間の検証値はSecrets Managerが生成し、CloudFormationが動的参照する。値をCI Secretや
ローカル環境変数へコピーしない。

静的サイトだけを戻す場合は、S3の以前のバージョンを復元するか、対象Git revisionで再ビルド・再同期する。
インフラを戻す場合はCloudFormationで以前のテンプレートを再デプロイする。S3バケットはスタック削除時も
保持されるため、不要になった場合の削除は中身とバックアップを確認して別途行う。

## 検証結果

- Lambda単体テスト: 3件成功
- 従来ゲートウェイテスト: 7件成功
- ESLint: 成功
- Next.js静的ビルド: 成功
- Next.js standaloneビルド: 成功
- CloudFormationテンプレート検証: 成功
- CloudFormation事前検証イベント: エラー0件
- `/`, `/Home/`, `/healthz`: HTTP 200
- セッションAPI: HTTP 200、レスポンス形状検証成功
- API Gateway直アクセス: HTTP 403
- 短い無音ストリームによるTranscribe接続: 成功

ローカル環境にcfn-lint/cfn-guardがなかったため、これらのローカル検査は未実施。AWSのテンプレート検証と
CloudFormation事前検証は実施した。アカウントに永続CloudTrail Trailはなく、監査保持は標準Event History
相当である。
