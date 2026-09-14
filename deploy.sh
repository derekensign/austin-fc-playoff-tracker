#!/usr/bin/env bash
# Deploy the hourly playoff-forecast refresh to AWS Lambda via SAM.
#
# Usage:
#   AWS_PROFILE=personal ./deploy.sh
#
# Prereqs:
#   - a PERSONAL AWS profile (NOT the work techops account)
#   - a GitHub fine-grained PAT with contents:write on this repo, stored in
#     Secrets Manager under the name in GITHUB_TOKEN_SECRET_ID below. Create it:
#       aws secretsmanager create-secret \
#         --name verde-run-in/github-token --secret-string 'github_pat_...'
#
# No parameter value here contains a space: sam's --parameter-overrides splits
# on whitespace, so the schedule stays hardcoded in template.yaml.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

STACK_NAME="verde-run-in"
WORK_ACCOUNT_ID="856708425739"
PERSONAL_ACCOUNT_ID="853443719819"
GITHUB_TOKEN_SECRET_ID="verde-run-in/github-token"

if [[ -z "${AWS_PROFILE:-}" ]]; then
    echo "ERROR: set AWS_PROFILE to your PERSONAL aws profile first, e.g.:" >&2
    echo "  AWS_PROFILE=personal ./deploy.sh" >&2
    exit 1
fi

# Guardrail: this is a personal project, so refuse anything but the personal
# account rather than merely warning about the work one.
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
if [[ "$ACCOUNT_ID" == "$WORK_ACCOUNT_ID" ]]; then
    echo "ERROR: that is the WORK techops account ($ACCOUNT_ID)." >&2
    echo "This is a personal project — switch AWS_PROFILE to a personal account." >&2
    exit 1
fi
if [[ "$ACCOUNT_ID" != "$PERSONAL_ACCOUNT_ID" ]]; then
    echo "ERROR: expected personal account $PERSONAL_ACCOUNT_ID, got $ACCOUNT_ID." >&2
    exit 1
fi
echo "Deploying to AWS account: $ACCOUNT_ID (profile: $AWS_PROFILE)"

# Fail before building if the token is missing: the function's only job is to
# push a commit, so a deploy without it produces an hourly job that can only
# fail. Checked here, not in the template, because Secrets Manager secrets are
# managed outside this stack on purpose.
if ! aws secretsmanager describe-secret --secret-id "$GITHUB_TOKEN_SECRET_ID" >/dev/null 2>&1; then
    echo "ERROR: Secrets Manager secret '$GITHUB_TOKEN_SECRET_ID' not found in $ACCOUNT_ID." >&2
    echo "Create it with a GitHub fine-grained PAT that has contents:write on the repo:" >&2
    echo "  aws secretsmanager create-secret --name $GITHUB_TOKEN_SECRET_ID --secret-string 'github_pat_...'" >&2
    exit 1
fi

sam build
sam deploy \
    --stack-name "$STACK_NAME" \
    --resolve-s3 \
    --capabilities CAPABILITY_IAM \
    --no-confirm-changeset \
    --no-fail-on-empty-changeset \
    --parameter-overrides \
        "GithubTokenSecretId=$GITHUB_TOKEN_SECRET_ID" \
        "GithubOwner=derekensign" \
        "GithubRepo=austin-fc-playoff-tracker" \
        "GithubBranch=main"

echo
echo "Deployed. The refresh now checks for new MLS results hourly."
echo "  Logs:    aws logs tail /aws/lambda/verde-run-in-refresh --follow"
echo "  Force:   aws lambda invoke --function-name verde-run-in-refresh \\"
echo "             --payload '{\"force\":true}' --cli-binary-format raw-in-base64-out /dev/stdout"
echo "  Remove:  sam delete --stack-name $STACK_NAME"
