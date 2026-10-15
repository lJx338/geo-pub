"""Verify the actual distributable before exposing it as an Actions artifact."""

import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import subprocess
import sys
import tempfile


def run(*args):
    try:
        return subprocess.check_output([str(arg) for arg in args], stderr=subprocess.STDOUT)
    except subprocess.CalledProcessError as error:
        print(error.output.decode(errors='replace'), file=sys.stderr)
        raise


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def verify_signature(target, team):
    run('codesign', '--verify', '--deep', '--strict', '--verbose=2', target)
    details = run('codesign', '--display', '--verbose=4', target).decode()
    require('Authority=Developer ID Application:' in details, f'Not a Developer ID signature: {target}')
    require(f'TeamIdentifier={team}' in details.splitlines(), f'Wrong signing team: {target}')


def main():
    require(platform.system() == 'Darwin', 'DMG verification requires macOS')
    team = os.environ.get('APPLE_TEAM_ID')
    require(bool(team), 'Missing APPLE_TEAM_ID')
    package = json.loads(Path('package.json').read_text(encoding='utf-8'))
    output = Path('release/mac-dmg').resolve()
    images = list(output.glob('*.dmg'))
    require(len(images) == 1, 'Expected exactly one DMG')
    dmg = images[0]
    run('hdiutil', 'verify', dmg)

    with tempfile.TemporaryDirectory(prefix='geo-dmg-verify-') as temporary:
        mount = Path(temporary) / 'mounted'
        mount.mkdir()
        run('hdiutil', 'attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg)
        try:
            apps = list(mount.glob('*.app'))
            require(len(apps) == 1, 'Expected exactly one application in DMG')
            app = apps[0]
            info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
            require(info['CFBundleIdentifier'] == package['build']['appId'], 'Unexpected Bundle ID')
            require(info['CFBundleShortVersionString'] == package['version'], 'Application version mismatch')
            executable = app / 'Contents/MacOS' / info['CFBundleExecutable']
            cli = app / 'Contents/Resources/cli/geo-publisher-darwin-arm64'
            for binary in (executable, cli):
                require(binary.is_file(), f'Missing executable: {binary}')
                run('lipo', binary, '-verify_arch', 'arm64')
            verify_signature(app, team)
            verify_signature(cli, team)
            run('xcrun', 'stapler', 'validate', app)
            run('spctl', '--assess', '--type', 'execute', '--verbose=2', app)
            if platform.machine() == 'arm64':
                cli_version = json.loads(run(cli, 'version'))
                require(cli_version.get('ok') is True and cli_version.get('version') == package['version'],
                        'Bundled CLI version mismatch')
        finally:
            run('hdiutil', 'detach', mount)

    digest = hashlib.sha256()
    with dmg.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    checksum = digest.hexdigest()
    (output / 'SHA256SUMS.txt').write_text(f'{checksum}  {dmg.name}\n', encoding='utf-8')
    metadata = {
        'version': package['version'],
        'architecture': 'arm64',
        'file': dmg.name,
        'sha256': checksum,
        'size': dmg.stat().st_size,
        'commit': run('git', 'rev-parse', 'HEAD').decode().strip(),
        'runId': os.environ.get('GITHUB_RUN_ID'),
        'runAttempt': os.environ.get('GITHUB_RUN_ATTEMPT'),
        'verified': ['dmg-integrity', 'mount', 'version', 'architecture', 'developer-id-signatures',
                     'stapled-notarization-ticket', 'gatekeeper'],
    }
    (output / 'build-info.json').write_text(json.dumps(metadata, indent=2) + '\n', encoding='utf-8')
    print(f'Verified {dmg.name}: {checksum}')


if __name__ == '__main__':
    main()
