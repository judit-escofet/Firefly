# One-command deploy for Firefly P3 (AWS SAM).
# 1. Paste the workshop's $Env:AWS_... credential lines into this PowerShell window.
# 2. Run:  powershell -ExecutionPolicy Bypass -File .\deploy.ps1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# SAM's default settings folder is locked on this laptop; use a separate one.
$env:__SAM_CLI_APP_DIR = "$HOME\.sam-cli"
$env:SAM_CLI_TELEMETRY = '0'

Write-Host "`n== Checking AWS credentials" -ForegroundColor Cyan
$identity = aws sts get-caller-identity --output json 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Host "No working AWS credentials in this window. Paste the workshop's `$Env:AWS_... lines first." -ForegroundColor Red
  Write-Host $identity
  exit 1
}
$account = ($identity | ConvertFrom-Json).Account
$region = if ($env:AWS_DEFAULT_REGION) { $env:AWS_DEFAULT_REGION } else { 'us-west-2' }
Write-Host "Account $account, region $region"

Write-Host "`n== Bundling the tracking page" -ForegroundColor Cyan
Push-Location api
npm run build:page | Out-Null
if ($LASTEXITCODE -ne 0) { Pop-Location; throw 'npm run build:page failed' }
Pop-Location

Write-Host "`n== Building" -ForegroundColor Cyan
sam build
if ($LASTEXITCODE -ne 0) { throw 'sam build failed' }

Write-Host "`n== Deploying (2-4 minutes)" -ForegroundColor Cyan
sam deploy --region $region --no-confirm-changeset --no-fail-on-empty-changeset
if ($LASTEXITCODE -ne 0) {
  Write-Host "`nDeploy failed. Copy the red error lines above (not your keys) and send them to Claude." -ForegroundColor Red
  exit 1
}

Write-Host "`n== Done. Send these outputs to Claude:" -ForegroundColor Green
aws cloudformation describe-stacks --stack-name firefly --region $region `
  --query "Stacks[0].Outputs[].[OutputKey,OutputValue]" --output table
