import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { UpdateStatus } from '../shared/protocol.js';

const DEFAULT_UPDATE_BASE_URL = 'https://lingxi-1303034624.cos.ap-guangzhou.myqcloud.com/geo-publisher/releases';
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

export function updatePlatformKey(platform = process.platform, arch = process.arch): string | null {
  if (platform === 'darwin' && arch === 'arm64') return 'mac-arm64';
  if (platform === 'win32' && arch === 'x64') return 'win-x64';
  return null;
}

export function updateFeedUrl(channel = process.env.GEO_UPDATE_CHANNEL || 'stable'): string | null {
  const platform = updatePlatformKey();
  if (!platform) return null;
  const base = (process.env.GEO_UPDATE_BASE_URL || DEFAULT_UPDATE_BASE_URL).replace(/\/+$/, '');
  return `${base}/${channel}/${platform}`;
}

export function updateChannelForVersion(version: string): 'stable' | 'beta' {
  return process.env.GEO_UPDATE_CHANNEL === 'beta' || /-(?:alpha|beta)\./.test(version) ? 'beta' : 'stable';
}

export class UpdateManager {
  private status: UpdateStatus;
  private timer: NodeJS.Timeout | null = null;
  private readonly channel: 'stable' | 'beta';

  constructor(
    currentVersion: string,
    private readonly isBusy: () => boolean,
    private readonly onChange: (status: UpdateStatus) => void,
  ) {
    this.channel = updateChannelForVersion(currentVersion);
    this.status = {
      phase: app.isPackaged ? 'idle' : 'disabled',
      currentVersion,
      availableVersion: null,
      progress: null,
      message: app.isPackaged ? '等待检查更新' : '开发模式不检查更新',
      checkedAt: null,
      canRestart: false,
    };
  }

  start(): void {
    if (!app.isPackaged || !updateFeedUrl(this.channel)) return;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = this.channel === 'beta';
    autoUpdater.channel = this.channel;
    autoUpdater.setFeedURL({ provider: 'generic', url: updateFeedUrl(this.channel)! });

    autoUpdater.on('checking-for-update', () => this.patch({ phase: 'checking', message: '正在检查更新', progress: null }));
    autoUpdater.on('update-available', (info) => this.patch({ phase: 'available', availableVersion: info.version, message: `发现新版本 ${info.version}` }));
    autoUpdater.on('update-not-available', () => this.patch({ phase: 'current', message: '当前已是最新版本', checkedAt: new Date().toISOString() }));
    autoUpdater.on('download-progress', (progress) => this.patch({ phase: 'downloading', progress: Math.round(progress.percent), message: `正在下载更新 ${Math.round(progress.percent)}%` }));
    autoUpdater.on('update-downloaded', (info) => this.patch({
      phase: 'downloaded',
      availableVersion: info.version,
      progress: 100,
      message: this.isBusy() ? '更新已下载，将在发布任务完成后安装' : '更新已下载，可以重启安装',
      checkedAt: new Date().toISOString(),
      canRestart: !this.isBusy(),
    }));
    autoUpdater.on('error', (error) => this.patch({ phase: 'error', message: `检查更新失败：${error.message}`, checkedAt: new Date().toISOString(), canRestart: false }));

    setTimeout(() => { void this.check(); }, 30_000).unref();
    this.timer = setInterval(() => { void this.check(); }, CHECK_INTERVAL_MS);
    this.timer.unref();
  }

  getStatus(): UpdateStatus {
    if (this.status.phase === 'downloaded' && !this.isBusy() && !this.status.canRestart) {
      this.patch({ canRestart: true, message: '更新已下载，可以重启安装' });
    }
    return { ...this.status };
  }

  async check(): Promise<UpdateStatus> {
    if (!app.isPackaged) return this.getStatus();
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      this.patch({ phase: 'error', message: `检查更新失败：${error instanceof Error ? error.message : String(error)}`, checkedAt: new Date().toISOString(), canRestart: false });
    }
    return this.getStatus();
  }

  install(): { accepted: boolean; message: string } {
    if (this.status.phase !== 'downloaded') return { accepted: false, message: '尚未下载可安装的更新' };
    if (this.isBusy()) return { accepted: false, message: '发布任务正在运行，任务完成后才能重启安装' };
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return { accepted: true, message: '正在重启并安装更新' };
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private patch(change: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...change };
    this.onChange({ ...this.status });
  }
}
