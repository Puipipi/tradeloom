function Get-EnterpriseHttpsConfiguration {
  param([AllowEmptyString()][string]$ExternalHttpsUrl = '')

  if ([string]::IsNullOrEmpty($ExternalHttpsUrl)) {
    return [pscustomobject]@{ Enabled = $false; Url = ''; Origin = ''; Host = ''; Authority = '' }
  }
  if ($ExternalHttpsUrl -cne $ExternalHttpsUrl.Trim() -or
      $ExternalHttpsUrl.Contains('?') -or $ExternalHttpsUrl.Contains('#')) {
    throw 'ExternalHttpsUrl must not contain surrounding whitespace, a query, or a fragment.'
  }

  $uri = $null
  if (-not [Uri]::TryCreate($ExternalHttpsUrl, [UriKind]::Absolute, [ref]$uri) -or
      $uri.Scheme -cne 'https' -or [string]::IsNullOrWhiteSpace($uri.Host) -or
      $uri.Port -lt 1 -or $uri.Port -gt 65535 -or
      -not [string]::IsNullOrEmpty($uri.UserInfo) -or
      $uri.AbsolutePath -notin @('/', '/enterprise/')) {
    throw 'ExternalHttpsUrl must be an HTTPS origin with no credentials, query, or fragment; an empty path, /, or /enterprise/ is allowed.'
  }

  $hostName = $uri.DnsSafeHost
  $allowedHost = if ($uri.HostNameType -eq [UriHostNameType]::IPv6) { "[$hostName]" } else { $hostName }
  $origin = $uri.GetLeftPart([UriPartial]::Authority)
  return [pscustomobject]@{
    Enabled = $true
    Url = $ExternalHttpsUrl
    Origin = $origin
    Host = $allowedHost
    Authority = $uri.Authority
  }
}

function Get-EnterpriseHttpsEnabled {
  param([Parameter(Mandatory)]$Configuration)
  $property = $Configuration.PSObject.Properties['https_enabled']
  if ($null -eq $property) { return $false }
  return [bool]$property.Value
}

function Set-EnterpriseHttpsMode {
  param(
    [Parameter(Mandatory)]$Configuration,
    [Parameter(Mandatory)][bool]$Enabled,
    [AllowEmptyString()][string]$ExternalHttpsUrl = ''
  )
  if ($null -eq $Configuration.PSObject.Properties['https_enabled']) {
    $Configuration | Add-Member -NotePropertyName https_enabled -NotePropertyValue $Enabled
  } else {
    $Configuration.https_enabled = $Enabled
  }
  if ($PSBoundParameters.ContainsKey('ExternalHttpsUrl')) {
    if ($null -eq $Configuration.PSObject.Properties['external_https_url']) {
      $Configuration | Add-Member -NotePropertyName external_https_url -NotePropertyValue $ExternalHttpsUrl
    } else {
      $Configuration.external_https_url = $ExternalHttpsUrl
    }
  }
}

function Write-EnterpriseServerConfiguration {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)]$Configuration
  )
  $Configuration | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Invoke-EnterpriseHealthRequest {
  param(
    [Parameter(Mandatory)][int]$Port,
    [string]$HostHeader = "127.0.0.1:$Port",
    [switch]$TrustedHttpsProxyHeader
  )

  $handler = [System.Net.Http.HttpClientHandler]::new()
  $handler.AllowAutoRedirect = $false
  $client = [System.Net.Http.HttpClient]::new($handler)
  $client.Timeout = [TimeSpan]::FromSeconds(2)
  $request = $null
  $response = $null
  try {
    $request = [System.Net.Http.HttpRequestMessage]::new(
      [System.Net.Http.HttpMethod]::Get,
      [Uri]"http://127.0.0.1:$Port/api/health"
    )
    $request.Headers.Host = $HostHeader
    if ($TrustedHttpsProxyHeader) {
      $null = $request.Headers.TryAddWithoutValidation('X-Forwarded-Proto', 'https')
    }
    $response = $client.SendAsync($request).GetAwaiter().GetResult()
    $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    return [pscustomobject]@{
      StatusCode = [int]$response.StatusCode
      Location = if ($null -eq $response.Headers.Location) { '' } else { $response.Headers.Location.ToString() }
      Body = $body
    }
  } finally {
    if ($null -ne $request) { $request.Dispose() }
    if ($null -ne $response) { $response.Dispose() }
    $client.Dispose()
    $handler.Dispose()
  }
}

function Test-EnterpriseServerHealthMode {
  param(
    [Parameter(Mandatory)][int]$Port,
    [Parameter(Mandatory)][bool]$HttpsEnabled,
    [string]$PublicAuthority = ''
  )

  try {
    if ($HttpsEnabled) {
      if ([string]::IsNullOrWhiteSpace($PublicAuthority)) { return $false }
      $proxied = Invoke-EnterpriseHealthRequest -Port $Port -HostHeader $PublicAuthority -TrustedHttpsProxyHeader
      if ($proxied.StatusCode -ne 200) { return $false }
      $health = $proxied.Body | ConvertFrom-Json
      if ($health.status -ne 'ok' -or -not $health.database_ok) { return $false }
      $direct = Invoke-EnterpriseHealthRequest -Port $Port -HostHeader $PublicAuthority
      return ($direct.StatusCode -in @(301, 302, 307, 308) -and
        $direct.Location.StartsWith("https://$PublicAuthority/", [StringComparison]::OrdinalIgnoreCase))
    }

    $direct = Invoke-EnterpriseHealthRequest -Port $Port
    if ($direct.StatusCode -ne 200) { return $false }
    $health = $direct.Body | ConvertFrom-Json
    return ($health.status -eq 'ok' -and [bool]$health.database_ok)
  } catch {
    return $false
  }
}
