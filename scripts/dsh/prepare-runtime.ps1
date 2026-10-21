[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ReferencePath,
  [Parameter(Mandatory = $true)][string]$RuntimePath
)

$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$patchRoot = Join-Path $repoRoot 'integrations\dsh\patches'
$lockPath = Join-Path $patchRoot 'patches.lock.json'
$workspaceRoot = Split-Path -Parent $repoRoot
$expectedReference = [IO.Path]::GetFullPath((Join-Path $workspaceRoot 'workspace\research\references\deepseek-harness'))
$testRoot = [IO.Path]::GetFullPath((Join-Path $workspaceRoot 'workspace\testing\dsh-slot-patches\temp-runtimes'))
$runtimeRoot = [IO.Path]::GetFullPath((Join-Path $workspaceRoot 'workspace\runtime\tradeloom-harness'))
$releaseRoot = Join-Path $runtimeRoot 'releases'

function Resolve-CanonicalPath([string]$Path) {
  $full = [IO.Path]::GetFullPath($Path)
  if (Test-Path -LiteralPath $full) { return [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $full).Path) }
  $parent = Split-Path -Parent $full
  $leaf = Split-Path -Leaf $full
  if (Test-Path -LiteralPath $parent) { $parent = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $parent).Path) }
  return [IO.Path]::GetFullPath((Join-Path $parent $leaf))
}

function Test-Under([string]$Path, [string]$Root) {
  $prefix = $Root.TrimEnd('\') + '\'
  return $Path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

function Test-NoReparseAncestors([string]$Path) {
  $current = [IO.Path]::GetFullPath($Path)
  while ($true) {
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
    }
    $parent = Split-Path -Parent $current
    if (-not $parent -or $parent -eq $current) { break }
    $current = $parent
  }
  return $true
}

function Write-Result([hashtable]$Result, [int]$Code) {
  $Result | ConvertTo-Json -Compress -Depth 6 | Write-Output
  exit $Code
}

function Invoke-Git([string]$WorkingDirectory, [string[]]$Arguments) {
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = & git -C $WorkingDirectory @Arguments 2>&1
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($code -ne 0) { throw "git $($Arguments -join ' ') failed ($code): $($output -join ' ')" }
  return (($output | ForEach-Object { [string]$_ }) -join "`n").Trim()
}

$referenceInput = [IO.Path]::GetFullPath($ReferencePath)
$runtimeInput = [IO.Path]::GetFullPath($RuntimePath)
$inputPathsSafe = (Test-NoReparseAncestors $referenceInput) -and (Test-NoReparseAncestors $runtimeInput)
$reference = Resolve-CanonicalPath $ReferencePath
$runtime = Resolve-CanonicalPath $RuntimePath
$expectedRefCanonical = Resolve-CanonicalPath $expectedReference
$testRootCanonical = Resolve-CanonicalPath $testRoot
$runtimeRootCanonical = Resolve-CanonicalPath $runtimeRoot
$allowedReference = $reference.Equals($expectedRefCanonical, [StringComparison]::OrdinalIgnoreCase) -or (Test-Under $reference $testRootCanonical)
$releaseRootCanonical = Resolve-CanonicalPath $releaseRoot
$isVersionedRelease = (Split-Path -Parent $runtime).Equals($releaseRootCanonical, [StringComparison]::OrdinalIgnoreCase)
$allowedRuntime = $isVersionedRelease -or (Test-Under $runtime $testRootCanonical)

if (-not $allowedReference -or -not $allowedRuntime -or -not $inputPathsSafe -or -not (Test-NoReparseAncestors $reference) -or -not (Test-NoReparseAncestors $runtime)) {
  Write-Result @{ status = 'path_rejected'; referencePath = $reference; runtimePath = $runtime; message = 'Only the pinned read-only reference or task test fixtures and app-owned runtime paths are accepted.' } 21
}
if (Test-Path -LiteralPath $runtime) {
  Write-Result @{ status = 'target_exists'; runtimePath = $runtime; message = 'Existing runtime is never overwritten.' } 20
}
if (-not (Test-Path -LiteralPath $lockPath)) {
  Write-Result @{ status = 'lock_missing'; lockPath = $lockPath } 24
}

$lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
$patchNames = @('ui-layout-shell-top.patch', 'ui-sidebar-agents.patch', 'reasoning-hidden.patch', 'desktop-identity.patch', 'desktop-host-lan.patch', 'desktop-business-csrf.patch', 'desktop-managed-update.patch', 'desktop-websocket-authority.patch', 'native-provider-ui-fix.patch', 'desktop-startup-account-free.patch', 'desktop-branding.patch')
foreach ($name in $patchNames) {
  $file = Join-Path $patchRoot $name
  if (-not (Test-Path -LiteralPath $file)) { Write-Result @{ status = 'patch_missing'; patch = $name } 24 }
  $actualHash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
  if ($actualHash -ne $lock.patches.$name) { Write-Result @{ status = 'patch_hash_mismatch'; patch = $name; expected = $lock.patches.$name; actual = $actualHash } 24 }
}

$sourceCommit = Invoke-Git $reference @('rev-parse', 'HEAD')
if ($sourceCommit -ne $lock.upstream.commit) {
  Write-Result @{ status = 'source_head_mismatch'; expected = $lock.upstream.commit; actual = $sourceCommit; targetCreated = $false } 22
}
$licensePath = Join-Path $reference 'LICENSE'
if (-not (Test-Path -LiteralPath $licensePath)) {
  Write-Result @{ status = 'license_mismatch'; expected = $lock.upstream.licenseSha256; actual = $null; targetCreated = $false } 23
}
$licenseHash = (Get-FileHash -LiteralPath $licensePath -Algorithm SHA256).Hash
if ($licenseHash -ne $lock.upstream.licenseSha256) {
  Write-Result @{ status = 'license_mismatch'; expected = $lock.upstream.licenseSha256; actual = $licenseHash; targetCreated = $false } 23
}

$runtimeParent = Split-Path -Parent $runtime
if (-not (Test-Path -LiteralPath $runtimeParent)) {
  New-Item -ItemType Directory -Path $runtimeParent -Force | Out-Null
}
$stage = Join-Path $runtimeParent ('.tradeloom-harness.prepare-' + [guid]::NewGuid().ToString('N'))
$stageCreated = $false
try {
  $stageCreated = $true
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $cloneOutput = & git clone --quiet --no-local --depth 1 --no-checkout $reference $stage 2>&1
    $cloneCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($cloneCode -ne 0) { throw "git clone failed ($cloneCode): $($cloneOutput -join ' ')" }
  & git -C $stage config core.longpaths true
  if ($LASTEXITCODE -ne 0) { throw 'Unable to set repository-local core.longpaths.' }
  $clonedHead = Invoke-Git $stage @('checkout', '--detach', $lock.upstream.commit)
  $actualHead = Invoke-Git $stage @('rev-parse', 'HEAD')
  if ($actualHead -ne $lock.upstream.commit) { throw "Cloned source HEAD mismatch: $actualHead" }
  $actualLicense = (Get-FileHash -LiteralPath (Join-Path $stage 'LICENSE') -Algorithm SHA256).Hash
  if ($actualLicense -ne $lock.upstream.licenseSha256) { throw "Cloned source license mismatch: $actualLicense" }

  foreach ($relativePath in $lock.targetFiles.PSObject.Properties.Name) {
    $target = Join-Path $stage $relativePath
    $actualHash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
    $expectedHash = [string]$lock.targetFiles.$relativePath.baseSha256
    if ($actualHash -ne $expectedHash) { throw "Patch base target hash mismatch: $relativePath" }
  }

  foreach ($name in $patchNames) {
    $patch = Join-Path $patchRoot $name
    $checkOutput = & git -C $stage apply --check $patch 2>&1
    if ($LASTEXITCODE -ne 0) {
      Write-Result @{ status = 'patch_conflict'; patch = $name; sourceCommit = $actualHead; conflicts = @($checkOutput | ForEach-Object { [string]$_ }); targetCreated = $false } 25
    }
    $applyOutput = & git -C $stage apply $patch 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Patch application failed for ${name}: $($applyOutput -join ' ')" }
  }

  foreach ($relativePath in $lock.targetFiles.PSObject.Properties.Name) {
    $target = Join-Path $stage $relativePath
    $actualHash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
    $expectedHash = [string]$lock.targetFiles.$relativePath.newSha256
    if ($actualHash -ne $expectedHash) { throw "Patch output target hash mismatch: $relativePath" }
  }

  $runtimeOwnership = "tradeloom-dsh-runtime-v1`n$($lock.upstream.commit)`n"
  [IO.File]::WriteAllText((Join-Path $stage '.tradeloom-runtime-owned'), $runtimeOwnership, [Text.UTF8Encoding]::new($false))

  if (Test-Path -LiteralPath $runtime) {
    Write-Result @{ status = 'target_exists'; runtimePath = $runtime; message = 'Runtime appeared during preparation; it was not replaced.' } 20
  }
  if (-not (Test-NoReparseAncestors $stage) -or -not (Test-NoReparseAncestors $runtime) -or -not (Test-NoReparseAncestors $runtimeParent)) {
    throw 'A reparse-point ancestor appeared before publishing the runtime.'
  }
  Move-Item -LiteralPath $stage -Destination $runtime
  $stageCreated = $false
  Write-Result @{ status = 'prepared'; runtimePath = $runtime; sourceCommit = $actualHead; licenseSha256 = $actualLicense; patches = $patchNames; targetCreated = $true } 0
} catch {
  Write-Result @{ status = 'prepare_failed'; runtimePath = $runtime; sourceCommit = $sourceCommit; message = $_.Exception.Message; targetCreated = $false } 24
} finally {
  if ($stageCreated -and (Test-Path -LiteralPath $stage)) {
    if ((Test-NoReparseAncestors $stage) -and (Test-NoReparseAncestors $runtimeParent)) {
      $resolvedStage = Resolve-CanonicalPath $stage
      $expectedStageParent = [IO.Path]::GetFullPath($runtimeParent).TrimEnd('\') + '\'
      if ((Test-NoReparseAncestors $resolvedStage) -and $resolvedStage.StartsWith($expectedStageParent, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolvedStage).StartsWith('.tradeloom-harness.prepare-', [StringComparison]::OrdinalIgnoreCase)) {
        try {
          Remove-Item -LiteralPath $resolvedStage -Recurse -Force -ErrorAction Stop
        } catch {
          [Console]::Error.WriteLine("Cleanup warning: could not remove owned preparation stage '$resolvedStage': $($_.Exception.Message)")
        }
      }
    }
  }
}
