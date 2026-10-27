[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ReferencePath,
  [Parameter(Mandatory = $true)][string]$RuntimePath,
  [Parameter()][string]$ProspectiveLockPath,
  [Parameter()][Alias('PatchRoot')][string]$PatchRootOverride,
  [Parameter()][Alias('PatchOrder')][string]$PatchOrderPath
)

$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$patchRoot = Join-Path $repoRoot 'integrations\dsh\patches'
$lockPath = Join-Path $patchRoot 'patches.lock.json'
$workspaceRoot = Split-Path -Parent $repoRoot
$expectedReference = [IO.Path]::GetFullPath((Join-Path $workspaceRoot 'workspace\research\references\deepseek-harness-v0.2.1-rc.3-readonly'))
$testRoot = [IO.Path]::GetFullPath((Join-Path $workspaceRoot 'workspace\testing\dsh-slot-patches\temp-runtimes'))
$runtimeRoot = [IO.Path]::GetFullPath((Join-Path $workspaceRoot 'workspace\runtime\tradeloom-harness'))
$releaseRoot = Join-Path $runtimeRoot 'releases'
$defaultPatchNames = @('ui-layout-shell-top.patch', 'reasoning-hidden.patch', 'desktop-identity.patch', 'desktop-host-lan.patch', 'desktop-business-csrf.patch', 'desktop-managed-update.patch', 'desktop-websocket-authority.patch', 'native-provider-ui-fix.patch', 'desktop-startup-account-free.patch', 'desktop-branding.patch', 'desktop-fatal-restart-in-place.patch', 'desktop-workspace-default-flat.patch', 'primary-runtime-windows-namespaced-python.patch', 'tradeloom-conversation-file-drafts.patch', 'question-composer-density.patch', 'owner-document-popout.patch', 'desktop-pane-popout.patch', 'composer-pane-density.patch', 'conversation-header-factory.patch', 'desktop-ai-web.patch')
$patchNames = $defaultPatchNames

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

function Test-SafeRelativeTarget([string]$RelativePath) {
  if ([string]::IsNullOrWhiteSpace($RelativePath) -or [IO.Path]::IsPathRooted($RelativePath) -or
    $RelativePath.Contains([char]92) -or $RelativePath.Contains([char]58)) { return $false }
  foreach ($segment in $RelativePath.Split('/')) {
    if ($segment -in @('', '.', '..') -or $segment.EndsWith('.') -or $segment.EndsWith(' ') -or
      $segment -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$' -or
      $segment -match '[<>:"|?*\x00-\x1f]') { return $false }
  }
  return $true
}

$overrideKeys = @('ProspectiveLockPath', 'PatchRootOverride', 'PatchOrderPath')
$suppliedOverrideKeys = @($overrideKeys | Where-Object { $PSBoundParameters.ContainsKey($_) })
$overrideCount = $suppliedOverrideKeys.Count
if ($overrideCount -ne 0 -and ($overrideCount -ne 3 -or
  [string]::IsNullOrWhiteSpace($ProspectiveLockPath) -or
  [string]::IsNullOrWhiteSpace($PatchRootOverride) -or
  [string]::IsNullOrWhiteSpace($PatchOrderPath))) {
  Write-Result @{ status = 'parameter_set_rejected'; message = 'ProspectiveLockPath、PatchRootOverride 与 PatchOrderPath 必须全省略或同时提供。'; targetCreated = $false } 21
}
$prospectiveLockMode = $overrideCount -eq 3
if ($prospectiveLockMode) {
  if (-not [IO.Path]::IsPathRooted($ProspectiveLockPath) -or -not [IO.Path]::IsPathRooted($PatchRootOverride) -or
    -not [IO.Path]::IsPathRooted($PatchOrderPath)) {
    Write-Result @{ status = 'prospective_path_rejected'; message = 'All prospective input paths must be absolute.'; targetCreated = $false } 21
  }
  $patchRoot = [IO.Path]::GetFullPath($PatchRootOverride)
  $lockPath = [IO.Path]::GetFullPath($ProspectiveLockPath)
  $patchOrderPathCanonical = [IO.Path]::GetFullPath($PatchOrderPath)
  $approvedPatchRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'integrations\dsh\patches'))
  $approvedProspectiveSets = @(
    @{ root = [IO.Path]::GetFullPath((Join-Path $workspaceRoot 'workspace\testing\frontend-visual-fixes-20261025\batch16-native-preflight\v2-24')); lockSha256 = '1f4834f8a84bfb733b967916cfd5fb5492afdeafae9d36bc737913b50bb6ee51'; orderSha256 = '783cc93af8aaaaa514f18a9017b5c5405ad0c1197addabe850c4609fe35cdda1' },
    @{ root = [IO.Path]::GetFullPath((Join-Path $workspaceRoot 'workspace\testing\frontend-visual-fixes-20261025\batch16-native-preflight\v3-25')); lockSha256 = '31c63c81bd4bf3adae868e0d6e173bf36b5c4c54e288f424c3dfd693bfab65bf'; orderSha256 = '4555a7185ef1b08b7584974c1e27879df5ec0db2789848ba9e017aa58933cadd' },
    @{ root = [IO.Path]::GetFullPath((Join-Path $workspaceRoot 'workspace\testing\frontend-visual-fixes-20261025\batch16-native-preflight\v4-26')); lockSha256 = '5e9e6180601e2b6231ce1c28aac02d17632fed6aad5a39094ec6af783cbc94c2'; orderSha256 = '3d880cebc6689e43c6ab596a441634affb156090efba6c420f76518217abeac4' },
    @{ root = [IO.Path]::GetFullPath((Join-Path $workspaceRoot 'workspace\testing\frontend-visual-fixes-20261025\batch46-menu-runtime-source\patch-set-27')); lockSha256 = '0376bad0288ff90a944fd94b90596328a73cfe449ccc2faf1fe2682b50c51c2f'; orderSha256 = 'e20f845702006c17bf2bce647a62567230f418b3fd0ab1e51e8b5ca678a5384b' },
    @{ root = [IO.Path]::GetFullPath((Join-Path $workspaceRoot 'workspace\testing\frontend-visual-fixes-20261025\batch66-native-runtime28\patch-set-28')); lockSha256 = '710c76095935fcc1844d29870cd201f1cf098f262f0ef30da6ab9aa5d242520c'; orderSha256 = '86585366b268fc7f2f8fa5589e36e7f73c7f9460affc9b14f0b745c8b04401db' },
    @{ root = [IO.Path]::GetFullPath((Join-Path $workspaceRoot 'workspace\testing\native-file-applications-policy-20261027\patch-set-29')); lockSha256 = 'f7c1e3a8cd79729695f48090daae03bfa929ee2477e0711cb635d3ba31932eb4'; orderSha256 = '8ed49e1ad1988da93f507377fbc5f8ad02ca15fad47282829480424cb589bd05' },
    @{ root = [IO.Path]::GetFullPath((Join-Path $workspaceRoot 'workspace\testing\native-file-applications-policy-20261027\patch-set-32')); lockSha256 = 'fbf76ea942fd87debcf89ff7e27fa559d86cdd0b90232663ab38e1558c81a9cb'; orderSha256 = 'e3ec3d709d902991f5fccf53435d8ed1bc4b83b0f573cb0c2b0dba1a317243ff' },
    @{ root = [IO.Path]::GetFullPath((Join-Path $workspaceRoot 'workspace\testing\native-file-applications-policy-20261027\patch-set-33')); lockSha256 = '19cde34c354166c17f8997acba20c76452ae2d1c9fd7c5b96118ed486b6ac874'; orderSha256 = 'a465752afb9ee874e98f3e0123bfa01ed36bae9041124e2fd9acbe995f0c565c' },
    @{ root = [IO.Path]::GetFullPath((Join-Path $workspaceRoot 'workspace\testing\desktop24-exit-fix-build-20261027\patch-set-33-exit')); lockSha256 = '848409e5579e83d3760e07b0975f5a2dae3d4b09b4b856eedd0a64a383b2c94c'; orderSha256 = 'a465752afb9ee874e98f3e0123bfa01ed36bae9041124e2fd9acbe995f0c565c' },
    @{ root = [IO.Path]::GetFullPath((Join-Path $repoRoot 'integrations\dsh\prospective\desktop24-exit')); lockSha256 = '848409e5579e83d3760e07b0975f5a2dae3d4b09b4b856eedd0a64a383b2c94c'; orderSha256 = 'a465752afb9ee874e98f3e0123bfa01ed36bae9041124e2fd9acbe995f0c565c' }
  )
  $selectedProspectiveSet = $null
  foreach ($candidateSet in $approvedProspectiveSets) {
    if ($lockPath.Equals((Join-Path $candidateSet.root 'patches.prospective.lock.json'), [StringComparison]::OrdinalIgnoreCase) -and
      $patchOrderPathCanonical.Equals((Join-Path $candidateSet.root 'order.prospective.json'), [StringComparison]::OrdinalIgnoreCase)) {
      $selectedProspectiveSet = $candidateSet
      break
    }
  }
  $approvedForSet = if ($null -ne $selectedProspectiveSet -and $selectedProspectiveSet.root.Equals([IO.Path]::GetFullPath((Join-Path $repoRoot 'integrations\dsh\prospective\desktop24-exit')), [StringComparison]::OrdinalIgnoreCase)) { Join-Path $selectedProspectiveSet.root 'patches' } else { $approvedPatchRoot }
  if (-not $patchRoot.Equals($approvedForSet, [StringComparison]::OrdinalIgnoreCase) -or
    $null -eq $selectedProspectiveSet -or
    -not (Test-NoReparseAncestors $patchRoot) -or -not (Test-NoReparseAncestors $lockPath) -or
    -not (Test-NoReparseAncestors $patchOrderPathCanonical)) {
    Write-Result @{ status = 'prospective_path_rejected'; message = 'Prospective inputs must be the approved lock/order and repository patch root with ordinary path ancestors.'; targetCreated = $false } 21
  }
  if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf) -or -not (Test-Path -LiteralPath $patchOrderPathCanonical -PathType Leaf)) {
    Write-Result @{ status = 'prospective_input_missing'; targetCreated = $false } 24
  }
  $prospectiveLockHash = (Get-FileHash -LiteralPath $lockPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $prospectiveOrderHash = (Get-FileHash -LiteralPath $patchOrderPathCanonical -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($prospectiveLockHash -ne $selectedProspectiveSet.lockSha256 -or
    $prospectiveOrderHash -ne $selectedProspectiveSet.orderSha256) {
    Write-Result @{ status = 'prospective_digest_rejected'; targetCreated = $false } 24
  }
  try {
    $lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
    $orderDocument = Get-Content -LiteralPath $patchOrderPathCanonical -Raw | ConvertFrom-Json
    $patchNames = @($orderDocument.order | ForEach-Object { [string]$_ })
  } catch {
    Write-Result @{ status = 'prospective_input_invalid'; targetCreated = $false } 24
  }
  $lockedPatchNames = @($lock.patches.PSObject.Properties.Name)
  if ($patchNames.Count -eq 0 -or $patchNames.Count -ne $lockedPatchNames.Count -or
    @($patchNames | Select-Object -Unique).Count -ne $patchNames.Count -or
    @($patchNames | Where-Object { $_ -notmatch '^[A-Za-z0-9._-]+\.patch$' }).Count -gt 0 -or
    @($lockedPatchNames | Where-Object { $_ -notin $patchNames }).Count -gt 0 -or
    @($patchNames | Where-Object { $_ -notin $lockedPatchNames }).Count -gt 0) {
    Write-Result @{ status = 'prospective_order_rejected'; targetCreated = $false } 24
  }
  if ($lock.upstream.commit -ne '1f81c047fc48fa190a683e469daa699857e9afe8' -or
    $lock.upstream.licenseSha256 -ne 'EBB4F09972AEE8608BE255DEBAF78451A68E95C290F55C240DEC2ECFA16EA6BE') {
    Write-Result @{ status = 'prospective_source_rejected'; targetCreated = $false } 22
  }
} else {
  $patchOrderPathCanonical = $null
  $lock = $null
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

$lock = if ($prospectiveLockMode) { $lock } else { Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json }
if (-not $prospectiveLockMode -and (@($lock.patches.PSObject.Properties.Name | Where-Object { $_ -notin $patchNames }).Count -gt 0 -or
  @($patchNames | Where-Object { $_ -notin @($lock.patches.PSObject.Properties.Name) }).Count -gt 0)) {
  Write-Result @{ status = 'default_order_mismatch'; targetCreated = $false } 24
}
foreach ($relativePath in $lock.targetFiles.PSObject.Properties.Name) {
  if (-not (Test-SafeRelativeTarget ([string]$relativePath))) {
    Write-Result @{ status = 'unsafe_target_path'; file = $relativePath; targetCreated = $false } 24
  }
}
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
