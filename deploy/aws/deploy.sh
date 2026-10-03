#!/usr/bin/env bash
# Deploy Firefly (app + API) as ONE AWS Lambda behind an HTTPS function URL.
#
#   AWS credentials in the environment (AWS_ACCESS_KEY_ID / SECRET / SESSION_TOKEN, region), then:
#   ./deploy/aws/deploy.sh            # build, package, create or update, print the URL
#   ./deploy/aws/deploy.sh --teardown # delete the function, its URL and the role
#
# Why one Lambda: the mic needs HTTPS and the app expects /api on the same origin. The function
# URL is HTTPS; lambda.js serves app/dist and runs the Azure-Functions-style API under /api/*.
# API keys come from api/local.settings.json (git-ignored) and become Lambda environment
# variables. The URL is PUBLIC: anyone with it can use the app (and the Gemini/ElevenLabs
# credit behind /api/companion/*). Tear it down after the demo.
set -euo pipefail

NAME="${FIREFLY_FUNCTION:-firefly-app}"
ROLE="${FIREFLY_ROLE:-firefly-app-lambda}"
REGION="${AWS_DEFAULT_REGION:-${AWS_REGION:-us-west-2}}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
aws() { command aws --region "$REGION" "$@"; }

if [[ "${1:-}" == "--teardown" ]]; then
  aws lambda delete-function-url-config --function-name "$NAME" 2>/dev/null || true
  aws lambda delete-function --function-name "$NAME" && echo "deleted function $NAME" || true
  aws iam detach-role-policy --role-name "$ROLE" --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole 2>/dev/null || true
  aws iam delete-role --role-name "$ROLE" && echo "deleted role $ROLE" || true
  exit 0
fi

echo "== account: $(aws sts get-caller-identity --query Arn --output text)"

echo "== build app"
(cd "$ROOT/app" && npm ci --silent && npx vite build >/dev/null)

echo "== package"
PKG="$WORK/pkg"
mkdir -p "$PKG"
cp -R "$ROOT/api/src" "$ROOT/api/lib" "$ROOT/api/db" "$ROOT/api/lambda.js" "$ROOT/api/package.json" "$ROOT/api/package-lock.json" "$PKG/"
(cd "$PKG" && npm ci --omit=dev --silent)
cp -R "$ROOT/app/dist" "$PKG/public"
(cd "$PKG" && zip -qr9 "$WORK/function.zip" . -x '*.map')
SIZE=$(wc -c < "$WORK/function.zip")
echo "   function.zip: $((SIZE / 1024 / 1024)) MB"
if (( SIZE > 50 * 1024 * 1024 )); then echo "!! over Lambda's 50 MB direct-upload limit"; exit 1; fi

echo "== environment (from api/local.settings.json; keys are not printed)"
node -e '
  const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).Values || {};
  const keep = {};
  for (const [k, val] of Object.entries(v)) if (val && !["FUNCTIONS_WORKER_RUNTIME", "AzureWebJobsStorage"].includes(k)) keep[k] = val;
  keep.COMPANION_DATA_DIR = "/tmp/firefly-data";
  require("fs").writeFileSync(process.argv[2], JSON.stringify({ Variables: keep }));
  console.log("   variables:", Object.keys(keep).join(", "));
' "$ROOT/api/local.settings.json" "$WORK/env.json"

echo "== role $ROLE"
if ! ROLE_ARN=$(aws iam get-role --role-name "$ROLE" --query Role.Arn --output text 2>/dev/null); then
  ROLE_ARN=$(aws iam create-role --role-name "$ROLE" \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
    --query Role.Arn --output text)
  aws iam attach-role-policy --role-name "$ROLE" --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  echo "   created; waiting for IAM to propagate"; sleep 12
fi

echo "== function $NAME"
if aws lambda get-function --function-name "$NAME" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$NAME" --zip-file "fileb://$WORK/function.zip" --query LastModified --output text
  aws lambda wait function-updated --function-name "$NAME"
  aws lambda update-function-configuration --function-name "$NAME" --environment "file://$WORK/env.json" --query LastModified --output text
else
  aws lambda create-function --function-name "$NAME" --runtime nodejs22.x --architectures arm64 \
    --handler lambda.handler --role "$ROLE_ARN" --memory-size 1024 --timeout 30 \
    --environment "file://$WORK/env.json" --zip-file "fileb://$WORK/function.zip" --query FunctionArn --output text
fi
aws lambda wait function-updated --function-name "$NAME"

echo "== public HTTPS URL"
if ! URL=$(aws lambda get-function-url-config --function-name "$NAME" --query FunctionUrl --output text 2>/dev/null); then
  URL=$(aws lambda create-function-url-config --function-name "$NAME" --auth-type NONE --query FunctionUrl --output text)
  aws lambda add-permission --function-name "$NAME" --statement-id public-url --action lambda:InvokeFunctionUrl \
    --principal '*' --function-url-auth-type NONE >/dev/null
  # Newer AWS rule: URL calls also need InvokeFunction, scoped here to calls via the URL only.
  aws lambda add-permission --function-name "$NAME" --statement-id public-invoke-via-url --action lambda:InvokeFunction \
    --principal '*' --invoked-via-function-url >/dev/null 2>&1 || true
fi
URL="${URL%/}"

# Contacts' tracking links and texts should point at this deployment.
node -e '
  const f = process.argv[1]; const e = JSON.parse(require("fs").readFileSync(f, "utf8"));
  e.Variables.PUBLIC_BASE_URL = process.argv[2]; require("fs").writeFileSync(f, JSON.stringify(e));
' "$WORK/env.json" "$URL"
aws lambda update-function-configuration --function-name "$NAME" --environment "file://$WORK/env.json" --query LastModified --output text >/dev/null
aws lambda wait function-updated --function-name "$NAME"

echo "== smoke test"
curl -s -o /dev/null -w "   /                 → %{http_code}\n" "$URL/"
curl -s -o /dev/null -w "   /api/news         → %{http_code}\n" "$URL/api/news?interests=music"
curl -s -o /dev/null -w "   /api/speech-token → %{http_code}\n" "$URL/api/speech-token"
echo
echo "Firefly is live at: $URL"
echo "(Mic needs HTTPS: this URL works on phones. Tear down after the demo: $0 --teardown)"
