/**
 * 内容生产的共用口径（PRD 4.1–4.3，任务 M3、M4）：选题类别预置、季节节点、小红书稿件规格。
 * 前端用来显示字数提示，后端用来校验 AI 输出。
 */
export type Audience = 'C' | 'B';

/** 选题类别预置：C 端 6 类、B 端 5 类，上线后可在选题清单里增删。 */
export const DEFAULT_TOPIC_CATEGORIES: Record<Audience, string[]> = {
  C: ['营养食养', '品种对比', '开箱', '储存食用', '伴手礼与企业礼赠', '产地纪实'],
  B: ['产地优势', '错峰空档', '采摘打包实拍', '供货稳定性', '合作采购政策'],
};

export interface SeasonNode {
  name: string;
  /** YYYY-MM-DD */
  start: string;
  /** YYYY-MM-DD */
  end: string;
}

/** 季节节点示例，以运营确认为准（错峰上市期需按产地实际采收期调整）。 */
export const DEFAULT_SEASON_NODES: SeasonNode[] = [
  { name: '中秋', start: '2026-09-18', end: '2026-09-25' },
  { name: '国庆', start: '2026-09-28', end: '2026-10-07' },
  { name: '双十一', start: '2026-10-25', end: '2026-11-11' },
  { name: '错峰上市期', start: '2026-11-15', end: '2027-04-30' },
  { name: '元旦', start: '2026-12-25', end: '2027-01-01' },
  { name: '年货节与春节', start: '2027-01-10', end: '2027-02-06' },
];

/** 小红书图文规格（建议值，开发时按平台当前规则核对）。 */
export const XHS_LIMITS = { title: 20, body: 1000, tagsMin: 5, tagsMax: 10 };

/** 按用户感知的字数计（emoji、汉字都算 1 个）。 */
export const textLength = (s: string) => [...s].length;

export interface XhsDraftLike {
  title: string;
  body: string;
  tags: string[];
}

/** 检查小红书稿件是否符合规格，返回不符合的地方（空数组表示都符合）。 */
export function checkXhsDraft(d: XhsDraftLike): string[] {
  const problems: string[] = [];
  if (!d.title.trim()) problems.push('标题为空');
  if (textLength(d.title) > XHS_LIMITS.title) problems.push(`标题 ${textLength(d.title)} 字，超过 ${XHS_LIMITS.title} 字`);
  if (!d.body.trim()) problems.push('正文为空');
  if (textLength(d.body) > XHS_LIMITS.body) problems.push(`正文 ${textLength(d.body)} 字，超过 ${XHS_LIMITS.body} 字`);
  if (d.tags.length < XHS_LIMITS.tagsMin || d.tags.length > XHS_LIMITS.tagsMax) {
    problems.push(`标签 ${d.tags.length} 个，应为 ${XHS_LIMITS.tagsMin}–${XHS_LIMITS.tagsMax} 个`);
  }
  return problems;
}

/** 某天所在周的周一（按北京时间），返回 YYYY-MM-DD。 */
export function mondayOf(date: Date): string {
  const bj = new Date(date.getTime() + 8 * 3600_000);
  const day = bj.getUTCDay() || 7;
  bj.setUTCDate(bj.getUTCDate() - day + 1);
  return bj.toISOString().slice(0, 10);
}

/** 下周一（按北京时间），返回 YYYY-MM-DD。 */
export function nextMonday(now = new Date()): string {
  return mondayOf(new Date(now.getTime() + 7 * 86_400_000));
}

/** YYYY-MM-DD 加减天数。 */
export function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 与 [from, to] 有交集的季节节点。 */
export function nodesBetween(nodes: SeasonNode[], from: string, to: string): SeasonNode[] {
  return nodes.filter((n) => n.start <= to && n.end >= from);
}
