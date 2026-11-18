param(
  [Parameter(Mandatory = $true)][string]$InputPackage,
  [Parameter(Mandatory = $true)][string]$OutputPackage
)

$ErrorActionPreference = 'Stop'
$makeAppx = Get-Command makeappx.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source
if (-not $makeAppx) {
  $makeAppx = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\makeappx.exe" -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $makeAppx) { throw 'Windows SDK makeappx.exe not found.' }

# Electron Builder maps its payload under app\. Windows looks for the shortcut
# under VFS\Desktop at the package root, so add it before creating the final package.
$staging = Split-Path -Parent $InputPackage
$contents = Join-Path $staging 'package-contents'
& $makeAppx unpack /p $InputPackage /d $contents
if ($LASTEXITCODE -ne 0) { throw 'Could not unpack the Store package.' }

$manifestPath = Join-Path $contents 'AppxManifest.xml'
$manifest = [System.Xml.XmlDocument]::new()
$manifest.Load($manifestPath)
$package = $manifest.DocumentElement
$application = $package.Applications.Application
$shortcutManifest = [System.Xml.XmlDocument]::new()
$shortcutManifest.Load((Join-Path $PSScriptRoot '../build/appx-desktop-shortcut.xml'))
$extension = $shortcutManifest.DocumentElement
$linkName = [IO.Path]::GetFileName($extension.Shortcut.File)
$shortcutDirectory = Join-Path $contents 'VFS\Desktop'
New-Item -ItemType Directory -Force -Path $shortcutDirectory | Out-Null

# Windows encodes the first eight bytes of the UTF-16LE publisher's SHA-256
# digest with its Base32 alphabet to obtain the package publisher ID.
$sha256 = [Security.Cryptography.SHA256]::Create()
try {
  $digest = $sha256.ComputeHash([Text.Encoding]::Unicode.GetBytes($package.Identity.Publisher))
} finally {
  $sha256.Dispose()
}
$bits = -join ($digest[0..7] | ForEach-Object { [Convert]::ToString($_, 2).PadLeft(8, '0') })
$bits += '0'
$alphabet = '0123456789abcdefghjkmnpqrstvwxyz'
$publisherId = -join (0..12 | ForEach-Object { $alphabet[[Convert]::ToInt32($bits.Substring($_ * 5, 5), 2)] })
$appUserModelId = "$($package.Identity.Name)_$publisherId!$($application.Id)"

# AppsFolder activation works with the package identity across Store updates.
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut((Join-Path $shortcutDirectory $linkName))
$shortcut.TargetPath = "$env:WINDIR\explorer.exe"
$shortcut.Arguments = "shell:AppsFolder\$appUserModelId"
$shortcut.Save()

$application.Extensions.AppendChild($manifest.ImportNode($extension, $true)) | Out-Null
$manifest.Save($manifestPath)

# MakeAppx regenerates package metadata from the updated payload.
foreach ($file in @('AppxBlockMap.xml', 'AppxSignature.p7x', '[Content_Types].xml', 'AppxMetadata\CodeIntegrity.cat')) {
  $footprint = Join-Path $contents $file
  if (Test-Path -LiteralPath $footprint) { Remove-Item -LiteralPath $footprint }
}
$packed = Join-Path $staging 'with-shortcut.appx'
& $makeAppx pack /d $contents /p $packed
if ($LASTEXITCODE -ne 0) { throw 'Could not build the Store package with its desktop shortcut.' }
Move-Item -LiteralPath $packed -Destination $OutputPackage -Force
