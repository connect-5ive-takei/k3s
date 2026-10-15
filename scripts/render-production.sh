#!/usr/bin/env bash

set -Eeuo pipefail

if [[ -z "${PUBLIC_HOST:-}" ]]; then
  echo "PUBLIC_HOST is required (example: app.example.com)." >&2
  exit 64
fi

if [[ ! "$PUBLIC_HOST" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$ ]]; then
  echo "PUBLIC_HOST is not a valid lowercase DNS hostname: ${PUBLIC_HOST}" >&2
  exit 64
fi

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if command -v kubectl >/dev/null 2>&1; then
  rendered="$(kubectl kustomize "${repository_root}/overlays/production")"
elif command -v kustomize >/dev/null 2>&1; then
  rendered="$(kustomize build "${repository_root}/overlays/production")"
else
  echo "kubectl or kustomize is required." >&2
  exit 69
fi

rendered="${rendered//__PUBLIC_HOST__/$PUBLIC_HOST}"

if [[ "$rendered" == *"__PUBLIC_HOST__"* ]] || [[ "$rendered" == *"REPLACE_"* ]]; then
  echo "Production manifest still contains an unresolved placeholder." >&2
  exit 65
fi

printf '%s\n' "$rendered"
