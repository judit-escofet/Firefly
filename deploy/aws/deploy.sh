#!/usr/bin/env bash
# Deploy Firefly (app + API) as ONE AWS Lambda behind an HTTPS function URL.
#
#   AWS credentials in the environment (AWS_ACCESS_KEY_ID / SECRET / SESSION_TOKEN, region), then:
#   ./deploy/aws/deploy.sh            # build, package, create or update, print the URL
#   ./deploy/aws/deploy.sh --teardown # delete the function and its URL (and the role, if this script made it)
#   FIREFLY_ROLE=<existing role> ./deploy/aws/deploy.sh   # accounts that can't create IAM roles
#     (AWS Workshop Studio: DemoToolLambdaRole has only AWSLambdaBasicExecutionRole)
#
# Why one Lambda: the mic needs HTTPS and the app expects /api on the same origin. The function
# URL is HTTPS; api/src/lambda.js runs the API (/api/*), the tracking page (/track/*) and serves
# the built app (bundled as ./public). (P3's deploy-workshop.ps1 deploys the API alone.)
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
# Windows Git Bash: hand Windows-style paths (C:/...) to aws.exe, node and python; /tmp/... and
# fileb:///tmp/... don't resolve for native Windows programs. Bash accepts C:/... too.
if command -v cygpath >/dev/null 2>&1; then WORK="$(cygpath -m "$WORK")"; ROOT="$(cygpath -m "$ROOT")"; fi
aws() { command aws --region "$REGION" "$@"; }

if [[ "${1:-}" == "--teardown" ]]; then
  aws lambda delete-function-url-config --function-name "$NAME" 2>/dev/null || true
  aws lambda delete-function --function-name "$NAME" && echo "deleted function $NAME" || true
  # Only delete the role this script creates; never a role someone else provided (FIREFLY_ROLE).
  if [[ "$ROLE" == "firefly-app-lambda" ]]; then
    aws iam detach-role-policy --role-name "$ROLE" --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole 2>/dev/null || true
    aws iam delete-role --role-name "$ROLE" 2>/dev/null && echo "deleted role $ROLE" || true
  fi
  exit 0
fi

echo "== account: $(aws sts get-caller-identity --query Arn --output text)"

echo "== build app"
(cd "$ROOT/app" && npm ci --silent && npx vite build >/dev/null)

echo "== package"
PKG="$WORK/pkg"
mkdir -p "$PKG"
cp -R "$ROOT/api/src" "$ROOT/api/lib" "$ROOT/api/db" "$ROOT/api/package.json" "$ROOT/api/package-lock.json" "$PKG/"
mkdir -p "$PKG/static" && cp "$ROOT/app/public/track/index.html" "$PKG/static/track.html"
(cd "$PKG" && npm ci --omit=dev --silent)
cp -R "$ROOT/app/dist" "$PKG/public"
if command -v zip >/dev/null 2>&1; then
  (cd "$PKG" && zip -qr9 "$WORK/function.zip" . -x '*.map')
else
  # Windows Git Bash has no zip: use Python's zipfile (forward-slash paths, which Lambda needs).
  # Pick a Python that actually runs (on Windows, python3 can be a Microsoft Store placeholder).
  PY=""
  for c in python3 python py; do
    if "$c" -c 'import zipfile' >/dev/null 2>&1; then PY="$c"; break; fi
  done
  [[ -n "$PY" ]] || { echo "!! need zip or python to package"; exit 1; }
  SRC="$PKG"; OUT="$WORK/function.zip"
  if command -v cygpath >/dev/null 2>&1; then SRC=$(cygpath -w "$SRC"); OUT=$(cygpath -w "$OUT"); fi
  "$PY" - "$SRC" "$OUT" <<'PYEOF'
import os, sys, zipfile
src, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for root, _, files in os.walk(src):
        for name in files:
            if name.endswith(".map"):
                continue
            full = os.path.join(root, name)
            z.write(full, os.path.relpath(full, src).replace(os.sep, "/"))
PYEOF
fi
SIZE=$(wc -c < "$WORK/function.zip")
echo "   function.zip: $((SIZE / 1024 / 1024)) MB"
if (( SIZE > 50 * 1024 * 1024 )); then echo "!! over Lambda's 50 MB direct-upload limit"; exit 1; fi

echo "== environment (from api/local.settings.json; keys are not printed)"
# Merge into what the live function already has, so a teammate deploying without (say) the Gemini
# key in their own local.settings.json doesn't wipe it. Local values win.
aws lambda get-function-configuration --function-name "$NAME" --query Environment.Variables --output json   > "$WORK/existing.json" 2>/dev/null || echo '{}' > "$WORK/existing.json"
node -e '
  const fs = require("fs");
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(process.argv[3], "utf8")) || {}; } catch {}
  const v = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).Values || {};
  const keep = { ...existing };
  for (const [k, val] of Object.entries(v)) if (val && !["FUNCTIONS_WORKER_RUNTIME", "AzureWebJobsStorage"].includes(k)) keep[k] = val;
  keep.COMPANION_DATA_DIR = "/tmp/firefly-data";
  const out = JSON.stringify({ Variables: keep });
  if (out.length > 4000) { console.error("!! Lambda allows 4 KB of environment variables; these are " + out.length + " bytes"); process.exit(1); }
  fs.writeFileSync(process.argv[2], out);
  const kept = Object.keys(existing).filter((k) => !(k in v));
  console.log("   variables:", Object.keys(keep).join(", "));
  if (kept.length) console.log("   kept from the live function:", kept.join(", "));
' "$ROOT/api/local.settings.json" "$WORK/env.json" "$WORK/existing.json"

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
  aws lambda update-function-configuration --function-name "$NAME" --handler src/lambda.handler --environment "file://$WORK/env.json" --query LastModified --output text
else
  aws lambda create-function --function-name "$NAME" --runtime nodejs22.x --architectures arm64 \
    --handler src/lambda.handler --role "$ROLE_ARN" --memory-size 1024 --timeout 30 \
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

echo "== Vonage webhooks (in-app emergency calls)"
node "$ROOT/api/scripts/vonage-webhooks.js" "$URL"

echo "== smoke test"
curl -s -o /dev/null -w "   /                 → %{http_code}\n" "$URL/"
curl -s -o /dev/null -w "   /api/news         → %{http_code}\n" "$URL/api/news?interests=music"
curl -s -o /dev/null -w "   /api/speech-token → %{http_code}\n" "$URL/api/speech-token"
echo
echo "Firefly is live at: $URL"
echo "(Mic needs HTTPS: this URL works on phones. Tear down after the demo: $0 --teardown)"
