import { cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { app, clipboard, shell } from 'electron';
import type { WorkBuddyIntegrationStatus } from '../shared/protocol.js';
import { cliExecutablePath, discoveryFilePath, integrationsDirectory } from './runtime-paths.js';

function sourceSkillPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'integrations', 'workbuddy', 'geo-publisher')
    : join(app.getAppPath(), 'integrations', 'workbuddy', 'geo-publisher');
}

function preparedSkillPath(): string {
  return join(integrationsDirectory(), 'workbuddy', 'geo-publisher');
}

/** WorkBuddy auto-discovers user-installed skills from this directory. */
export function workBuddySkillsDirectory(): string {
  if (process.env.WORKBUDDY_SKILLS_DIR) return process.env.WORKBUDDY_SKILLS_DIR;
  if (process.env.WORKBUDDY_HOME) return join(process.env.WORKBUDDY_HOME, 'skills');
  return join(homedir(), '.workbuddy', 'skills');
}

/** Escape a Windows path for a PowerShell single-quoted string. */
export function quotePowerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function windowsCliCommand(cliPath: string, args = 'doctor --json'): string {
  return `& ${quotePowerShellLiteral(cliPath)} ${args}`;
}

export function buildWorkBuddyPrompt(options: {
  appPath: string;
  cliPath: string;
  skillPath: string;
  installedSkillPath: string;
  discoveryPath: string;
  platform?: NodeJS.Platform;
}): string {
  const platform = options.platform ?? process.platform;
  const quotedCli = platform === 'win32'
    ? `& ${quotePowerShellLiteral(options.cliPath)}`
    : `'${options.cliPath.replaceAll("'", `'\\''`)}'`;
  return [
    'GEO Publisher Skill 已自动安装到当前 WorkBuddy 的 Skill 目录，请重新加载 Skill 后使用。',
    '以下路径由当前电脑和当前安装自动生成，不要替换成其他电脑的路径：',
    `GEO Publisher 安装位置：${options.appPath}`,
    `Skill 目录：${options.skillPath}`,
    `WorkBuddy 已安装目录：${options.installedSkillPath}`,
    `CLI 位置：${options.cliPath}`,
    `CLI 调用前缀：${quotedCli}`,
    `Discovery 文件：${options.discoveryPath}`,
    ...(platform === 'win32' ? [
      `PowerShell 诊断命令：${windowsCliCommand(options.cliPath)}`,
      `PowerShell 读取 Discovery：Get-Content -Raw -LiteralPath ${quotePowerShellLiteral(options.discoveryPath)}`,
      `PowerShell 读取 Skill：Get-Content -Raw -LiteralPath ${quotePowerShellLiteral(`${options.installedSkillPath}\\SKILL.md`)}`,
    ] : []),
    '先完整读取 WorkBuddy 已安装目录中的 SKILL.md，然后运行 CLI 的 doctor --json 和 instructions --json。',
    'CLI 路径可能包含空格。Windows PowerShell 必须保留开头的 & 和引号；每条命令都要捕获 stdout、stderr 和退出码。',
    '以后百家号、头条号、知乎、企鹅号、搜狐号、网易号的填充与发布都按该 Skill 执行。',
  ].join('\n');
}

function currentApplicationPath(): string {
  return app.isPackaged ? process.execPath : app.getAppPath();
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function workBuddyIntegrationStatus(): Promise<WorkBuddyIntegrationStatus> {
  const source = sourceSkillPath();
  const target = preparedSkillPath();
  const promptPath = join(integrationsDirectory(), 'workbuddy', 'CONNECT-WORKBUDDY.txt');
  const installedSkill = join(workBuddySkillsDirectory(), 'geo-publisher');
  const targetReady = await exists(join(target, 'SKILL.md'));
  const installedReady = await exists(join(installedSkill, 'SKILL.md'));
  return {
    available: await exists(join(source, 'SKILL.md')),
    prepared: targetReady && installedReady,
    skillPath: installedReady ? installedSkill : null,
    promptPath: await exists(promptPath) ? promptPath : null,
  };
}

export async function prepareWorkBuddyIntegration(openWorkBuddy = true, activeCliPath: string | null = null): Promise<WorkBuddyIntegrationStatus & { prompt: string }> {
  const source = sourceSkillPath();
  if (!(await exists(join(source, 'SKILL.md')))) throw new Error('安装包中缺少 GEO Publisher Skill');
  const cliPath = activeCliPath || cliExecutablePath();
  if (!(await exists(cliPath))) throw new Error(`GEO Publisher CLI 尚未安装或已被拦截：${cliPath}`);

  const target = preparedSkillPath();
  const directory = join(integrationsDirectory(), 'workbuddy');
  await mkdir(directory, { recursive: true });
  await rm(target, { recursive: true, force: true });
  await cp(source, target, { recursive: true });

  // Install into WorkBuddy's discovery directory so the pasted prompt is not
  // the only connection mechanism. Keep the app-data copy as an auditable
  // source and stage a complete copy before replacing WorkBuddy's copy.
  const installedSkill = join(workBuddySkillsDirectory(), 'geo-publisher');
  await mkdir(workBuddySkillsDirectory(), { recursive: true });
  const temporaryInstalled = `${installedSkill}.new`;
  await rm(temporaryInstalled, { recursive: true, force: true });
  await cp(target, temporaryInstalled, { recursive: true });
  await rm(installedSkill, { recursive: true, force: true });
  await rename(temporaryInstalled, installedSkill);

  const prompt = buildWorkBuddyPrompt({
    appPath: currentApplicationPath(),
    cliPath,
    skillPath: target,
    installedSkillPath: installedSkill,
    discoveryPath: discoveryFilePath(),
  });
  const promptPath = join(directory, 'CONNECT-WORKBUDDY.txt');
  await writeFile(promptPath, `${prompt}\n`, { encoding: 'utf8', mode: 0o600 });
  clipboard.writeText(prompt);

  if (openWorkBuddy && process.env.GEO_DISABLE_OPEN_WORKBUDDY !== '1') {
    await shell.openExternal('workbuddy://').catch(() => undefined);
  }
  return { ...(await workBuddyIntegrationStatus()), prompt };
}

export async function readWorkBuddyPrompt(): Promise<string | null> {
  const path = join(integrationsDirectory(), 'workbuddy', 'CONNECT-WORKBUDDY.txt');
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}
