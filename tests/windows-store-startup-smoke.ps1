param(
  [Parameter(Mandatory = $true)]
  [string]$ReleaseDirectory
)

$ErrorActionPreference = 'Stop'
# This test installs a temporary signing certificate and package on a disposable
# runner. Never alter a developer's installed Store app or certificate store.
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Run this test only on a disposable GitHub Actions Windows runner.' }
$identity = '78707CBF.LingxiWorkspace'
if (Get-AppxPackage -Name $identity) { throw 'A Lingxi Store package is already installed; refusing to replace it.' }
$package = Get-ChildItem $ReleaseDirectory -File | Where-Object { $_.Extension -in '.appx', '.msix' } | Select-Object -First 1
if (-not $package) { throw 'MSIX/AppX package not found.' }
$testDirectory = Join-Path $env:RUNNER_TEMP ('lingxi-msix-test-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $testDirectory | Out-Null
$certificate = $null
$installed = $null
$trustedCertificate = $null
$logPaths = @()
try {
  $signedPackage = Join-Path $testDirectory $package.Name
  Copy-Item $package.FullName $signedPackage
  $certificate = New-SelfSignedCertificate -Type Custom -Subject 'CN=5C62BC82-3986-4D37-81C4-0EAF060A1A5D' `
    -KeyUsage DigitalSignature -CertStoreLocation 'Cert:\CurrentUser\My' -HashAlgorithm SHA256 `
    -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}')
  $certificatePath = Join-Path $testDirectory 'test.cer'
  Export-Certificate -Cert $certificate -FilePath $certificatePath | Out-Null
  $trustedCertificate = Import-Certificate -FilePath $certificatePath -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople'
  $signTool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" | Sort-Object FullName -Descending | Select-Object -First 1
  if (-not $signTool) { throw 'Windows SDK signtool.exe not found.' }
  & $signTool.FullName sign /fd SHA256 /sha1 $certificate.Thumbprint $signedPackage
  if ($LASTEXITCODE -ne 0) { throw 'Could not sign the test copy of the MSIX.' }
  Add-AppxPackage -Path $signedPackage
  $installed = Get-AppxPackage -Name $identity
  if (-not $installed) { throw 'MSIX installation failed.' }
  $launchedAt = [datetime]::UtcNow
  # Exercise package activation, without --disable-gpu or a development profile.
  Start-Process explorer.exe -ArgumentList "shell:AppsFolder\$($installed.PackageFamilyName)!LingxiWorkspace"
  $logPaths = @(
    (Join-Path $env:LOCALAPPDATA "Packages\$($installed.PackageFamilyName)\LocalCache\Local\GEO Publisher Desktop\diagnostics\startup.log"),
    (Join-Path $env:LOCALAPPDATA 'GEO Publisher Desktop\diagnostics\startup.log'),
    (Join-Path $env:TEMP 'lingxi-startup\startup.log')
  )
  $ready = $false
  for ($attempt = 0; $attempt -lt 90; $attempt++) {
    foreach ($logPath in $logPaths) {
      if (-not (Test-Path $logPath)) { continue }
      $records = @(Get-Content $logPath | ForEach-Object {
        try { $entry = $_ | ConvertFrom-Json; if ([datetime]$entry.time -ge $launchedAt) { $entry } } catch { }
      })
      $begin = $records | Where-Object { $_.event -eq 'startup.begin' -and $_.details.windowsStore -and $_.details.packaged } | Select-Object -Last 1
      if ($begin -and ($records | Where-Object { $_.event -eq 'renderer.ready' -and $_.pid -eq $begin.pid })) {
        if ($begin.details.softwareRendering) { throw 'Store smoke unexpectedly bypassed hardware acceleration.' }
        $ready = $true
        break
      }
    }
    if ($ready) { break }
    Start-Sleep -Seconds 1
  }
  if (-not $ready) { throw 'Installed MSIX did not render the workspace under its Store identity within 90 seconds.' }
  Write-Host "MSIX startup smoke passed: $($installed.Version), package identity and renderer ready confirmed."
} finally {
  $evidence = Join-Path $ReleaseDirectory 'startup-test-logs'
  New-Item -ItemType Directory -Force -Path $evidence | Out-Null
  $index = 0
  foreach ($logPath in $logPaths) {
    if (Test-Path $logPath) { Copy-Item $logPath (Join-Path $evidence "startup-$index.log"); $index++ }
  }
  if ($installed) {
    Get-Process | Where-Object {
      try { $_.Path -and $_.Path.StartsWith($installed.InstallLocation, [System.StringComparison]::OrdinalIgnoreCase) } catch { $false }
    } | Stop-Process -Force -ErrorAction SilentlyContinue
    Remove-AppxPackage -Package $installed.PackageFullName -ErrorAction Continue
  }
  if ($trustedCertificate) { Remove-Item "Cert:\LocalMachine\TrustedPeople\$($trustedCertificate.Thumbprint)" -ErrorAction Continue }
  if ($certificate) { Remove-Item "Cert:\CurrentUser\My\$($certificate.Thumbprint)" -ErrorAction Continue }
  Remove-Item -Recurse -Force $testDirectory -ErrorAction Continue
}
