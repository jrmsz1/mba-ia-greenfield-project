<#
.SYNOPSIS
  StreamTube - verification (Windows PowerShell 5.1+ / PowerShell 7).

.DESCRIPTION
  .\scripts\verify.ps1         quick: health, credential isolation of every
                               container, essential storage/upload/streaming/
                               processing suites (a few minutes)
  .\scripts\verify.ps1 -Full   full regression: unit + integration, e2e,
                               media (FFmpeg), tsc --noEmit, eslint

  Every suite runs in an ephemeral test container (compose.test.yaml,
  `run --rm`): only the test database, S3_TEST_BUCKET, the test queue schema
  and the restricted test identities. Variable NAMES are inspected, never
  values. The 10 GiB verification is separate and never runs here.
#>
[CmdletBinding()]
param([switch]$Full)

$ErrorActionPreference = 'Continue'
Set-StrictMode -Version 2.0

$Repo = Split-Path -Parent $PSScriptRoot
$Backend = Join-Path $Repo 'nestjs-project'
function Compose { & docker compose --project-directory $Backend -f (Join-Path $Backend 'compose.yaml') @args }
function ComposeTest { & docker compose --project-directory $Backend -f (Join-Path $Backend 'compose.yaml') -f (Join-Path $Backend 'compose.test.yaml') @args }

$script:Pass = 0
$script:Fail = 0
function Record([bool]$passed, [string]$label) {
  if ($passed) { $script:Pass++; Write-Host "    PASS  $label" -ForegroundColor Green }
  else { $script:Fail++; Write-Host "    FAIL  $label" -ForegroundColor Red }
}
function Check([string]$label, [scriptblock]$cmd) {
  & $cmd *> $null
  Record ($LASTEXITCODE -eq 0) $label
}
# A failing suite keeps its complete output in .local\verify-logs\ (git-ignored,
# outside the bind mount). Output is redacted before it is written or shown:
# every value of the local credential files (exact match), presigned URL
# signature parameters and bearer tokens.
$LogDir = Join-Path $Repo '.local\verify-logs'
function Get-SecretValues {
  $dir = Join-Path $Repo '.local\secrets'
  if (-not (Test-Path $dir)) { return @() }
  $values = foreach ($file in Get-ChildItem -Path $dir -Filter '*.env' -File) {
    foreach ($line in [IO.File]::ReadAllLines($file.FullName)) {
      $i = $line.IndexOf('=')
      if ($i -gt 0 -and -not $line.TrimStart().StartsWith('#')) {
        $v = $line.Substring($i + 1).TrimEnd("`r")
        if ($v.Length -ge 8) { $v }
      }
    }
  }
  return @($values)
}
function Protect-Line([string]$line, [string[]]$secrets) {
  foreach ($s in $secrets) { $line = $line.Replace($s, '<redacted>') }
  $line = $line -replace '(X-Amz-(Signature|Credential|Security-Token)=)[^&\s"]*', '$1<redacted>'
  return ($line -replace '(Bearer )[A-Za-z0-9._~+/=-]+', '$1<redacted>')
}
function Run-Suite([string]$label, [string]$service, [string[]]$command) {
  Write-Host "    ...   $label"
  $out = @(ComposeTest run --rm $service @command 2>&1 | ForEach-Object { "$_" })
  if ($LASTEXITCODE -eq 0) {
    $tests = $out | Where-Object { $_ -match '^Tests:' } | Select-Object -Last 1
    if ($tests) { $label = "$label ($(($tests -replace '^Tests:\s*', '').Trim()))" }
    Record $true $label
  } else {
    $secrets = @(Get-SecretValues)
    $safe = @($out | ForEach-Object { Protect-Line $_ $secrets })
    $slug = (($label.ToLowerInvariant() -replace '[^a-z0-9]+', '-').Trim('-'))
    if ($slug.Length -gt 60) { $slug = $slug.Substring(0, 60) }
    $saved = Join-Path $LogDir ("{0}-{1}.log" -f (Get-Date).ToUniversalTime().ToString("yyyyMMdd'T'HHmmss'Z'"), $slug)
    try {
      New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
      [IO.File]::WriteAllLines($saved, [string[]]$safe)
    } catch { $saved = $null }
    Record $false "$label - last lines:"
    $safe | Select-Object -Last 25 | ForEach-Object { Write-Host "          $_" }
    if ($saved) { Write-Host "          full log (redacted): $saved" }
    else { Write-Host '          (the full log could not be saved)' }
  }
}

# Credential variable NAMES of a container environment.
$CredRe = '^(MINIO_ROOT_|S3_ACCESS_KEY_ID$|S3_SECRET_ACCESS_KEY$|S3_DELIVERY_|S3_API_|S3_WORKER_|S3_TEST_(API|WORKER|DELIVERY|MAINTENANCE)_)'
function Select-CredNames($lines) {
  [string[]]$names = @($lines | ForEach-Object { ("$_".Split('=')[0]).Trim() } | Where-Object { $_ -cmatch $CredRe } | Select-Object -Unique)
  [Array]::Sort($names, [StringComparer]::Ordinal)
  return ($names -join ' ')
}
function Names-Running([string]$service) { Select-CredNames (Compose exec -T $service sh -c 'env | cut -d= -f1') }
function Names-Test([string]$service) { Select-CredNames (ComposeTest run --rm --no-deps -T $service sh -c 'env | cut -d= -f1') }
function Names-DotEnv { Select-CredNames ([IO.File]::ReadAllLines((Join-Path $Backend '.env')) | Where-Object { $_ -match '^[A-Z0-9_]+=.+' }) }
function Expect-Names([string]$label, [string]$actual, [string]$expected) {
  if ($actual -ceq $expected) { Record $true $label }
  else { Record $false "$label (got: $(if ($actual) { $actual } else { 'none' }); expected: $(if ($expected) { $expected } else { 'none' }))" }
}

Write-Host '==> Services and health'
Check 'PostgreSQL accepts connections' { Compose exec -T db pg_isready -U streamtube }
Check 'MinIO is ready' { Compose exec -T minio curl -fsS http://localhost:9000/minio/health/ready }
Check 'API answers' { Compose exec -T nestjs-api curl -fsS http://localhost:3000/ }
$workerUp = [bool]((Compose ps --status running -q worker | Out-String).Trim())
$workerLogs = ((Compose logs worker 2>$null) | Out-String)
Record ($workerUp -and ($workerLogs -match 'Video worker started')) 'worker running and connected to the queue'

Write-Host ''
Write-Host '==> Credential isolation (variable names only)'
Expect-Names 'nestjs-api: only the API and delivery identities' (Names-Running 'nestjs-api') 'S3_ACCESS_KEY_ID S3_DELIVERY_ACCESS_KEY_ID S3_DELIVERY_SECRET_ACCESS_KEY S3_SECRET_ACCESS_KEY'
Expect-Names 'worker: only the worker identity' (Names-Running 'worker') 'S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY'
Expect-Names 'mounted .env: no credential' (Names-DotEnv) ''
$testNames = 'S3_TEST_API_ACCESS_KEY_ID S3_TEST_API_SECRET_ACCESS_KEY S3_TEST_DELIVERY_ACCESS_KEY_ID S3_TEST_DELIVERY_SECRET_ACCESS_KEY S3_TEST_WORKER_ACCESS_KEY_ID S3_TEST_WORKER_SECRET_ACCESS_KEY'
Expect-Names 'test-api: only the restricted test identities' (Names-Test 'test-api') $testNames
Expect-Names 'test-worker: only the restricted test identities' (Names-Test 'test-worker') $testNames
if (Get-Command git -ErrorAction SilentlyContinue) {
  $tracked = & git -C $Repo ls-files .local 2>$null
  Record (-not $tracked) 'no secret file tracked by Git'
}

Write-Host ''
Write-Host '==> Test suites (ephemeral test containers)'
if (-not $Full) {
  Run-Suite 'storage identities: permission matrix + bucket verification' 'test-api' @('npx', 'jest', '--selectProjects', 'integration', '--testPathPatterns', 'src/storage/storage-permissions', 'src/storage/storage.service.integration')
  Run-Suite 'upload, completion, streaming (Range) and download - HTTP' 'test-api' @('npx', 'jest', '--config', './test/jest-e2e.json', '--runInBand', '--testPathPatterns', 'videos-upload-complete', 'videos-delivery-urls')
  Run-Suite 'asynchronous processing: ffprobe metadata + thumbnail (FFmpeg)' 'test-worker' @('env', 'MEDIA_TOOLS_REQUIRED=1', 'npx', 'jest', '--selectProjects', 'integration', '--testPathPatterns', 'src/worker/video-processing.worker', 'src/media/media-probe')
} else {
  Run-Suite 'unit + integration (npm test)' 'test-api' @('npm', 'test')
  Run-Suite 'e2e (npm run test:e2e)' 'test-api' @('npm', 'run', 'test:e2e')
  Run-Suite 'media and worker suites with FFmpeg (npm run test:media)' 'test-worker' @('npm', 'run', 'test:media')
  Run-Suite 'TypeScript (tsc --noEmit)' 'test-api' @('npx', 'tsc', '--noEmit')
  Run-Suite 'lint (eslint, check only)' 'test-api' @('npx', 'eslint', '{src,apps,libs,test}/**/*.ts')
}

Write-Host ''
Write-Host "==> Summary: $script:Pass passed, $script:Fail failed"
if ($script:Fail -eq 0) { Write-Host 'RESULT: PASS' -ForegroundColor Green; exit 0 }
Write-Host 'RESULT: FAIL' -ForegroundColor Red; exit 1
