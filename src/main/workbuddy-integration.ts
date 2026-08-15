import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, clipboard, shell } from 'electron';
import type { WorkBuddyIntegrationStatus } from '../shared/protocol.js';
import { cliExecutablePath, integrationsDirectory } from './runtime-paths.js';

function sourceSkillPath(name = 'geo-publisher'): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'integrations', 'workbuddy', name)
    : join(app.getAppPath(), 'integrations', 'workbuddy', name);
}

function preparedSkillPath(name = 'geo-publisher'): string {
  return join(integrationsDirectory(), 'workbuddy', name);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export function buildWorkBuddyPrompt(options: {
  appPath: string;
  cliPath: string;
  skillPath: string;
  profileSkillPath: string;
  platform?: NodeJS.Platform;
  arch?: string;
}): string {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const quotedCli = platform === 'win32'
    ? `& '${options.cliPath.replaceAll("'", "''")}'`
    : `'${options.cliPath.replaceAll("'", `'\\''`)}'`;
  return [
    '请安装并启用本机 GEO Publisher 的两个 Skill。',
    '以下路径由当前安装自动生成，仅适用于这台电脑；不要替换成其他电脑的路径：',
    `GEO Publisher 安装位置：${options.appPath}`,
    `Skill 目录：${options.skillPath}`,
    `客户资料 Skill 目录：${options.profileSkillPath}`,
    `CLI 位置：${options.cliPath}`,
    `CLI 调用前缀：${quotedCli}`,
    `系统与架构：${platform} / ${arch}`,
    '只允许使用上述 production CLI；不要查找或调用 geo-publisher-dev、.dev-cli 或开发诊断命令。',
    'CLI 路径可能包含空格。执行时必须把完整路径作为一个可执行文件参数；Windows PowerShell 必须保留开头的 & 和引号。',
    '先完整读取两个 Skill 目录中的 SKILL.md，然后运行 CLI 的 doctor 和 instructions --json。',
    '客户资料、素材、选题、文章包和分发记录都必须保存在 GEO Publisher 当前客户项目中；不要创建或要求客户维护单独工作空间。',
    '如果客户要求创建项目，先交互式收集资料并展示摘要；只有客户明确确认后，才按 Skill 调用 production CLI 的 project create。',
    '以后百家号、头条号、知乎、企鹅号、搜狐号、网易号的填充与发布都按该 Skill 执行。',
    '应用更新或更换安装位置后，重新点击 GEO Publisher 的“连接 WorkBuddy”，以刷新本机路径和 Skill。',
  ].join('\n');
}

function currentApplicationPath(): string {
  // On packaged Windows builds app.getAppPath() resolves inside app.asar.
  // WorkBuddy needs the executable path the customer actually installed.
  return app.isPackaged && process.platform === 'win32' ? process.execPath : app.getAppPath();
}

export async function workBuddyIntegrationStatus(): Promise<WorkBuddyIntegrationStatus> {
  const source = sourceSkillPath();
  const profileSource = sourceSkillPath('geo-customer-profile');
  const target = preparedSkillPath();
  const profileTarget = preparedSkillPath('geo-customer-profile');
  const promptPath = join(integrationsDirectory(), 'workbuddy', 'CONNECT-WORKBUDDY.txt');
  const sourceAvailable = await exists(join(source, 'SKILL.md'));
  const profileSourceAvailable = await exists(join(profileSource, 'SKILL.md'));
  const targetPrepared = await exists(join(target, 'SKILL.md'));
  const profileTargetPrepared = await exists(join(profileTarget, 'SKILL.md'));
  return {
    available: sourceAvailable && profileSourceAvailable,
    prepared: targetPrepared && profileTargetPrepared,
    skillPath: targetPrepared ? target : null,
    profileSkillPath: profileTargetPrepared ? profileTarget : null,
    promptPath: await exists(promptPath) ? promptPath : null,
  };
}

export async function prepareWorkBuddyIntegration(openWorkBuddy = true, activeCliPath: string | null = null): Promise<WorkBuddyIntegrationStatus & { prompt: string }> {
  const source = sourceSkillPath();
  const profileSource = sourceSkillPath('geo-customer-profile');
  if (!(await exists(join(source, 'SKILL.md'))) || !(await exists(join(profileSource, 'SKILL.md')))) {
    throw new Error('安装包中缺少 GEO Publisher 或客户资料收集 Skill');
  }

  const target = preparedSkillPath();
  const profileTarget = preparedSkillPath('geo-customer-profile');
  const directory = join(integrationsDirectory(), 'workbuddy');
  await mkdir(directory, { recursive: true });
  await rm(target, { recursive: true, force: true });
  await rm(profileTarget, { recursive: true, force: true });
  await cp(source, target, { recursive: true });
  await cp(profileSource, profileTarget, { recursive: true });

  const prompt = buildWorkBuddyPrompt({
    appPath: currentApplicationPath(),
    cliPath: activeCliPath || cliExecutablePath(),
    skillPath: target,
    profileSkillPath: profileTarget,
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
