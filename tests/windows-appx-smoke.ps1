param(
  [Parameter(Mandatory = $true)]
  [string]$PackagePath,

  [Parameter(Mandatory = $true)]
  [string]$IdentityName,

  [Parameter(Mandatory = $true)]
  [string]$Publisher,

  [Parameter(Mandatory = $true)]
  [string]$ExpectedVersion,

  [Parameter(Mandatory = $true)]
  [string]$ApplicationId
)

$ErrorActionPreference = 'Stop'
$package = (Resolve-Path -LiteralPath $PackagePath).Path
if ($ExpectedVersion -match '^\d+\.\d+\.\d+$') {
  $ExpectedVersion = "$ExpectedVersion.0"
}

$smokeRoot = Join-Path $env:RUNNER_TEMP 'geo-publisher-appx-smoke'
$signedPackage = Join-Path $smokeRoot 'test-signed.appx'
$pfxPath = Join-Path $smokeRoot 'publisher-test.pfx'
$cerPath = Join-Path $smokeRoot 'publisher-test.cer'
$passwordText = 'appx-smoke-password'
$password = ConvertTo-SecureString $passwordText -AsPlainText -Force
$installed = $null
$certificate = $null

New-Item -ItemType Directory -Force -Path $smokeRoot | Out-Null
Copy-Item -LiteralPath $package -Destination $signedPackage -Force

try {
  $signtool = Get-ChildItem -Path "$env:ProgramFiles(x86)\Windows Kits\10\bin\*\x64\signtool.exe" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if (-not $signtool) {
    throw 'Windows SDK signtool.exe was not found on the runner'
  }

  $certificate = New-SelfSignedCertificate -Type CodeSigningCert -Subject $Publisher -CertStoreLocation 'Cert:\CurrentUser\My' -KeyExportPolicy Exportable -NotAfter (Get-Date).AddDays(2)
  Export-PfxCertificate -Cert $certificate -FilePath $pfxPath -Password $password | Out-Null
  Export-Certificate -Cert $certificate -FilePath $cerPath | Out-Null
  Import-Certificate -FilePath $cerPath -CertStoreLocation 'Cert:\CurrentUser\TrustedPeople' | Out-Null

  $signature = Get-AuthenticodeSignature -FilePath $signedPackage
  if ($signature.Status -ne 'Valid') {
    & $signtool.FullName sign /fd SHA256 /f $pfxPath /p $passwordText $signedPackage
    if ($LASTEXITCODE -ne 0) {
      throw "signtool failed with exit code $LASTEXITCODE"
    }
  }

  Get-AppxPackage -Name $IdentityName -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-AppxPackage -Package $_.PackageFullName -ErrorAction SilentlyContinue }

  $discoveryPath = Join-Path $env:LOCALAPPDATA 'GEO Publisher Desktop\discovery.json'
  if (Test-Path -LiteralPath $discoveryPath) {
    Remove-Item -LiteralPath $discoveryPath -Force
  }

  Add-AppxPackage -Path $signedPackage
  $installed = Get-AppxPackage -Name $IdentityName | Select-Object -First 1
  if (-not $installed) {
    throw "AppX package $IdentityName was not installed"
  }
  if ($installed.Version.ToString() -ne $ExpectedVersion) {
    throw "Installed AppX version is $($installed.Version), expected $ExpectedVersion"
  }

  $manifest = Get-AppxPackageManifest -Package $installed
  $application = @($manifest.Package.Applications.Application) | Where-Object { $_.Id -eq $ApplicationId } | Select-Object -First 1
  if (-not $application) {
    throw "Application.Id $ApplicationId was not found in the installed manifest"
  }

  $launchTarget = "shell:AppsFolder\$($installed.PackageFamilyName)!$ApplicationId"
  Start-Process -FilePath explorer.exe -ArgumentList $launchTarget | Out-Null

  $discovery = $null
  for ($attempt = 0; $attempt -lt 90; $attempt += 1) {
    if (Test-Path -LiteralPath $discoveryPath) {
      try {
        $candidate = Get-Content -Raw -LiteralPath $discoveryPath | ConvertFrom-Json
        if ($candidate.ready -and $candidate.cliPath -and (Test-Path -LiteralPath $candidate.cliPath)) {
          $discovery = $candidate
          break
        }
      } catch {
        # The app writes discovery atomically; tolerate a partially-written file.
      }
    }
    Start-Sleep -Seconds 1
  }
  if (-not $discovery) {
    throw "MSIX app did not create a ready discovery record at $discoveryPath"
  }

  $version = & $discovery.cliPath version | ConvertFrom-Json
  if (-not $version.ok -or $version.version -ne $discovery.appVersion) {
    throw 'Bundled CLI did not connect to the MSIX-installed desktop'
  }

  Write-Host "MSIX install smoke passed: package=$package version=$ExpectedVersion"
} finally {
  if ($installed) {
    Get-Process | Where-Object {
      try { $_.Path -and $_.Path.StartsWith($installed.InstallLocation, [System.StringComparison]::OrdinalIgnoreCase) } catch { $false }
    } | Stop-Process -Force -ErrorAction SilentlyContinue
    Remove-AppxPackage -Package $installed.PackageFullName -ErrorAction SilentlyContinue
  }
  if ($certificate) {
    Remove-Item -Path "Cert:\CurrentUser\My\$($certificate.Thumbprint)" -Force -ErrorAction SilentlyContinue
    Remove-Item -Path "Cert:\CurrentUser\TrustedPeople\$($certificate.Thumbprint)" -Force -ErrorAction SilentlyContinue
  }
}
