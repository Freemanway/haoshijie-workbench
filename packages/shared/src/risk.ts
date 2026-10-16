/**
 * 内容风控词库匹配（PRD 7.2 词库匹配，任务 M5-2）。
 * 精确匹配 + 空格/符号拆字变体，单条私信回复需在 100 毫秒内返回。
 * 谐音与拼音变体通过在词库里登记变体词实现（如“薇信”“VX”）。
 */
export type RiskLevel = 'block' | 'warn' | 'pass';

export interface RiskRule {
  category: string;
  level: RiskLevel;
  words: string[];
}

export interface RiskHit {
  start: number;
  end: number;
  matched: string;
  word: string;
  level: RiskLevel;
  category: string;
  suggestion?: string;
}

/** 初始词库，来自 PRD 7.1，上线前由运营补充并对照平台最新社区规范确认。 */
export const DEFAULT_RULES: RiskRule[] = [
  {
    category: '医疗功效与疗效承诺',
    level: 'block',
    words: ['治便秘', '治疗', '治愈', '抗癌', '降血糖', '降血压', '润肠通便', '排毒', '增强免疫力', '养胃', '消炎'],
  },
  { category: '绝对化用语', level: 'block', words: ['最好', '第一', '顶级', '国家级', '100%', '绝对'] },
  { category: '平台引流敏感词', level: 'warn', words: ['微信号', 'VX', '薇信', '加我', '二维码'] },
  { category: '营销敏感词', level: 'warn', words: ['秒杀', '全网最低价', '限时免费'] },
];

export const DEFAULT_SUGGESTIONS: Record<string, string> = {
  养胃: '口感绵软，适合早餐搭配',
  润肠通便: '富含膳食纤维（以检测报告为准）',
  增强免疫力: '当季鲜果，营养丰富',
  排毒: '清爽解腻',
  最好: '很受欢迎',
  顶级: '精选',
  加我: '点击下方卡片',
  VX: '官方留资卡',
  微信号: '官方留资卡',
  二维码: '官方留资卡',
  秒杀: '限量',
  全网最低价: '产地直供价',
};

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 字与字之间允许空白或常见分隔符，识别“润 肠 通 便”“养-胃”这类拆字。 */
const fuzzy = (w: string) => new RegExp([...w].map(escapeRegExp).join('[\\s\\-_·.*]*'), 'gi');

interface CompiledRule {
  re: RegExp;
  word: string;
  level: RiskLevel;
  category: string;
}

export class RiskEngine {
  private readonly compiled: CompiledRule[];
  private readonly whitelist: RegExp[];

  /**
   * @param whitelist 白名单短语：命中词完全落在白名单短语里时放行，
   *   例如白名单“第一次”可放行“第一次吃”里的“第一”。
   */
  constructor(
    rules: RiskRule[] = DEFAULT_RULES,
    private readonly suggestions: Record<string, string> = DEFAULT_SUGGESTIONS,
    whitelist: string[] = [],
  ) {
    this.compiled = rules
      .filter((r) => r.level !== 'pass')
      .flatMap((r) =>
        r.words.map((w) => ({ re: fuzzy(w), word: w, level: r.level, category: r.category })),
      );
    this.whitelist = whitelist.filter(Boolean).map(fuzzy);
  }

  /** 返回不重叠的命中，同一位置优先取更长的词。 */
  scan(text: string): RiskHit[] {
    const safe: Array<[number, number]> = [];
    for (const re of this.whitelist) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) safe.push([m.index, m.index + m[0].length]);
    }
    const hits: RiskHit[] = [];
    for (const c of this.compiled) {
      c.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = c.re.exec(text))) {
        const s = m.index;
        const e = s + m[0].length;
        if (safe.some(([a, b]) => a <= s && e <= b)) continue;
        hits.push({
          start: m.index,
          end: m.index + m[0].length,
          matched: m[0],
          word: c.word,
          level: c.level,
          category: c.category,
          suggestion: this.suggestions[c.word],
        });
      }
    }
    hits.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
    const out: RiskHit[] = [];
    let end = -1;
    for (const h of hits) {
      if (h.start >= end) {
        out.push(h);
        end = h.end;
      }
    }
    return out;
  }

  /** 是否存在拦截级命中：稿件不能通过，自动回复不能发出。 */
  isBlocked(text: string): boolean {
    return this.scan(text).some((h) => h.level === 'block');
  }
}
