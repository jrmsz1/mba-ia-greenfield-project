<#
.SYNOPSIS
  StreamTube - external test-storage maintenance (phase-03-videos/TD-15).

.DESCRIPTION
  .\scripts\test-storage-maintenance.ps1            dry run: counts only
  .\scripts\test-storage-maintenance.ps1 -Confirm   remove objects and abort
                                                    multipart sessions of
                                                    S3_TEST_BUCKET only

  Never run automatically. Runs in a one-off container (not a Compose service,
  not nestjs-api/worker) with only the maintenance identity (maintenance.env);
  the tool refuses any other bucket, root or operational credentials, and any
  moment a test run holds the test-run lock.
#>
[CmdletBinding()]
param([switch]$Confirm)

$ErrorActionPreference = 'Continue'
$Repo = Split-Path -Parent $PSScriptRoot
$Backend = Join-Path $Repo 'nestjs-project'
$MaintenanceEnv = Join-Path $Repo '.local\secrets\maintenance.env'
function Compose { & docker compose --project-directory $Backend -f (Join-Path $Backend 'compose.yaml') @args }
function Get-Setting([string]$key) {
  foreach ($line in [IO.File]::ReadAllLines((Join-Path $Backend '.env'))) {
    if ($line.StartsWith("$key=")) { return $line.Substring($key.Length + 1).TrimEnd("`r") }
  }
  return ''
}

if (-not (Test-Path $MaintenanceEnv)) { Write-Host 'maintenance.env not found - run .\scripts\setup.ps1 first'; exit 1 }
$minioId = (Compose ps -q minio | Out-String).Trim()
$apiId = (Compose ps -q nestjs-api | Out-String).Trim()
if (-not $minioId -or -not $apiId) { Write-Host 'the stack is not running - run .\scripts\setup.ps1 first'; exit 1 }
$project = (& docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' $minioId | Out-String).Trim()
$image = (& docker inspect -f '{{ .Config.Image }}' $apiId | Out-String).Trim()

$toolArgs = @()
if ($Confirm) { $toolArgs = @('--confirm') }
& docker run --rm --network "${project}_default" `
  --env-file $MaintenanceEnv `
  -e STREAMTUBE_TEST_MAINTENANCE=1 `
  -e S3_ENDPOINT=http://minio:9000 `
  -e "S3_BUCKET=$(Get-Setting 'S3_BUCKET')" -e "S3_TEST_BUCKET=$(Get-Setting 'S3_TEST_BUCKET')" `
  -e DB_HOST=db -e DB_PORT=5432 `
  -e "DB_USERNAME=$(Get-Setting 'DB_USERNAME')" -e "DB_PASSWORD=$(Get-Setting 'DB_PASSWORD')" `
  -e "DB_TEST_NAME=$(Get-Setting 'DB_TEST_NAME')" -e "DB_TEST_SERVER_ID=$(Get-Setting 'DB_TEST_SERVER_ID')" `
  -v "${Backend}:/home/node/app" -w /home/node/app `
  $image npx ts-node --transpile-only src/test/storage-maintenance.ts @toolArgs
exit $LASTEXITCODE
