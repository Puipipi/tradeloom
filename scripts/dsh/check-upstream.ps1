[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$RuntimePath,
  [Parameter()][string]$CandidateRef,
  [Parameter()][string]$ProspectiveLockPath,
  [Parameter()][Alias('PatchRoot')][string]$PatchRootOverride,
  [Parameter()][Alias('PatchOrder')][string]$PatchOrderPath
)

$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$patchRoot = Join-Path $repoRoot 'integrations\dsh\patches'
$lockPath = Join-Path $patchRoot 'patches.lock.json'
$workspaceRoot = Split-Path -Parent $repoRoot
$runtimeRoot = [IO.Path]::GetFullPath((Join-Path $workspaceRoot 'workspace\runtime\tradeloom-harness'))
$releaseRoot = Join-Path $runtimeRoot 'releases'
$testRoot = [IO.Path]::GetFullPath((Join-Path $workspaceRoot 'workspace\testing\dsh-slot-patches\temp-runtimes'))
$defaultPatchNames = @('ui-layout-shell-top.patch', 'reasoning-hidden.patch', 'desktop-identity.patch', 'desktop-host-lan.patch', 'desktop-business-csrf.patch', 'desktop-managed-update.patch', 'desktop-websocket-authority.patch', 'native-provider-ui-fix.patch', 'desktop-startup-account-free.patch', 'desktop-branding.patch', 'desktop-fatal-restart-in-place.patch', 'desktop-workspace-default-flat.patch', 'primary-runtime-windows-namespaced-python.patch', 'tradeloom-conversation-file-drafts.patch', 'question-composer-density.patch', 'owner-document-popout.patch', 'desktop-pane-popout.patch', 'composer-pane-density.patch', 'conversation-header-factory.patch', 'desktop-ai-web.patch')
$patchNames = $defaultPatchNames
$patchedFiles = @(
  'packages/client/ui-layout/src/client/index.ts',
  'packages/client/ui-layout/src/client/AppFrame.tsx',
  'packages/client/ui-chat/src/client/chat/ReasoningRow.tsx',
  'packages/client/ui-chat/src/client/presentation-policy.ts',
  'packages/client/ui-chat/tests/presentation-policy.client.spec.tsx',
  'packages/client/ui-chat/tests/reasoning-row.client.spec.tsx',
  'apps/desktop/scripts/electron-builder-config.mjs',
  'apps/desktop/scripts/desktop-package-environment.mjs',
  'apps/desktop/scripts/desktop-package-environment.d.mts',
  'scripts/client-build-environment.ts',
  'scripts/client-build-environment.client.spec.ts',
  'apps/desktop/scripts/package-target.ts',
  'apps/desktop/scripts/desktop-build-paths.mjs',
  'apps/desktop/scripts/desktop-build-paths.d.mts',
  'apps/desktop/scripts/smoke-packaged-runtime.ts',
  'apps/desktop/package.json',
  'apps/desktop/src/main.ts',
  'apps/desktop/src/fatal-recovery.ts',
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
  'apps/desktop/tests/fatal-recovery.spec.ts',
  'apps/desktop/tests/expected/about-panel.json',
  'apps/desktop/tests/expected/application-menu-en-US.json',
  'apps/desktop/tests/expected/application-menu-zh-CN.json',
  'apps/desktop/tests/expected/fatal-address-in-use-en.txt',
  'apps/desktop/tests/expected/fatal-address-in-use-zh-CN.txt',
  'apps/desktop/tests/expected/fatal-dialog-en.txt',
  'apps/desktop/tests/expected/fatal-dialog-zh-CN.txt',
  'apps/desktop/tests/expected/fatal-dialog-with-report-en.txt',
  'apps/desktop/tests/expected/fatal-dialog-with-report-zh-CN.txt',
  'apps/desktop/src/browser-guests.ts',
  'apps/desktop/src/ipc.ts',
  'apps/desktop/src/preload-app.ts',
  'apps/web/index.html',
  'apps/web/public/manifest.webmanifest',
  'apps/web/public/favicon.svg',
  'apps/web/public/favicon-dark.svg',
  'packages/client/ui-conversation/src/client/locales.ts',
  'apps/desktop/src/update-coordinator.ts',
  'packages/client/ui-settings-models/src/client/CustomProviderCard.tsx',
  'packages/client/ui-settings-models/src/client/ProviderEditor.tsx',
  'packages/client/ui-settings-models/src/client/locales.ts',
  'packages/client/ui-settings-models/tests/provider-form.client.spec.tsx',
  'packages/client/ui-workspace/src/client/stores.ts',
  'packages/client/ui-workspace/tests/tree.client.spec.ts',
  'packages/client/ui-workspace/tests/workspace-browser.client.spec.tsx',
  'packages/client/ui-conversation/src/client/service.ts',
  'packages/client/ui-conversation/tests/service-orchestration.client.spec.ts',
  'packages/client/ui-conversation/README.md',
  'packages/client/ui-conversation/README.zh.md',
  'packages/client/ui-attachment/src/client/ComposerAttachments.tsx',
  'packages/client/ui-attachment/src/client/drop-events.ts',
  'packages/client/ui-attachment/tests/composer-attachments.client.spec.tsx',
  'packages/client/ui-conversation/src/client/contract/slots.ts',
  'packages/client/ui-conversation/src/client/apply.ts',
  'packages/client/ui-conversation/src/client/skeleton/ConversationHeader.tsx',
  'packages/client/ui-conversation/tests/apply-wiring.client.spec.tsx',
  'packages/client/ui-conversation/src/client/input/editor/ComposerContentEditable.tsx',
  'packages/client/ui-conversation/src/client/input/editor/view-binding.ts',
  'packages/client/ui-conversation/src/client/skeleton/InputBar.tsx',
  'packages/client/ui-primitives/src/HoverCard.tsx',
  'packages/client/ui-primitives/src/HoverCardGroup.tsx',
  'packages/client/ui-primitives/src/Menu.tsx',
  'packages/client/ui-primitives/src/MenuSurface.tsx',
  'packages/client/ui-primitives/src/Tooltip.tsx',
  'packages/client/ui-primitives/src/useDismissOnOutsidePointer.ts',
  'packages/client/ui-user-questions/src/client/QuestionComposer.module.css',
  'packages/client/ui-primitives/src/Button.module.css',
  'packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css',
  'packages/client/ui-conversation/src/client/skeleton/InputBar.module.css',
  'scripts/primary-runtime/prepare.ts'
)
$generatedPatchFiles = @('apps/desktop/src/websocket-authority.ts', 'apps/desktop/tests/websocket-authority.spec.ts', 'apps/desktop/tests/desktop-installer-include.spec.ts', 'packages/client/ui-conversation/tests/secondary-window-owner-document.client.spec.tsx', 'packages/client/ui-primitives/src/owner-document.ts', 'packages/client/ui-primitives/tests/secondary-window.client.spec.tsx')

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
  Write-Result @{ status = 'parameter_set_rejected'; message = 'ProspectiveLockPath、PatchRootOverride 与 PatchOrderPath 必须全省略或同时提供。'; targetMutated = $false } 21
}
$prospectiveLockMode = $overrideCount -eq 3
if ($prospectiveLockMode) {
  if (-not [IO.Path]::IsPathRooted($ProspectiveLockPath) -or -not [IO.Path]::IsPathRooted($PatchRootOverride) -or
    -not [IO.Path]::IsPathRooted($PatchOrderPath)) {
    Write-Result @{ status = 'prospective_path_rejected'; message = 'All prospective input paths must be absolute.'; targetMutated = $false } 21
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
    Write-Result @{ status = 'prospective_path_rejected'; message = 'Prospective inputs must be the approved lock/order and repository patch root with ordinary path ancestors.'; targetMutated = $false } 21
  }
  if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf) -or -not (Test-Path -LiteralPath $patchOrderPathCanonical -PathType Leaf)) {
    Write-Result @{ status = 'prospective_input_missing'; targetMutated = $false } 24
  }
  if ((Get-FileHash -LiteralPath $lockPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $selectedProspectiveSet.lockSha256 -or
    (Get-FileHash -LiteralPath $patchOrderPathCanonical -Algorithm SHA256).Hash.ToLowerInvariant() -ne $selectedProspectiveSet.orderSha256) {
    Write-Result @{ status = 'prospective_digest_rejected'; targetMutated = $false } 24
  }
  try {
    $lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
    $orderDocument = Get-Content -LiteralPath $patchOrderPathCanonical -Raw | ConvertFrom-Json
    $patchNames = @($orderDocument.order | ForEach-Object { [string]$_ })
  } catch {
    Write-Result @{ status = 'prospective_input_invalid'; targetMutated = $false } 24
  }
  $lockedPatchNames = @($lock.patches.PSObject.Properties.Name)
  if ($patchNames.Count -eq 0 -or $patchNames.Count -ne $lockedPatchNames.Count -or
    @($patchNames | Select-Object -Unique).Count -ne $patchNames.Count -or
    @($patchNames | Where-Object { $_ -notmatch '^[A-Za-z0-9._-]+\.patch$' }).Count -gt 0 -or
    @($lockedPatchNames | Where-Object { $_ -notin $patchNames }).Count -gt 0 -or
    @($patchNames | Where-Object { $_ -notin $lockedPatchNames }).Count -gt 0) {
    Write-Result @{ status = 'prospective_order_rejected'; targetMutated = $false } 24
  }
  if ($lock.upstream.commit -ne '1f81c047fc48fa190a683e469daa699857e9afe8' -or
    $lock.upstream.licenseSha256 -ne 'EBB4F09972AEE8608BE255DEBAF78451A68E95C290F55C240DEC2ECFA16EA6BE') {
    Write-Result @{ status = 'prospective_source_rejected'; targetMutated = $false } 22
  }
  $patchedFiles = @($lock.targetFiles.PSObject.Properties.Name)
  foreach ($relativePath in $patchedFiles) {
    if (-not (Test-SafeRelativeTarget ([string]$relativePath))) {
      Write-Result @{ status = 'unsafe_target_path'; file = $relativePath; targetMutated = $false } 24
    }
  }
  $generatedPatchFiles = @()
  foreach ($name in $patchNames) {
    $patchContent = [IO.File]::ReadAllText((Join-Path $patchRoot $name))
    foreach ($section in [regex]::Split($patchContent, '(?m)(?=^diff --git )')) {
      if ($section -match '(?m)^diff --git a/\S+ b/(\S+)\r?$') {
        $addedTarget = $Matches[1]
        if ($section -match '(?m)^new file mode ') { $generatedPatchFiles += $addedTarget }
      }
    }
  }
  $generatedPatchFiles = @($generatedPatchFiles | Select-Object -Unique)
  $expectedGeneratedPatchCount = if ((Split-Path -Leaf $selectedProspectiveSet.root) -in @('patch-set-28', 'patch-set-29', 'patch-set-32', 'patch-set-33', 'patch-set-33-exit', 'desktop24-exit')) { 12 } elseif ((Split-Path -Leaf $selectedProspectiveSet.root) -in @('v4-26', 'patch-set-27')) { 10 } else { 9 }
  if ($generatedPatchFiles.Count -ne $expectedGeneratedPatchCount) {
    Write-Result @{ status = 'generated_target_set_rejected'; targetMutated = $false } 24
  }
  if (@($generatedPatchFiles | Where-Object { -not (Test-SafeRelativeTarget ([string]$_)) -or $_ -in $patchedFiles }).Count -gt 0) {
    Write-Result @{ status = 'generated_target_rejected'; targetMutated = $false } 24
  }
} else {
  $patchOrderPathCanonical = $null
}

function Test-PatchSet([string]$SourceDirectory, [bool]$Reverse, [bool]$ValidatePinnedTargets = $true) {
  $conflicts = @()
  $requiredFiles = @($patchedFiles)
  if ($Reverse) { $requiredFiles += $generatedPatchFiles }
  foreach ($relativePath in $requiredFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $SourceDirectory $relativePath) -PathType Leaf)) {
      $conflicts += [ordered]@{ patch = 'patch-set'; file = $relativePath; details = @('Required patch target is absent from source snapshot.') }
    }
  }
  if ($conflicts.Count -gt 0) { return ,$conflicts }

  $orderedNames = @($patchNames)
  $checkDirectory = $SourceDirectory
  $temporaryReverseRoot = $null
  if ($Reverse) {
    [Array]::Reverse($orderedNames)
    if (-not (Test-Path -LiteralPath $testRootCanonical)) { New-Item -ItemType Directory -Path $testRootCanonical -Force | Out-Null }
    $temporaryReverseRoot = Join-Path $testRootCanonical ('reverse-' + [guid]::NewGuid().ToString('N'))
    if (-not (Test-NoReparseAncestors $temporaryReverseRoot)) {
      return ,@([ordered]@{ patch = 'patch-set'; details = @('Reverse check scratch path has a reparse-point ancestor.') })
    }
    New-Item -ItemType Directory -Path $temporaryReverseRoot | Out-Null
    $checkDirectory = $temporaryReverseRoot
    foreach ($relativePath in $requiredFiles) {
      $sourcePath = Join-Path $SourceDirectory $relativePath
      $destinationPath = Join-Path $checkDirectory $relativePath
      $destinationParent = Split-Path -Parent $destinationPath
      if (-not (Test-Path -LiteralPath $destinationParent)) { New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null }
      Copy-Item -LiteralPath $sourcePath -Destination $destinationPath
    }
    & git -C $checkDirectory init --quiet
    if ($LASTEXITCODE -ne 0) { return ,@([ordered]@{ patch = 'patch-set'; details = @('Unable to initialize isolated reverse-check fixture.') }) }
    & git -C $checkDirectory config core.autocrlf false
    if ($LASTEXITCODE -ne 0) { return ,@([ordered]@{ patch = 'patch-set'; details = @('Unable to set reverse-check line-ending policy.') }) }
    & git -C $checkDirectory add -- @requiredFiles
    if ($LASTEXITCODE -ne 0) { return ,@([ordered]@{ patch = 'patch-set'; details = @('Unable to index isolated reverse-check targets.') }) }
  }

  try {
    foreach ($name in $orderedNames) {
      $patch = Join-Path $patchRoot $name
      $gitArgs = @('-C', $checkDirectory, 'apply', '--check')
      if ($Reverse) { $gitArgs += '--reverse' }
      $gitArgs += $patch
      $output = & git @gitArgs 2>&1
      if ($LASTEXITCODE -ne 0) {
        $conflicts += [ordered]@{ patch = $name; details = @($output | ForEach-Object { [string]$_ }) }
        break
      }
      $applyArgs = @('-C', $checkDirectory, 'apply')
      if ($Reverse) { $applyArgs += '--reverse' }
      $applyArgs += $patch
      $output = & git @applyArgs 2>&1
      if ($LASTEXITCODE -ne 0) {
        $conflicts += [ordered]@{ patch = $name; details = @($output | ForEach-Object { [string]$_ }) }
        break
      }
    }

    if ($conflicts.Count -eq 0 -and $ValidatePinnedTargets) {
      foreach ($property in $lock.targetFiles.PSObject.Properties) {
        $target = Join-Path $checkDirectory $property.Name
        $expected = if ($Reverse) { [string]$property.Value.baseSha256 } else { [string]$property.Value.newSha256 }
        $actual = if (Test-Path -LiteralPath $target -PathType Leaf) { (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() } else { $null }
        if ($actual -ne $expected) {
          $conflicts += [ordered]@{ patch = 'patch-set'; file = $property.Name; details = @("Target SHA-256 mismatch after ordered patch application; expected $expected, found $actual.") }
          break
        }
      }
    }
    if ($conflicts.Count -eq 0) {
      foreach ($relativePath in $generatedPatchFiles) {
        $target = Join-Path $checkDirectory $relativePath
        $exists = Test-Path -LiteralPath $target -PathType Leaf
        if (($Reverse -and $exists) -or (-not $Reverse -and -not $exists)) {
          $conflicts += [ordered]@{ patch = 'patch-set'; file = $relativePath; details = @('Generated patch target does not match the expected ordered patch-set state.') }
          break
        }
      }
    }
    return ,$conflicts
  } finally {
    if ($temporaryReverseRoot -and (Test-Path -LiteralPath $temporaryReverseRoot)) {
      $resolvedScratch = Resolve-CanonicalPath $temporaryReverseRoot
      $safePrefix = $testRootCanonical.TrimEnd('\') + '\reverse-'
      if ((Test-NoReparseAncestors $resolvedScratch) -and (Test-NoReparseAncestors $testRootCanonical) -and $resolvedScratch.StartsWith($safePrefix, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $resolvedScratch -Recurse -Force
      }
    }
  }
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
if (-not $prospectiveLockMode -and (@($lock.patches.PSObject.Properties.Name | Where-Object { $_ -notin $patchNames }).Count -gt 0 -or
  @($patchNames | Where-Object { $_ -notin @($lock.patches.PSObject.Properties.Name) }).Count -gt 0)) {
  Write-Result @{ status = 'default_order_mismatch'; targetMutated = $false } 24
}
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
  $conflicts = Test-PatchSet $scratch $false $false
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
