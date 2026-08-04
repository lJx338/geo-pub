param(
  [Parameter(Mandatory = $true)]
  [string]$ReleaseDirectory
)

$ErrorActionPreference = 'Stop'

$installer = Get-ChildItem -Path $ReleaseDirectory -Filter '*.exe' -File |
  Where-Object { $_.Name -notmatch 'uninstall' } |
  Select-Object -First 1
if (-not $installer) {
  throw "Windows installer was not found in $ReleaseDirectory"
}

$dataDirectory = Join-Path $env:LOCALAPPDATA 'GEO Publisher Desktop'
$discoveryPath = Join-Path $dataDirectory 'discovery.json'

try {
  $install = Start-Process -FilePath $installer.FullName -ArgumentList '/S' -Wait -PassThru
  if ($install.ExitCode -ne 0) {
    throw "Installer exited with code $($install.ExitCode)"
  }
  $appPath = Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'Programs') -Filter 'GEO Publisher.exe' -File -Recurse |
    Select-Object -First 1 -ExpandProperty FullName
  if (-not $appPath) {
    throw 'Installed GEO Publisher.exe was not found below LOCALAPPDATA\Programs'
  }
  $installDirectory = Split-Path -Parent $appPath
  $skillPath = Join-Path $installDirectory 'resources\integrations\workbuddy\geo-publisher\SKILL.md'
  if (-not (Test-Path $skillPath)) {
    throw "Bundled WorkBuddy Skill was not found at $skillPath"
  }

  $env:GEO_DISABLE_OPEN_WORKBUDDY = '1'
  $appProcess = Start-Process -FilePath $appPath -ArgumentList '--disable-gpu' -PassThru

  $discovery = $null
  for ($attempt = 0; $attempt -lt 90; $attempt += 1) {
    if (Test-Path $discoveryPath) {
      try {
        $candidate = Get-Content -Raw -Path $discoveryPath | ConvertFrom-Json
        if ($candidate.ready -and $candidate.cliPath -and (Test-Path $candidate.cliPath)) {
          $discovery = $candidate
          break
        }
      } catch {
        # The app writes discovery atomically, but tolerate antivirus/file-system delays.
      }
    }
    Start-Sleep -Seconds 1
  }
  if (-not $discovery) {
    throw "Desktop did not create a ready discovery record at $discoveryPath"
  }
  if ($discovery.platform -ne 'win32' -or $discovery.arch -ne 'x64') {
    throw "Unexpected discovery platform: $($discovery.platform)/$($discovery.arch)"
  }
  if ($discovery.appPath -ne $appPath) {
    throw "Discovery appPath does not match the installed executable"
  }

  $version = & $discovery.cliPath version | ConvertFrom-Json
  if (-not $version.ok -or $version.version -ne $discovery.appVersion) {
    throw "CLI version does not match the desktop discovery record"
  }
  $doctor = & $discovery.cliPath doctor | ConvertFrom-Json
  if (-not $doctor.ok -or -not $doctor.data.desktopConnected -or -not $doctor.data.versionMatch) {
    throw "CLI doctor could not connect to the installed desktop"
  }
  $instructions = & $discovery.cliPath instructions --json | ConvertFrom-Json
  $schema = & $discovery.cliPath schema --json | ConvertFrom-Json
  if (-not $instructions.ok -or $instructions.data.platformOrder.Count -ne 6) {
    throw "CLI instructions are incomplete"
  }
  if (-not $schema.ok -or $schema.data.article.platform.Count -ne 6) {
    throw "CLI schema is incomplete"
  }

  Write-Host "Windows install smoke passed: app=$($discovery.appVersion), cli=$($version.version)"
} finally {
  if ($installDirectory) {
    Get-Process | Where-Object {
      try { $_.Path -and $_.Path.StartsWith($installDirectory, [System.StringComparison]::OrdinalIgnoreCase) } catch { $false }
    } | Stop-Process -Force -ErrorAction SilentlyContinue
  }

  if ($installDirectory) {
    $uninstaller = Join-Path $installDirectory 'Uninstall GEO Publisher.exe'
    if (Test-Path $uninstaller) {
      Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait | Out-Null
    }
  }
}
