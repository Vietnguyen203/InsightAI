# `docker compose` for the stack made by setup.ps1, with its env file and profiles. Every argument
# goes to docker compose (no PowerShell parameters, so "-d" is never taken for one):
#   docker\local\ops.ps1 ps
#   docker\local\ops.ps1 logs -f --tail 100 api worker
#   docker\local\ops.ps1 --profile backup run --rm backup
#   docker\local\ops.ps1 down          (stops InsightAI; data stays in the Docker volumes)
# Folder of the env file: $env:INSIGHTAI_PROD_DIR, default %USERPROFILE%\InsightAI-prod.
$Dir = if ($env:INSIGHTAI_PROD_DIR) { $env:INSIGHTAI_PROD_DIR } else { Join-Path $env:USERPROFILE 'InsightAI-prod' }
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$env:INSIGHTAI_ENV_FILE = Join-Path $Dir 'production.env'
$env:SEAWEEDFS_S3_CONFIG = Join-Path $Dir 'seaweedfs-s3.json'
$env:BACKUP_HOST_DIR = Join-Path $Dir 'backups'
if (-not (Test-Path $env:INSIGHTAI_ENV_FILE)) { throw "No $($env:INSIGHTAI_ENV_FILE): run docker\local\setup.ps1 first" }
$named = @(Get-Content $env:INSIGHTAI_ENV_FILE | Where-Object { $_ -match '^CLOUDFLARE_TUNNEL_TOKEN=.+' }).Count -gt 0
$profiles = @('--profile', 'selfhosted-db', '--profile', 'selfhosted-s3')
# INSIGHTAI_NO_TUNNEL=1: this machine/LAN only (setup.ps1 -NoTunnel).
if ($env:INSIGHTAI_NO_TUNNEL -ne '1') {
  $profiles += @('--profile', $(if ($named) { 'tunnel' } else { 'quick-tunnel' }))
}
& docker compose -f (Join-Path $Repo 'docker\compose.prod.yml') --env-file $env:INSIGHTAI_ENV_FILE @profiles @args
exit $LASTEXITCODE
