$ErrorActionPreference = 'Stop'
$adapters = @(Get-NetAdapter -Physical | Where-Object { $_.Status -eq 'Up' -and $_.HardwareInterface })
$candidates = @(
  foreach ($adapter in $adapters) {
    $name = $adapter.Name
    $description = $adapter.InterfaceDescription
    $kind = if ([int]$adapter.InterfaceType -eq 71 -or $adapter.PhysicalMediaType -match '802\.11') { 'wifi' }
      elseif ([int]$adapter.InterfaceType -eq 6 -or $adapter.PhysicalMediaType -eq '802.3' -or $adapter.MediaType -eq '802.3') { 'ethernet' }
      else { $null }
    if ($null -eq $kind) { continue }
    foreach ($address in (Get-NetIPAddress -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.AddressState -eq 'Preferred' })) {
      $value = $address.IPAddress
      if ($value -match '^10\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$' -or
          $value -match '^192\.168\.(\d{1,3})\.(\d{1,3})$' -or
          $value -match '^172\.(1[6-9]|2\d|3[01])\.(\d{1,3})\.(\d{1,3})$') {
        [pscustomobject]@{
          name = $name
          interfaceDescription = $description
          kind = $kind
          status = 'Up'
          hardwareInterface = $true
          addresses = @([pscustomobject]@{ addressFamily = 'IPv4'; address = $value })
        }
      }
    }
  }
)
ConvertTo-Json -InputObject @($candidates) -Depth 4 -Compress