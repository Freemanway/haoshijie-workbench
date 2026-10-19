import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { addDays, maskPhone, workMinutesBetween } from '@hsj/shared';
import { Audience, LeadStatus, Platform, Prisma, Role } from '@prisma/client';
import { z } from 'zod';
import { AiService } from '../ai/ai.module';
import { reportInsight, ReportInsightOut } from '../ai/prompts';
import { AuditService } from '../audit/audit.module';
import { AuthUser } from '../common/auth.decorators';
import { decrypt } from '../common/pii';
import { InboxService } from '../inbox/inbox.module';
import { PrismaService } from '../prisma/prisma.service';
import { NotifyService } from '../wecom/wecom.module';
import { SheetData, writeXlsx } from './xlsx';

const num = z.number().min(0).max(1e6).nullable().optional();
/** 上线前基线（PRD 11.2）：人工方式下每周的数字，加微率、成交率按百分数填；目标值同样口径。 */
const BaselineFigures = z.object({
  weeklyPosts: num,
  minutesPerPost: num,
  weeklyConsults: num,
  firstResponseMin: num,
  aiSolveRate: num,
  weeklyLeadsC: num,
  weeklyLeadsB: num,
  wecomRateC: num,
  wonRateC: num,
  wonRateB: num,
  riskMisses: num,
  penalties: num,
});
export const BaselineInput = z.object({
  period: z.string().trim().max(60).default(''),
  note: z.string().trim().max(500).default(''),
  baseline: BaselineFigures,
  target: BaselineFigures.default({}),
});
export type BaselineInput = z.infer<typeof BaselineInput>;
const BASELINE_KEY = 'report.baseline';

export interface ReportQuery {
  from: string;
  to: string;
  platform?: Platform;
  accountId?: string;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const HOUR = 3600_000;
/** 北京时间某天 0 点 */
const dayStart = (ymd: string) => new Date(`${ymd}T00:00:00+08:00`);
/** 时间对应的北京时间日期 */
export const ymdOf = (d: Date) => new Date(d.getTime() + 8 * HOUR).toISOString().slice(0, 10);
const postKey = (url: string) => /[0-9a-f]{24}/i.exec(url)?.[0] ?? url.split('?')[0];
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
const pctText = (v: number | null) => (v == null ? '—' : `${v}%`);
const yuan = (cents: number) => `¥${(cents / 100).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;
const AUDIENCES = [Audience.C, Audience.B];
const PLATFORM_NAME: Record<string, string> = { XHS: '小红书', DOUYIN: '抖音', WECHAT_CHANNELS: '视频号' };

type Count = Record<string, number>;
type Ranked = { name: string; count: number }[];
interface LeadStat {
  new: number;
  wecom: number;
  won: number;
  wecomRate: number | null;
  wonRate: number | null;
  orders: number;
  repeat: number;
  dealCents: number;
  intent: Count;
  scene: Ranked;
  channel: Ranked;
  city: Ranked;
  sources: Ranked;
  posts: Ranked;
  categories: Ranked;
}
const inc = (m: Count, k: string | null | undefined, n = 1) => {
  const key = k || '未知';
  m[key] = (m[key] ?? 0) + n;
};
const sortedCounts = (m: Count, take = 20) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, take).map(([name, count]) => ({ name, count }));

/**
 * M12 数据报表：按 PRD 8.1 口径实时计算看板指标（内容、客服、客资、转化漏斗，附环比），
 * 每周一、每月 1 日生成周报、月报快照并附 AI 解读，推送企业微信；明细导出 Excel。
 * 数据量是一个品牌几个账号的规模，直接按查询时的数据计算，不另建每日汇总表；报告快照保留生成当时的数字。
 */
@Injectable()
export class ReportsService {
  private readonly log = new Logger('Reports');

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly inbox: InboxService,
    private readonly notify: NotifyService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  private check(q: ReportQuery) {
    if (!YMD.test(q.from) || !YMD.test(q.to) || q.from > q.to) throw new BadRequestException('日期范围不对');
    if ((dayStart(q.to).getTime() - dayStart(q.from).getTime()) / 86_400_000 > 366) throw new BadRequestException('一次最多看一年');
    if (q.platform && !(q.platform in Platform)) throw new BadRequestException('平台不对');
  }

  /** 看板：本期全部指标，加上一个等长周期的核心指标做环比。 */
  async dashboard(q: ReportQuery) {
    this.check(q);
    const days = Math.round((dayStart(q.to).getTime() - dayStart(q.from).getTime()) / 86_400_000) + 1;
    const prevQ = { ...q, from: addDays(q.from, -days), to: addDays(q.from, -1) };
    const [cur, prev] = await Promise.all([this.compute(q), this.compute(prevQ)]);
    return { ...cur, prev: { from: prevQ.from, to: prevQ.to, kpi: prev.kpi } };
  }

  private async compute(q: ReportQuery) {
    const start = dayStart(q.from);
    const end = dayStart(addDays(q.to, 1));
    const range = { gte: start, lt: end };
    const account = q.accountId ? await this.prisma.platformAccount.findUnique({ where: { id: q.accountId } }) : null;
    const accWhere: Prisma.PlatformAccountWhereInput = { ...(q.platform ? { platform: q.platform } : {}), ...(q.accountId ? { id: q.accountId } : {}) };
    const convWhere: Prisma.ConversationWhereInput = { account: accWhere };
    const leadWhere: Prisma.LeadWhereInput = { ...(q.platform ? { sourcePlatform: q.platform } : {}), ...(account ? { sourceAccount: account.name } : {}) };
    const orderWhere: Prisma.OrderWhereInput = { ...(q.platform ? { attrPlatform: q.platform } : {}), ...(account ? { attrAccount: account.name } : {}) };

    // ---------- 作品 ----------
    const [posts, allPosted] = await Promise.all([
      this.prisma.scheduleItem.findMany({
        where: { publishedAt: range, account: accWhere },
        include: { account: { select: { name: true, platform: true } }, draft: { include: { topic: true, versions: { where: { chosen: true }, take: 1 } } } },
        orderBy: { publishedAt: 'asc' },
      }),
      this.prisma.scheduleItem.findMany({ where: { postUrl: { not: null } }, select: { postUrl: true, draft: { select: { topic: { select: { title: true, category: true, audience: true } } } } } }),
    ]);
    const postInfo = new Map(allPosted.map((p) => [postKey(p.postUrl!), p.draft.topic]));
    const keys = posts.filter((p) => p.postUrl).map((p) => postKey(p.postUrl!));
    const [postConvs, postLeads] = keys.length
      ? await Promise.all([
          this.prisma.conversation.findMany({ where: { OR: keys.map((k) => ({ sourcePostUrl: { contains: k } })) }, select: { sourcePostUrl: true } }),
          this.prisma.lead.findMany({ where: { OR: keys.map((k) => ({ sourcePostUrl: { contains: k } })) }, select: { sourcePostUrl: true } }),
        ])
      : [[], []];
    const byKey = (rows: { sourcePostUrl: string | null }[]) => rows.reduce<Count>((m, r) => (r.sourcePostUrl ? (inc(m, postKey(r.sourcePostUrl)), m) : m), {});
    const convByPost = byKey(postConvs);
    const leadByPost = byKey(postLeads);
    const postRows = posts.map((p) => {
      const reads = p.reads ?? 0;
      const inter = (p.likes ?? 0) + (p.saves ?? 0) + (p.comments ?? 0);
      const k = p.postUrl ? postKey(p.postUrl) : null;
      return {
        id: p.id,
        title: p.draft.versions[0]?.title ?? p.draft.topic.title,
        topic: p.draft.topic.title,
        category: p.draft.topic.category,
        audience: p.draft.topic.audience,
        platform: p.account.platform,
        account: p.account.name,
        publishedAt: p.publishedAt!,
        postUrl: p.postUrl,
        reads,
        likes: p.likes ?? 0,
        saves: p.saves ?? 0,
        comments: p.comments ?? 0,
        rate: pct(inter, reads),
        filled: p.reads != null,
        consults: k ? (convByPost[k] ?? 0) : 0,
        leads: k ? (leadByPost[k] ?? 0) : 0,
      };
    });
    const group = <K extends string>(key: (p: (typeof postRows)[number]) => K) => {
      const m = new Map<K, { posts: number; reads: number; inter: number; consults: number; leads: number }>();
      for (const p of postRows) {
        const g = m.get(key(p)) ?? { posts: 0, reads: 0, inter: 0, consults: 0, leads: 0 };
        g.posts++;
        g.reads += p.reads;
        g.inter += p.likes + p.saves + p.comments;
        g.consults += p.consults;
        g.leads += p.leads;
        m.set(key(p), g);
      }
      return [...m.entries()].map(([name, g]) => ({ name, posts: g.posts, reads: g.reads, rate: pct(g.inter, g.reads), consults: g.consults, leads: g.leads })).sort((a, b) => b.consults - a.consults || b.reads - a.reads);
    };

    // ---------- 客服 ----------
    const [custMsgs, aiReplies, handoffMsgs, aiMeta] = await Promise.all([
      this.prisma.message.findMany({
        where: { sender: 'customer', createdAt: range, conversation: convWhere },
        select: { conversationId: true, createdAt: true, conversation: { select: { audience: true, account: { select: { audience: true } } } } },
      }),
      this.prisma.message.count({ where: { sender: 'ai', createdAt: range, conversation: convWhere } }),
      this.prisma.message.findMany({ where: { sender: 'system', text: { startsWith: '转人工：' }, createdAt: range, conversation: convWhere }, select: { conversationId: true, text: true, createdAt: true }, orderBy: { createdAt: 'asc' } }),
      this.prisma.message.findMany({ where: { sender: 'ai', createdAt: range, conversation: convWhere, meta: { not: Prisma.DbNull } }, select: { meta: true }, take: 20_000 }),
    ]);
    const consultKeys = new Set<string>();
    const consultDaily: Count = {};
    const consultBy: Record<Audience, number> = { C: 0, B: 0 };
    const activeConvs = new Set<string>();
    for (const m of custMsgs) {
      activeConvs.add(m.conversationId);
      const day = ymdOf(m.createdAt);
      const k = `${m.conversationId}|${day}`;
      if (consultKeys.has(k)) continue;
      consultKeys.add(k);
      inc(consultDaily, day);
      consultBy[m.conversation.audience ?? m.conversation.account.audience]++;
    }
    const handoffConvs = new Set(handoffMsgs.map((m) => m.conversationId));
    const reasons: Count = {};
    for (const m of handoffMsgs) inc(reasons, m.text.replace(/^转人工：/, '').replace(/（非工作时间.*$/, ''));
    const convTotal = new Set([...activeConvs, ...handoffConvs]).size;
    const aiOnly = [...activeConvs].filter((c) => !handoffConvs.has(c)).length;

    // 首响：每次转人工之后客服发出的第一条回复，按工作时间计分钟
    const workHours = (await this.inbox.settings()).workHours;
    const agentMsgs = handoffConvs.size
      ? await this.prisma.message.findMany({ where: { sender: 'agent', conversationId: { in: [...handoffConvs] }, createdAt: { gte: start } }, select: { conversationId: true, createdAt: true, authorId: true }, orderBy: { createdAt: 'asc' } })
      : [];
    const byAgent = new Map<string, number[]>();
    const waits: number[] = [];
    for (const h of handoffMsgs) {
      const reply = agentMsgs.find((a) => a.conversationId === h.conversationId && a.createdAt > h.createdAt);
      if (!reply) continue;
      const min = workMinutesBetween(h.createdAt, reply.createdAt, workHours);
      waits.push(min);
      const key = reply.authorId ?? '未知';
      byAgent.set(key, [...(byAgent.get(key) ?? []), min]);
    }
    const agents = await this.prisma.user.findMany({ where: { id: { in: [...byAgent.keys()] } }, select: { id: true, name: true } });
    const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
    const faqCount: Count = {};
    for (const r of aiMeta) {
      const meta = r.meta as { matched?: boolean; faqIds?: string[] };
      if (meta.matched && meta.faqIds?.[0]) inc(faqCount, meta.faqIds[0]);
    }
    const topFaq = sortedCounts(faqCount, 10);
    const faqs = await this.prisma.faqItem.findMany({ where: { id: { in: topFaq.map((f) => f.name) } }, select: { id: true, question: true } });

    // ---------- 客资 ----------
    const [leads, orders] = await Promise.all([
      this.prisma.lead.findMany({
        where: { ...leadWhere, createdAt: range },
        select: { audience: true, intent: true, intentDetail: true, status: true, sourcePlatform: true, sourceAccount: true, sourcePostUrl: true, _count: { select: { wecomContacts: true } } },
      }),
      this.prisma.order.findMany({ where: { ...orderWhere, cancelled: false, orderedAt: range }, select: { audience: true, amountCents: true, isRepeat: true, leadId: true } }),
    ]);
    const leadStats = Object.fromEntries(
      AUDIENCES.map((a) => {
        const ls = leads.filter((l) => l.audience === a);
        const wecom = ls.filter((l) => l._count.wecomContacts > 0 || l.status === LeadStatus.ADDED_WECOM).length;
        const won = ls.filter((l) => l.status === LeadStatus.WON).length;
        const os = orders.filter((o) => o.audience === a);
        const intent: Count = {};
        const scene: Count = {};
        const channel: Count = {};
        const city: Count = {};
        const source: Count = {};
        const post: Count = {};
        const category: Count = {};
        for (const l of ls) {
          inc(intent, l.intent ?? 'unknown');
          const d = (l.intentDetail ?? {}) as Record<string, string | null>;
          if (a === Audience.C) inc(scene, d.scene);
          else {
            inc(channel, d.channel);
            inc(city, d.city);
          }
          inc(source, l.sourcePlatform ? `${PLATFORM_NAME[l.sourcePlatform] ?? l.sourcePlatform} · ${l.sourceAccount ?? '未知账号'}` : '手动录入 / 企业微信');
          const info = l.sourcePostUrl ? postInfo.get(postKey(l.sourcePostUrl)) : undefined;
          if (l.sourcePostUrl) inc(post, info?.title ?? '未登记的作品');
          inc(category, info?.category ?? (l.sourcePostUrl ? '未登记的作品' : '无来源作品'));
        }
        return [
          a,
          {
            new: ls.length,
            wecom,
            won,
            wecomRate: pct(wecom, ls.length),
            wonRate: pct(won, wecom),
            orders: os.length,
            repeat: os.filter((o) => o.isRepeat).length,
            dealCents: os.reduce((n, o) => n + o.amountCents, 0),
            intent,
            scene: sortedCounts(scene),
            channel: sortedCounts(channel),
            city: sortedCounts(city, 10),
            sources: sortedCounts(source),
            posts: sortedCounts(post, 10),
            categories: sortedCounts(category),
          },
        ];
      }),
    ) as Record<Audience, LeadStat>;

    const days: string[] = [];
    for (let d = q.from; d <= q.to; d = addDays(d, 1)) days.push(d);
    const postsDaily: Count = {};
    for (const p of postRows) inc(postsDaily, ymdOf(p.publishedAt));
    const reads = postRows.reduce((n, p) => n + p.reads, 0);

    return {
      from: q.from,
      to: q.to,
      kpi: {
        posts: postRows.length,
        reads,
        consults: consultKeys.size,
        leads: leads.length,
        leadsC: leadStats.C.new,
        leadsB: leadStats.B.new,
        dealCents: orders.reduce((n, o) => n + o.amountCents, 0),
      },
      funnel: AUDIENCES.map((a) => ({
        audience: a,
        steps: [
          { key: 'exposure', label: '曝光', value: postRows.filter((p) => p.audience === a).reduce((n, p) => n + p.reads, 0) },
          { key: 'consult', label: '咨询', value: consultBy[a] },
          { key: 'lead', label: '线索', value: leadStats[a].new },
          { key: 'wecom', label: '加微', value: leadStats[a].wecom },
          { key: 'won', label: '成交', value: leadStats[a].won },
        ],
      })),
      content: {
        posts: postRows,
        unfilled: postRows.filter((p) => !p.filled).length,
        byPlatform: group((p) => PLATFORM_NAME[p.platform] ?? p.platform),
        byAccount: group((p) => p.account),
        byCategory: group((p) => p.category),
        top: [...postRows].sort((a, b) => b.consults - a.consults || (b.rate ?? 0) - (a.rate ?? 0) || b.reads - a.reads).slice(0, 10),
      },
      service: {
        daily: days.map((d) => ({ date: d, consults: consultDaily[d] ?? 0, posts: postsDaily[d] ?? 0 })),
        conversations: convTotal,
        aiReplies,
        aiOnly,
        handoffs: handoffConvs.size,
        handoffRate: pct(handoffConvs.size, convTotal),
        reasons: sortedCounts(reasons, 10).map((r) => ({ reason: r.name, count: r.count })),
        firstResponse: avg(waits),
        firstResponseCount: waits.length,
        byAgent: [...byAgent.entries()].map(([id, xs]) => ({ name: agents.find((a) => a.id === id)?.name ?? '未知', count: xs.length, avg: avg(xs) })).sort((a, b) => b.count - a.count),
        topQuestions: topFaq.flatMap((f) => {
          const faq = faqs.find((x) => x.id === f.name);
          return faq ? [{ question: faq.question, count: f.count }] : [];
        }),
      },
      leads: leadStats,
    };
  }

  // ---------- 周报、月报 ----------

  /** 上一个完整周期：周报是上周一到周日，月报是上个月。 */
  lastPeriod(kind: 'week' | 'month', now = new Date()) {
    const today = ymdOf(now);
    if (kind === 'week') {
      const dow = new Date(`${today}T00:00:00Z`).getUTCDay() || 7;
      const thisMonday = addDays(today, 1 - dow);
      return { from: addDays(thisMonday, -7), to: addDays(thisMonday, -1) };
    }
    const first = `${today.slice(0, 7)}-01`;
    const prevLast = addDays(first, -1);
    return { from: `${prevLast.slice(0, 7)}-01`, to: prevLast };
  }

  /** 生成（或重新生成）一期报告：算指标、AI 写解读、存快照；push 时推送企业微信。 */
  async generate(kind: 'week' | 'month', period = this.lastPeriod(kind), opts: { push?: boolean; userId?: string } = {}) {
    const data = await this.dashboard(period);
    let insight: ReportInsightOut | null = null;
    let llmCallId: string | null = null;
    try {
      const r = await this.ai.run(reportInsight, this.insightInput(kind, data), { refType: 'report', refId: `${kind}:${period.from}` });
      insight = r.output;
      llmCallId = r.callId ?? null;
    } catch (e) {
      this.log.warn(`报告解读生成失败：${(e as Error).message}`);
    }
    const json = JSON.parse(JSON.stringify(data)) as Prisma.InputJsonValue;
    const report = await this.prisma.report.upsert({
      where: { kind_from: { kind, from: period.from } },
      create: { kind, from: period.from, to: period.to, data: json, insight: insight ?? Prisma.DbNull, llmCallId },
      update: { to: period.to, data: json, insight: insight ?? Prisma.DbNull, llmCallId, createdAt: new Date() },
    });
    if (opts.userId) await this.audit.log(opts.userId, 'report.generate', report.id, { kind, from: period.from });
    if (opts.push) await this.push(report.id);
    return report;
  }

  private insightInput(kind: 'week' | 'month', d: Awaited<ReturnType<ReportsService['dashboard']>>) {
    const k = d.kpi;
    const p = d.prev.kpi;
    return {
      kind,
      period: `${d.from} 至 ${d.to}`,
      kpi: [
        { label: '发布量', value: `${k.posts} 篇`, prev: `${p.posts} 篇` },
        { label: '阅读', value: String(k.reads), prev: String(p.reads) },
        { label: '咨询', value: `${k.consults} 人次`, prev: `${p.consults} 人次` },
        { label: '新增线索', value: `${k.leads}（C ${k.leadsC} / B ${k.leadsB}）`, prev: `${p.leads}` },
        { label: '成交金额', value: yuan(k.dealCents), prev: yuan(p.dealCents) },
      ],
      funnel: d.funnel.map((f) => ({ audience: f.audience, steps: f.steps.map((s) => ({ label: s.label, value: s.value })) })),
      topPosts: d.content.top.slice(0, 5).map((x) => ({ title: x.title, reads: x.reads, rate: pctText(x.rate), consults: x.consults, leads: x.leads })),
      categories: d.content.byCategory.map((c) => ({ category: c.name, posts: c.posts, reads: c.reads, consults: c.consults, leads: c.leads })),
      service: {
        handoffRate: pctText(d.service.handoffRate),
        firstResponse: d.service.firstResponse == null ? '无人工接待' : `${d.service.firstResponse} 分钟`,
        reasons: d.service.reasons,
        topQuestions: d.service.topQuestions,
      },
      leads: AUDIENCES.map((a) => ({ audience: a, new: d.leads[a].new, wecomRate: pctText(d.leads[a].wecomRate), wonRate: pctText(d.leads[a].wonRate), deal: yuan(d.leads[a].dealCents) })),
    };
  }

  /** 推送给管理员、管理层和内容运营：核心数字 + 一句亮点 + 看板链接。 */
  async push(id: string) {
    const r = await this.prisma.report.findUniqueOrThrow({ where: { id } });
    const d = r.data as unknown as Awaited<ReturnType<ReportsService['dashboard']>>;
    const k = d.kpi;
    const insight = r.insight as ReportInsightOut | null;
    const url = `${this.config.get('WEB_ORIGIN', 'http://localhost:5173')}/overview?report=${r.id}`;
    const text = [
      `【${r.kind === 'week' ? '周报' : '月报'}】${r.from.slice(5).replace('-', '/')}–${r.to.slice(5).replace('-', '/')}`,
      `发布 ${k.posts} 篇，阅读 ${k.reads}，咨询 ${k.consults}，新增线索 ${k.leads}（C ${k.leadsC} / B ${k.leadsB}），成交 ${yuan(k.dealCents)}。`,
      ...(insight?.highlights[0] ? [`亮点：${insight.highlights[0]}`] : []),
      ...(insight?.problems[0] ? [`问题：${insight.problems[0]}`] : []),
      `查看看板：${url}`,
    ].join('\n');
    await this.notify.toRoles([Role.ADMIN, Role.VIEWER, Role.CONTENT], text);
    await this.prisma.report.update({ where: { id }, data: { pushedAt: new Date() } });
  }

  list() {
    return this.prisma.report.findMany({ select: { id: true, kind: true, from: true, to: true, pushedAt: true, createdAt: true }, orderBy: [{ from: 'desc' }, { kind: 'asc' }], take: 60 });
  }

  async get(id: string) {
    const r = await this.prisma.report.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('报告不存在');
    return r;
  }

  async baseline() {
    const row = await this.prisma.setting.findUnique({ where: { key: BASELINE_KEY } });
    return row ? { ...(row.value as object), updatedAt: row.updatedAt } : null;
  }

  async saveBaseline(me: AuthUser, input: BaselineInput) {
    const value = { ...input, recordedBy: me.name } as unknown as Prisma.InputJsonValue;
    await this.prisma.setting.upsert({ where: { key: BASELINE_KEY }, create: { key: BASELINE_KEY, value }, update: { value } });
    await this.audit.log(me.id, 'report.baseline', BASELINE_KEY, { period: input.period });
    return this.baseline();
  }

  private get cronOn() {
    return this.config.get('CRON_ENABLED', 'true') !== 'false';
  }

  @Cron('0 0 9 * * 1', { name: 'weekly-report', timeZone: 'Asia/Shanghai' })
  async weekly() {
    if (this.cronOn) await this.generate('week', undefined, { push: true }).catch((e) => this.log.error(`周报生成失败：${(e as Error).message}`));
  }

  @Cron('0 0 9 1 * *', { name: 'monthly-report', timeZone: 'Asia/Shanghai' })
  async monthly() {
    if (this.cronOn) await this.generate('month', undefined, { push: true }).catch((e) => this.log.error(`月报生成失败：${(e as Error).message}`));
  }

  // ---------- 明细导出 ----------

  /** 明细 Excel：汇总、作品、会话；线索明细只给管理员（脱敏，明文请在线索库导出）。都记导出日志。 */
  async exportXlsx(me: AuthUser, q: ReportQuery) {
    const d = await this.dashboard(q);
    const start = dayStart(q.from);
    const end = dayStart(addDays(q.to, 1));
    const accWhere: Prisma.PlatformAccountWhereInput = { ...(q.platform ? { platform: q.platform } : {}), ...(q.accountId ? { id: q.accountId } : {}) };
    const convs = await this.prisma.conversation.findMany({
      where: { account: accWhere, messages: { some: { createdAt: { gte: start, lt: end } } } },
      include: { account: { select: { name: true, platform: true } }, agent: { select: { name: true } }, lead: { select: { id: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const fmt = (t: Date | null | undefined) => (t ? new Date(t.getTime() + 8 * HOUR).toISOString().replace('T', ' ').slice(0, 16) : '');
    const k = d.kpi;
    const p = d.prev.kpi;
    const sheets: SheetData[] = [
      {
        name: '汇总',
        rows: [
          ['指标', `本期 ${d.from} 至 ${d.to}`, `上期 ${d.prev.from} 至 ${d.prev.to}`],
          ['发布量', k.posts, p.posts],
          ['阅读', k.reads, p.reads],
          ['咨询（人次）', k.consults, p.consults],
          ['新增线索', k.leads, p.leads],
          ['C 端线索', k.leadsC, p.leadsC],
          ['B 端线索', k.leadsB, p.leadsB],
          ['成交金额（元）', k.dealCents / 100, p.dealCents / 100],
          ['转人工率', pctText(d.service.handoffRate), ''],
          ['人工首响（分钟）', d.service.firstResponse ?? '', ''],
          ...AUDIENCES.flatMap((a) => [
            [`${a} 端加微率`, pctText(d.leads[a].wecomRate), ''],
            [`${a} 端成交率`, pctText(d.leads[a].wonRate), ''],
          ]),
        ],
      },
      {
        name: '作品',
        rows: [
          ['发布时间', '平台', '账号', '客群', '选题类别', '标题', '链接', '阅读', '点赞', '收藏', '评论', '互动率', '带来咨询', '带来线索'],
          ...d.content.posts.map((x) => [fmt(new Date(x.publishedAt)), PLATFORM_NAME[x.platform] ?? x.platform, x.account, x.audience, x.category, x.title, x.postUrl, x.filled ? x.reads : '未回填', x.likes, x.saves, x.comments, pctText(x.rate), x.consults, x.leads]),
        ],
      },
      {
        name: '会话',
        rows: [
          ['开始时间', '最近消息', '平台', '账号', '类型', '客户昵称', '客群', '意向', '状态', '转人工原因', '接待客服', '来源作品', '已建线索'],
          ...convs.map((c) => [fmt(c.createdAt), fmt(c.lastMessageAt), PLATFORM_NAME[c.account.platform], c.account.name, c.kind === 'comment' ? '评论' : '私信', c.nickname, c.audience, c.intent, c.status, c.handoffReason, c.agent?.name, c.sourcePostUrl, c.lead ? '是' : '']),
        ],
      },
    ];
    if (me.roles.includes(Role.ADMIN)) {
      const leads = await this.prisma.lead.findMany({
        where: { createdAt: { gte: start, lt: end }, ...(q.platform ? { sourcePlatform: q.platform } : {}) },
        include: { owner: { select: { name: true } } },
        orderBy: { createdAt: 'asc' },
      });
      const phone = (enc: string | null) => {
        try {
          return enc ? maskPhone(decrypt(enc)) : '';
        } catch {
          return '';
        }
      };
      sheets.push({
        name: '线索',
        rows: [
          ['创建时间', '客群', '状态', '意向', '昵称', '手机号（脱敏）', '来源平台', '来源账号', '来源作品', '负责人', '成交金额（元）', '成交单数'],
          ...leads.map((l) => [fmt(l.createdAt), l.audience, l.status, l.intent, l.nickname ?? l.name, phone(l.phoneEnc), l.sourcePlatform ? PLATFORM_NAME[l.sourcePlatform] : '', l.sourceAccount, l.sourcePostUrl, l.owner?.name, l.dealCents / 100, l.orderCount]),
        ],
      });
    }
    await this.audit.log(me.id, 'report.export', `${q.from}~${q.to}`, { sheets: sheets.map((s) => s.name), rows: sheets.reduce((n, s) => n + s.rows.length - 1, 0) });
    return writeXlsx(sheets);
  }
}
