/** 收件箱（M8）用到的纯函数：问句相似度、工作时间判断。前后端共用。 */

const PUNCT = /[\s\p{P}\p{S}]+/gu;

function bigrams(text: string) {
  const s = text.toLowerCase().replace(PUNCT, '');
  const out = new Set<string>();
  if (s.length === 1) out.add(s);
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

/**
 * 两句话的相似度（0–1）：按相邻两字切分后算重合比例，以较短一句为分母。
 * 用于把客户问题和 FAQ 对上；语义检索（pgvector）接入后替换，接口不变。
 */
export function similarity(a: string, b: string) {
  const x = bigrams(a);
  const y = bigrams(b);
  if (!x.size || !y.size) return 0;
  let same = 0;
  for (const g of x) if (y.has(g)) same++;
  return same / Math.min(x.size, y.size);
}

/** 从候选里挑和问题最像的几条，低于阈值的不要。 */
export function bestMatches<T>(question: string, items: T[], text: (t: T) => string, opts: { min?: number; take?: number } = {}) {
  const { min = 0.34, take = 3 } = opts;
  return items
    .map((item) => ({ item, score: similarity(question, text(item)) }))
    .filter((m) => m.score >= min)
    .sort((a, b) => b.score - a.score)
    .slice(0, take);
}

export interface WorkHours {
  /** 1–7，周一为 1 */
  days: number[];
  /** HH:mm，北京时间 */
  start: string;
  end: string;
}

const BJ = 8 * 3600_000;
const minutes = (hm: string) => {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
};

/** 北京时间的星期（1–7）和当天第几分钟。 */
function bjClock(d: Date) {
  const t = new Date(d.getTime() + BJ);
  return { day: t.getUTCDay() || 7, minute: t.getUTCHours() * 60 + t.getUTCMinutes() };
}

export function isWorkTime(d: Date, w: WorkHours) {
  const { day, minute } = bjClock(d);
  return w.days.includes(day) && minute >= minutes(w.start) && minute < minutes(w.end);
}

/** 工作时间内经过的分钟数，用于判断转人工后是否超时（下班时间不计）。 */
export function workMinutesBetween(from: Date, to: Date, w: WorkHours) {
  let n = 0;
  for (let t = from.getTime(); t < to.getTime() && n < 100_000; t += 60_000) if (isWorkTime(new Date(t), w)) n++;
  return n;
}

/** 给客户看的人工上班时间说明，如“每天 9:00–21:00”。 */
export function workHoursText(w: WorkHours) {
  const names = ['一', '二', '三', '四', '五', '六', '日'];
  const days = [...w.days].sort();
  const contiguous = days.every((d, i) => i === 0 || d === days[i - 1] + 1);
  const dayText = days.length === 7 ? '每天' : contiguous && days.length > 1 ? `周${names[days[0] - 1]}至周${names[days.at(-1)! - 1]}` : days.map((d) => `周${names[d - 1]}`).join('、');
  const hm = (s: string) => s.replace(/^0/, '');
  return `${dayText} ${hm(w.start)}–${hm(w.end)}`;
}
