import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildWorkBuddyPrompt } from './workbuddy-integration.js';

describe('WorkBuddy connection prompt', () => {
  it('uses the current installation and runtime paths instead of a fixed user path', () => {
    const prompt = buildWorkBuddyPrompt({
      appPath: 'D:\\Apps\\GEO Publisher\\GEO Publisher.exe',
      cliPath: 'C:\\Users\\demo\\AppData\\Local\\GEO Publisher Desktop\\bin\\versions\\0.5.0\\geo-publisher.exe',
      skillPath: 'C:\\Users\\demo\\AppData\\Local\\GEO Publisher Desktop\\integrations\\workbuddy\\geo-publisher',
      profileSkillPath: 'C:\\Users\\demo\\AppData\\Local\\GEO Publisher Desktop\\integrations\\workbuddy\\geo-customer-profile',
      topicSkillPath: 'C:\\Users\\demo\\AppData\\Local\\GEO Publisher Desktop\\integrations\\workbuddy\\geo-topic-planner',
      articleSkillPath: 'C:\\Users\\demo\\AppData\\Local\\GEO Publisher Desktop\\integrations\\workbuddy\\geo-article-writer',
      materialSkillPath: 'C:\\Users\\demo\\AppData\\Local\\GEO Publisher Desktop\\integrations\\workbuddy\\geo-material-organizer',
      platform: 'win32',
      arch: 'x64',
    });
    expect(prompt).toContain('GEO Publisher 安装位置：D:\\Apps\\GEO Publisher\\GEO Publisher.exe');
    expect(prompt).toContain('系统与架构：win32 / x64');
    expect(prompt).toContain("CLI 调用前缀：& 'C:\\Users\\demo\\AppData\\Local\\GEO Publisher Desktop\\bin\\versions\\0.5.0\\geo-publisher.exe'");
    expect(prompt).toContain('Windows PowerShell 必须保留开头的 & 和引号');
    expect(prompt).toContain('若 PowerShell 工具只回显 powershell 路径');
    expect(prompt).toContain('cmd.exe /d /s /c');
    expect(prompt).toContain('只允许使用上述 production CLI');
    expect(prompt).toContain('不要替换成其他电脑的路径');
    expect(prompt).toContain('客户资料 Skill（geo-customer-profile）：C:\\Users\\demo\\AppData\\Local\\GEO Publisher Desktop\\integrations\\workbuddy\\geo-customer-profile');
    expect(prompt).toContain('选题规划 Skill（geo-topic-planner）：C:\\Users\\demo\\AppData\\Local\\GEO Publisher Desktop\\integrations\\workbuddy\\geo-topic-planner');
    expect(prompt).toContain('文章创作 Skill（geo-article-writer）：C:\\Users\\demo\\AppData\\Local\\GEO Publisher Desktop\\integrations\\workbuddy\\geo-article-writer');
    expect(prompt).toContain('图片素材 Skill（geo-material-organizer）：C:\\Users\\demo\\AppData\\Local\\GEO Publisher Desktop\\integrations\\workbuddy\\geo-material-organizer');
    expect(prompt).toContain('五个 Skill');
    expect(prompt).toContain('只有客户明确确认后');
    expect(prompt).toContain('应用更新或更换安装位置后');
  });

  it('quotes macOS CLI paths containing spaces', () => {
    const prompt = buildWorkBuddyPrompt({
      appPath: '/Applications/GEO Publisher.app',
      cliPath: '/Users/demo/Library/Application Support/GEO Publisher Desktop/bin/geo-publisher',
      skillPath: '/Users/demo/Library/Application Support/GEO Publisher Desktop/integrations/workbuddy/geo-publisher',
      profileSkillPath: '/Users/demo/Library/Application Support/GEO Publisher Desktop/integrations/workbuddy/geo-customer-profile',
      topicSkillPath: '/Users/demo/Library/Application Support/GEO Publisher Desktop/integrations/workbuddy/geo-topic-planner',
      articleSkillPath: '/Users/demo/Library/Application Support/GEO Publisher Desktop/integrations/workbuddy/geo-article-writer',
      materialSkillPath: '/Users/demo/Library/Application Support/GEO Publisher Desktop/integrations/workbuddy/geo-material-organizer',
      platform: 'darwin',
    });
    expect(prompt).toContain("CLI 调用前缀：'/Users/demo/Library/Application Support/GEO Publisher Desktop/bin/geo-publisher'");
  });

  it('ships a dedicated customer profile skill with the WorkBuddy integration', async () => {
    const skill = await readFile(join(process.cwd(), 'integrations', 'workbuddy', 'geo-customer-profile', 'SKILL.md'), 'utf8');
    expect(skill).toContain('name: geo-customer-profile');
    expect(skill).toContain('Use at most two collection rounds');
    expect(skill).toContain('confirmCreate: true');
  });

  it('ships separate topic planning and article writing skills with routed references', async () => {
    const topic = await readFile(join(process.cwd(), 'integrations', 'workbuddy', 'geo-topic-planner', 'SKILL.md'), 'utf8');
    const writer = await readFile(join(process.cwd(), 'integrations', 'workbuddy', 'geo-article-writer', 'SKILL.md'), 'utf8');
    const sevenDimension = await readFile(join(process.cwd(), 'integrations', 'workbuddy', 'geo-article-writer', 'references', 'structures', 'seven-dimension.md'), 'utf8');
    expect(topic).toContain('name: geo-topic-planner');
    expect(topic).toContain('content save <projectId>');
    expect(writer).toContain('name: geo-article-writer');
    expect(writer).toContain('Do not load all structure files');
    expect(sevenDimension).toContain('Seven-Dimension Structure');
  });

  it('ships a dedicated one-time image material organizer skill', async () => {
    const skill = await readFile(join(process.cwd(), 'integrations', 'workbuddy', 'geo-material-organizer', 'SKILL.md'), 'utf8');
    expect(skill).toContain('name: geo-material-organizer');
    expect(skill).toContain('material pending');
    expect(skill).toContain('material analyze');
    expect(skill).toContain('Do not reanalyze');
  });
});
