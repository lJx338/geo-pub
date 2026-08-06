import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { BetaActivationResult, UpdateStatus } from '../shared/protocol.js';
import { dataDirectory } from './runtime-paths.js';

const DEFAULT_UPDATE_BASE_URL = 'https://lingxi-1303034624.cos.ap-guangzhou.myqcloud.com/geo-publisher/releases';
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const BETA_INVITE_TIMEOUT_MS = 8_000;

interface BetaInvite {
  channel: 'beta';
  expiresAt?: string;
}

export function updatePlatformKey(platform = process.platform, arch = process.arch): string | null {
  if (platform === 'darwin' && arch === 'arm64') return 'mac-arm64';
  if (platform === 'win32' && arch === 'x64') return 'win-x64';
  return null;
}

export function updateFeedUrl(
  channel = process.env.GEO_UPDATE_CHANNEL || 'stable',
  runtimePlatform = process.platform,
  runtimeArch = process.arch,
): string | null {
  const platform = updatePlatformKey(runtimePlatform, runtimeArch);
  if (!platform) return null;
  const base = (process.env.GEO_UPDATE_BASE_URL || DEFAULT_UPDATE_BASE_URL).replace(/\/+$/, '');
  return `${base}/channels/${channel}/${platform}`;
}

export function updateChannelForVersion(version: string): 'stable' | 'beta' {
  return process.env.GEO_UPDATE_CHANNEL === 'beta' || /-(?:alpha|beta)\./.test(version) ? 'beta' : 'stable';
}

export function updaterManifestChannel(channel: 'stable' | 'beta'): 'beta' | null {
  return channel === 'beta' ? 'beta' : null;
}

export class UpdateManager {
  private status: UpdateStatus;
  private timer: NodeJS.Timeout | null = null;
  private channel: 'stable' | 'beta';
  private readonly channelPath = join(dataDirectory(), 'update-channel.json');

  constructor(
    currentVersion: string,
    private readonly isBusy: () => boolean,
    private readonly onChange: (status: UpdateStatus) => void,
  ) {
    this.channel = this.readChannel(currentVersion);
    this.status = {
      phase: app.isPackaged ? 'idle' : 'disabled',
      currentVersion,
      channel: this.channel,
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
    this.configureFeed();

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

  async activateBeta(code: string): Promise<BetaActivationResult> {
    const normalized = code.trim().toUpperCase();
    if (!/^BETA-[A-Z0-9]{6,32}$/.test(normalized)) {
      return { accepted: false, enabled: this.channel === 'beta', message: '邀请码格式不正确，请输入 BETA- 开头的邀请码', update: this.getStatus() };
    }
    try {
      await this.verifyBetaInvite(normalized);
      writeFileSync(this.channelPath, JSON.stringify({ channel: 'beta', codeHash: createHash('sha256').update(normalized).digest('hex'), activatedAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
      this.channel = 'beta';
      this.patch({ channel: 'beta' });
      if (app.isPackaged) this.configureFeed();
      const update = this.getStatus();
      void this.check();
      return { accepted: true, enabled: true, message: 'Beta 灰度已开启，正在检查更新', update };
    } catch (error) {
      return { accepted: false, enabled: this.channel === 'beta', message: `保存灰度设置失败：${error instanceof Error ? error.message : String(error)}`, update: this.getStatus() };
    }
  }

  deactivateBeta(): BetaActivationResult {
    try {
      writeFileSync(this.channelPath, JSON.stringify({ channel: 'stable', deactivatedAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
      this.channel = 'stable';
      this.patch({ channel: 'stable' });
      if (app.isPackaged) this.configureFeed();
      return { accepted: true, enabled: false, message: '已恢复正式版更新通道', update: this.getStatus() };
    } catch (error) {
      return { accepted: false, enabled: this.channel === 'beta', message: `保存更新通道失败：${error instanceof Error ? error.message : String(error)}`, update: this.getStatus() };
    }
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
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
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

  private readChannel(version: string): 'stable' | 'beta' {
    try {
      const record = JSON.parse(readFileSync(this.channelPath, 'utf8')) as { channel?: string };
      if (record.channel === 'beta') return 'beta';
    } catch {
      // First launch or an old installation has no channel override.
    }
    return updateChannelForVersion(version);
  }

  private configureFeed(): void {
    autoUpdater.allowPrerelease = this.channel === 'beta';
    const manifestChannel = updaterManifestChannel(this.channel);
    autoUpdater.channel = manifestChannel ?? null;
    autoUpdater.setFeedURL({ provider: 'generic', url: updateFeedUrl(this.channel)! });
  }

  private async verifyBetaInvite(code: string): Promise<void> {
    if (!app.isPackaged && process.env.GEO_BETA_INVITE_ALLOW_LOCAL === '1') return;
    const codeHash = createHash('sha256').update(code).digest('hex');
    const base = (process.env.GEO_UPDATE_BASE_URL || DEFAULT_UPDATE_BASE_URL).replace(/\/releases\/?$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BETA_INVITE_TIMEOUT_MS);
    try {
      const response = await fetch(`${base}/invites/${codeHash}.json`, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error('邀请码无效或未开通灰度资格');
      const invite = await response.json() as BetaInvite;
      if (invite.channel !== 'beta') throw new Error('邀请码未对应 Beta 通道');
      if (invite.expiresAt && Number.isNaN(Date.parse(invite.expiresAt))) throw new Error('邀请码配置无效');
      if (invite.expiresAt && Date.parse(invite.expiresAt) <= Date.now()) throw new Error('邀请码已过期');
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new Error('邀请码验证超时，请检查网络后重试');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
