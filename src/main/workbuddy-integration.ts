import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, clipboard, shell } from 'electron';
import type { WorkBuddyIntegrationStatus } from '../shared/protocol.js';
import { cliExecutablePath, integrationsDirectory } from './runtime-paths.js';

function sourceSkillPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'integrations', 'workbuddy', 'geo-publisher')
    : join(app.getAppPath(), 'integrations', 'workbuddy', 'geo-publisher');
}

function preparedSkillPath(): string {
  return join(integrationsDirectory(), 'workbuddy', 'geo-publisher');
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
  return {
    available: await exists(join(source, 'SKILL.md')),
    prepared: await exists(join(target, 'SKILL.md')),
    skillPath: await exists(join(target, 'SKILL.md')) ? target : null,
    promptPath: await exists(promptPath) ? promptPath : null,
  };
}

export async function prepareWorkBuddyIntegration(openWorkBuddy = true, activeCliPath: string | null = null): Promise<WorkBuddyIntegrationStatus & { prompt: string }> {
  const source = sourceSkillPath();
  if (!(await exists(join(source, 'SKILL.md')))) throw new Error('安装包中缺少 GEO Publisher Skill');

  const target = preparedSkillPath();
  const directory = join(integrationsDirectory(), 'workbuddy');
  await mkdir(directory, { recursive: true });
  await rm(target, { recursive: true, force: true });
  await cp(source, target, { recursive: true });

  const prompt = [
    '请安装并启用本机 GEO Publisher Skill。',
    `Skill 目录：${target}`,
    `CLI 位置：${activeCliPath || cliExecutablePath()}`,
    '先完整读取 Skill 目录中的 SKILL.md，然后运行 CLI 的 doctor 和 instructions --json。',
    '以后百家号、头条号、知乎、企鹅号、搜狐号、网易号的填充与发布都按该 Skill 执行。',
  ].join('\n');
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
