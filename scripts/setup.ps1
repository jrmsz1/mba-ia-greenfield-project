<#
.SYNOPSIS
  StreamTube - one-command local setup (Windows PowerShell 5.1+ / PowerShell 7).

.DESCRIPTION
  .\scripts\setup.ps1               prepare everything and start the stack
  .\scripts\setup.ps1 -PrepareOnly  only generate/validate the credential files
                                    (no container is started or changed; a
                                    running MinIO gets a read-only
                                    provisioning preflight)

  Safe to re-run: existing credentials are never overwritten, provisioning is
  idempotent and non-destructive, migrations only apply what is pending.
  Secrets are generated into <repo>\.local\secrets\ (git-ignored, outside every
  bind mount) and are never printed. See phase-03-videos/TD-15 and TD-16.
  If scripts are blocked: powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1
#>
[CmdletBinding()]
param([switch]$PrepareOnly)

$ErrorActionPreference = 'Continue'   # native tools write progress to stderr
Set-StrictMode -Version 2.0

$Repo = Split-Path -Parent $PSScriptRoot
$Backend = Join-Path $Repo 'nestjs-project'
$Secrets = Join-Path $Repo '.local\secrets'
$EnvFile = Join-Path $Backend '.env'
$ProvisionImage = 'streamtube-storage-provision:local'
$OnWindows = ($env:OS -eq 'Windows_NT')

function Step($m) { Write-Host ''; Write-Host "==> $m" }
function Ok($m) { Write-Host "    OK   $m" }
function Warn($m) { Write-Host "    WARN $m" -ForegroundColor Yellow }
function Die($m) { Write-Host "    FAIL $m" -ForegroundColor Red; exit 1 }
function Compose { & docker compose --project-directory $Backend -f (Join-Path $Backend 'compose.yaml') @args }
function RandHex([int]$bytes) {
  $b = New-Object byte[] $bytes
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  ($b | ForEach-Object { $_.ToString('x2') }) -join ''
}
# Value of KEY in FILE (never printed by this script).
function Get-EnvValue([string]$key, [string]$file) {
  if (-not (Test-Path $file)) { return '' }
  foreach ($line in [IO.File]::ReadAllLines($file)) {
    if ($line.StartsWith("$key=")) { return $line.Substring($key.Length + 1).TrimEnd("`r") }
  }
  return ''
}
# UTF-8 without BOM, LF line endings (Compose and the containers read these).
function Write-TextFile([string]$path, [string[]]$lines) {
  [IO.File]::WriteAllText($path, (($lines -join "`n") + "`n"), (New-Object Text.UTF8Encoding $false))
}
function Restrict-ToOwner([string]$path, [switch]$Directory) {
  if ($OnWindows) {
    $grant = if ($Directory) { "$($env:USERNAME):(OI)(CI)F" } else { "$($env:USERNAME):F" }
    & icacls $path /inheritance:r /grant:r $grant | Out-Null
  } else {
    & chmod ($(if ($Directory) { '700' } else { '600' })) $path
  }
}

$CredentialKeysRe = '^(MINIO_ROOT_USER|MINIO_ROOT_PASSWORD|S3_ACCESS_KEY_ID|S3_SECRET_ACCESS_KEY|S3_DELIVERY_ACCESS_KEY_ID|S3_DELIVERY_SECRET_ACCESS_KEY|S3_API_[A-Z_]+|S3_WORKER_[A-Z_]+|S3_TEST_(API|WORKER|DELIVERY|MAINTENANCE)_[A-Z_]+)='

# ---------------------------------------------------------------- 1. prerequisites
Step 'Checking prerequisites'
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Die 'docker not found - install Docker Desktop' }
& docker info *> $null
if ($LASTEXITCODE -ne 0) { Die 'the Docker daemon is not reachable - start Docker Desktop and retry' }
$composeVersion = (& docker compose version --short 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $composeVersion) { Die 'docker compose (v2) not found' }
$composeVersion = "$composeVersion".Trim().TrimStart('v')
$parts = $composeVersion.Split('.')
if ([int]$parts[0] -lt 2 -or ([int]$parts[0] -eq 2 -and [int]$parts[1] -lt 24)) {
  Die "docker compose $composeVersion is too old (2.24+ is required for env_file with 'required')"
}
Ok "docker and docker compose $composeVersion"
try {
  $drive = Get-PSDrive -Name ((Split-Path -Qualifier $Repo).TrimEnd(':')) -ErrorAction Stop
  if ($drive.Free -lt 10GB) { Warn 'less than 10 GiB free on this disk; the stack runs, but the optional 10 GiB verification needs ~30 GiB' }
  else { Ok 'free disk space' }
} catch { Warn 'could not measure free disk space' }
if (Get-Command git -ErrorAction SilentlyContinue) {
  & git -C $Repo rev-parse *> $null
  if ($LASTEXITCODE -eq 0) {
    & git -C $Repo check-ignore -q '.local/secrets/probe.env'
    if ($LASTEXITCODE -ne 0) { Die '.local/ is not git-ignored - refusing to generate secrets inside the checkout' }
    if (& git -C $Repo ls-files .local) { Die 'files under .local/ are tracked by Git - remove them from the index first' }
    Ok '.local/ is git-ignored and untracked'
  }
}

# ---------------------------------------------------------------- 2. .env (non-secret settings)
Step 'Preparing nestjs-project/.env (non-secret settings)'
if (-not (Test-Path $EnvFile)) {
  $minioPort = if ($env:STREAMTUBE_MINIO_PORT) { $env:STREAMTUBE_MINIO_PORT } else { '9000' }
  $lines = foreach ($line in [IO.File]::ReadAllLines((Join-Path $Backend '.env.example'))) {
    if ($line.StartsWith('JWT_SECRET=')) { "JWT_SECRET=$(RandHex 32)" }
    elseif ($line.StartsWith('JWT_REFRESH_SECRET=')) { "JWT_REFRESH_SECRET=$(RandHex 32)" }
    elseif ($line.StartsWith('S3_PUBLIC_ENDPOINT=')) { "S3_PUBLIC_ENDPOINT=http://localhost:$minioPort" }
    else { $line }
  }
  Write-TextFile $EnvFile $lines
  Ok 'created from .env.example (random JWT secrets)'
} else {
  Ok 'kept the existing .env'
}
$legacyKeys = @([IO.File]::ReadAllLines($EnvFile) | Where-Object { $_ -match ($CredentialKeysRe + '.+') } | ForEach-Object { $_.Split('=')[0] })

# ---------------------------------------------------------------- 3. credential files
Step 'Preparing the credential files in .local\secrets\'
New-Item -ItemType Directory -Force -Path $Secrets | Out-Null
Restrict-ToOwner $Secrets -Directory
$minioEnv = Join-Path $Secrets 'minio.env'
$provisionEnv = Join-Path $Secrets 'provision.env'

if (-not (Test-Path $minioEnv)) {
  $legacyUser = Get-EnvValue 'MINIO_ROOT_USER' $EnvFile
  $legacyPass = Get-EnvValue 'MINIO_ROOT_PASSWORD' $EnvFile
  if ($legacyUser -and $legacyPass) {
    Write-TextFile $minioEnv @("MINIO_ROOT_USER=$legacyUser", "MINIO_ROOT_PASSWORD=$legacyPass")
    Ok 'minio.env: reused the existing MinIO root pair from .env (the data volume stays usable)'
  } else {
    Write-TextFile $minioEnv @("MINIO_ROOT_USER=streamtube-root-$(RandHex 3)", "MINIO_ROOT_PASSWORD=$(RandHex 24)")
    Ok 'minio.env: generated a new MinIO root pair'
  }
} else {
  Ok 'minio.env: kept (never overwritten)'
}
$rootUser = Get-EnvValue 'MINIO_ROOT_USER' $minioEnv
$rootPass = Get-EnvValue 'MINIO_ROOT_PASSWORD' $minioEnv
if (-not $rootUser -or -not $rootPass) { Die 'minio.env is incomplete (fix or remove it explicitly; it is never overwritten)' }

$prefixes = @('S3_API', 'S3_WORKER', 'S3_DELIVERY', 'S3_TEST_API', 'S3_TEST_WORKER', 'S3_TEST_DELIVERY', 'S3_TEST_MAINTENANCE')
if (-not (Test-Path $provisionEnv)) {
  $lines = @("MINIO_ROOT_USER=$rootUser", "MINIO_ROOT_PASSWORD=$rootPass")
  foreach ($p in $prefixes) {
    $role = $p.Substring(3).ToLower().Replace('_', '-')
    $lines += "${p}_ACCESS_KEY_ID=streamtube-$role-$(RandHex 3)"
    $lines += "${p}_SECRET_ACCESS_KEY=$(RandHex 24)"
  }
  Write-TextFile $provisionEnv $lines
  Ok 'provision.env: generated 7 identities'
} else {
  Ok 'provision.env: kept (never overwritten)'
}
foreach ($p in $prefixes) {
  if (-not (Get-EnvValue "${p}_ACCESS_KEY_ID" $provisionEnv) -or -not (Get-EnvValue "${p}_SECRET_ACCESS_KEY" $provisionEnv)) {
    Die "provision.env misses ${p}_ACCESS_KEY_ID/${p}_SECRET_ACCESS_KEY (fix it explicitly; it is never overwritten)"
  }
}
if ((Get-EnvValue 'MINIO_ROOT_USER' $provisionEnv) -ne $rootUser -or (Get-EnvValue 'MINIO_ROOT_PASSWORD' $provisionEnv) -ne $rootPass) {
  Die 'provision.env and minio.env disagree on the root pair (nothing overwritten)'
}

# Every per-process file is derived from provision.env (the single source).
function Pair($idKey, $secretKey, $prefix) {
  @("$idKey=$(Get-EnvValue "${prefix}_ACCESS_KEY_ID" $provisionEnv)", "$secretKey=$(Get-EnvValue "${prefix}_SECRET_ACCESS_KEY" $provisionEnv)")
}
$testLines = @()
foreach ($p in @('S3_TEST_API', 'S3_TEST_WORKER', 'S3_TEST_DELIVERY')) { $testLines += Pair "${p}_ACCESS_KEY_ID" "${p}_SECRET_ACCESS_KEY" $p }
$derived = [ordered]@{
  'api.env'         = @((Pair 'S3_ACCESS_KEY_ID' 'S3_SECRET_ACCESS_KEY' 'S3_API') + (Pair 'S3_DELIVERY_ACCESS_KEY_ID' 'S3_DELIVERY_SECRET_ACCESS_KEY' 'S3_DELIVERY'))
  'worker.env'      = @(Pair 'S3_ACCESS_KEY_ID' 'S3_SECRET_ACCESS_KEY' 'S3_WORKER')
  'test-api.env'    = $testLines
  'test-worker.env' = $testLines
  'maintenance.env' = @(Pair 'S3_TEST_MAINTENANCE_ACCESS_KEY_ID' 'S3_TEST_MAINTENANCE_SECRET_ACCESS_KEY' 'S3_TEST_MAINTENANCE')
}
foreach ($name in $derived.Keys) {
  $path = Join-Path $Secrets $name
  $expected = (($derived[$name] -join "`n") + "`n")
  if (-not (Test-Path $path)) {
    Write-TextFile $path $derived[$name]
    Ok "${name}: generated"
  } elseif (([IO.File]::ReadAllText($path)).Replace("`r", '') -eq $expected) {
    Ok "${name}: kept (consistent with provision.env)"
  } else {
    Die "$name differs from provision.env - not overwritten; reconcile it explicitly"
  }
}
Get-ChildItem -Path $Secrets -Filter *.env | ForEach-Object { Restrict-ToOwner $_.FullName }
Ok 'permissions: owner-only'

# ---------------------------------------------------------------- 4. legacy credentials in .env
if ($legacyKeys.Count -gt 0) {
  $names = $legacyKeys -join ' '
  if ($PrepareOnly) {
    Warn "nestjs-project/.env still holds credentials ($names); the full setup moves them out (prepare-only changes nothing)"
  } else {
    $backup = Join-Path $Secrets ("legacy-env-{0}.bak" -f (Get-Date -Format 'yyyyMMddHHmmss'))
    $all = [IO.File]::ReadAllLines($EnvFile)
    Write-TextFile $backup @($all | Where-Object { $_ -match $CredentialKeysRe })
    Restrict-ToOwner $backup
    $clean = foreach ($line in $all) {
      if ($line -match $CredentialKeysRe) { "# $($line.Split('=')[0])= (moved to .local/secrets by setup)" } else { $line }
    }
    Write-TextFile $EnvFile $clean
    Ok "moved credentials out of .env ($names); backup kept in .local\secrets\ (owner-only)"
  }
} else {
  Ok 'nestjs-project/.env holds no credential'
}

# ---------------------------------------------------------------- 4b. JWT secrets in .env
# Same rule as the API (src/config/env.validation.ts), which refuses to start
# otherwise: present, not a public placeholder, >= 32 characters, >= 8 distinct
# characters, access != refresh. Only a secret that fails is regenerated (32
# random bytes); valid secrets are kept. Values are never printed.
function Test-JwtSecret([string]$v) {
  if ($v.Length -lt 32) { return $false }
  if ($v -match '(?i)change[-_ ]?me|placeholder|your[-_ ]?secret|replace[-_ ]?me') { return $false }
  return ((@($v.ToCharArray() | Select-Object -Unique)).Count -ge 8)
}
$jwtAccess = Get-EnvValue 'JWT_SECRET' $EnvFile
$jwtRefresh = Get-EnvValue 'JWT_REFRESH_SECRET' $EnvFile
$newAccess = -not (Test-JwtSecret $jwtAccess)
$newRefresh = -not (Test-JwtSecret $jwtRefresh)
if (-not $newAccess -and -not $newRefresh -and ($jwtAccess -ceq $jwtRefresh)) { $newRefresh = $true }
$jwtAccess = $null; $jwtRefresh = $null
if (-not $newAccess -and -not $newRefresh) {
  Ok 'JWT secrets: kept (strong and distinct)'
} elseif ($PrepareOnly) {
  Warn 'JWT secrets in .env are missing, public placeholders, weak or identical; the API refuses them and the full setup replaces them (prepare-only changes nothing)'
} else {
  $all = [IO.File]::ReadAllLines($EnvFile)
  $backup = Join-Path $Secrets ("jwt-env-{0}.bak" -f (Get-Date -Format 'yyyyMMddHHmmss'))
  Write-TextFile $backup @($all | Where-Object { $_ -match '^JWT_(SECRET|REFRESH_SECRET)=' })
  Restrict-ToOwner $backup
  $seenAccess = $false; $seenRefresh = $false
  $updated = foreach ($line in $all) {
    if ($line.StartsWith('JWT_SECRET=')) { $seenAccess = $true; if ($newAccess) { "JWT_SECRET=$(RandHex 32)" } else { $line } }
    elseif ($line.StartsWith('JWT_REFRESH_SECRET=')) { $seenRefresh = $true; if ($newRefresh) { "JWT_REFRESH_SECRET=$(RandHex 32)" } else { $line } }
    else { $line }
  }
  if (-not $seenAccess) { $updated = @($updated) + "JWT_SECRET=$(RandHex 32)" }
  if (-not $seenRefresh) { $updated = @($updated) + "JWT_REFRESH_SECRET=$(RandHex 32)" }
  Write-TextFile $EnvFile $updated
  $replaced = (@($(if ($newAccess) { 'JWT_SECRET' }), $(if ($newRefresh) { 'JWT_REFRESH_SECRET' })) | Where-Object { $_ }) -join ' '
  Ok "JWT secrets: generated $replaced (the previous value was missing, public, weak or identical); tokens signed before stop working; previous lines kept in .local\secrets\ (owner-only)"
}

# ---------------------------------------------------------------- 5. configuration check
Step 'Validating the Compose configuration (values are never printed)'
Compose config --quiet
if ($LASTEXITCODE -ne 0) { Die 'compose.yaml is not valid' }
Compose -f (Join-Path $Backend 'compose.test.yaml') config --quiet
if ($LASTEXITCODE -ne 0) { Die 'compose.test.yaml is not valid' }
Ok 'compose.yaml + compose.test.yaml'

function Invoke-Provision([string]$mode) {
  $minioId = (Compose ps -q minio | Out-String).Trim()
  if (-not $minioId) { return $false }
  & docker build -q -t $ProvisionImage (Join-Path $Backend 'docker\storage-provision') | Out-Null
  if ($LASTEXITCODE -ne 0) { Die 'could not build the provisioning image' }
  & docker run --rm --network "container:$minioId" `
    --env-file $provisionEnv `
    -e MINIO_ENDPOINT=http://localhost:9000 `
    -e "S3_BUCKET=$(Get-EnvValue 'S3_BUCKET' $EnvFile)" `
    -e "S3_TEST_BUCKET=$(Get-EnvValue 'S3_TEST_BUCKET' $EnvFile)" `
    -e "PROVISION_MODE=$mode" `
    -v "$(Join-Path $Backend 'docker\storage-provision'):/provision:ro" `
    $ProvisionImage /provision/provision.sh | ForEach-Object { Write-Host "    $_" }
  return ($LASTEXITCODE -eq 0)
}

if ($PrepareOnly) {
  Step 'Read-only provisioning preflight'
  if ((Compose ps -q minio | Out-String).Trim()) {
    if (-not (Invoke-Provision 'check')) { Die 'provisioning preflight refused (nothing was written)' }
  } else {
    Warn 'MinIO is not running - preflight skipped'
  }
  Write-Host ''
  Write-Host 'Prepare-only finished: nothing was started, stopped or changed.'
  exit 0
}

# ---------------------------------------------------------------- 6. infrastructure
Step 'Starting PostgreSQL, Mailpit and MinIO'
Compose up -d --wait db mailpit minio
if ($LASTEXITCODE -ne 0) { Die 'infrastructure did not become healthy' }
Ok 'infrastructure healthy'

if (-not (Get-EnvValue 'DB_TEST_SERVER_ID' $EnvFile)) {
  $serverId = ((Compose exec -T db psql -U streamtube -d postgres -tAc 'SELECT system_identifier FROM pg_control_system()') | Out-String).Trim()
  if (-not $serverId) { Die 'could not read the PostgreSQL system identifier' }
  $updated = foreach ($line in [IO.File]::ReadAllLines($EnvFile)) {
    if ($line.StartsWith('DB_TEST_SERVER_ID=')) { "DB_TEST_SERVER_ID=$serverId" } else { $line }
  }
  Write-TextFile $EnvFile $updated
  Ok 'DB_TEST_SERVER_ID recorded in .env (machine-specific, git-ignored)'
}

# ---------------------------------------------------------------- 7. provisioning
Step 'Provisioning MinIO (buckets, policies, identities - idempotent, non-destructive)'
if (-not (Invoke-Provision 'apply')) { Die 'provisioning stopped (it never deletes or overwrites anything)' }

# ---------------------------------------------------------------- 8. dependencies, build, migrations
Step 'Installing dependencies, building and applying migrations'
if (-not (Test-Path (Join-Path $Backend 'node_modules'))) {
  Compose run --rm --no-deps nestjs-api npm ci
  if ($LASTEXITCODE -ne 0) { Die 'npm ci failed' }
}
Compose run --rm --no-deps nestjs-api npm run build | Out-Null
if ($LASTEXITCODE -ne 0) { Die 'build failed' }
Ok 'build'
$migration = Compose run --rm --no-deps nestjs-api npm run migration:run
if ($LASTEXITCODE -ne 0) { $migration | Select-Object -Last 20 | ForEach-Object { Write-Host "    $_" }; Die 'migrations failed' }
$migration | Select-Object -Last 3 | ForEach-Object { Write-Host "    $_" }
Ok 'migrations applied (pending ones only)'

# ---------------------------------------------------------------- 9. API and worker
Step 'Starting the API and the worker'
# Started one after the other, with one bounded, visible retry each: on Docker
# Desktop for Windows a bind-mounted node_modules can briefly return EIO or a
# missing file to a container that starts while another one is loading it.
function Start-StackService([string]$service) {
  Compose up -d --wait --force-recreate $service
  if ($LASTEXITCODE -ne 0) {
    Warn "$service did not start on the first attempt (bind-mount I/O); retrying once in 10 s"
    Start-Sleep -Seconds 10
    Compose up -d --wait $service
    if ($LASTEXITCODE -ne 0) {
      Compose logs --tail 30 $service | ForEach-Object { Write-Host "    $_" }
      Die "$service did not start"
    }
  }
}
Start-StackService 'nestjs-api'
Start-StackService 'worker'
Compose exec -T nestjs-api curl -fsS http://localhost:3000/ | Out-Null
if ($LASTEXITCODE -ne 0) { Die 'the API does not answer' }
$apiPort = if ($env:STREAMTUBE_API_PORT) { $env:STREAMTUBE_API_PORT } else { '3000' }
Ok "API answering on http://localhost:$apiPort"
$ready = $false
for ($i = 0; $i -lt 30 -and -not $ready; $i++) {
  if (((Compose logs worker 2>$null) | Out-String) -match 'Video worker started') { $ready = $true } else { Start-Sleep -Seconds 2 }
}
if (-not $ready) { Die "the worker did not report 'Video worker started'" }
Ok 'worker connected to the queue'

$consolePort = if ($env:STREAMTUBE_MINIO_CONSOLE_PORT) { $env:STREAMTUBE_MINIO_CONSOLE_PORT } else { '9001' }
$mailPort = if ($env:STREAMTUBE_MAILPIT_UI_PORT) { $env:STREAMTUBE_MAILPIT_UI_PORT } else { '8025' }
Write-Host @"

StreamTube is running.
  API ............ http://localhost:$apiPort   (OpenAPI: set SWAGGER_ENABLED=true in nestjs-project\.env)
  MinIO console .. http://localhost:$consolePort
  Mailpit ........ http://localhost:$mailPort
Next:
  .\scripts\verify.ps1         quick verification (health, isolation, essential tests)
  .\scripts\verify.ps1 -Full   full regression (unit, integration, e2e, media, tsc, lint)
Credentials live in .local\secrets\ (never printed, never versioned).
"@
