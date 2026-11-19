$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'A disposable runner is required.' }
$identity = '78707CBF.LingxiWorkspace'
$family = "$($identity)_00tbjt2yye0b2"
$aumid = "$family!LingxiWorkspace"
$desktop = [Environment]::GetFolderPath('DesktopDirectory')
$linkPath = Join-Path $desktop 'Lingxi Workspace.lnk'
$urlPath = Join-Path $desktop 'Lingxi Workspace.url'
if ((Get-AppxPackage -Name $identity) -or (Test-Path $linkPath) -or (Test-Path $urlPath)) { throw 'Use a clean account.' }
$evidence = Join-Path $PWD 'probe-evidence'
$temp = Join-Path $env:RUNNER_TEMP ('shortcut-probe-' + [guid]::NewGuid())
New-Item -ItemType Directory $evidence,$temp | Out-Null
$package = Get-ChildItem probe-input -Filter '*.appx' -File | Select-Object -First 1
if (-not $package) { throw 'Package fixture missing.' }
$sdk = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
$signTool = Get-ChildItem "$sdk\Windows Kits\10\bin\*\x64\signtool.exe" | Sort-Object FullName -Descending | Select-Object -First 1
$makeAppx = Join-Path $signTool.DirectoryName 'makeappx.exe'
$shell = New-Object -ComObject WScript.Shell
$certificate = $null
$results = @()

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
public static class NativeAppLink {
    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellLinkW {
        void GetPath(IntPtr path, int count, IntPtr findData, uint flags);
        void GetIDList(out IntPtr pidl);
        void SetIDList(IntPtr pidl);
    }
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    private static extern void SHParseDisplayName(string name, IntPtr ctx, out IntPtr pidl, uint requested, out uint returned);
    [DllImport("shell32.dll", PreserveSig = false)]
    private static extern void SHGetNameFromIDList(IntPtr pidl, uint kind, [MarshalAs(UnmanagedType.LPWStr)] out string name);
    private static object Link() {
        return Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("00021401-0000-0000-C000-000000000046")));
    }
    public static void Create(string target, string file) {
        uint ignored;
        IntPtr pidl;
        SHParseDisplayName(target, IntPtr.Zero, out pidl, 0, out ignored);
        var link = Link();
        try {
            ((IShellLinkW)link).SetIDList(pidl);
            ((IPersistFile)link).Save(file, true);
        } finally { Marshal.FreeCoTaskMem(pidl); Marshal.FinalReleaseComObject(link); }
    }
    public static string GetTarget(string file) {
        var link = Link();
        IntPtr pidl = IntPtr.Zero;
        try {
            ((IPersistFile)link).Load(file, 0);
            ((IShellLinkW)link).GetIDList(out pidl);
            if (pidl == IntPtr.Zero) return "";
            string name;
            SHGetNameFromIDList(pidl, 0x80028000, out name);
            return name;
        } finally { Marshal.FreeCoTaskMem(pidl); Marshal.FinalReleaseComObject(link); }
    }
}
'@

function Sign-Package($Path) {
  & $signTool.FullName sign /fd SHA256 /sha1 $certificate.Thumbprint $Path
  if ($LASTEXITCODE -ne 0) { throw 'SignTool failed' }
}

function Remove-Install {
  $installed = Get-AppxPackage -Name $identity
  if ($installed) {
    Get-Process -Name 'Lingxi Workspace' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Remove-AppxPackage -Package $installed.PackageFullName
  }
  foreach ($path in @($linkPath, $urlPath)) {
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path }
  }
}

try {
  $certificate = New-SelfSignedCertificate -Type Custom -Subject 'CN=5C62BC82-3986-4D37-81C4-0EAF060A1A5D' -KeyUsage DigitalSignature -CertStoreLocation Cert:\CurrentUser\My -HashAlgorithm SHA256 -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}')
  $cer = Join-Path $temp 'probe.cer'
  Export-Certificate -Cert $certificate -FilePath $cer | Out-Null
  Import-Certificate -FilePath $cer -CertStoreLocation Cert:\LocalMachine\TrustedPeople | Out-Null
  $reference = Join-Path $temp 'reference.appx'
  Copy-Item -LiteralPath $package.FullName -Destination $reference
  Sign-Package $reference
  Add-AppxPackage -Path $reference
  $native = Join-Path $evidence 'reference-native.lnk'
  [NativeAppLink]::Create("shell:AppsFolder\$aumid", $native)
  $nativeHash = (Get-FileHash -LiteralPath $native).Hash
  $nativeTarget = [NativeAppLink]::GetTarget($native)
  Write-Host "Native reference target: $nativeTarget"
  Remove-Install

  $contents = Join-Path $temp 'contents'
  & $makeAppx unpack /p $package.FullName /d $contents | Select-Object -Last 4 | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'MakeAppx unpack failed' }
  foreach ($name in @('AppxBlockMap.xml','[Content_Types].xml','AppxSignature.p7x')) {
    $footprint = Join-Path $contents $name
    if (Test-Path -LiteralPath $footprint) { Remove-Item -LiteralPath $footprint }
  }
  $manifestPath = Join-Path $contents AppxManifest.xml
  $original = Get-Content -LiteralPath $manifestPath -Raw
  $vfsDesktop = Join-Path $contents 'VFS\Desktop'
  New-Item -ItemType Directory $vfsDesktop | Out-Null
  $desktopNs = 'http://schemas.microsoft.com/appx/manifest/desktop/windows10/7'
  $uapNs = 'http://schemas.microsoft.com/appx/manifest/uap/windows10'
  $revision = 30
  foreach ($variant in @('system-launcher','win32-runtime','documented-desktop','data-shortcut')) {
    $revision++
    $record = [ordered]@{ Variant = $variant; Packed = $false; Installed = $false; Items = @(); FirstLaunch = $false; Error = $null }
    $candidate = Join-Path $temp "$variant.appx"
    try {
      $xml = [xml]$original
      $root = $xml.DocumentElement
      $root.SetAttribute('xmlns:desktop7', $desktopNs)
      $root.SetAttribute('IgnorableNamespaces', "$($root.IgnorableNamespaces) desktop7")
      $root.Identity.SetAttribute('Version', "1.0.24.$revision")
      $app = $root.Applications.Application
      $name = 'Lingxi Workspace.lnk'
      if ($variant -in @('win32-runtime','documented-desktop')) {
        Copy-Item -LiteralPath $native -Destination (Join-Path $vfsDesktop $name)
      }
      if ($variant -eq 'win32-runtime') {
        $app.RemoveAttribute('EntryPoint')
        $runtime = $xml.CreateAttribute('uap10','RuntimeBehavior',"$uapNs/10")
        $runtime.Value = 'win32App'
        [void]$app.Attributes.Append($runtime)
        $trust = $xml.CreateAttribute('uap10','TrustLevel',"$uapNs/10")
        $trust.Value = 'mediumIL'
        [void]$app.Attributes.Append($trust)
      }
      if ($variant -eq 'data-shortcut') {
        $name = 'Lingxi Workspace.url'
        Set-Content -LiteralPath (Join-Path $vfsDesktop $name) -Encoding ascii -Value @('[InternetShortcut]','URL=lingxi-workspace-shortcut-probe:open')
        $protocol = $xml.CreateElement('uap','Extension',$uapNs)
        $protocol.SetAttribute('Category','windows.protocol')
        $scheme = $xml.CreateElement('uap','Protocol',$uapNs)
        $scheme.SetAttribute('Name','lingxi-workspace-shortcut-probe')
        [void]$protocol.AppendChild($scheme)
        [void]$app.Extensions.AppendChild($protocol)
        $dataNs = 'http://schemas.microsoft.com/appx/manifest/desktop/windows10/10'
        $root.SetAttribute('xmlns:desktop10', $dataNs)
        $root.SetAttribute('IgnorableNamespaces', "$($root.IgnorableNamespaces) desktop10")
        $dataExtension = $xml.CreateElement('desktop10','Extension',$dataNs)
        $dataExtension.SetAttribute('Category','windows.dataShortcuts')
        $dataShortcuts = $xml.CreateElement('desktop10','DataShortcuts',$dataNs)
        $dataShortcut = $xml.CreateElement('desktop10','DataShortcut',$dataNs)
        $dataShortcut.SetAttribute('Path', "VFS\Desktop\$name")
        $dataShortcut.SetAttribute('DisplayName', 'Lingxi Workspace')
        $dataShortcut.SetAttribute('AUMID', $aumid)
        [void]$dataShortcuts.AppendChild($dataShortcut)
        [void]$dataExtension.AppendChild($dataShortcuts)
        $extensions = $xml.CreateElement('Extensions', $root.NamespaceURI)
        [void]$extensions.AppendChild($dataExtension)
        [void]$root.AppendChild($extensions)
      }
      if ($variant -ne 'data-shortcut') {
        $extension = $xml.CreateElement('desktop7','Extension',$desktopNs)
        $extension.SetAttribute('Category','windows.shortcut')
        $shortcut = $xml.CreateElement('desktop7','Shortcut',$desktopNs)
        $shortcut.SetAttribute('File', "[{Desktop}]\$name")
        $shortcut.SetAttribute('Icon', '[{Package}]\app\Lingxi Workspace.exe')
        if ($variant -eq 'system-launcher') {
          $extension.SetAttribute('Executable','[{Windows}]\explorer.exe')
          $extension.SetAttribute('EntryPoint','Windows.FullTrustApplication')
          $shortcut.SetAttribute('Arguments',"shell:AppsFolder\$aumid")
        }
        if ($variant -eq 'documented-desktop') {
          $shortcut.SetAttribute('File', ('$(Desktop)\' + $name))
        }
        [void]$extension.AppendChild($shortcut)
        [void]$app.Extensions.AppendChild($extension)
      }
      $xml.Save($manifestPath)
      & $makeAppx pack /nc /d $contents /p $candidate | Set-Content -LiteralPath (Join-Path $evidence "$variant-pack.log")
      if ($LASTEXITCODE -ne 0) { throw "MakeAppx failed with code $LASTEXITCODE" }
      $record.Packed = $true
      Sign-Package $candidate
      Add-AppxPackage -Path $candidate
      $record.Installed = $true
      if (Get-Process -Name 'Lingxi Workspace' -ErrorAction SilentlyContinue) { throw 'The application is already running.' }
      Start-Sleep -Seconds 3
      foreach ($path in @($linkPath, $urlPath)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
        $file = Get-Item -LiteralPath $path
        $item = [ordered]@{ Name = $file.Name; SameBytes = ((Get-FileHash -LiteralPath $path).Hash -eq $nativeHash); Target = ''; Arguments = ''; ShellTarget = ''; Protocol = '' }
        Copy-Item -LiteralPath $path -Destination (Join-Path $evidence "$variant$($file.Extension)")
        if ($file.Extension -eq '.lnk') {
          $link = $shell.CreateShortcut($path)
          $item.Target = $link.TargetPath
          $item.Arguments = $link.Arguments
          try { $item.ShellTarget = [NativeAppLink]::GetTarget($path) } catch { $item.ShellTarget = $_.Exception.Message }
        } else { $item.Protocol = @(Get-Content -LiteralPath $path -Encoding ascii -TotalCount 2) }
        $record.Items += [pscustomobject]$item
        $stable = $item.SameBytes -or ($item.ShellTarget -eq $nativeTarget -and $nativeTarget -like "*$aumid*") -or
          ($item.Target -eq (Join-Path $env:WINDIR 'explorer.exe') -and $item.Arguments -eq "shell:AppsFolder\$aumid") -or
          ($item.Protocol -contains 'URL=lingxi-workspace-shortcut-probe:open')
        if ($stable) {
          $started = [datetime]::UtcNow
          Invoke-Item -LiteralPath $path
          $logs = @(
            (Join-Path $env:LOCALAPPDATA 'GEO Publisher Desktop\diagnostics\startup.log'),
            (Join-Path $env:LOCALAPPDATA "Packages\$family\LocalCache\Local\GEO Publisher Desktop\diagnostics\startup.log")
          )
          for ($attempt = 0; $attempt -lt 40 -and -not $record.FirstLaunch; $attempt++) {
            foreach ($log in $logs) {
              if (-not (Test-Path -LiteralPath $log)) { continue }
              $ready = Get-Content -LiteralPath $log | ForEach-Object {
                try { $line = $_ | ConvertFrom-Json; if ($line.event -eq 'renderer.ready' -and [datetime]$line.time -ge $started) { $line } } catch { }
              }
              if ($ready) { $record.FirstLaunch = $true }
            }
            if (-not $record.FirstLaunch) { Start-Sleep -Seconds 1 }
          }
        }
      }
    } catch { $record.Error = $_.Exception.Message }
    finally {
      $results += [pscustomobject]$record
      ConvertTo-Json -InputObject $results -Depth 7 | Set-Content -LiteralPath (Join-Path $evidence 'results.json')
      ConvertTo-Json -InputObject $record -Depth 7 | Out-Host
      Remove-Install
      Get-ChildItem -LiteralPath $vfsDesktop -File | Remove-Item
      if (Test-Path -LiteralPath $candidate) { Remove-Item -LiteralPath $candidate }
    }
  }
} finally {
  Remove-Install
  if ($certificate) {
    Remove-Item "Cert:\LocalMachine\TrustedPeople\$($certificate.Thumbprint)" -ErrorAction SilentlyContinue
    Remove-Item "Cert:\CurrentUser\My\$($certificate.Thumbprint)" -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
exit 0
