# Deploy Firefly P3 to an AWS Workshop Studio account, which blocks CloudFormation (so no SAM).
# Creates a Lambda with a public function URL (API Gateway is blocked there too), an S3 clips
# bucket and a permissions role, directly with the AWS CLI. Safe to run again: it
# finds what already exists and updates it.
#
# 1. Paste the workshop's $Env:AWS_... credential lines into this PowerShell window.
# 2. Run:  powershell -ExecutionPolicy Bypass -File .\deploy-workshop.ps1
#    Add -MockMaps to use straight-line routes instead of Amazon Location.
param([switch]$MockMaps)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$env:AWS_PAGER = ''
$tmp = Join-Path $env:TEMP 'firefly-deploy'
New-Item -ItemType Directory -Force $tmp | Out-Null

# ---------- helpers ----------
function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "   OK  $text" -ForegroundColor Green }
function Warn($text) { Write-Host "   !!  $text" -ForegroundColor Yellow }

# Runs the AWS CLI. Returns @{ ok; data; err } and never throws.
# Output is read straight from the process (no temp files, which antivirus can lock on Windows).
$awsExe = (Get-Command aws -ErrorAction Stop).Source
function Quote([string]$s) {
  if ($s -notmatch '[\s"]' -and $s -ne '') { return $s }
  return '"' + ($s -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}
function Aws([string[]]$A) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $awsExe
  $psi.Arguments = (($A + @('--output', 'json')) | ForEach-Object { Quote $_ }) -join ' '
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $p = [System.Diagnostics.Process]::Start($psi)
  $outTask = $p.StandardOutput.ReadToEndAsync()
  $errTask = $p.StandardError.ReadToEndAsync()
  $p.WaitForExit()
  $text = $outTask.Result
  $err = $errTask.Result
  $data = $null
  if ($p.ExitCode -eq 0 -and $text.Trim()) {
    try { $data = $text | ConvertFrom-Json } catch { $data = $text }
  }
  return @{ ok = ($p.ExitCode -eq 0); data = $data; err = "$err".Trim() }
}
function AwsOrDie([string[]]$A, [string]$what) {
  $r = Aws $A
  if (-not $r.ok) {
    Write-Host "   XX  $what failed:" -ForegroundColor Red
    Write-Host "       $($r.err)" -ForegroundColor Red
    Write-Host "`nSend the red lines above (not your keys) to Claude." -ForegroundColor Red
    exit 1
  }
  return $r.data
}
# Writes JSON without a byte-order mark and returns a file:// URI for the AWS CLI.
function JsonFile([string]$name, $obj) {
  $p = Join-Path $tmp $name
  [IO.File]::WriteAllText($p, ($obj | ConvertTo-Json -Depth 20))
  return 'file://' + ($p -replace '\\', '/')
}

try {
  # ---------- 0. who and where ----------
  Step 'Checking AWS credentials'
  $id = AwsOrDie @('sts', 'get-caller-identity') 'Credential check (paste the workshop $Env:AWS_... lines first)'
  $account = $id.Account
  $region = if ($env:AWS_DEFAULT_REGION) { $env:AWS_DEFAULT_REGION } else { 'us-west-2' }
  Ok "account $account, region $region"
  $prefix = 'firefly'

  # ---------- settings from api/local.settings.json ----------
  $settings = (Get-Content api/local.settings.json -Raw | ConvertFrom-Json).Values
  if (-not $settings.TIGER_DATABASE_URL) { throw 'TIGER_DATABASE_URL is missing from api/local.settings.json' }

  # ---------- 1. Amazon Location available? ----------
  Step 'Checking Amazon Location walking routes'
  $useMock = [bool]$MockMaps
  if (-not $useMock) {
    $routeInput = JsonFile 'route-probe.json' @{ Origin = @(-122.3321, 47.6062); Destination = @(-122.3301, 47.6089); TravelMode = 'Pedestrian' }
    $probe = Aws @('geo-routes', 'calculate-routes', '--region', $region, '--cli-input-json', $routeInput)
    if ($probe.ok) { Ok 'Amazon Location works' }
    else { $useMock = $true; Warn "Amazon Location is blocked here, using straight-line routes. ($($probe.err.Split("`n")[0]))" }
  } else { Warn 'Straight-line routes (-MockMaps)' }

  # ---------- 2. Lambda execution role ----------
  Step 'Lambda permissions role'
  $roleName = "$prefix-lambda-role"
  $bucket = "$prefix-clips-$account-$region"
  $role = Aws @('iam', 'get-role', '--role-name', $roleName)
  if ($role.ok) {
    $roleArn = $role.data.Role.Arn; Ok "using existing $roleName"
  } else {
    $trust = JsonFile 'trust.json' @{ Version = '2012-10-17'; Statement = @(@{ Effect = 'Allow'; Principal = @{ Service = 'lambda.amazonaws.com' }; Action = 'sts:AssumeRole' }) }
    $created = Aws @('iam', 'create-role', '--role-name', $roleName, '--assume-role-policy-document', $trust)
    if ($created.ok) {
      $roleArn = $created.data.Role.Arn
      Ok "created $roleName"
      [void](Aws @('iam', 'attach-role-policy', '--role-name', $roleName, '--policy-arn', 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'))
      $policy = JsonFile 'policy.json' @{ Version = '2012-10-17'; Statement = @(
        @{ Effect = 'Allow'; Action = @('s3:GetObject', 's3:PutObject'); Resource = "arn:aws:s3:::$bucket/*" },
        @{ Effect = 'Allow'; Action = @('s3:ListBucket'); Resource = "arn:aws:s3:::$bucket" },
        @{ Effect = 'Allow'; Action = @('geo-routes:CalculateRoutes'); Resource = '*' },
        @{ Effect = 'Allow'; Action = @('execute-api:ManageConnections'); Resource = "arn:aws:execute-api:${region}:${account}:*/*" }
      ) }
      $put = Aws @('iam', 'put-role-policy', '--role-name', $roleName, '--policy-name', "$prefix-access", '--policy-document', $policy)
      if (-not $put.ok) { Warn "Could not attach permissions to the role: $($put.err)" }
      Write-Host '   ..  waiting 10 s for the new role to become usable'
      Start-Sleep -Seconds 10
    } else {
      Warn "Can't create roles here ($($created.err.Split("`n")[0])). Looking for an existing Lambda role..."
      $roles = AwsOrDie @('iam', 'list-roles') 'Listing roles'
      $candidate = $roles.Roles | Where-Object {
        [Uri]::UnescapeDataString(($_.AssumeRolePolicyDocument | ConvertTo-Json -Depth 10 -Compress)) -match 'lambda\.amazonaws\.com'
      } | Select-Object -First 1
      if (-not $candidate) { throw 'This account allows neither creating a role nor reusing one for Lambda, so it cannot run the backend.' }
      $roleArn = $candidate.Arn
      Warn "Using existing role $($candidate.RoleName). Clips or live updates may fail if it lacks S3 or WebSocket permissions."
    }
  }

  # ---------- 3. Clips bucket ----------
  Step "Clips bucket ($bucket)"
  $clipsOk = $true
  if ((Aws @('s3api', 'head-bucket', '--bucket', $bucket)).ok) { Ok 'exists' }
  else {
    $args3 = @('s3api', 'create-bucket', '--bucket', $bucket, '--region', $region)
    if ($region -ne 'us-east-1') { $args3 += @('--create-bucket-configuration', "LocationConstraint=$region") }
    $b = Aws $args3
    if ($b.ok) {
      [void](Aws @('s3api', 'put-public-access-block', '--bucket', $bucket, '--public-access-block-configuration',
        'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true'))
      $life = JsonFile 'lifecycle.json' @{ Rules = @(@{ ID = 'expire-clips'; Status = 'Enabled'; Filter = @{ Prefix = '' }; Expiration = @{ Days = 2 } }) }
      [void](Aws @('s3api', 'put-bucket-lifecycle-configuration', '--bucket', $bucket, '--lifecycle-configuration', $life))
      Ok 'created (private, clips deleted after 2 days)'
    } else { $clipsOk = $false; Warn "Can't create S3 buckets here; clips will be stored in Tiger Data instead. $($b.err.Split("`n")[0])" }
  }

  # ---------- 4. Package the code ----------
  Step 'Packaging the code'
  Push-Location api
  npm install --omit=dev --no-audit --no-fund --loglevel=error | Out-Null
  npm run build:page | Out-Null
  Pop-Location
  Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
  $zipPath = Join-Path $tmp 'firefly.zip'
  if (Test-Path $zipPath) { Remove-Item $zipPath }
  $apiDir = (Resolve-Path api).Path
  $zip = [IO.Compression.ZipFile]::Open($zipPath, 'Create')
  $files = @(Get-Item (Join-Path $apiDir 'package.json')) +
           @(Get-ChildItem -Recurse -File -Path (Join-Path $apiDir 'src'), (Join-Path $apiDir 'lib'), (Join-Path $apiDir 'db'), (Join-Path $apiDir 'static'), (Join-Path $apiDir 'node_modules'))
  foreach ($f in $files) {
    $rel = $f.FullName.Substring($apiDir.Length + 1).Replace('\', '/')
    [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, $rel, 'Optimal')
  }
  $zip.Dispose()
  $mb = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)
  Ok "firefly.zip, $mb MB"
  $zipUri = 'fileb://' + ($zipPath -replace '\\', '/')

  function Deploy-Function([string]$name, [string]$handler, [hashtable]$vars, [int]$timeout) {
    $envFile = JsonFile "env-$name.json" @{ Variables = $vars }
    $existing = Aws @('lambda', 'get-function', '--function-name', $name, '--region', $region)
    if ($existing.ok) {
      [void](AwsOrDie @('lambda', 'update-function-code', '--function-name', $name, '--zip-file', $zipUri, '--region', $region) "Updating $name code")
      [void](Aws @('lambda', 'wait', 'function-updated-v2', '--function-name', $name, '--region', $region))
      [void](AwsOrDie @('lambda', 'update-function-configuration', '--function-name', $name, '--environment', $envFile,
        '--handler', $handler, '--timeout', "$timeout", '--region', $region) "Updating $name settings")
      [void](Aws @('lambda', 'wait', 'function-updated-v2', '--function-name', $name, '--region', $region))
      Ok "$name updated"
      return $existing.data.Configuration.FunctionArn
    }
    $created = AwsOrDie @('lambda', 'create-function', '--function-name', $name, '--runtime', 'nodejs22.x',
      '--architectures', 'arm64', '--role', $roleArn, '--handler', $handler, '--zip-file', $zipUri,
      '--timeout', "$timeout", '--memory-size', '512', '--environment', $envFile, '--region', $region) "Creating $name"
    [void](Aws @('lambda', 'wait', 'function-active-v2', '--function-name', $name, '--region', $region))
    Ok "$name created"
    return $created.FunctionArn
  }
  function Allow-PublicUrl([string]$fn) {
    # Anyone may call the URL; the share token is the access control, same as with API Gateway.
    $r = Aws @('lambda', 'add-permission', '--function-name', $fn, '--statement-id', 'public-url', '--action', 'lambda:InvokeFunctionUrl',
      '--principal', '*', '--function-url-auth-type', 'NONE', '--region', $region)
    if (-not $r.ok -and $r.err -notmatch 'ResourceConflict|already exists') { Warn "Public URL permission failed: $($r.err.Split("`n")[0])" }
    # Newer accounts also require lambda:InvokeFunction for function URLs; older CLIs don't know this flag.
    $r = Aws @('lambda', 'add-permission', '--function-name', $fn, '--statement-id', 'public-url-invoke', '--action', 'lambda:InvokeFunction',
      '--principal', '*', '--invoked-via-function-url', '--region', $region)
    if (-not $r.ok -and $r.err -notmatch 'ResourceConflict|already exists|Unknown options|invoked-via-function-url') { Warn "Invoke permission: $($r.err.Split("`n")[0])" }
  }

  $dbVars = @{ TIGER_DATABASE_URL = "$($settings.TIGER_DATABASE_URL)"; PG_POOL_MAX = '2' }

  # ---------- 5. API + tracking page on a Lambda function URL ----------
  # This account blocks API Gateway (so no WebSocket API either): the tracking page polls every 3 s.
  Step 'API and tracking page (Lambda function URL)'
  $apiVars = $dbVars.Clone()
  $apiVars.MOCK_MAPS = $(if ($useMock) { '1' } else { '0' })
  if ($clipsOk) { $apiVars.CLIPS_BUCKET = $bucket }
  foreach ($k in 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER') { if ($settings.$k) { $apiVars[$k] = "$($settings.$k)" } }
  [void](Deploy-Function "$prefix-api" 'src/lambda.handler' $apiVars 20)

  $urlCfg = Aws @('lambda', 'get-function-url-config', '--function-name', "$prefix-api", '--region', $region)
  if ($urlCfg.ok) { $fnUrl = $urlCfg.data.FunctionUrl }
  else {
    $cors = JsonFile 'cors.json' @{ AllowOrigins = @('*'); AllowMethods = @('GET', 'POST'); AllowHeaders = @('content-type', 'x-clip-duration'); MaxAge = 600 }
    $fnUrl = (AwsOrDie @('lambda', 'create-function-url-config', '--function-name', "$prefix-api", '--auth-type', 'NONE',
      '--cors', $cors, '--region', $region) 'Creating the public HTTPS address (function URL)').FunctionUrl
  }
  Allow-PublicUrl "$prefix-api"
  $appUrl = $fnUrl.TrimEnd('/')
  Ok $appUrl

  # ---------- 6. Smoke test ----------
  Step 'Smoke test'
  Start-Sleep -Seconds 5
  try {
    Invoke-RestMethod -Method Post -Uri "$appUrl/api/profile" -ContentType 'application/json' -Body '{"name":"x"}' | Out-Null
    Warn 'Expected a 400 for bad input but got 200'
  } catch {
    $status = [int]$_.Exception.Response.StatusCode
    if ($status -eq 400) { Ok 'API answers and validates input (400 for bad input, as expected)' }
    elseif ($status -eq 403) { Warn 'Got 403: this account may block public function URLs.' }
    else { Warn "API returned $status. Check CloudWatch logs for $prefix-api." }
  }

  Write-Host "`n== Done. Send this to Claude:" -ForegroundColor Green
  Write-Host "   AppUrl:       $appUrl"
  Write-Host "   Live updates: tracking page polls every 3 s (API Gateway is blocked in this account)"
  Write-Host "   Routes:       $(if ($useMock) { 'straight-line mock' } else { 'Amazon Location' })"
  Write-Host "   Clips:        $(if ($clipsOk) { 'S3 ' + $bucket } else { 'stored in Tiger Data (S3 is blocked)' })"
}
finally {
  # The env files contain the database URL; don't leave them in TEMP.
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
