import { describe, expect, it } from 'vitest';
import { bestMatches, isWorkTime, similarity, workHoursText, workMinutesBetween } from './inbox';

const W = { days: [1, 2, 3, 4, 5, 6, 7], start: '09:00', end: '21:00' };

describe('问句相似度', () => {
  it('同义问法能对上 FAQ，不相干的对不上', () => {
    const faqs = ['无花果怎么保存', '发货到哪些城市', '一箱多少钱'];
    const m = bestMatches('买回来的无花果要怎么保存呀？', faqs, (q) => q);
    expect(m[0].item).toBe('无花果怎么保存');
    expect(bestMatches('你们老板是谁', faqs, (q) => q)).toEqual([]);
    expect(similarity('', 'abc')).toBe(0);
  });
});

describe('工作时间', () => {
  it('按北京时间判断', () => {
    expect(isWorkTime(new Date('2026-10-19T01:00:00Z'), W)).toBe(true); // 北京 9:00
    expect(isWorkTime(new Date('2026-10-19T13:00:00Z'), W)).toBe(false); // 北京 21:00
    expect(isWorkTime(new Date('2026-10-18T02:00:00Z'), { ...W, days: [1, 2, 3, 4, 5] })).toBe(false); // 周日
  });
  it('超时只算工作时间内的分钟', () => {
    // 北京 20:58 到次日 9:03：工作时间内只有 2 + 3 分钟
    expect(workMinutesBetween(new Date('2026-10-19T12:58:00Z'), new Date('2026-10-20T01:03:00Z'), W)).toBe(5);
  });
  it('生成给客户看的时间说明', () => {
    expect(workHoursText(W)).toBe('每天 9:00–21:00');
    expect(workHoursText({ ...W, days: [1, 2, 3, 4, 5] })).toBe('周一至周五 9:00–21:00');
  });
});
