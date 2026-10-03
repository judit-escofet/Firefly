# Deploy Firefly (app + API) to the AWS workshop account, from PowerShell.
#   powershell -ExecutionPolicy Bypass -File .\deploy-aws.ps1
# Asks you to paste the workshop's credential lines (either the "export AWS_..." or the
# "$Env:AWS_..." version), then runs deploy/aws/deploy.sh through Git Bash.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$bash = @("C:\Program Files\Git\bin\bash.exe", "C:\Program Files (x86)\Git\bin\bash.exe", "$env:LOCALAPPDATA\Programs\Git\bin\bash.exe") |
  Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $bash) { Write-Host "Git Bash not found. Install Git for Windows: https://git-scm.com/download/win" -ForegroundColor Red; exit 1 }

if (-not $env:AWS_ACCESS_KEY_ID -or -not $env:AWS_SESSION_TOKEN) {
  Write-Host "Paste the 4 AWS credential lines from the workshop page, then press Enter on an empty line:" -ForegroundColor Cyan
  while ($true) {
    $line = Read-Host
    if ([string]::IsNullOrWhiteSpace($line)) { break }
    # export AWS_X="value"   or   $Env:AWS_X="value"   (quotes optional)
    if ($line -match '^\s*(?:export\s+|\$Env:)(AWS_[A-Z_]+)\s*=\s*"?([^"]*)"?\s*$') {
      Set-Item -Path "Env:$($Matches[1])" -Value $Matches[2]
      Write-Host "   got $($Matches[1])"
    } else {
      Write-Host "   (skipped a line that isn't an AWS_... setting)" -ForegroundColor Yellow
    }
  }
}
if (-not $env:AWS_ACCESS_KEY_ID -or -not $env:AWS_SECRET_ACCESS_KEY -or -not $env:AWS_SESSION_TOKEN) {
  Write-Host "Missing AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY or AWS_SESSION_TOKEN. Copy all 4 lines and try again." -ForegroundColor Red
  exit 1
}
if (-not $env:AWS_DEFAULT_REGION) { $env:AWS_DEFAULT_REGION = 'us-west-2' }
if (-not $env:FIREFLY_ROLE) { $env:FIREFLY_ROLE = 'DemoToolLambdaRole' }

Write-Host "`nDeploying (a few minutes)..." -ForegroundColor Cyan
& $bash ./deploy/aws/deploy.sh
if ($LASTEXITCODE -ne 0) { Write-Host "`nDeploy failed. Copy the lines above (not your keys) and send them to Claude." -ForegroundColor Red; exit 1 }
