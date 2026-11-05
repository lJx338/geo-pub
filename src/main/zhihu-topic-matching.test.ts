import { describe, expect, it } from 'vitest';
import { chooseZhihuTopic, zhihuTopicSearchQueries } from './zhihu-topic-matching.js';

describe('Zhihu related topics', () => {
  it('shortens complete words and retains acronyms', () => {
    expect(zhihuTopicSearchQueries('CNC铣削')).toEqual(['CNC铣削', 'CNC', '铣削']);
    expect(zhihuTopicSearchQueries('食品安全')).toEqual(['食品安全', '食品']);
    expect(zhihuTopicSearchQueries('安全')).toEqual(['安全']);
    expect(zhihuTopicSearchQueries('供应商审核')).toEqual(['供应商审核', '供应商', '审核']);
  });
  it('prefers exact topics even when a related result is first', () => {
    expect(chooseZhihuTopic('CNC铣削', ['CNC加工', 'cnc铣削'], 'CNC加工工艺')?.selected).toBe('cnc铣削');
    expect(chooseZhihuTopic('CNC 铣削', ['cnc铣削'], '')?.reason).toBe('同名匹配');
  });
  it('chooses machining from the real CNC example using article context', () => {
    expect(chooseZhihuTopic('CNC铣削', ['CNC编程', 'CNC雕刻机', 'CNC加工', 'cnc数控'], '铣削加工工艺与零件质量')?.selected).toBe('CNC加工');
  });
  it('does not select a different subject just because it shares characters', () => {
    expect(chooseZhihuTopic('食品安全', ['食品摄影', '网络安全'], '食品生产与安全检查')).toBeNull();
    expect(chooseZhihuTopic('CNC铣削', ['CNC编程', 'CNC雕刻机'], '铣削工艺与零件质量')).toBeNull();
    expect(chooseZhihuTopic('CNC铣削', ['CNC编程'], '这篇文章不涉及CNC编程')).toBeNull();
  });
  it('accepts a broader classification but skips equally supported alternatives', () => {
    expect(chooseZhihuTopic('食品安全', ['食品'], '食品检验')?.selected).toBe('食品');
    expect(chooseZhihuTopic('CNC铣削', ['CNC编程', 'CNC加工'], '编程与加工')).toBeNull();
  });
});
