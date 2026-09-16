import { describe, expect, it } from 'vitest';
import { buildWorkBuddyPrompt, quotePowerShellLiteral, windowsCliCommand, workBuddySkillsDirectory } from './workbuddy-integration.js';

describe('WorkBuddy integration paths', () => {
  it('uses the WorkBuddy home and quotes Windows CLI paths', () => {
    const prompt = buildWorkBuddyPrompt({
      appPath: 'D:\\Apps\\GEO Publisher\\GEO Publisher.exe',
      cliPath: 'C:\\Users\\demo\\AppData\\Local\\GEO Publisher Desktop\\bin\\geo-publisher.exe',
      skillPath: 'C:\\Users\\demo\\AppData\\Local\\GEO Publisher Desktop\\integrations\\workbuddy\\geo-publisher',
      installedSkillPath: 'C:\\Users\\demo\\.workbuddy\\skills\\geo-publisher',
      discoveryPath: 'C:\\Users\\demo\\AppData\\Local\\GEO Publisher Desktop\\discovery.json',
      platform: 'win32',
    });

    expect(prompt).toContain('GEO Publisher 安装位置：D:\\Apps\\GEO Publisher\\GEO Publisher.exe');
    expect(prompt).toContain("CLI 调用前缀：& 'C:\\Users\\demo\\AppData\\Local\\GEO Publisher Desktop\\bin\\geo-publisher.exe'");
    expect(prompt).toContain("PowerShell 诊断命令：& 'C:\\Users\\demo\\AppData\\Local\\GEO Publisher Desktop\\bin\\geo-publisher.exe' doctor --json");
    expect(prompt).toContain('WorkBuddy 已安装目录：C:\\Users\\demo\\.workbuddy\\skills\\geo-publisher');
    expect(prompt).toContain('Windows PowerShell 必须保留开头的 & 和引号');
    expect(prompt).toContain("PowerShell 读取 Discovery：Get-Content -Raw -LiteralPath 'C:\\Users\\demo\\AppData\\Local\\GEO Publisher Desktop\\discovery.json'");
  });

  it('keeps Windows shell metacharacters inside literal path quotes', () => {
    const cliPath = "D:\\客户\\A&B (生产)\\O'Reilly\\geo-publisher.exe";
    expect(quotePowerShellLiteral(cliPath)).toBe("'D:\\客户\\A&B (生产)\\O''Reilly\\geo-publisher.exe'");
    expect(windowsCliCommand(cliPath, 'instructions --json')).toBe("& 'D:\\客户\\A&B (生产)\\O''Reilly\\geo-publisher.exe' instructions --json");
  });

  it('supports an explicit WorkBuddy skills directory for managed installations', () => {
    const previous = process.env.WORKBUDDY_SKILLS_DIR;
    process.env.WORKBUDDY_SKILLS_DIR = '/managed/workbuddy/skills';
    expect(workBuddySkillsDirectory()).toBe('/managed/workbuddy/skills');
    if (previous === undefined) delete process.env.WORKBUDDY_SKILLS_DIR;
    else process.env.WORKBUDDY_SKILLS_DIR = previous;
  });

  it('quotes macOS CLI paths containing spaces', () => {
    const prompt = buildWorkBuddyPrompt({
      appPath: '/Applications/Tools/GEO Publisher.app/Contents/MacOS/GEO Publisher',
      cliPath: '/Users/demo/Library/Application Support/GEO Publisher Desktop/bin/geo-publisher',
      skillPath: '/Users/demo/Library/Application Support/GEO Publisher Desktop/integrations/workbuddy/geo-publisher',
      installedSkillPath: '/Users/demo/.workbuddy/skills/geo-publisher',
      discoveryPath: '/Users/demo/Library/Application Support/GEO Publisher Desktop/discovery.json',
      platform: 'darwin',
    });

    expect(prompt).toContain('GEO Publisher 安装位置：/Applications/Tools/GEO Publisher.app/Contents/MacOS/GEO Publisher');
    expect(prompt).toContain("CLI 调用前缀：'/Users/demo/Library/Application Support/GEO Publisher Desktop/bin/geo-publisher'");
    expect(prompt).toContain('WorkBuddy 已安装目录：/Users/demo/.workbuddy/skills/geo-publisher');
  });
});
