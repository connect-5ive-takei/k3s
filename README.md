# Next.js + Laravel の k3s デプロイ設定

frontend / backend / k3s の3リポジトリで管理するための雛形です。AWS の
`ap-southeast-2` にある既存 EC2 の k3s を対象にします。
このフォルダの作成だけでは、AWS へのデプロイや GitHub 自動デプロイは実行されません。
アプリのソース、Dockerfile、DB、TLS 証明書、Argo CD は別途用意します。

## 構成

```text
k3s/
├── bootstrap/namespace.yaml       # 最初に手動作成する名前空間
├── base/
│   ├── frontend/                  # Next.js の Deployment / Service
│   ├── backend/                   # Laravel の Deployment / Service
│   └── kustomization.yaml         # 共通環境変数（秘密情報を除く）
├── overlays/production/           # イメージのバージョンと HTTPS 公開設定
├── gitops/argocd.yaml.example     # 任意：Argo CD の監視設定
├── .env.example                  # Laravel Secret の入力例
└── secrets/                      # Git 管理対象外のローカル入力
```

```text
https://アプリのドメイン/       → Traefik → frontend:3000（Next.js）
https://アプリのドメイン/api/*  → Traefik → backend:8080（Laravel）
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
- App Router の `app/healthz/route.ts`（src 構成なら `src/app/healthz/route.ts`）に以下を追加する。

```ts
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({ status: 'ok' });
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

## 2. イメージ名とドメインを設定する

`overlays/production/kustomization.yaml` の以下を変更します。

- `ghcr.io/replace-org/frontend` と `ghcr.io/replace-org/backend` → 実際のイメージ名
- `REPLACE_FRONTEND_COMMIT_SHA` と `REPLACE_BACKEND_COMMIT_SHA` → push 済みタグ
- `APP_URL=https://app.example.invalid` → 本番 URL

`overlays/production/ingress.yaml` の `app.example.invalid` も **2箇所**とも変更します。
GHCR は例です。ECR を使う場合も名前は置換できますが、k3s の ECR 認証設定が別途必要です。
ECR のログイントークンは期限付きなので、固定 Secret の一度の作成で永続運用しないでください。

## 3. ローカルで YAML を生成して確認する

以降のコマンドは **この k3s フォルダをカレントディレクトリ**にして実行します。
EC2 上ではこのフォルダを clone / 転送してから実行し、`kubectl` を `sudo k3s kubectl` に
読み替えてください。Mac 側に接続先 kubeconfig を設定していない場合、適用コマンドは EC2 で実行します。

```bash
kubectl kustomize base
kubectl kustomize overlays/production
```

生成はクラスタ接続なしでできます。ConfigMap のハッシュが Pod の参照先に入るため、
環境変数を Git で変更したときも新しい Pod に更新されます。
生成結果に `REPLACE_`、`replace-org`、`example.invalid` が残ったまま適用しないでください。

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

非公開イメージの場合は、両 Deployment の `spec.template.spec.imagePullSecrets` に
`- name: registry-credentials` を追加し、同じ名前空間に読み取り用 Secret を事前に作成します。
GHCR なら対象 package の読み取りに限定した認証を使い、Docker 設定ファイルを安全に用意します。

```bash
kubectl -n web3team create secret generic registry-credentials \
  --type=kubernetes.io/dockerconfigjson \
  --from-file=.dockerconfigjson=secrets/docker-config.json \
  --dry-run=client -o yaml | kubectl apply -f -
```

認証情報のあるファイルは `secrets/` に置きます。公開イメージならこの設定は不要です。

## 5. HTTPS 公開を準備する

k3s 標準の Traefik が稼働していることを確認します。

```bash
kubectl -n kube-system get deployment traefik
```

DNS の A レコードを EC2 の到達可能な固定 IP に向け、必要な接続元から TCP 443 を許可します。
固定 IP を含む AWS リソースには料金が発生する場合があります。6443番や8472番を全世界に開放しません。
この Ingress は `websecure` のみを使用し、HTTP→HTTPS リダイレクトや証明書の自動発行は含みません。
ドメインに対応する有効な証明書と秘密鍵を用意し、次を実行します。

```bash
kubectl -n web3team create secret tls web3team-tls \
  --cert=secrets/tls.crt --key=secrets/tls.key \
  --dry-run=client -o yaml | kubectl apply -f -
```

証明書の更新も必要です。継続運用では cert-manager 等の自動更新を別途構成してください。

## 6. 初回デプロイ

イメージ・DB・Secret・ドメイン・TLS を準備した後、接続先を確認して適用します。

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

## 7. main 更新時の自動デプロイへ接続する

この雛形では GitHub リポジトリ URL が未確定のため、CI と Argo CD は有効化していません。

1. front / back の GitHub Actions を `push: branches: [main]` で起動する。
2. テスト後にイメージをビルドし、commit SHA タグでレジストリへ push する。
3. k3s リポジトリの `overlays/production/kustomization.yaml` の対象アプリのタグだけ更新する。
4. Argo CD が k3s リポジトリの `main` を監視し、更新された Deployment を反映する。

別リポジトリへの更新には通常の `GITHUB_TOKEN` だけでは足りません。k3s リポジトリへの
必要な権限だけを持つ GitHub App 等を構成します。front / back が同時更新するときは、
最新 main を取得して対象タグだけ編集し、競合時に再試行して相手の変更を上書きしないようにします。
branch protection がある場合は PR 経由で反映する設定に合わせます。

Argo CD 導入済みなら `gitops/argocd.yaml.example` の GitHub URL を2箇所置換して使えます。
`k3s/` の中身を専用リポジトリのルートに置くと `path: overlays/production`、この親フォルダを
そのままリポジトリにするなら `path: k3s/overlays/production` に変更します。
private リポジトリは Argo CD に読み取り認証を別途登録します。

名前空間と Secret は事前に手動作成します。AppProject はこのリポジトリと `web3team` 名前空間、
必要なリソース種別だけを許可します。Argo CD のインストールや bootstrap を自動適用する設定ではありません。
自動同期を有効にすると、Git から削除した管理対象を `prune` が削除し、手動変更を `selfHeal` が戻します。
移行後は Git を設定の基準とし、ロールバックも対象イメージタグの Git revert で行います。

## 参考資料

- [Kustomize](https://kubernetes.io/docs/tasks/manage-kubernetes-objects/kustomization/)
- [Next.js のセルフホスティング](https://nextjs.org/docs/app/guides/self-hosting)
- [Laravel のデプロイ](https://laravel.com/docs/deployment)
- [k3s の要件](https://docs.k3s.io/installation/requirements)
- [k3s の Traefik](https://docs.k3s.io/networking/networking-services)
- [Argo CD の自動同期](https://argo-cd.readthedocs.io/en/stable/user-guide/auto_sync/)
