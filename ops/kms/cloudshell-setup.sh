#!/usr/bin/env bash
# The AWS half of the sponsor's KMS cutover, one network per run, in AWS CloudShell.
#
#   1. Open AWS CloudShell in the region the sponsor uses (eu-central-1, Frankfurt).
#   2. Upload this file (Actions > Upload file) or paste it into a file, then:
#        bash cloudshell-setup.sh testnet
#        bash cloudshell-setup.sh mainnet
#   3. Each run prints three values. Keep them for ops/kms/cutover.sh on the laptop, which asks for
#      them with hidden prompts. Then run `clear` here.
#
# What it creates, per network (one key and one IAM user PER NETWORK, so a leaked testnet
# credential can never sign for the mainnet account):
#   - an IAM user `lumenia-sponsor-worker-<network>` with no console access and no policy of its own;
#   - a KMS Ed25519 signing key (the key spec is in the create-key call below), alias
#     `alias/lumenia-sponsor-<network>`, whose
#     key policy lets that user call ONLY kms:Sign, kms:GetPublicKey and kms:DescribeKey, and keeps
#     the account itself as the key's administrator (without that line a key policy can lock the
#     account out of its own key);
#   - one access key for that user (the Worker's credential).
# The private key cannot leave KMS. Every Sign call appears in CloudTrail's Event history (90 days,
# on by default); the lookup command for the evidence is printed at the end.
# Running it again for the same network reuses the user, the key and the alias, and makes a new
# access key only if the user has fewer than two.
set -euo pipefail

NET="${1:-}"
case "$NET" in
  testnet | mainnet) ;;
  *) echo "usage: bash cloudshell-setup.sh testnet|mainnet" >&2; exit 2 ;;
esac
REGION="${AWS_REGION:-eu-central-1}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
USER_NAME="lumenia-sponsor-worker-$NET"
ALIAS="alias/lumenia-sponsor-$NET"

echo "account $ACCOUNT, region $REGION, network $NET"

if ! aws iam get-user --user-name "$USER_NAME" >/dev/null 2>&1; then
  aws iam create-user --user-name "$USER_NAME" --tags Key=purpose,Value="lumenia sponsor signer ($NET)" >/dev/null
  echo "created IAM user $USER_NAME"
else
  echo "IAM user $USER_NAME exists"
fi
USER_ARN="arn:aws:iam::$ACCOUNT:user/$USER_NAME"

KEY_ID="$(aws kms list-aliases --region "$REGION" --query "Aliases[?AliasName=='$ALIAS'].TargetKeyId | [0]" --output text)"
if [ -z "$KEY_ID" ] || [ "$KEY_ID" = "None" ]; then
  # A new IAM user can take a few seconds to become usable as a key-policy principal.
  sleep 10
  POLICY=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "account-administers-the-key", "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::$ACCOUNT:root" }, "Action": "kms:*", "Resource": "*" },
    { "Sid": "sponsor-sign-only", "Effect": "Allow",
      "Principal": { "AWS": "$USER_ARN" },
      "Action": ["kms:Sign", "kms:GetPublicKey", "kms:DescribeKey"], "Resource": "*" }
  ]
}
JSON
)
  KEY_ID="$(aws kms create-key --region "$REGION" \
    --key-spec ECC_NIST_EDWARDS25519 --key-usage SIGN_VERIFY \
    --description "Lumenia sponsor signer ($NET)" \
    --policy "$POLICY" --query KeyMetadata.KeyId --output text)"
  aws kms create-alias --region "$REGION" --alias-name "$ALIAS" --target-key-id "$KEY_ID"
  echo "created KMS key $KEY_ID ($ALIAS)"
else
  echo "KMS key exists: $KEY_ID ($ALIAS)"
fi
KEY_ARN="$(aws kms describe-key --region "$REGION" --key-id "$KEY_ID" --query KeyMetadata.Arn --output text)"
SPEC="$(aws kms describe-key --region "$REGION" --key-id "$KEY_ID" --query KeyMetadata.KeySpec --output text)"
[ "$SPEC" = "ECC_NIST_EDWARDS25519" ] || { echo "unexpected key spec $SPEC" >&2; exit 1; }

COUNT="$(aws iam list-access-keys --user-name "$USER_NAME" --query 'length(AccessKeyMetadata)' --output text)"
if [ "$COUNT" -ge 2 ]; then
  echo "the user already has two access keys; delete an unused one first:" >&2
  echo "  aws iam list-access-keys --user-name $USER_NAME" >&2
  exit 1
fi
read -r AK SK < <(aws iam create-access-key --user-name "$USER_NAME" \
  --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text)

cat <<EOF

== For ops/kms/cutover.sh $NET on the laptop (it asks for these three) ==
KMS key ARN            $KEY_ARN
AWS access key id      $AK
AWS secret access key  $SK

Keep the last two in your password manager, then run: clear

After the first real signature, the CloudTrail evidence (run here):
  aws cloudtrail lookup-events --region $REGION \\
    --lookup-attributes AttributeKey=ResourceName,AttributeValue=$KEY_ARN \\
    --max-results 5 --query 'Events[].{time:EventTime,name:EventName,user:Username}' --output table
EOF
