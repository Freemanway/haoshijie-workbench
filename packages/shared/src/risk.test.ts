import { describe, expect, it } from 'vitest';
import { RiskEngine } from './risk';

const engine = new RiskEngine();

describe('RiskEngine', () => {
  it('拦截医疗功效表述', () => {
    const hits = engine.scan('每天吃两个，润肠通便');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ word: '润肠通便', level: 'block' });
    expect(engine.isBlocked('每天吃两个，润肠通便')).toBe(true);
  });

  it('识别空格和符号拆字', () => {
    expect(engine.scan('润 肠 通-便')[0]?.word).toBe('润肠通便');
    expect(engine.scan('养·胃')[0]?.word).toBe('养胃');
  });

  it('引流词只警告，不拦截', () => {
    const text = '想要的加我 vx';
    expect(engine.scan(text).map((h) => h.level)).toEqual(['warn', 'warn']);
    expect(engine.isBlocked(text)).toBe(false);
  });

  it('长词优先，不重复计数', () => {
    const hits = engine.scan('无花果能治便秘吗');
    expect(hits).toHaveLength(1);
    expect(hits[0].word).toBe('治便秘');
  });

  it('白名单词不再命中', () => {
    expect(new RiskEngine(undefined, undefined, ['第一']).scan('第一次吃')).toHaveLength(0);
  });

  it('合规文本不命中', () => {
    expect(engine.scan('富含膳食纤维，早餐配酸奶很合适')).toHaveLength(0);
  });
});

describe('RiskEngine 白名单短语', () => {
  it('命中词落在白名单短语里时放行，其他位置照常命中', () => {
    const e = new RiskEngine(undefined, undefined, ['第一次']);
    expect(e.scan('第一次吃无花果')).toHaveLength(0);
    expect(e.scan('第一次吃，全国第一')).toHaveLength(1);
  });

  it('pass 级规则不产生命中', () => {
    const e = new RiskEngine([{ category: '食养知识', level: 'pass', words: ['膳食纤维'] }]);
    expect(e.scan('富含膳食纤维')).toHaveLength(0);
  });
});
