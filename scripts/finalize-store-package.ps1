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

# Use an image for the manifest icon so it never doubles as an executable
# target. ICO supports a PNG image inside the icon directory entry.
$iconPath = Join-Path $contents $extension.Shortcut.Icon.Substring('[{Package}]\'.Length)
$logo = [IO.File]::ReadAllBytes((Join-Path $contents 'assets\Square150x150Logo.png'))
$iconHeader = [byte[]]@(0, 0, 1, 0, 1, 0, 150, 150, 0, 0, 1, 0, 32, 0)
[IO.File]::WriteAllBytes($iconPath, ($iconHeader + [BitConverter]::GetBytes([int]$logo.Length) + [BitConverter]::GetBytes(22) + $logo))

$arguments = "shell:AppsFolder\$appUserModelId"
$extension.Shortcut.SetAttribute('Arguments', $arguments)

# MS-SHLLINK: store only an expandable target and Unicode arguments. An
# ordinary WScript link records the build machine's paths and target ID list.
# The deployed link resolves Explorer on the user's system and activates the
# registered application independently of the package's install directory.
$target = '%SystemRoot%\explorer.exe'
$header = [byte[]]::new(76)
[BitConverter]::GetBytes(76).CopyTo($header, 0)
([guid]'00021401-0000-0000-c000-000000000046').ToByteArray().CopyTo($header, 4)
# PreferEnvironmentPath | HasExpString | IsUnicode | HasArguments.
[BitConverter]::GetBytes(0x020002A0).CopyTo($header, 20)
[BitConverter]::GetBytes(1).CopyTo($header, 60) # SW_SHOWNORMAL
$argumentBytes = [Text.Encoding]::Unicode.GetBytes($arguments)
$environmentBlock = [byte[]]::new(0x314)
[BitConverter]::GetBytes(0x314).CopyTo($environmentBlock, 0)
[BitConverter]::GetBytes([uint32]2684354561).CopyTo($environmentBlock, 4) # 0xA0000001
[Text.Encoding]::ASCII.GetBytes($target).CopyTo($environmentBlock, 8)
[Text.Encoding]::Unicode.GetBytes($target).CopyTo($environmentBlock, 268)
$link = $header + [BitConverter]::GetBytes([uint16]$arguments.Length) + $argumentBytes + $environmentBlock + [byte[]]::new(4)
[IO.File]::WriteAllBytes((Join-Path $shortcutDirectory $linkName), $link)

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
