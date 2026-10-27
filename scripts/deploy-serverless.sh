#!/usr/bin/env bash

set -Eeuo pipefail

aws_region="${AWS_REGION:-ap-southeast-2}"
bootstrap_stack="${BOOTSTRAP_STACK_NAME:-connect5ive-serverless-bootstrap}"
application_stack="${APPLICATION_STACK_NAME:-connect5ive-serverless}"
rate_limit_per_hour="${RATE_LIMIT_PER_HOUR:-6}"
custom_domain_name="${CUSTOM_DOMAIN_NAME-}"
cloudfront_certificate_arn="${CLOUDFRONT_CERTIFICATE_ARN-}"
repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
frontend_root="$(cd "${repository_root}/../frontend" && pwd)"
broker_root="${repository_root}/serverless/functions/session-broker"

for command_name in aws npm; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Required command is unavailable: ${command_name}" >&2
    exit 69
  fi
done

if [[ ! "$rate_limit_per_hour" =~ ^[1-9][0-9]*$ ]] || (( rate_limit_per_hour > 60 )); then
  echo "RATE_LIMIT_PER_HOUR must be an integer between 1 and 60." >&2
  exit 64
fi

custom_domain_is_set=false
certificate_arn_is_set=false
[[ "${CUSTOM_DOMAIN_NAME+x}" == x ]] && custom_domain_is_set=true
[[ "${CLOUDFRONT_CERTIFICATE_ARN+x}" == x ]] && certificate_arn_is_set=true

if [[ "$custom_domain_is_set" != "$certificate_arn_is_set" ]] || \
  { [[ -n "$custom_domain_name" ]] && [[ -z "$cloudfront_certificate_arn" ]]; } || \
  { [[ -z "$custom_domain_name" ]] && [[ -n "$cloudfront_certificate_arn" ]]; }; then
  echo "CUSTOM_DOMAIN_NAME and CLOUDFRONT_CERTIFICATE_ARN must be set together." >&2
  exit 64
fi

temporary_directory="$(mktemp -d)"
cleanup() {
  rm -rf -- "$temporary_directory"
}
trap cleanup EXIT

echo "Installing deterministic Lambda production dependencies."
npm --prefix "$broker_root" ci --omit=dev --no-audit --no-fund

echo "Building the Next.js static export."
(
  cd "$frontend_root"
  NEXT_STATIC_EXPORT=true \
    NEXT_PUBLIC_TRANSCRIBE_TRANSPORT=direct \
    NEXT_PUBLIC_TRANSCRIBE_SESSION_ENDPOINT=/api/transcribe-session \
    npm run build
)

if [[ ! -f "${frontend_root}/out/index.html" ]]; then
  echo "Static export did not produce out/index.html." >&2
  exit 65
fi

echo "Deploying the private CloudFormation packaging bucket."
parameter_overrides=("RateLimitPerHour=${rate_limit_per_hour}")
if [[ "$custom_domain_is_set" == true ]]; then
  parameter_overrides+=(
    "CustomDomainName=${custom_domain_name}"
    "CloudFrontCertificateArn=${cloudfront_certificate_arn}"
  )
fi

aws cloudformation deploy \
  --region "$aws_region" \
  --stack-name "$bootstrap_stack" \
  --template-file "${repository_root}/serverless/bootstrap.yaml" \
  --no-fail-on-empty-changeset

artifact_bucket="$(aws cloudformation describe-stacks \
  --region "$aws_region" \
  --stack-name "$bootstrap_stack" \
  --query 'Stacks[0].Outputs[?OutputKey==`DeploymentArtifactsBucketName`].OutputValue | [0]' \
  --output text)"
if [[ -z "$artifact_bucket" || "$artifact_bucket" == "None" ]]; then
  echo "CloudFormation did not return the deployment artifact bucket." >&2
  exit 70
fi

echo "Packaging and deploying the serverless application stack."
aws cloudformation package \
  --region "$aws_region" \
  --template-file "${repository_root}/serverless/template.yaml" \
  --s3-bucket "$artifact_bucket" \
  --s3-prefix lambda \
  --output-template-file "${temporary_directory}/packaged.yaml"

aws cloudformation deploy \
  --region "$aws_region" \
  --stack-name "$application_stack" \
  --template-file "${temporary_directory}/packaged.yaml" \
  --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND \
  --parameter-overrides "${parameter_overrides[@]}" \
  --no-fail-on-empty-changeset

read_stack_output() {
  local output_key="$1"
  aws cloudformation describe-stacks \
    --region "$aws_region" \
    --stack-name "$application_stack" \
    --query "Stacks[0].Outputs[?OutputKey==\`${output_key}\`].OutputValue | [0]" \
    --output text
}

site_bucket="$(read_stack_output StaticSiteBucketName)"
distribution_id="$(read_stack_output CloudFrontDistributionId)"
site_url="$(read_stack_output SiteUrl)"

if [[ -z "$site_bucket" || "$site_bucket" == "None" ]]; then
  echo "CloudFormation did not return the static site bucket." >&2
  exit 70
fi
if [[ ! "$distribution_id" =~ ^[A-Z0-9]+$ ]]; then
  echo "CloudFormation returned an invalid CloudFront distribution ID." >&2
  exit 70
fi

echo "Publishing the static export to the private site bucket."
aws s3 sync "${frontend_root}/out/" "s3://${site_bucket}/" \
  --region "$aws_region" \
  --delete \
  --exclude "*.html" \
  --exclude "healthz" \
  --cache-control "public,max-age=300"
aws s3 cp "${frontend_root}/out/" "s3://${site_bucket}/" \
  --region "$aws_region" \
  --recursive \
  --exclude "*" \
  --include "*.html" \
  --cache-control "public,max-age=0,must-revalidate" \
  --content-type "text/html; charset=utf-8"
aws s3 cp "${frontend_root}/out/healthz" "s3://${site_bucket}/healthz" \
  --region "$aws_region" \
  --cache-control "public,max-age=0,must-revalidate" \
  --content-type "application/json; charset=utf-8"

echo "Invalidating CloudFront so the new release is visible."
invalidation_id="$(aws cloudfront create-invalidation \
  --distribution-id "$distribution_id" \
  --paths '/*' \
  --query 'Invalidation.Id' \
  --output text)"
aws cloudfront wait invalidation-completed \
  --distribution-id "$distribution_id" \
  --id "$invalidation_id"

echo "Deployment completed: ${site_url}"
