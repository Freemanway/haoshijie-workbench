import { describe, expect, it } from 'vitest';
import { diffLines, draftText } from './diff';

describe('修改前后对比', () => {
  it('标出删除和新增的行', () => {
    const d = diffLines('标题\n第一段\n第二段', '标题\n第一段改过\n第二段\n结尾');
    expect(d).toEqual([
      { type: 'same', text: '标题' },
      { type: 'del', text: '第一段' },
      { type: 'add', text: '第一段改过' },
      { type: 'same', text: '第二段' },
      { type: 'add', text: '结尾' },
    ]);
  });
  it('拼出的稿件文本包含标签', () => {
    expect(draftText({ title: 't', body: 'b', tags: ['无花果'] })).toBe('t\n\nb\n\n#无花果');
  });
});
