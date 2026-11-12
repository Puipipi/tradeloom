param(
    [Parameter(Mandatory=$true)][string]$Path,
    [Parameter(Mandatory=$true)][string]$RecipePath
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$recipe = Get-Content -LiteralPath $RecipePath -Raw -Encoding UTF8 | ConvertFrom-Json
$expected = $recipe.acquisition.publisherSubject
if ([string]::IsNullOrEmpty($expected)) { throw 'Reviewed publisher subject missing.' }
$signature = Get-AuthenticodeSignature -LiteralPath $Path -ErrorAction Stop
$subject = if ($null -ne $signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null }
$publisherExact = [string]::Equals($subject, $expected, [StringComparison]::Ordinal)
[pscustomobject]@{
    status = $signature.Status.ToString()
    subject = $subject
    issuer = if ($null -ne $signature.SignerCertificate) { $signature.SignerCertificate.Issuer } else { $null }
    thumbprint = if ($null -ne $signature.SignerCertificate) { $signature.SignerCertificate.Thumbprint } else { $null }
    publisherExact = $publisherExact
} | ConvertTo-Json -Compress
if ($signature.Status -ne 'Valid' -or -not $publisherExact) { throw 'Official Authenticode/publisher verification failed.' }
