# Next.js + Laravel の k3s デプロイ設定

frontend / backend / k3s の3リポジトリで管理するための雛形です。AWS の
`ap-southeast-2` にある既存 EC2 の k3s を対象にします。
GitHub Actions でテスト、ECR へのイメージ push、k3s への反映まで行います。
公開 URL は `PUBLIC_HOST` で指定した独自ドメイン（本番は `takajirou.app`）を使用し、cert-manager と Let's Encrypt で
TLS 証明書を自動取得します。

## 構成

```text
k3s/
├── bootstrap/namespace.yaml       # 最初に手動作成する名前空間
├── base/
│   ├── frontend/                  # Next.js の Deployment / Service
│   ├── backend/                   # Laravel の Deployment / Service
│   └── kustomization.yaml         # 共通環境変数（秘密情報を除く）
├── overlays/production/           # イメージのバージョンと公開設定
├── gitops/argocd.yaml             # 任意：Argo CD の監視設定
├── .env.example                  # Laravel Secret の入力例
└── secrets/                      # Git 管理対象外のローカル入力
```

```text
https://<PUBLIC_HOST>/       → Traefik → frontend:3000（Next.js）
https://<PUBLIC_HOST>/api/*  → Traefik → backend:8080（Laravel）
Next.js のサーバー処理          → http://backend:8080/api/*
```

両方のアプリは同じ EC2 で動かせます。各1 Podで、更新時は一時的に新旧 Pod が共存します。
最低でも k3s 自体に CPU 2コア・メモリ2GBが必要です。t3.medium（4 GiB）を学習用の
開始目安とし、アプリと追加コンポーネントの使用量に応じて調整してください。
この構成は1台構成で、EC2 の障害に対する冗長性はありません。

## 1. アプリのコンテナイメージを用意する

どちらも Linux amd64 向けにビルドし、レジストリに push してください。
Apple Silicon の Mac でビルドするときも `--platform linux/amd64` を指定します。
イメージは commit SHA のタグ、または digest で固定します。`latest` は使用しません。

### frontend（Next.js）

- production ビルド済み。`next start` または standalone の `node server.js` で起動する。
- `0.0.0.0:3000` で HTTP を待ち受ける。起動コマンドはイメージの CMD / ENTRYPOINT に持たせる。
- UID/GID `10001:10001` で起動できること。既存イメージが別 UID なら Deployment の数値を合わせる。
- キャッシュ等、実行時に書くディレクトリをその UID が書き込めるようにする。
- App Router の `app/healthz/route.ts`（src 構成なら `src/app/healthz/route.ts`）に、
  認証や外部サービスに依存しないヘルスチェックを追加する。

```ts
export function GET() {
  return Response.json({ status: "ok" });
}
```

このエンドポイントは認証・リダイレクト・DB 接続に依存させず、middleware / proxy の
認証対象から除外してください。Pages Router 等の場合は同じ `/healthz` を別途実装します。

ブラウザからは同じドメインの相対 URL `/api/...` で Laravel を呼びます。
`/api` はすべて Laravel に転送するため、Next.js の API Route と共用しません。
SSR 等では `process.env.BACKEND_INTERNAL_URL` を利用するコードをアプリ側に追加し、
`http://backend:8080/api/...` に接続できます。この環境変数は Next.js 標準の自動設定ではありません。
静的生成時にはクラスタ内 DNS を使えないため、ビルド時の API 取得とは分離してください。
`NEXT_PUBLIC_*` はビルド時に埋め込まれます。Pod の環境変数だけ変更してもブラウザ側は変わりません。

### backend（Laravel）

- アプリと Composer の production 依存を `/app` に含める。
- `0.0.0.0:8080` で **HTTP** を提供するイメージにする。
  FrankenPHP、または Nginx + PHP-FPM を含む構成などをアプリの Dockerfile 側で用意する。
  PHP-FPM の9000番は FastCGI であり、この Service にそのまま接続できない。
  `php artisan serve` は production の起動方法として使用しない。
- 公開ディレクトリは `/app/public` に限定する。
- UID/GID `10001:10001` で動作し、`storage` / `bootstrap/cache` と Web サーバーの
  作業ディレクトリに書き込めること。別 UID のイメージなら Deployment と合わせる。
- `/up` が認証不要で HTTP 200 を返すこと。Laravel 11以降の既定ヘルスルートを想定。
  旧バージョンや無効化した構成なら実装するか probe のパスを変更する。
- `/api/...` のルートを定義する。Ingress は `/api` を削除しない。
- DB ドライバー等、使用する PHP 拡張をイメージに含める。
- `config:cache` は Secret 注入後のコンテナ起動時に行う。ビルド時のダミー環境変数で
  設定をキャッシュしない。ENTRYPOINT の最終プロセスは終了シグナルを受け取れるようにする。
- Traefik からの転送ヘッダーを適切に扱うよう Laravel の trusted proxies を設定する。
  `APP_URL` を設定するだけでは HTTPS 判定の代わりにならない。

DB は到達可能な既存 DB を設定してください。Pod 内の SQLite やローカルファイルに
永続データを保存する構成にはしていません。ファイルのアップロードには永続ストレージが必要です。
初期設定は同期キュー・cookie セッション・ファイルキャッシュです。Redis / worker / scheduler は
未導入です。ファイルキャッシュや Next.js のキャッシュは Pod ごとに独立し、再作成で消えます。
キャッシュをロック・業務データ・複数 Pod 間の共有状態に使う場合は外部ストアに変更してください。
Sanctum の SPA 認証を使う場合は `/sanctum/csrf-cookie`、ログイン等の公開ルートと
cookie / CSRF 設定をアプリに合わせて追加してください。この雛形では認証方式を確定しません。

## 2. イメージ名と公開 URL を設定する

`overlays/production/kustomization.yaml` には現在、次を設定しています。

- frontend / backend の Amazon ECR リポジトリ
- push 済みの固定タグ `bootstrap-20261011-074753`（Actions の初回成功後は commit SHA に更新）
- 公開ホストのプレースホルダー `__PUBLIC_HOST__`
- HTTPS 用 `SESSION_SECURE_COOKIE=true`
- Sanctum 用 `SANCTUM_STATEFUL_DOMAINS=__PUBLIC_HOST__`

実際のホスト名は GitHub の `production` Environment 変数 `PUBLIC_HOST` からデプロイ時に注入します。
EC2 を停止してから再起動すると、Elastic IP を割り当てていないパブリック IP は変わる可能性があります。
DNS の A レコードは、再起動後の到達可能な IP または Elastic IP に向けてください。

## 3. ローカルで YAML を生成して確認する

以降のコマンドは **この k3s フォルダをカレントディレクトリ**にして実行します。
EC2 上ではこのフォルダを clone / 転送してから実行し、`kubectl` を `sudo k3s kubectl` に
読み替えてください。Mac 側に接続先 kubeconfig を設定していない場合、適用コマンドは EC2 で実行します。

```bash
kubectl kustomize base
PUBLIC_HOST=takajirou.app ./scripts/render-production.sh
```

生成はクラスタ接続なしでできます。ConfigMap のハッシュが Pod の参照先に入るため、
環境変数を Git で変更したときも新しい Pod に更新されます。
生成結果に `REPLACE_` または `__PUBLIC_HOST__` が残ったまま適用しないでください。

## 4. 名前空間・秘密情報を準備する

```bash
kubectl apply -f bootstrap/namespace.yaml
cp .env.example secrets/backend.env
chmod 600 secrets/backend.env
```

`secrets/backend.env` を編集します。Secret の値はチャット・Git・ログに貼らないでください。
新しい Laravel アプリの APP_KEY はアプリの環境で `php artisan key:generate --show` を使って生成します。
既存アプリの APP_KEY は維持します。env ファイルは `KEY=value` とし、値を引用符で囲みません。

```bash
kubectl -n web3team create secret generic backend-secrets \
  --from-env-file=secrets/backend.env \
  --dry-run=client -o yaml | kubectl apply -f -
```

Secret を後から変更した場合は、適用後に `kubectl -n web3team rollout restart deployment/backend`
で環境変数を再読込します。Kubernetes Secret は保存時の暗号化と RBAC を別途管理してください。

両 Deployment は `registry-credentials` を参照します。EC2 に設定した最小権限のIAMロールから
ECRトークンを取得し、同じ名前空間のSecretをデプロイ前に更新します。トークンは期限付きのため、
新しいイメージをデプロイするときは毎回次をEC2上で実行します。

```bash
ecr_password="$(aws ecr get-login-password --region ap-southeast-2)"
sudo k3s kubectl -n web3team create secret docker-registry registry-credentials \
  --docker-server=255229736336.dkr.ecr.ap-southeast-2.amazonaws.com \
  --docker-username=AWS \
  --docker-password="$ecr_password" \
  --dry-run=client -o yaml | sudo k3s kubectl apply -f -
unset ecr_password
```

トークンをログやファイルへ出力しないでください。

## 5. 公開設定を確認する

k3s 標準の Traefik が稼働していることを確認します。

```bash
kubectl -n kube-system get deployment traefik
```

DNS の A レコードを EC2 の到達可能な IP に向け、セキュリティグループの TCP 80 / 443 を
インターネットから許可します。TCP 80 は Let's Encrypt の HTTP-01 検証と HTTPS リダイレクトに必要です。
6443番や8472番を全世界に開放しません。SSHを使わず、デプロイ操作はSystems Manager経由で行います。

`takajirou.app` の権威DNSは Cloudflare です。EC2 を起動してパブリック IPv4 を確認した後、
Cloudflare の **DNS → Records → Add record** で次を設定します。

| 項目         | 値                            |
| ------------ | ----------------------------- |
| Type         | `A`                           |
| Name         | `@`                           |
| IPv4 address | k3s EC2 のパブリック IPv4     |
| Proxy status | 最初は `DNS only`（灰色の雲） |
| TTL          | `Auto`                        |

証明書が `Ready` になり、`https://takajirou.app` を確認した後は Cloudflare Proxy を有効にできます。
有効にする場合、Cloudflare の **SSL/TLS encryption mode** は `Full (strict)` にし、`Flexible` は使用しません。
EC2 に Elastic IP がないまま停止・起動するとパブリック IPv4 が変わるため、その都度 A レコードの更新が必要です。
固定したい場合は Elastic IP を新規割り当てし、料金条件を確認した上で EC2 に関連付けます。

`bootstrap/cert-manager.yaml` は k3s の Helm Controller を使い、cert-manager v1.21.2 を導入します。
`overlays/production/issuer.yaml` が Let's Encrypt の本番 Issuer を作成し、Ingress から
`web3team-tls` Secretを自動発行・更新します。

## 6. 初回デプロイ

イメージ・DB・Secret・公開 URL を準備した後、接続先を確認して適用します。

```bash
kubectl config current-context
kubectl apply --dry-run=server -k overlays/production
kubectl apply -k overlays/production
kubectl -n web3team rollout status deployment/backend --timeout=300s
kubectl -n web3team rollout status deployment/frontend --timeout=300s
kubectl -n web3team get pods,svc,ingress
```

DB マイグレーションは Pod 起動のたびに実行しません。DB のバックアップと旧バージョンとの
互換性を確認し、リリース単位で一度実行します。初回もアプリを利用し始める前に実行してください。

```bash
kubectl -n web3team exec deployment/backend -- php artisan migrate --force
```

`/up` は既定では DB 接続やテーブルの存在まで保証しません。デプロイ完了後、実際の API と
ブラウザ画面を確認します。継続運用の migration Job と失敗時の手順は DB の構成確定後に追加します。

不調時の確認:

```bash
kubectl -n web3team get pods
kubectl -n web3team get events --sort-by=.metadata.creationTimestamp
kubectl -n web3team logs deployment/backend --tail=100
kubectl -n web3team logs deployment/frontend --tail=100
```

`ImagePullBackOff` はイメージ名・タグ・認証、`CreateContainerConfigError` は Secret、
probe エラーは `/healthz`・`/up` と待受ポート、`Pending` は空きリソースを確認します。
ログを共有するときは秘密情報を除いてください。

## 7. GitHub Actions 自動デプロイ

### 処理の流れ

1. backend / frontend の `main` 更新でテストを実行する。
2. GitHub OIDC で短期 AWS 認証情報を取得する。
3. commit SHA を immutable tag として Docker イメージを ECR に push する。
4. 1時間で失効する GitHub App installation token で k3s リポジトリへ `repository_dispatch` を送る。
5. k3s workflow が対象イメージタグを `kustomization.yaml` に記録する。
6. AWS Systems Manager Run Command で、EC2 上の k3s に manifest を適用する。
7. rollout、TLS 証明書、`/healthz`、未認証 `/api/user` の401を確認する。

EC2 が停止中の場合、ECR への push とタグ記録までは完了しますが、k3s 適用は失敗します。
EC2 を起動して SSM が `Online` になった後、k3s リポジトリの `Deploy production` を
`infrastructure` で再実行してください。Actions は EC2 を自動起動しません。

### GitHub Environment

3リポジトリに `production` Environment を作ります。必要なら required reviewers を設定します。

backend / frontend に設定する値:

| 種類     | 名前                     | 値                                                                 |
| -------- | ------------------------ | ------------------------------------------------------------------ |
| Variable | `AWS_ACCOUNT_ID`         | `255229736336`                                                     |
| Variable | `AWS_REGION`             | `ap-southeast-2`                                                   |
| Variable | `ECR_REPOSITORY`         | backendは `connect5ive/backend`、frontendは `connect5ive/frontend` |
| Variable | `DEPLOY_APP_CLIENT_ID`   | 後述のGitHub App Client ID                                         |
| Secret   | `AWS_BUILD_ROLE_ARN`     | 対象リポジトリだけを信頼するECR push用IAM Role ARN                 |
| Secret   | `DEPLOY_APP_PRIVATE_KEY` | 後述のGitHub App秘密鍵                                             |

k3s に設定する値:

| 種類     | 名前                  | 値                                               |
| -------- | --------------------- | ------------------------------------------------ |
| Variable | `AWS_ACCOUNT_ID`      | `255229736336`                                   |
| Variable | `AWS_REGION`          | `ap-southeast-2`                                 |
| Variable | `K3S_INSTANCE_ID`     | `i-015929fe168de0c25`                            |
| Variable | `PUBLIC_HOST`         | `takajirou.app`                                  |
| Secret   | `AWS_DEPLOY_ROLE_ARN` | k3sリポジトリだけを信頼するSSM実行用IAM Role ARN |

k3sリポジトリの **Settings → Actions → General → Workflow permissions** は
`Read and write permissions` にします。人がmainへ直接コミットする代わりに、デプロイworkflowだけが
immutable image tagを記録します。

### GitHub App

組織にデプロイ専用GitHub Appを作成し、k3sリポジトリだけへインストールします。

- Repository permission: **Contents: Read and write**
- Webhook: 無効でよい
- backend / frontend にはAppの Client IDをVariable、秘密鍵をSecretとして保存
- Personal Access Tokenは使用しない

### AWS OIDC と最小権限

AWSに `https://token.actions.githubusercontent.com`、audience `sts.amazonaws.com` のOIDC providerを作り、
backend、frontend、k3sの各リポジトリと `production` Environmentにsubjectを限定したIAM Roleを用意します。
長期アクセスキーをGitHub Secretsへ保存しません。

各Roleの信頼ポリシーでは `token.actions.githubusercontent.com:aud` を `sts.amazonaws.com` と一致させ、
`token.actions.githubusercontent.com:sub` をRoleごとに次の1件へ限定します。

- backend: `repo:connect-5ive-takei/backend:environment:production`
- frontend: `repo:connect-5ive-takei/frontend:environment:production`
- k3s: `repo:connect-5ive-takei/k3s:environment:production`

build roleには対象ECRリポジトリだけのpush権限と、リソース指定できない
`ecr:GetAuthorizationToken` だけを許可します。deploy roleには対象EC2への
`ssm:SendCommand`、`AWS-RunShellScript` document、コマンド結果の取得、
`ssm:DescribeInstanceInformation` だけを許可します。

現在のAWSアカウントではOrganizationsのSCPによりOIDC providerの参照が明示拒否されます。
同じSCPが作成も拒否する場合、組織管理者にGitHub OIDC providerと上記Roleの作成を依頼してください。
この制約を長期アクセスキーで回避しないでください。

### EC2側の前提

- SSM Agentが起動し、Systems ManagerのManaged nodesで `Online` になること
- EC2 instance profileに `AmazonSSMManagedInstanceCore` 相当の権限があること
- EC2 instance profileに2つのECRリポジトリへのpull-only権限があること
- `aws`、`gzip`、`base64`、`sudo k3s kubectl` が使用できること
- `web3team/backend-secrets` を事前に作成していること

### 手動ロールバック

k3sの `Deploy production` を手動実行し、componentに `backend` または `frontend`、
image_tagに過去のECR commit SHA tagを指定します。存在しないtagはrolloutで失敗します。

Argo CDへ移行する場合は `gitops/argocd.yaml` を利用できますが、現在の主経路は
GitHub Actions + Systems Managerです。二重管理を避けるため、Argo CDの自動同期と同時に有効化しません。

## 参考資料

- [Kustomize](https://kubernetes.io/docs/tasks/manage-kubernetes-objects/kustomization/)
- [Next.js のセルフホスティング](https://nextjs.org/docs/app/guides/self-hosting)
- [Laravel のデプロイ](https://laravel.com/docs/deployment)
- [k3s の要件](https://docs.k3s.io/installation/requirements)
- [k3s の Traefik](https://docs.k3s.io/networking/networking-services)
- [k3s Helm Controller](https://docs.k3s.io/add-ons/helm)
- [cert-manager](https://cert-manager.io/docs/installation/)
- [GitHub Actions OIDC for AWS](https://docs.github.com/actions/deployment/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services)
- [Argo CD の自動同期](https://argo-cd.readthedocs.io/en/stable/user-guide/auto_sync/)
