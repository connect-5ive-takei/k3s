#!/usr/bin/env bash

set -Eeuo pipefail

if [[ $# -ne 3 ]]; then
  echo "Usage: $0 <aws-region> <ecr-registry> <work-directory>" >&2
  exit 64
fi

aws_region="$1"
ecr_registry="$2"
work_dir="$3"
kube=(sudo k3s kubectl)

cleanup() {
  sudo rm -rf "$work_dir"
}
trap cleanup EXIT

"${kube[@]}" apply -f "$work_dir/namespace.yaml"
"${kube[@]}" apply -f "$work_dir/cert-manager.yaml"

for attempt in $(seq 1 60); do
  if "${kube[@]}" get crd issuers.cert-manager.io >/dev/null 2>&1; then
    break
  fi
  sleep 5
done

"${kube[@]}" wait \
  --for=condition=Established \
  crd/issuers.cert-manager.io \
  --timeout=300s

for attempt in $(seq 1 60); do
  if "${kube[@]}" -n cert-manager get deployment cert-manager-webhook >/dev/null 2>&1; then
    break
  fi
  sleep 5
done

"${kube[@]}" -n cert-manager rollout status \
  deployment/cert-manager-webhook \
  --timeout=300s

registry_password="$(aws ecr get-login-password --region "$aws_region")"
"${kube[@]}" -n web3team create secret docker-registry registry-credentials \
  --docker-server="$ecr_registry" \
  --docker-username=AWS \
  --docker-password="$registry_password" \
  --dry-run=client \
  -o yaml | "${kube[@]}" apply -f -
unset registry_password

if ! "${kube[@]}" -n web3team get secret backend-secrets >/dev/null 2>&1; then
  echo "backend-secrets is missing in namespace web3team." >&2
  exit 1
fi

"${kube[@]}" apply -f "$work_dir/production.yaml"
"${kube[@]}" -n web3team rollout status deployment/backend --timeout=300s
"${kube[@]}" -n web3team rollout status deployment/frontend --timeout=300s
"${kube[@]}" -n web3team wait \
  --for=condition=Ready \
  issuer/letsencrypt-production \
  --timeout=180s

for attempt in $(seq 1 60); do
  if "${kube[@]}" -n web3team get certificate web3team-tls >/dev/null 2>&1; then
    break
  fi
  sleep 5
done

"${kube[@]}" -n web3team wait \
  --for=condition=Ready \
  certificate/web3team-tls \
  --timeout=300s

"${kube[@]}" -n web3team get pods,svc,ingress,certificate
