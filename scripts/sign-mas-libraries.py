"""Sign shared code without process entitlements, before signing the executables."""
import argparse
import json
from pathlib import Path
import subprocess
import sys

from mas_macho import library_signing_targets


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('app', type=Path)
    parser.add_argument('identity')
    parser.add_argument('--keychain')
    args = parser.parse_args()
    if sys.platform != 'darwin':
        raise SystemExit('MAS signing requires macOS')
    app = args.app.resolve(strict=True)
    if app.suffix != '.app' or not args.identity or args.identity == '-':
        raise ValueError('Expected an app bundle and a distribution signing identity')
    targets = library_signing_targets(app)
    for target in targets:
        command = ['codesign', '--force', '--sign', args.identity, '--timestamp']
        if args.keychain:
            command.extend(['--keychain', args.keychain])
        # Do not use --deep, --entitlements or preserve existing entitlements.
        subprocess.run([*command, str(target)], check=True, stdout=sys.stderr)
    # osx-sign must skip these already-signed paths, including symlink aliases.
    print(json.dumps([str(path.resolve()) for path in targets]))


if __name__ == '__main__':
    main()
