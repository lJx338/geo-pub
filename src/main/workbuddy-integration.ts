import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, clipboard, shell } from 'electron';
import type { WorkBuddyIntegrationStatus } from '../shared/protocol.js';
import { cliExecutablePath, integrationsDirectory } from './runtime-paths.js';

const WORKBUDDY_SKILLS = ['geo-publisher', 'geo-customer-profile', 'geo-topic-planner', 'geo-article-writer', 'geo-material-organizer'] as const;

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
  topicSkillPath: string;
  articleSkillPath: string;
  materialSkillPath: string;
  platform?: NodeJS.Platform;
  arch?: string;
}): string {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const quotedCli = platform === 'win32'
    ? `& '${options.cliPath.replaceAll("'", "''")}'`
    : `'${options.cliPath.replaceAll("'", `'\\''`)}'`;
  return [
    '请从下面五个独立目录安装并启用本机 GEO Publisher 的五个 Skill；不要把它们合并成一个 Skill。',
    '以下路径由当前安装自动生成，仅适用于这台电脑；不要替换成其他电脑的路径：',
    `GEO Publisher 安装位置：${options.appPath}`,
    `发布与基础连接 Skill（geo-publisher）：${options.skillPath}`,
    `客户资料 Skill（geo-customer-profile）：${options.profileSkillPath}`,
    `选题规划 Skill（geo-topic-planner）：${options.topicSkillPath}`,
    `文章创作 Skill（geo-article-writer）：${options.articleSkillPath}`,
    `图片素材 Skill（geo-material-organizer）：${options.materialSkillPath}`,
    `CLI 位置：${options.cliPath}`,
    `CLI 调用前缀：${quotedCli}`,
    `系统与架构：${platform} / ${arch}`,
    '只允许使用上述 production CLI；不要查找或调用 geo-publisher-dev、.dev-cli 或开发诊断命令。',
    'CLI 路径可能包含空格。执行时必须把完整路径作为一个可执行文件参数；Windows PowerShell 必须保留开头的 & 和引号。',
    'Windows 首次调用请只做一次连通性检查：& \'<CLI 位置>\' doctor --json；必须看到 JSON 且包含 ok 或 command 字段后才能继续。若 PowerShell 工具只回显 powershell 路径、没有 JSON 输出，不要重复执行同一条命令，也不要判定 CLI 损坏；改用 cmd.exe /d /s /c \'"<CLI 位置>" doctor --json\'，或使用 Git Bash 调用同一个完整 CLI 路径，并继续核对 JSON 返回。',
    '不要把 CLI 路径拆成多个参数，不要用 Start-Process 丢失标准输出，也不要把 PowerShell 路径本身当作 CLI 返回。每条命令都必须捕获 stdout、stderr 和退出码；退出码非 0 或无效 JSON 才报告 CLI_EXECUTION_ERROR。',
    '安装时分别完整读取五个目录中的 SKILL.md，并保留每个目录内的 agents 与 references；以后按用户意图调用对应 Skill。',
    '用户要求收集或修改公司资料时调用 geo-customer-profile；要求整理或识别图片素材时调用 geo-material-organizer；要求意图词、选题或选题池时调用 geo-topic-planner；要求生成或修改文章时调用 geo-article-writer；要求登录、填充、发布或对账时调用 geo-publisher。',
    '每个任务先按 geo-publisher 运行 production CLI 的 doctor 和 instructions --json；多客户任务再运行 project list，按客户名称精确匹配唯一项目，执行 project select <projectId> 后用 project current 复核。不要使用其他任务缓存的客户项目。',
    '客户资料、素材、选题、文章包和分发记录都必须保存在 GEO Publisher 当前客户项目中；不要创建或要求客户维护单独工作空间。',
    '如果客户要求创建项目，先交互式收集资料并展示摘要；只有客户明确确认后，才按 Skill 调用 production CLI 的 project create。',
    '百家号、头条号、知乎、企鹅号、搜狐号、网易号的填充与发布只按 geo-publisher Skill 执行；选题和文章 Skill 不得直接控制平台页面。',
    '平台发布选项默认使用 GEO Publisher 当前客户项目中保存的默认值。只有用户明确要求“这一次”修改某个选项时，才在 draft.fill 或 draft.publish 请求中传 platformOptions 作为单次覆盖；未明确提出时禁止猜测或传覆盖值。',
    '应用更新或更换安装位置后，重新点击 GEO Publisher 的“连接 WorkBuddy”，以刷新本机路径和 Skill。',
  ].join('\n');
}

function currentApplicationPath(): string {
  // On packaged Windows builds app.getAppPath() resolves inside app.asar.
  // WorkBuddy needs the executable path the customer actually installed.
  return app.isPackaged && process.platform === 'win32' ? process.execPath : app.getAppPath();
}

export async function workBuddyIntegrationStatus(): Promise<WorkBuddyIntegrationStatus> {
  const sources = Object.fromEntries(WORKBUDDY_SKILLS.map((name) => [name, sourceSkillPath(name)])) as Record<typeof WORKBUDDY_SKILLS[number], string>;
  const targets = Object.fromEntries(WORKBUDDY_SKILLS.map((name) => [name, preparedSkillPath(name)])) as Record<typeof WORKBUDDY_SKILLS[number], string>;
  const promptPath = join(integrationsDirectory(), 'workbuddy', 'CONNECT-WORKBUDDY.txt');
  const sourceStates = await Promise.all(WORKBUDDY_SKILLS.map((name) => exists(join(sources[name], 'SKILL.md'))));
  const targetStates = await Promise.all(WORKBUDDY_SKILLS.map((name) => exists(join(targets[name], 'SKILL.md'))));
  const targetPrepared = Object.fromEntries(WORKBUDDY_SKILLS.map((name, index) => [name, targetStates[index]])) as Record<typeof WORKBUDDY_SKILLS[number], boolean>;
  return {
    available: sourceStates.every(Boolean),
    prepared: targetStates.every(Boolean),
    skillPath: targetPrepared['geo-publisher'] ? targets['geo-publisher'] : null,
    profileSkillPath: targetPrepared['geo-customer-profile'] ? targets['geo-customer-profile'] : null,
    topicSkillPath: targetPrepared['geo-topic-planner'] ? targets['geo-topic-planner'] : null,
    articleSkillPath: targetPrepared['geo-article-writer'] ? targets['geo-article-writer'] : null,
    materialSkillPath: targetPrepared['geo-material-organizer'] ? targets['geo-material-organizer'] : null,
    promptPath: await exists(promptPath) ? promptPath : null,
  };
}

export async function prepareWorkBuddyIntegration(openWorkBuddy = true, activeCliPath: string | null = null): Promise<WorkBuddyIntegrationStatus & { prompt: string }> {
  const sources = Object.fromEntries(WORKBUDDY_SKILLS.map((name) => [name, sourceSkillPath(name)])) as Record<typeof WORKBUDDY_SKILLS[number], string>;
  const targets = Object.fromEntries(WORKBUDDY_SKILLS.map((name) => [name, preparedSkillPath(name)])) as Record<typeof WORKBUDDY_SKILLS[number], string>;
  const missing = [] as string[];
  for (const name of WORKBUDDY_SKILLS) {
    if (!(await exists(join(sources[name], 'SKILL.md')))) missing.push(name);
  }
  if (missing.length > 0) throw new Error(`安装包中缺少 WorkBuddy Skill：${missing.join('、')}`);

  const directory = join(integrationsDirectory(), 'workbuddy');
  await mkdir(directory, { recursive: true });
  for (const name of WORKBUDDY_SKILLS) {
    await rm(targets[name], { recursive: true, force: true });
    await cp(sources[name], targets[name], { recursive: true });
  }

  const prompt = buildWorkBuddyPrompt({
    appPath: currentApplicationPath(),
    cliPath: activeCliPath || cliExecutablePath(),
    skillPath: targets['geo-publisher'],
    profileSkillPath: targets['geo-customer-profile'],
    topicSkillPath: targets['geo-topic-planner'],
    articleSkillPath: targets['geo-article-writer'],
    materialSkillPath: targets['geo-material-organizer'],
  });
  const promptPath = join(directory, 'CONNECT-WORKBUDDY.txt');
  await writeFile(promptPath, `${prompt}\n`, { encoding: 'utf8', mode: 0o600 });
  clipboard.writeText(prompt);

  if (openWorkBuddy && process.env.GEO_DISABLE_OPEN_WORKBUDDY !== '1') {
    await shell.openExternal('workbuddy://').catch(() => undefined);
  }
  return { ...(await workBuddyIntegrationStatus()), prompt };
}

export async function prepareWorkBuddyMaterialOrganization(activeCliPath: string | null = null): Promise<WorkBuddyIntegrationStatus & { prompt: string }> {
  const cliPath = activeCliPath || cliExecutablePath();
  const prepared = await prepareWorkBuddyIntegration(false, cliPath);
  const quotedCli = process.platform === 'win32'
    ? `& '${cliPath.replaceAll("'", "''")}'`
    : `'${cliPath.replaceAll("'", `'\\''`)}'`;
  const prompt = [
    '请使用 geo-material-organizer Skill 整理 GEO Publisher 当前客户项目中所有待整理图片。',
    `Skill 路径：${prepared.materialSkillPath}`,
    `production CLI 调用前缀：${quotedCli}`,
    '严格先运行 doctor、instructions --json 和 project current；只处理 material pending 返回的图片。',
    '逐张查看 material get 返回的本地图片，使用 material analyze 写回一次性索引；不要修改原图，不要重复分析已完成素材。',
    '完成后汇报已整理数量、低置信度数量和仍待整理数量。',
  ].join('\n');
  await writeFile(join(integrationsDirectory(), 'workbuddy', 'CONNECT-WORKBUDDY.txt'), `${prompt}\n`, { encoding: 'utf8', mode: 0o600 });
  clipboard.writeText(prompt);
  if (process.env.GEO_DISABLE_OPEN_WORKBUDDY !== '1') await shell.openExternal('workbuddy://').catch(() => undefined);
  return { ...prepared, prompt };
}

export async function readWorkBuddyPrompt(): Promise<string | null> {
  const path = join(integrationsDirectory(), 'workbuddy', 'CONNECT-WORKBUDDY.txt');
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}
