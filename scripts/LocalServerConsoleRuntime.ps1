function Invoke-LocalServerConsoleCommand {
  param([string]$DataRoot, [ValidateSet('enable', 'open')][string]$Action)
  $root = (Resolve-Path -LiteralPath $DataRoot).Path
  $config = Get-Content -LiteralPath (Join-Path $root 'server-config.json') -Raw | ConvertFrom-Json
  if (Get-EnterpriseHttpsEnabled -Configuration $config) { throw 'HTTPS 模式请使用正常登录入口。' }
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $permitted = @($identity.User.Value, 'S-1-5-18', 'S-1-5-32-544')
  foreach ($protectedPath in @($root, (Join-Path $root 'secrets'))) {
    $acl = Get-Acl -LiteralPath $protectedPath
    foreach ($rule in $acl.Access) {
      if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $permitted) {
        throw '安装目录权限不符合本机授权要求；请使用正常登录入口。'
      }
    }
  }
  $python = Join-Path $config.runtime_root 'python\python.exe'
  $app = [IO.Path]::GetFullPath([string]$config.app_root)
  $serverPid = [int](Get-Content -LiteralPath (Join-Path $root 'django.pid') -Raw).Trim()
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$serverPid"
  if (-not $process -or $process.ExecutablePath -ine $python -or
      -not $process.CommandLine.Contains((Join-Path $app 'manage.py')) -or
      -not $process.CommandLine.Contains("runserver 127.0.0.1:$($config.http_port)")) {
    throw '无法确认当前安装的服务器进程；未签发授权。'
  }
  $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid
  if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne $identity.User.Value) { throw '当前 Windows 身份与服务运行身份不同或无法核实。现有免密入口仅支持服务所属账户，尚不支持技术员自己的另一 Windows 账户；请使用织贸正常登录，未签发授权。' }
  $listener = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort ([int]$config.http_port) -State Listen)
  if ($listener.Count -ne 1 -or $listener[0].OwningProcess -ne $serverPid) { throw '服务器监听归属不匹配；未签发授权。' }
  $secrets = Get-Content -LiteralPath (Join-Path $root 'secrets\service-secrets.json') -Raw | ConvertFrom-Json
  $variables = @{
    PYTHONPATH = (Join-Path $config.runtime_root 'python-packages')
    DJANGO_SETTINGS_MODULE = 'config.enterprise_settings'
    TRADELOOM_ENTERPRISE_DATA_ROOT = $root
    TRADELOOM_ENTERPRISE_SECRET_KEY = [string]$secrets.django_secret_key
    TRADELOOM_ENTERPRISE_HTTPS = '0'
    TRADELOOM_ENTERPRISE_BIND_HOST = '127.0.0.1'
    TRADELOOM_ENTERPRISE_ALLOWED_HOSTS = '127.0.0.1,localhost'
    TRADELOOM_DB_NAME = [string]$secrets.database_name
    TRADELOOM_DB_USER = [string]$secrets.database_user
    TRADELOOM_DB_PASSWORD = [string]$secrets.database_password
    TRADELOOM_DB_HOST = '127.0.0.1'
    TRADELOOM_DB_PORT = [string]$config.postgres_port
  }
  $previous = @{}
  foreach ($key in $variables.Keys) { $previous[$key] = [Environment]::GetEnvironmentVariable($key); [Environment]::SetEnvironmentVariable($key, $variables[$key]) }
  Push-Location $app
  try {
    & $python -B manage.py local_server_console $Action
    if ($LASTEXITCODE -ne 0) { throw '本机入口命令失败；未回退或修改服务器配置。' }
  } finally {
    Pop-Location
    foreach ($key in $variables.Keys) { [Environment]::SetEnvironmentVariable($key, $previous[$key]) }
  }
}
