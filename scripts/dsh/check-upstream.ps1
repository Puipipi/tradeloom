[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$RuntimePath,
  [Parameter()][string]$CandidateRef
)

$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$patchRoot = Join-Path $repoRoot 'integrations\dsh\patches'
$lockPath = Join-Path $patchRoot 'patches.lock.json'
$workspaceRoot = Split-Path -Parent $repoRoot
$runtimeRoot = [IO.Path]::GetFullPath((Join-Path $workspaceRoot 'workspace\runtime\tradeloom-harness'))
$releaseRoot = Join-Path $runtimeRoot 'releases'
$testRoot = [IO.Path]::GetFullPath((Join-Path $workspaceRoot 'workspace\testing\dsh-slot-patches\temp-runtimes'))
$patchNames = @('ui-layout-shell-top.patch', 'ui-sidebar-agents.patch', 'reasoning-hidden.patch', 'desktop-identity.patch', 'desktop-host-lan.patch', 'desktop-business-csrf.patch', 'desktop-managed-update.patch', 'desktop-websocket-authority.patch', 'native-provider-ui-fix.patch', 'desktop-startup-account-free.patch', 'desktop-branding.patch')
$patchedFiles = @(
  'packages/client/ui-layout/src/client/index.ts',
  'packages/client/ui-layout/src/client/AppFrame.tsx',
  'packages/client/ui-sidebar/src/client/contract/slots.ts',
  'packages/client/ui-sidebar/src/client/index.ts',
  'packages/client/ui-sidebar/src/client/SidebarRoot.tsx',
  'packages/client/ui-sidebar/tests/__snapshots__/sidebar-snapshot.client.spec.tsx.snap',
  'packages/client/ui-sidebar/tests/sidebar-root.client.spec.tsx',
  'packages/client/ui-chat/src/client/chat/ReasoningRow.tsx',
  'packages/client/ui-chat/src/client/presentation-policy.ts',
  'packages/client/ui-chat/tests/presentation-policy.client.spec.tsx',
  'packages/client/ui-chat/tests/reasoning-row.client.spec.tsx',
  'apps/desktop/scripts/electron-builder-config.mjs',
  'apps/desktop/scripts/desktop-package-environment.mjs',
  'apps/desktop/scripts/desktop-package-environment.d.mts',
  'apps/desktop/scripts/package-target.ts',
  'apps/desktop/scripts/desktop-build-paths.mjs',
  'apps/desktop/scripts/desktop-build-paths.d.mts',
  'apps/desktop/scripts/smoke-packaged-runtime.ts',
  'apps/desktop/src/main.ts',
  'apps/desktop/src/locale.ts',
  'apps/desktop/renderer/assets/welcome-brand.svg',
  'apps/desktop/resources/icon-windows.png',
  'apps/desktop/resources/icon-windows.svg',
  'apps/desktop/resources/tray-windows.ico',
  'apps/desktop/installer/assets/brand.png',
  'apps/desktop/installer/assets/brand-2x.png',
  'apps/desktop/installer/assets/brand-dark.png',
  'apps/desktop/installer/assets/brand-dark-2x.png',
  'apps/desktop/installer/assets/uninstaller-sidebar.png',
  'apps/desktop-host/src/index.ts',
  'apps/desktop/src/web-document.ts',
  'apps/desktop/tests/web-document.spec.ts',
  'apps/desktop/tests/desktop-package-environment.spec.ts',
  'apps/desktop/tests/desktop-build-paths.spec.ts',
  'apps/desktop/tests/main-startup.spec.ts',
  'apps/desktop/tests/expected/about-panel.json',
  'apps/desktop/tests/expected/application-menu-en-US.json',
  'apps/desktop/tests/expected/application-menu-zh-CN.json',
  'apps/web/index.html',
  'apps/web/public/manifest.webmanifest',
  'apps/web/public/favicon.svg',
  'apps/web/public/favicon-dark.svg',
  'packages/client/ui-conversation/src/client/locales.ts',
  'apps/desktop/src/update-coordinator.ts',
  'packages/client/ui-settings-models/src/client/CustomProviderCard.tsx',
  'packages/client/ui-settings-models/src/client/ProviderEditor.tsx',
  'packages/client/ui-settings-models/src/client/locales.ts',
  'packages/client/ui-settings-models/tests/provider-form.client.spec.tsx'
)
$generatedPatchFiles = @('apps/desktop/src/websocket-authority.ts', 'apps/desktop/tests/websocket-authority.spec.ts', 'apps/desktop/tests/desktop-installer-include.spec.ts')

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
  $output = & git -C $WorkingDirectory @Arguments 2>&1
  $code = $LASTEXITCODE
  if ($code -ne 0) { throw "git $($Arguments -join ' ') failed ($code): $($output -join ' ')" }
  return (($output | ForEach-Object { [string]$_ }) -join "`n").Trim()
}

function Test-PatchSet([string]$SourceDirectory, [bool]$Reverse) {
  $conflicts = @()
  $requiredFiles = @($patchedFiles)
  if ($Reverse) { $requiredFiles += $generatedPatchFiles }
  foreach ($relativePath in $requiredFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $SourceDirectory $relativePath) -PathType Leaf)) {
      $conflicts += [ordered]@{ patch = 'patch-set'; file = $relativePath; details = @('Required patch target is absent from source snapshot.') }
    }
  }
  if ($conflicts.Count -gt 0) { return ,$conflicts }
  foreach ($name in $patchNames) {
    $patch = Join-Path $patchRoot $name
    $gitArgs = @('-C', $SourceDirectory, 'apply', '--check')
    if ($Reverse) { $gitArgs += '--reverse' }
    $gitArgs += $patch
    $output = & git @gitArgs 2>&1
    if ($LASTEXITCODE -ne 0) {
      $conflicts += [ordered]@{ patch = $name; details = @($output | ForEach-Object { [string]$_ }) }
    }
  }
  return ,$conflicts
}

$runtimeInput = [IO.Path]::GetFullPath($RuntimePath)
$runtimeInputSafe = Test-NoReparseAncestors $runtimeInput
$runtime = Resolve-CanonicalPath $RuntimePath
$runtimeRootCanonical = Resolve-CanonicalPath $runtimeRoot
$testRootCanonical = Resolve-CanonicalPath $testRoot
$releaseRootCanonical = Resolve-CanonicalPath $releaseRoot
$isVersionedRelease = (Split-Path -Parent $runtime).Equals($releaseRootCanonical, [StringComparison]::OrdinalIgnoreCase)
$allowedRuntime = $isVersionedRelease -or (Test-Under $runtime $testRootCanonical)
if (-not $allowedRuntime -or -not $runtimeInputSafe -or -not (Test-NoReparseAncestors $runtime) -or -not (Test-NoReparseAncestors $testRootCanonical)) {
  Write-Result @{ status = 'path_rejected'; runtimePath = $runtime; message = 'Runtime must be the app-owned runtime or a task test fixture.' } 21
}
if (-not (Test-Path -LiteralPath $runtime -PathType Container) -or -not (Test-Path -LiteralPath (Join-Path $runtime '.git'))) {
  Write-Result @{ status = 'runtime_missing'; runtimePath = $runtime } 20
}
if (-not (Test-Path -LiteralPath $lockPath)) { Write-Result @{ status = 'lock_missing'; lockPath = $lockPath } 24 }
$lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
foreach ($name in $patchNames) {
  $patch = Join-Path $patchRoot $name
  if (-not (Test-Path -LiteralPath $patch)) { Write-Result @{ status = 'patch_missing'; patch = $name } 24 }
  $actualHash = (Get-FileHash -LiteralPath $patch -Algorithm SHA256).Hash
  if ($actualHash -ne $lock.patches.$name) { Write-Result @{ status = 'patch_hash_mismatch'; patch = $name; expected = $lock.patches.$name; actual = $actualHash } 24 }
}

$pinnedHead = [string]$lock.upstream.commit
if (-not $CandidateRef) {
  $head = Invoke-Git $runtime @('rev-parse', 'HEAD')
  if ($head -ne $pinnedHead) {
    Write-Result @{ status = 'source_head_mismatch'; expected = $pinnedHead; actual = $head; conflicts = @() } 32
  }
  $licensePath = Join-Path $runtime 'LICENSE'
  $licenseHash = if (Test-Path -LiteralPath $licensePath) { (Get-FileHash -LiteralPath $licensePath -Algorithm SHA256).Hash } else { $null }
  if ($licenseHash -ne $lock.upstream.licenseSha256) {
    Write-Result @{ status = 'license_mismatch'; expected = $lock.upstream.licenseSha256; actual = $licenseHash; conflicts = @() } 33
  }
  $conflicts = Test-PatchSet $runtime $true
  if ($conflicts.Count -gt 0) {
    Write-Result @{ status = 'patch_conflict'; sourceCommit = $head; conflicts = $conflicts; targetMutated = $false } 30
  }
  foreach ($relativePath in $lock.targetFiles.PSObject.Properties.Name) {
    $target = Join-Path $runtime $relativePath
    $actualHash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne [string]$lock.targetFiles.$relativePath.newSha256) {
      Write-Result @{ status = 'patch_target_hash_mismatch'; sourceCommit = $head; file = $relativePath; expected = $lock.targetFiles.$relativePath.newSha256; actual = $actualHash; targetMutated = $false } 36
    }
  }
  Write-Result @{ status = 'compatible'; sourceCommit = $head; licenseSha256 = $licenseHash; patchesApplied = $patchNames; targetMutated = $false } 0
}

try {
  $candidate = Invoke-Git $runtime @('rev-parse', '--verify', "$CandidateRef^{commit}")
} catch {
  Write-Result @{ status = 'candidate_ref_invalid'; candidateRef = $CandidateRef; message = $_.Exception.Message; targetMutated = $false } 34
}
$ancestorOutput = & git -C $runtime merge-base --is-ancestor $pinnedHead $candidate 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Result @{ status = 'candidate_ref_invalid'; candidateRef = $CandidateRef; candidateCommit = $candidate; message = 'Candidate must descend from the pinned upstream commit.'; targetMutated = $false } 34
}

if (-not (Test-Path -LiteralPath $testRootCanonical)) { New-Item -ItemType Directory -Path $testRootCanonical -Force | Out-Null }
$scratch = Join-Path $testRootCanonical ('candidate-' + [guid]::NewGuid().ToString('N'))
$archive = Join-Path $testRootCanonical ('dsh-candidate-' + [guid]::NewGuid().ToString('N') + '.zip')
try {
  if (-not (Test-NoReparseAncestors $scratch) -or -not (Test-NoReparseAncestors $archive)) {
    Write-Result @{ status = 'path_rejected'; candidateRef = $CandidateRef; message = 'Candidate scratch path has a reparse-point ancestor.'; targetMutated = $false } 21
  }
  $archiveArgs = @('-C', $runtime, 'archive', '--format=zip', "--output=$archive", $candidate, 'LICENSE') + $patchedFiles
  $archiveOutput = & git @archiveArgs 2>&1
  if ($LASTEXITCODE -ne 0) { throw "git archive failed ($LASTEXITCODE): $($archiveOutput -join ' ')" }
  New-Item -ItemType Directory -Path $scratch | Out-Null
  Expand-Archive -LiteralPath $archive -DestinationPath $scratch
  & git -C $scratch init --quiet
  if ($LASTEXITCODE -ne 0) { throw 'Unable to initialize isolated candidate fixture repository.' }
  & git -C $scratch config core.autocrlf false
  if ($LASTEXITCODE -ne 0) { throw 'Unable to set candidate fixture line-ending policy.' }
  $candidateLicensePath = Join-Path $scratch 'LICENSE'
  $candidateLicenseHash = if (Test-Path -LiteralPath $candidateLicensePath) { (Get-FileHash -LiteralPath $candidateLicensePath -Algorithm SHA256).Hash } else { $null }
  if ($candidateLicenseHash -ne $lock.upstream.licenseSha256) {
    Write-Result @{ status = 'candidate_conflict'; candidateRef = $CandidateRef; candidateCommit = $candidate; conflicts = @(@{ file = 'LICENSE'; expectedSha256 = $lock.upstream.licenseSha256; actualSha256 = $candidateLicenseHash }); targetMutated = $false } 31
  }
  & git -C $scratch add -- LICENSE @patchedFiles
  if ($LASTEXITCODE -ne 0) { throw 'Unable to index candidate patch targets for an exact apply check.' }
  $conflicts = Test-PatchSet $scratch $false
  if ($conflicts.Count -gt 0) {
    Write-Result @{ status = 'candidate_conflict'; candidateRef = $CandidateRef; candidateCommit = $candidate; conflicts = $conflicts; targetMutated = $false } 31
  }
  Write-Result @{ status = 'compatible'; candidateRef = $CandidateRef; candidateCommit = $candidate; licenseSha256 = $candidateLicenseHash; patches = $patchNames; targetMutated = $false } 0
} catch {
  Write-Result @{ status = 'candidate_check_failed'; candidateRef = $CandidateRef; candidateCommit = $candidate; message = $_.Exception.Message; targetMutated = $false } 35
} finally {
  if (Test-Path -LiteralPath $scratch) {
    if ((Test-NoReparseAncestors $scratch) -and (Test-NoReparseAncestors $testRootCanonical)) {
      $resolvedScratch = Resolve-CanonicalPath $scratch
      $safePrefix = $testRootCanonical.TrimEnd('\') + '\candidate-'
      if ((Test-NoReparseAncestors $resolvedScratch) -and $resolvedScratch.StartsWith($safePrefix, [StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $resolvedScratch -Recurse -Force }
    }
  }
  if (Test-Path -LiteralPath $archive) {
    if ((Test-NoReparseAncestors $archive) -and (Test-NoReparseAncestors $testRootCanonical)) {
      $resolvedArchive = Resolve-CanonicalPath $archive
      $safeArchivePrefix = $testRootCanonical.TrimEnd('\') + '\dsh-candidate-'
      if ((Test-NoReparseAncestors $resolvedArchive) -and $resolvedArchive.StartsWith($safeArchivePrefix, [StringComparison]::OrdinalIgnoreCase) -and $resolvedArchive.EndsWith('.zip', [StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $resolvedArchive -Force }
    }
  }
}
