import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';

const isolatedUserDataDirectory = join(process.cwd(), 'release', 'test-background-user-data');
const isolatedControlEndpoint = join(isolatedUserDataDirectory, 'control.sock');
await mkdir(isolatedUserDataDirectory, { recursive: true });

const app = await electron.launch({
  args: ['.', '--background'],
  cwd: process.cwd(),
  env: {
    ...process.env,
    GEO_DISABLE_OPEN_WORKBUDDY: '1',
    GEO_PUBLISHER_USER_DATA_DIR: isolatedUserDataDirectory,
    GEO_PUBLISHER_CONTROL_ENDPOINT: isolatedControlEndpoint,
  },
});

try {
  await new Promise((resolve) => setTimeout(resolve, 800));
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => ({ visible: window.isVisible(), focused: window.isFocused() })));
  if (windows.length < 2 || windows.some((window) => window.visible || window.focused)) {
    throw new Error(`background launch showed a window: ${JSON.stringify(windows)}`);
  }
} finally {
  await app.close();
}
