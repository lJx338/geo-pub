import packageJson from '../package.json' with { type: 'json' };

// Keep these overrides local to manual DMG builds; store and COS builds use
// their existing configuration. The native CLI is signed outside app.asar.
export default {
  ...packageJson.build,
  directories: { output: 'release/mac-dmg' },
  files: ['dist/**/*', '!dist/cli/**/*', 'package.json'],
  publish: null,
  mac: {
    ...packageJson.build.mac,
    target: [{ target: 'dmg', arch: ['arm64'] }],
    binaries: ['Contents/Resources/cli/geo-publisher-darwin-arm64'],
    forceCodeSigning: true,
    hardenedRuntime: true,
    notarize: true,
  },
  dmg: { writeUpdateInfo: false },
};
