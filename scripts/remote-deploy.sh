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
readonly max_apply_attempts=6
readonly apply_retry_delay_seconds=10

cleanup() {
  sudo rm -rf "$work_dir"
}
trap cleanup EXIT

wait_for_k3s() {
  for attempt in $(seq 1 60); do
    if "${kube[@]}" get --raw=/readyz >/dev/null 2>&1; then
      "${kube[@]}" wait --for=condition=Ready node --all --timeout=300s
      return
    fi

    if (( attempt == 60 )); then
      echo "k3s API did not become ready within 300 seconds." >&2
      return 1
    fi

    sleep 5
  done
}

apply_manifest() {
  local manifest="$1"
  local attempt
  local exit_code

  for attempt in $(seq 1 "$max_apply_attempts"); do
    if "${kube[@]}" apply -f "$manifest"; then
      return
    else
      exit_code=$?
    fi

    if (( attempt == max_apply_attempts )); then
      echo "Failed to apply ${manifest} after ${max_apply_attempts} attempts." >&2
      return "$exit_code"
    fi

    echo "kubectl apply failed for ${manifest}; retrying in ${apply_retry_delay_seconds}s (${attempt}/${max_apply_attempts})." >&2
    sleep "$apply_retry_delay_seconds"
  done
}

wait_for_k3s
apply_manifest "$work_dir/namespace.yaml"
apply_manifest "$work_dir/cert-manager.yaml"

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

"${kube[@]}" -n kube-system rollout status \
  deployment/coredns \
  --timeout=300s
"${kube[@]}" -n kube-system rollout status \
  deployment/traefik \
  --timeout=300s

registry_password="$(aws ecr get-login-password --region "$aws_region")"
registry_secret_manifest="$work_dir/registry-credentials.yaml"
"${kube[@]}" -n web3team create secret docker-registry registry-credentials \
  --docker-server="$ecr_registry" \
  --docker-username=AWS \
  --docker-password="$registry_password" \
  --dry-run=client \
  -o yaml > "$registry_secret_manifest"
unset registry_password
apply_manifest "$registry_secret_manifest"
sudo rm -f "$registry_secret_manifest"

if ! "${kube[@]}" -n web3team get secret backend-secrets >/dev/null 2>&1; then
  echo "backend-secrets is missing in namespace web3team." >&2
  exit 1
fi

apply_manifest "$work_dir/production.yaml"
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
