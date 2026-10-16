import { describe, expect, it } from 'vitest';
import { addDays, checkXhsDraft, DEFAULT_SEASON_NODES, mondayOf, nextMonday, nodesBetween, textLength } from './content';

describe('小红书稿件规格', () => {
  const ok = { title: '无花果怎么挑🍈', body: '正文', tags: ['a', 'b', 'c', 'd', 'e'] };
  it('符合规格时没有问题', () => expect(checkXhsDraft(ok)).toEqual([]));
  it('emoji 按 1 个字计', () => expect(textLength('🍈无花果')).toBe(4));
  it('标题超长、标签太少都会报出', () => {
    const p = checkXhsDraft({ ...ok, title: '一'.repeat(21), tags: ['a'] });
    expect(p).toHaveLength(2);
    expect(p[0]).toContain('21 字');
  });
});

describe('周与季节节点', () => {
  it('按北京时间算周一：周日深夜仍属本周', () => {
    // 2026-10-18 周日 23:30（北京时间）= 15:30Z
    expect(mondayOf(new Date('2026-10-18T15:30:00Z'))).toBe('2026-10-12');
    // 2026-10-19 周一 00:30（北京时间）= 前一天 16:30Z
    expect(mondayOf(new Date('2026-10-18T16:30:00Z'))).toBe('2026-10-19');
  });
  it('周四生成下周清单', () => expect(nextMonday(new Date('2026-10-15T01:00:00Z'))).toBe('2026-10-19'));
  it('取与下周有交集的节点', () => {
    const names = nodesBetween(DEFAULT_SEASON_NODES, '2026-10-05', addDays('2026-10-05', 6)).map((n) => n.name);
    expect(names).toEqual(['国庆']);
  });
});
