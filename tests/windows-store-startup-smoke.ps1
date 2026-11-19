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
$desktop = [Environment]::GetFolderPath('DesktopDirectory')
if (-not $desktop) { throw 'The test account must have a desktop directory.' }
$shortcutPath = Join-Path $desktop 'Lingxi Workspace.lnk'
if (Test-Path -LiteralPath $shortcutPath) { throw 'A Lingxi Workspace desktop shortcut already exists.' }
$package = Get-ChildItem $ReleaseDirectory -File | Where-Object { $_.Extension -in '.appx', '.msix' } | Select-Object -First 1
if (-not $package) { throw 'MSIX/AppX package not found.' }
$evidence = Join-Path $ReleaseDirectory 'startup-test-logs'
New-Item -ItemType Directory -Force -Path $evidence | Out-Null

function Start-FromDesktopShortcut($InstalledPackage, $Stage, $LogPaths) {
  for ($attempt = 0; $attempt -lt 15 -and -not (Test-Path -LiteralPath $shortcutPath -PathType Leaf); $attempt++) {
    Start-Sleep -Seconds 1
  }
  if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) {
    throw "$Stage installation did not place a shortcut on the desktop before launch."
  }

  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut($shortcutPath)
  @{
    PackageFullName = $InstalledPackage.PackageFullName
    ShortcutPath = $shortcutPath
    Target = $link.TargetPath
    Arguments = $link.Arguments
    IconLocation = $link.IconLocation
  } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $evidence "$Stage-shortcut.json") -Encoding UTF8
  if ($link.TargetPath -match '(?i)[\\/]WindowsApps[\\/]78707CBF\.LingxiWorkspace_') {
    throw "$Stage desktop shortcut targets a versioned WindowsApps path: $($link.TargetPath)"
  }

  $launchedAt = [datetime]::UtcNow
  Invoke-Item -LiteralPath $shortcutPath
  for ($attempt = 0; $attempt -lt 90; $attempt++) {
    foreach ($logPath in $LogPaths) {
      if (-not (Test-Path $logPath)) { continue }
      $records = @(Get-Content $logPath | ForEach-Object {
        try { $entry = $_ | ConvertFrom-Json; if ([datetime]$entry.time -ge $launchedAt) { $entry } } catch { }
      })
      $begin = $records | Where-Object { $_.event -eq 'startup.begin' -and $_.details.windowsStore -and $_.details.packaged } | Select-Object -Last 1
      if ($begin -and ($records | Where-Object { $_.event -eq 'renderer.ready' -and $_.pid -eq $begin.pid })) {
        if ($begin.details.softwareRendering) { throw 'Store smoke unexpectedly bypassed hardware acceleration.' }
        $process = Get-Process -Id $begin.pid -ErrorAction Stop
        if ($process.Path -ne (Join-Path $InstalledPackage.InstallLocation 'app\Lingxi Workspace.exe')) {
          throw "$Stage desktop shortcut started the wrong executable: $($process.Path)"
        }
        Write-Host "$Stage desktop shortcut opened $($InstalledPackage.Version)."
        return $begin
      }
    }
    Start-Sleep -Seconds 1
  }
  throw "$Stage desktop shortcut did not open the workspace under its Store identity within 90 seconds."
}

$testDirectory = Join-Path $env:RUNNER_TEMP ('lingxi-msix-test-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $testDirectory | Out-Null
$certificate = $null
$installed = $null
$trustedCertificate = $null
$logPaths = @()
$testStartedAt = $null
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
  $makeAppx = Join-Path $signTool.DirectoryName 'makeappx.exe'
  & $signTool.FullName sign /fd SHA256 /sha1 $certificate.Thumbprint $signedPackage
  if ($LASTEXITCODE -ne 0) { throw 'Could not sign the test copy of the MSIX.' }
  $testStartedAt = [datetime]::UtcNow
  Add-AppxPackage -Path $signedPackage
  $installed = Get-AppxPackage -Name $identity
  if (-not $installed) { throw 'MSIX installation failed.' }
  $logPaths = @(
    (Join-Path $env:LOCALAPPDATA "Packages\$($installed.PackageFamilyName)\LocalCache\Local\GEO Publisher Desktop\diagnostics\startup.log"),
    (Join-Path $env:LOCALAPPDATA 'GEO Publisher Desktop\diagnostics\startup.log'),
    (Join-Path $env:TEMP 'lingxi-startup\startup.log')
  )
  $begin = Start-FromDesktopShortcut $installed 'fresh' $logPaths

  # Keep the package family and shortcut in place while moving the app to a
  # new WindowsApps directory. The fourth version segment is for this CI copy only.
  $upgradeContents = Join-Path $testDirectory 'upgrade-contents'
  & $makeAppx unpack /p $package.FullName /d $upgradeContents
  if ($LASTEXITCODE -ne 0) { throw 'Could not unpack the MSIX for update testing.' }
  $upgradeManifestPath = Join-Path $upgradeContents 'AppxManifest.xml'
  $upgradeManifest = [System.Xml.XmlDocument]::new()
  $upgradeManifest.Load($upgradeManifestPath)
  $upgradeVersion = [version]::new($installed.Version.Major, $installed.Version.Minor, $installed.Version.Build, ($installed.Version.Revision + 1))
  $upgradeManifest.DocumentElement.Identity.SetAttribute('Version', $upgradeVersion.ToString())
  $upgradeManifest.Save($upgradeManifestPath)
  foreach ($file in @('AppxBlockMap.xml', '[Content_Types].xml')) {
    Remove-Item -LiteralPath (Join-Path $upgradeContents $file)
  }
  $upgradePackage = Join-Path $testDirectory 'upgrade.appx'
  & $makeAppx pack /d $upgradeContents /p $upgradePackage
  if ($LASTEXITCODE -ne 0) { throw 'Could not repack the MSIX for update testing.' }
  & $signTool.FullName sign /fd SHA256 /sha1 $certificate.Thumbprint $upgradePackage
  if ($LASTEXITCODE -ne 0) { throw 'Could not sign the MSIX update for testing.' }
  Add-AppxPackage -Path $upgradePackage -ForceTargetApplicationShutdown
  $updatedPackage = Get-AppxPackage -Name $identity
  if (-not $updatedPackage -or $updatedPackage.Version -ne $upgradeVersion -or $updatedPackage.InstallLocation -eq $installed.InstallLocation) {
    throw "MSIX update did not register version $upgradeVersion in a new directory."
  }
  $installed = $updatedPackage
  $begin = Start-FromDesktopShortcut $installed 'updated' $logPaths
  $expectedElectron = (Get-Content (Join-Path $PSScriptRoot '../package.json') -Raw | ConvertFrom-Json).devDependencies.electron
  if ($begin.details.electron -ne $expectedElectron) {
    throw "MSIX contains Electron $($begin.details.electron), expected the pinned runtime $expectedElectron."
  }
  # A rendered window alone does not prove the package remains usable. Windows
  # can terminate a GPU child later and mark the package NeedsRemediation.
  for ($attempt = 0; $attempt -lt 15; $attempt++) {
    Start-Sleep -Seconds 1
    $currentPackage = Get-AppxPackage -Name $identity
    if (-not $currentPackage -or [string]$currentPackage.Status -ne 'Ok') {
      throw "MSIX became unavailable after rendering: $($currentPackage.Status)"
    }
    $mainProcess = Get-Process -Id $begin.pid -ErrorAction SilentlyContinue
    if (-not $mainProcess -or $mainProcess.HasExited) {
      throw 'MSIX main process exited after the workspace rendered.'
    }
  }
  Write-Host "MSIX startup smoke passed: $($installed.Version), Electron $expectedElectron, renderer ready and package remains Ok."
} finally {
  $index = 0
  foreach ($logPath in $logPaths) {
    if (Test-Path $logPath) { Copy-Item $logPath (Join-Path $evidence "startup-$index.log"); $index++ }
  }
  if ($testStartedAt) {
    foreach ($channel in @('Microsoft-Windows-CodeIntegrity/Operational', 'Microsoft-Windows-AppModel-Runtime/Admin')) {
      $name = ($channel -replace '[/\\]', '-') + '.json'
      try {
        $events = @(Get-WinEvent -FilterHashtable @{ LogName = $channel; StartTime = $testStartedAt } -MaxEvents 300 -ErrorAction Stop |
          Where-Object { $_.Message -match [regex]::Escape($identity) } |
          Select-Object TimeCreated, Id, ProviderName, Message)
        ConvertTo-Json -InputObject $events -Depth 4 | Set-Content (Join-Path $evidence $name) -Encoding UTF8
      } catch {
        # A runner may not expose these channels or may have no events. Do not
        # disguise an unavailable diagnostic source as an empty successful read.
        $_.Exception.Message | Set-Content (Join-Path $evidence "$name.unavailable.log") -Encoding UTF8
      }
    }
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
