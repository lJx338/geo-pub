import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { normalizePenguinTags } from './penguin-adapter.js';

function imageDetectionScripts(): string[] {
  const source = ts.createSourceFile('penguin-adapter.ts', readFileSync(new URL('./penguin-adapter.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const scripts: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'executeJavaScript') {
      const argument = node.arguments[0];
      if (argument && ts.isTemplateLiteral(argument) && argument.getText(source).includes('data:image')) {
        scripts.push(ts.isNoSubstitutionTemplateLiteral(argument)
          ? argument.text
          : argument.head.text + argument.templateSpans.map((span) => '"test title"' + span.literal.text).join(''));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return scripts;
}

describe('企鹅号图片检测注入脚本', () => {
  const scripts = imageDetectionScripts();

  it('parses all three scripts after template literal escaping', () => {
    expect(scripts).toHaveLength(3);
    for (const script of scripts) expect(() => new Function(script)).not.toThrow();
  });

  it.each([
    ['https://example.com/image.png', true],
    ['http://example.com/image.png', true],
    ['blob:example-image', true],
    ['data:image/png;base64,AAAA', true],
    ['DATA:IMAGE/PNG;BASE64,AAAA', true],
    ['data:text/html,invalid', false],
    ['javascript:invalid', false],
    ['', false],
  ])('checks image source %s consistently', (source, expected) => {
    class ImageElement {
      currentSrc = source;
      src = source;
      getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; }
    }
    const document = {
      querySelectorAll: () => [new ImageElement()],
      querySelector: () => null,
    };
    for (const script of scripts) {
      const result = new Function('document', 'HTMLElement', 'HTMLImageElement', 'localStorage', 'return ' + script)(document, ImageElement, ImageElement, {});
      expect(Boolean(result)).toBe(expected);
    }
  });
});

describe('企鹅号标签规范化', () => {
  it('splits, de-duplicates, strips hashes, and applies platform limits', () => {
    expect(normalizePenguinTags(['#春日，生活随笔', '春日', '八个字刚好', '超过八个字符的标签'])).toEqual([
      '春日', '生活随笔', '八个字刚好',
    ]);
  });
});
