#!/usr/bin/env bash

set -Eeuo pipefail

aws_region="${AWS_REGION:-ap-southeast-2}"
application_stack="${APPLICATION_STACK_NAME:-connect5ive-serverless}"
backend_stage="${BACKEND_STAGE:-prod}"
parameter_prefix="/connect5ive/backend/${backend_stage}"

for command_name in aws jq; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Required command is unavailable: ${command_name}" >&2
    exit 69
  fi
done

required_variables=(
  APP_KEY
  JWT_SECRET
  DB_HOST
  DB_PORT
  DB_DATABASE
  DB_USERNAME
  DB_PASSWORD
  DB_SSLMODE
)

for variable_name in "${required_variables[@]}"; do
  if [[ -z "${!variable_name:-}" ]]; then
    echo "Missing required environment variable: ${variable_name}" >&2
    exit 64
  fi
done

if [[ ! "$APP_KEY" =~ ^base64:.+ ]]; then
  echo "APP_KEY must be a Laravel base64 application key." >&2
  exit 64
fi
if [[ ! "$JWT_SECRET" =~ ^base64:.+ ]]; then
  echo "JWT_SECRET must be a base64-encoded signing key." >&2
  exit 64
fi
if [[ ! "$DB_PORT" =~ ^[0-9]{1,5}$ ]] || (( DB_PORT < 1 || DB_PORT > 65535 )); then
  echo "DB_PORT must be an integer between 1 and 65535." >&2
  exit 64
fi
case "$DB_SSLMODE" in
  disable|allow|prefer|require|verify-ca|verify-full) ;;
  *)
    echo "DB_SSLMODE is not a supported PostgreSQL SSL mode." >&2
    exit 64
    ;;
esac

origin_secret_arn="$(aws cloudformation describe-stacks \
  --region "$aws_region" \
  --stack-name "$application_stack" \
  --query 'Stacks[0].Outputs[?OutputKey==`OriginVerificationSecretArn`].OutputValue | [0]' \
  --output text)"
if [[ ! "$origin_secret_arn" =~ ^arn:[^:]+:secretsmanager:[^:]+:[0-9]{12}:secret:.+$ ]]; then
  origin_secret_arn="$(aws cloudformation describe-stack-resource \
    --region "$aws_region" \
    --stack-name "$application_stack" \
    --logical-resource-id OriginVerificationSecret \
    --query 'StackResourceDetail.PhysicalResourceId' \
    --output text)"
fi
if [[ ! "$origin_secret_arn" =~ ^arn:[^:]+:secretsmanager:[^:]+:[0-9]{12}:secret:.+$ ]]; then
  echo "CloudFormation did not return the origin verification secret resource." >&2
  exit 70
fi

origin_verification_secret="$(aws secretsmanager get-secret-value \
  --region "$aws_region" \
  --secret-id "$origin_secret_arn" \
  --query SecretString \
  --output text)"
if [[ -z "$origin_verification_secret" || "$origin_verification_secret" == "None" ]]; then
  echo "Secrets Manager did not return the origin verification value." >&2
  exit 70
fi

temporary_directory="$(mktemp -d)"
cleanup() {
  rm -rf -- "$temporary_directory"
}
trap cleanup EXIT
chmod 700 "$temporary_directory"
parameter_payload="${temporary_directory}/parameter.json"

put_secure_parameter() {
  local parameter_name="$1"
  local parameter_value="$2"

  jq -n \
    --arg name "${parameter_prefix}/${parameter_name}" \
    --arg value "$parameter_value" \
    '{Name: $name, Value: $value, Type: "SecureString", Overwrite: true}' \
    > "$parameter_payload"
  chmod 600 "$parameter_payload"
  aws ssm put-parameter \
    --region "$aws_region" \
    --cli-input-json "file://${parameter_payload}" \
    --query Version \
    --output text >/dev/null
}

for variable_name in "${required_variables[@]}"; do
  put_secure_parameter "$variable_name" "${!variable_name}"
done
put_secure_parameter ORIGIN_VERIFICATION_SECRET "$origin_verification_secret"

echo "Configured encrypted backend parameters under ${parameter_prefix}."
