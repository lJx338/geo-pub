import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { app, clipboard, shell } from 'electron';
import { APP_NAME } from '../shared/branding.js';
import type { WorkBuddyIntegrationStatus } from '../shared/protocol.js';
import { cliExecutablePath, integrationsDirectory, isMacAppStoreRuntime, isWindowsStoreRuntime } from './runtime-paths.js';
import { externalDataDirectory, externalFilePath, externalSkillDirectory } from './windows-store-paths.js';

function powerShellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function cliCallPrefix(cliPath: string, platform = process.platform, mas = isMacAppStoreRuntime(), userData = '', windowsStore = isWindowsStoreRuntime()): string {
  if (platform === 'win32') {
    const call = `& ${powerShellQuote(cliPath)}`;
    if (!windowsStore) return call;
    if (!userData) throw new Error('Missing Microsoft Store user data directory');
    return `$env:GEO_PUBLISHER_USER_DATA_DIR=${powerShellQuote(userData)}; ${call}`;
  }
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  if (mas) {
    if (!userData) throw new Error('Missing Mac App Store user data directory');
    return `env GEO_PUBLISHER_USER_DATA_DIR=${quote(userData)} /bin/sh ${quote(cliPath)}`;
  }
  return quote(cliPath);
}

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
  mas?: boolean;
  windowsStore?: boolean;
  userData?: string;
}): string {
  const platform = options.platform ?? process.platform;
  const appName = APP_NAME;
  const arch = options.arch ?? process.arch;
  const windowsStore = platform === 'win32' && (options.windowsStore ?? isWindowsStoreRuntime());
  const quotedCli = cliCallPrefix(options.cliPath, platform, options.mas ?? false, options.userData, windowsStore);
  // Preserve cmd's nested quotes across PowerShell 5.1 and 7 native argument
  // handling. Disable delayed expansion so an exclamation mark in a path is literal.
  const windowsCheck = windowsStore
    ? `微软商店版每条命令都必须保留完整调用前缀（包括 GEO_PUBLISHER_USER_DATA_DIR），例如：${quotedCli} doctor --json。必须看到 JSON 且包含 ok 或 command 字段后才能继续。若 PowerShell 工具只回显 powershell 路径、没有 JSON 输出，不要重复执行同一条命令，也不要判定 CLI 损坏；备用检查也必须先设置同一环境变量：$env:GEO_PUBLISHER_USER_DATA_DIR=${powerShellQuote(options.userData!)}; cmd.exe --% /d /v:off /s /c ""${options.cliPath}" doctor --json"。捕获并核对 JSON 返回，不要省略数据目录设置或改用普通安装版路径。`
    : 'Windows 首次调用请只做一次连通性检查：& \'<CLI 位置>\' doctor --json；必须看到 JSON 且包含 ok 或 command 字段后才能继续。若 PowerShell 工具只回显 powershell 路径、没有 JSON 输出，不要重复执行同一条命令，也不要判定 CLI 损坏；改用 cmd.exe /d /s /c \'"<CLI 位置>" doctor --json\'，或使用 Git Bash 调用同一个完整 CLI 路径，并继续核对 JSON 返回。';
  return [
    `请从下面五个独立目录安装并启用本机 ${appName} 的五个 Skill；不要把它们合并成一个 Skill。`,
    '以下路径由当前安装自动生成，仅适用于这台电脑；不要替换成其他电脑的路径：',
    `${appName} 安装位置：${options.appPath}`,
    `发布与基础连接 Skill（geo-publisher）：${options.skillPath}`,
    `客户资料 Skill（geo-customer-profile）：${options.profileSkillPath}`,
    `选题规划 Skill（geo-topic-planner）：${options.topicSkillPath}`,
    `文章创作 Skill（geo-article-writer）：${options.articleSkillPath}`,
    `图片素材 Skill（geo-material-organizer）：${options.materialSkillPath}`,
    `CLI 位置：${options.cliPath}`,
    `CLI 调用前缀：${quotedCli}`,
    `系统与架构：${platform} / ${arch}`,
    '只允许使用上述 production CLI；不要查找或调用 geo-publisher-dev、.dev-cli 或开发诊断命令。',
    '必须原样使用完整 CLI 调用前缀，再追加命令；不要省略前缀中的环境变量、/bin/sh、& 或引号，不要改为直接执行安装包里的 Go 二进制文件。',
    'Windows PowerShell 必须保留开头的 & 和引号。',
    windowsCheck,
    '不要把 CLI 路径拆成多个参数，不要用 Start-Process 丢失标准输出，也不要把 PowerShell 路径本身当作 CLI 返回。每条命令都必须捕获 stdout、stderr 和退出码；退出码非 0 或无效 JSON 才报告 CLI_EXECUTION_ERROR。',
    '安装时分别完整读取五个目录中的 SKILL.md，并保留每个目录内的 agents 与 references；以后按用户意图调用对应 Skill。',
    '用户要求收集或修改公司资料时调用 geo-customer-profile；要求整理或识别图片素材时调用 geo-material-organizer；要求意图词、选题或选题池时调用 geo-topic-planner；要求生成或修改文章时调用 geo-article-writer；要求登录、填充、发布或对账时调用 geo-publisher。',
    '每个任务先按 geo-publisher 运行 production CLI 的 doctor 和 instructions --json；多客户任务再运行 project list，按客户名称精确匹配唯一项目，执行 project select <projectId> 后用 project current 复核。不要使用其他任务缓存的客户项目。',
    `客户资料、素材、选题、文章包和分发记录都必须保存在 ${appName} 当前客户项目中；不要创建或要求客户维护单独工作空间。`,
    '如果客户要求创建项目，先交互式收集资料并展示摘要；只有客户明确确认后，才按 Skill 调用 production CLI 的 project create。',
    '八个平台为百家号、头条号、知乎、企鹅号、搜狐号、网易号、微信公众号和列举网。写作时共用同一个选题，按各平台规则分别生成并保存一篇，所有文章关联同一个 topicId；指定部分平台时只生成对应版本，未指定时默认八篇。全部目标文章保存成功后只标记一次选题已使用。',
    '列举网使用 lieju，共用选题并单独生成标题与正文；标题 5～30 字，描述为 200～300 字的纯文本（含小标题、标点及末尾话题，不含文章标题和空白字符），保存前核对字数，按短文组织，不套用长文篇幅要求。分发只能调用 fill，返回 pending_manual 后停止，滑块验证和提交发布完全由用户手动完成；不得调用 publish 或自动继续。发布资料来自当前客户的 publishingDefaults.lieju，单价默认 1 元。',
    '微信公众号文章还需读取 geo-article-writer/references/wechat-layout.md，按约定传入 document.wechatLayout、段落 card 和 emphasis，程序负责卡片、配色和间距的渲染；不要把专家生成的 HTML 塞进正文。更新技能时保留该参考文件。',
    '分发时选择该主题对应平台的文章包，不要把一篇正文自动复用到八个平台。填充与发布只按 geo-publisher Skill 执行；选题和文章 Skill 不得直接控制平台页面。',
    '微信公众号使用 wechat，通过 fill 调用官方接口保存并读回草稿，禁止 publish 或群发。客户在桌面端的公众号连接设置填写 AppID/AppSecret；扫码登录不能替代接口配置，不要在对话或文章 JSON 中收集 AppSecret。',
    `平台发布选项默认使用 ${appName} 当前客户项目中保存的默认值。只有用户明确要求“这一次”修改某个选项时，才在 draft.fill 或 draft.publish 请求中传 platformOptions 作为单次覆盖；未明确提出时禁止猜测或传覆盖值。`,
    `应用更新或更换安装位置后，重新点击 ${appName} 的“连接 WorkBuddy”，以刷新本机路径和 Skill。`,
  ].join('\n');
}

function currentApplicationPath(): string {
  if (app.isPackaged && process.platform === 'darwin') return resolve(process.execPath, '../../..');
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
  const externalTargets = Object.fromEntries(await Promise.all(WORKBUDDY_SKILLS.map(async (name) => [
    name, targetPrepared[name] ? await externalSkillDirectory(targets[name]) : null,
  ]))) as Record<typeof WORKBUDDY_SKILLS[number], string | null>;
  return {
    available: sourceStates.every(Boolean),
    prepared: targetStates.every(Boolean),
    skillPath: externalTargets['geo-publisher'],
    profileSkillPath: externalTargets['geo-customer-profile'],
    topicSkillPath: externalTargets['geo-topic-planner'],
    articleSkillPath: externalTargets['geo-article-writer'],
    materialSkillPath: externalTargets['geo-material-organizer'],
    promptPath: await exists(promptPath) ? await externalFilePath(promptPath) : null,
  };
}

export async function prepareWorkBuddyIntegration(openWorkBuddy = true, activeCliPath: string | null = null): Promise<WorkBuddyIntegrationStatus & { prompt: string }> {
  if (isWindowsStoreRuntime() && !activeCliPath) {
    throw new Error('微软商店版 CLI 未安装成功，请完全退出并重新启动应用后再连接 WorkBuddy。');
  }
  const cliPath = await externalFilePath(activeCliPath || cliExecutablePath());
  const userData = await externalDataDirectory();
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

  const externalTargets = Object.fromEntries(await Promise.all(WORKBUDDY_SKILLS.map(async (name) => [
    name, await externalSkillDirectory(targets[name]),
  ]))) as Record<typeof WORKBUDDY_SKILLS[number], string>;
  const prompt = buildWorkBuddyPrompt({
    appPath: currentApplicationPath(),
    cliPath,
    skillPath: externalTargets['geo-publisher'],
    profileSkillPath: externalTargets['geo-customer-profile'],
    topicSkillPath: externalTargets['geo-topic-planner'],
    articleSkillPath: externalTargets['geo-article-writer'],
    materialSkillPath: externalTargets['geo-material-organizer'],
    mas: isMacAppStoreRuntime(),
    windowsStore: isWindowsStoreRuntime(),
    userData,
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
  const appName = app.getName();
  const prepared = await prepareWorkBuddyIntegration(false, activeCliPath);
  const cliPath = await externalFilePath(activeCliPath || cliExecutablePath());
  const quotedCli = cliCallPrefix(cliPath, process.platform, isMacAppStoreRuntime(), await externalDataDirectory());
  const prompt = [
    `请使用 geo-material-organizer Skill 整理 ${appName} 当前客户项目中所有待整理图片。`,
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
