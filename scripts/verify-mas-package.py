"""Run on the macOS runner after electron-builder, before uploading any artifact."""
import json
import os
from pathlib import Path
import plistlib
import stat
import subprocess
import tempfile

root = Path('release/store')
apps = list(root.glob('mas*/GEO Publisher.app'))
assert len(apps) == 1, 'Expected exactly one MAS application'
app = apps[0]
helper = app / 'Contents/Resources/cli/geo-publisher-darwin-arm64'
info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
assert info['CFBundleIdentifier'] == 'com.lingxi.geo-publisher'
assert info['CFBundleShortVersionString'] == os.environ['MAS_APP_VERSION']
assert info['CFBundleVersion'] == os.environ['MAS_BUILD_NUMBER']
assert info['ElectronTeamID'] == 'F8X7472LW9'
assert (app / 'Contents/embedded.provisionprofile').exists()
# Signing can succeed with root-only resources, but App Store validation will
# reject them. Audit all app resources, including the embedded public profile.
for path in [app, *app.rglob('*')]:
    mode = path.lstat().st_mode
    if stat.S_ISLNK(mode):
        continue
    assert mode & stat.S_IROTH, f'App file is not readable by normal users: {path}'
    if stat.S_ISDIR(mode) or mode & stat.S_IXUSR:
        assert mode & stat.S_IXOTH, f'App path is not executable/traversable by normal users: {path}'
source_version = json.loads(Path('package.json').read_text())['version']
packed_metadata = json.loads(subprocess.check_output([
    'node', '-e',
    "process.stdout.write(require('@electron/asar').extractFile(process.argv[1], 'package.json'))",
    str(app / 'Contents/Resources/app.asar'),
], text=True))
assert packed_metadata['version'] == source_version, 'Store version must not replace the internal product version'
for path in [app, helper]:
    subprocess.run(['codesign', '--verify', '--deep', '--strict', str(path)], check=True)
    result = subprocess.run(['codesign', '-d', '--entitlements', ':-', str(path)], check=True, capture_output=True)
    entitlement_bytes = result.stdout if b'<plist' in result.stdout else result.stderr
    start = entitlement_bytes.find(b'<?xml')
    end = entitlement_bytes.find(b'</plist>') + len(b'</plist>')
    rights = plistlib.loads(entitlement_bytes[start:end])
    assert rights.get('com.apple.security.app-sandbox') is True, 'Missing sandbox entitlement'
    assert not rights.get('com.apple.security.get-task-allow'), 'Debug entitlement in release'
    if path == helper:
        assert rights.get('com.apple.security.inherit') is True, 'CLI must inherit app sandbox'
    else:
        assert rights.get('com.apple.security.network.client') and rights.get('com.apple.security.network.server')
packages = list(app.parent.glob('*.pkg'))
assert len(packages) == 1, 'Expected one signed installer'
result = subprocess.check_output(['pkgutil', '--check-signature', str(packages[0])], text=True)
assert '3rd Party Mac Developer Installer:' in result and 'F8X7472LW9' in result, 'Wrong installer identity'
# Also verify the permissions that pkgbuild recorded for installation as root.
with tempfile.TemporaryDirectory(prefix='mas-permissions-') as directory:
    expanded = Path(directory) / 'expanded'
    subprocess.run(['pkgutil', '--expand', str(packages[0]), str(expanded)], check=True)
    boms = list(expanded.rglob('Bom'))
    assert boms, 'Missing installer bill of materials'
    for bom in boms:
        entries = subprocess.check_output(['lsbom', str(bom)], text=True)
        for entry in entries.splitlines():
            fields = entry.split('\t')
            assert len(fields) >= 2, f'Unexpected package permission entry: {entry}'
            mode = int(fields[1], 8)
            if stat.S_ISLNK(mode):
                continue
            assert mode & stat.S_IROTH, f'Installer file is not readable by normal users: {fields[0]}'
            if stat.S_ISDIR(mode) or mode & stat.S_IXUSR:
                assert mode & stat.S_IXOTH, f'Installer path lacks execute/traverse permission: {fields[0]}'
print(f"Internal version {source_version}, store version {info['CFBundleShortVersionString']}, "
      'Bundle ID, app/helper sandbox signatures, installer signature and installed file permissions verified.')
