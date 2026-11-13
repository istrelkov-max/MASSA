# Пример скрипта деплоя (без пароля).
# Настоящий deploy.ps1 лежит рядом, но в git не попадает — он в .gitignore.
# Использование:
#   $env:MASSA_SSH_PASS = "пароль"
#   powershell -File .\deploy.ps1

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$target = "root@50.114.115.15"
$pass = $env:MASSA_SSH_PASS
if (-not $pass) { throw "Задайте переменную окружения MASSA_SSH_PASS" }

$pscp = "C:\Program Files\PuTTY\pscp.exe"
$plink = "C:\Program Files\PuTTY\plink.exe"
$root = Join-Path $PSScriptRoot "prototype"

Write-Host "1. загрузка server/ и public/"

& $pscp -batch -pw $pass "$root\server\server.py" "${target}:/opt/massa/server/server.py" | Out-Null
& $pscp -batch -pw $pass -r "$root\public\*" "${target}:/opt/massa/public/" | Out-Null

Write-Host "2. права и перезапуск"

$lines = @(
  "set -e",
  "chown -R massa:massa /opt/massa",
  "find /opt/massa -type d -exec chmod 750 {} \;",
  "find /opt/massa -type f -exec chmod 640 {} \;",
  "systemctl restart massa",
  "sleep 2",
  "systemctl is-active massa",
  'curl -s https://50-114-115-15.sslip.io/api/ping; echo'
)

$tmp = Join-Path $env:TEMP "massa-deploy.sh"
[IO.File]::WriteAllText($tmp, ($lines -join "`n") + "`n")

& $plink -ssh -batch -pw $pass -m $tmp $target

Write-Host "готово"
