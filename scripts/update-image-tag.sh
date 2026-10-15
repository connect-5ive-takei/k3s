#!/usr/bin/env bash

set -Eeuo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <frontend|backend> <immutable-image-tag>" >&2
  exit 64
fi

component="$1"
image_tag="$2"

if [[ ! "$component" =~ ^(frontend|backend)$ ]]; then
  echo "Unsupported component: $component" >&2
  exit 64
fi

if [[ ! "$image_tag" =~ ^[0-9a-f]{40,64}$ ]]; then
  echo "Image tag must be a 40-64 character lowercase hexadecimal commit SHA." >&2
  exit 64
fi

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
kustomization_file="${repository_root}/overlays/production/kustomization.yaml"

COMPONENT_IMAGE="${component}-image" IMAGE_TAG="$image_tag" perl -0pi -e '
  $count = s{
    (name:\s*\Q$ENV{COMPONENT_IMAGE}\E\s*\n
     \s*newName:[^\n]+\n
     \s*newTag:\s*)[^\n]+
  }{$1$ENV{IMAGE_TAG}}x;

  END {
    die "Expected exactly one image entry for $ENV{COMPONENT_IMAGE}, updated $count\n"
      unless $count == 1;
  }
' "$kustomization_file"

echo "Updated ${component} image tag to ${image_tag}."
