import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Injectable,
  Logger,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { addDays, DEFAULT_SEASON_NODES, DEFAULT_TOPIC_CATEGORIES, nextMonday, nodesBetween } from '@hsj/shared';
import { Audience, Platform, Prisma, Role, TopicSource, TopicStatus } from '@prisma/client';
import { z } from 'zod';
import { AiService } from '../ai/ai.module';
import { TopicOut, TopicsInput, weeklyTopics } from '../ai/prompts';
import { AuditService } from '../audit/audit.module';
import { AuthUser, CurrentUser, Roles } from '../common/auth.decorators';
import { ZodPipe } from '../common/zod.pipe';
import { DraftsModule, DraftsService } from '../drafts/drafts.module';
import { PrismaService } from '../prisma/prisma.service';
import { NotifyService } from '../wecom/wecom.module';

const Ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD');

const SettingsSchema = z.object({
  /** 每周各平台篇数，一期只有小红书 */
  weeklyQuota: z.object({ XHS: z.number().int().min(0).max(30) }),
  /** C 端占比，其余为 B 端 */
  cRatio: z.number().min(0).max(1),
  seasonNodes: z.array(z.object({ name: z.string().trim().min(1), start: Ymd, end: Ymd })),
  /** 每周四 9 点自动生成下周清单 */
  autoGenerate: z.boolean(),
});
type Settings = z.infer<typeof SettingsSchema>;
const DEFAULT_SETTINGS: Settings = { weeklyQuota: { XHS: 5 }, cRatio: 0.8, seasonNodes: DEFAULT_SEASON_NODES, autoGenerate: true };
const SETTINGS_KEY = 'topics';

const TopicInput = z.object({
  title: z.string().trim().min(1, '请填写选题标题'),
  audience: z.nativeEnum(Audience),
  category: z.string().trim().min(1, '请选择类别'),
  platforms: z.array(z.nativeEnum(Platform)).default([Platform.XHS]),
  seasonTag: z.string().trim().nullish(),
  reason: z.string().trim().nullish(),
  suggestedDate: Ymd.nullish(),
  /** 带上周一日期表示追加到这周的选题清单（待确认） */
  weekOf: Ymd.nullish(),
});
const TopicPatch = TopicInput.omit({ weekOf: true })
  .partial()
  .extend({ status: z.enum([TopicStatus.IDLE, TopicStatus.ARCHIVED]).optional() });
const CategoryInput = z.object({ audience: z.nativeEnum(Audience), name: z.string().trim().min(1, '请填写类别名称') });
const GenerateInput = z.object({ weekOf: Ymd.optional(), replace: z.boolean().default(false) });
const ConfirmInput = z.object({
  weekOf: Ymd,
  topicIds: z.array(z.string()).min(1, '至少勾选一个选题'),
  versions: z.number().int().min(1).max(4).default(2),
});

const toDate = (ymd?: string | null) => (ymd ? new Date(`${ymd}T00:00:00Z`) : null);

@Injectable()
export class TopicsService {
  private readonly log = new Logger('TopicsService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly drafts: DraftsService,
    private readonly config: ConfigService,
    private readonly notify: NotifyService,
  ) {}

  async settings(): Promise<Settings> {
    const row = await this.prisma.setting.findUnique({ where: { key: SETTINGS_KEY } });
    const parsed = SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, ...((row?.value as object) ?? {}) });
    return parsed.success ? parsed.data : DEFAULT_SETTINGS;
  }

  async saveSettings(value: Settings) {
    await this.prisma.setting.upsert({ where: { key: SETTINGS_KEY }, create: { key: SETTINGS_KEY, value }, update: { value } });
    return value;
  }

  /** 首次使用时写入预置类别。 */
  async categories() {
    if (!(await this.prisma.topicCategory.count())) {
      await this.prisma.topicCategory.createMany({
        data: (['C', 'B'] as const).flatMap((audience) => DEFAULT_TOPIC_CATEGORIES[audience].map((name, sort) => ({ audience, name, sort }))),
        skipDuplicates: true,
      });
    }
    return this.prisma.topicCategory.findMany({ orderBy: [{ audience: 'desc' }, { sort: 'asc' }] });
  }

  /** 生成选题用的上下文：季节节点、近两周作品数据、私信高频问题、已有选题、品牌资料。 */
  private async context(weekOf: string, counts: { C: number; B: number }, extraAvoid: string[] = []): Promise<TopicsInput> {
    const s = await this.settings();
    const cats = await this.categories();
    const weekEnd = addDays(weekOf, 6);
    const since = new Date(Date.now() - 14 * 86_400_000);
    const [published, recent, items] = await Promise.all([
      this.prisma.scheduleItem.findMany({
        where: { publishedAt: { gte: since } },
        include: { draft: { include: { topic: true } } },
        orderBy: { saves: 'desc' },
        take: 10,
      }),
      this.prisma.topic.findMany({
        where: { createdAt: { gte: new Date(Date.now() - 60 * 86_400_000) }, status: { not: TopicStatus.ARCHIVED } },
        select: { title: true },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.prisma.knowledgeItem.findMany({ where: { kind: { not: 'compliance' } }, take: 30 }),
    ]);
    return {
      weekOf,
      weekEnd,
      counts,
      categories: { C: cats.filter((c) => c.audience === 'C').map((c) => c.name), B: cats.filter((c) => c.audience === 'B').map((c) => c.name) },
      seasonNodes: nodesBetween(s.seasonNodes, addDays(weekOf, -7), addDays(weekEnd, 14)),
      lastWeek: published.map((p) => ({ title: p.draft.topic.title, reads: p.reads ?? 0, likes: p.likes ?? 0, saves: p.saves ?? 0 })),
      // 收件箱（M8）上线后，按 FAQ 命中次数统计近 7 天私信高频问题
      hotQuestions: [],
      avoidTitles: [...new Set([...recent.map((t) => t.title), ...extraAvoid])],
      facts: items.map((i) => ({ title: i.title, content: i.content.slice(0, 200) })),
    };
  }

  /** 校验并修正 AI 给的选题：数量按配额截取，类别不在列表里的换成该客群第一类，日期落在本周内。 */
  private normalize(input: TopicsInput, topics: TopicOut[]) {
    const out: TopicOut[] = [];
    for (const audience of ['C', 'B'] as const) {
      const list = topics.filter((t) => t.audience === audience).slice(0, input.counts[audience]);
      for (const t of list) {
        const cats = input.categories[audience];
        out.push({
          ...t,
          title: t.title.trim(),
          category: cats.includes(t.category) ? t.category : (cats[0] ?? t.category),
          suggestedDate: t.suggestedDate >= input.weekOf && t.suggestedDate <= input.weekEnd ? t.suggestedDate : addDays(input.weekOf, out.length % 7),
        });
      }
    }
    return out;
  }

  private problems(input: TopicsInput) {
    return (o: unknown) => {
      const topics = (o as { topics: TopicOut[] }).topics;
      const p: string[] = [];
      for (const a of ['C', 'B'] as const) {
        const n = topics.filter((t) => t.audience === a).length;
        if (n < input.counts[a]) p.push(`${a} 端选题只有 ${n} 个，需要 ${input.counts[a]} 个`);
      }
      if (topics.some((t) => t.suggestedDate < input.weekOf || t.suggestedDate > input.weekEnd)) p.push(`建议发布日期必须在 ${input.weekOf} 至 ${input.weekEnd} 之间`);
      return p;
    };
  }

  async weekly(weekOf = nextMonday()) {
    const topics = await this.prisma.topic.findMany({
      where: { weekOf: toDate(weekOf), status: { not: TopicStatus.ARCHIVED } },
      include: { drafts: { select: { id: true, status: true } } },
      orderBy: [{ suggestedDate: 'asc' }, { createdAt: 'asc' }],
    });
    const s = await this.settings();
    return {
      weekOf,
      weekEnd: addDays(weekOf, 6),
      confirmed: topics.length > 0 && !topics.some((t) => t.status === TopicStatus.PROPOSED),
      seasonNodes: nodesBetween(s.seasonNodes, weekOf, addDays(weekOf, 6)),
      topics,
    };
  }

  /** 生成某周（默认下周）选题清单，按配额和 C/B 比例分配。 */
  async generateWeekly(weekOf = nextMonday(), replace = false, userId?: string) {
    const existing = await this.prisma.topic.count({ where: { weekOf: toDate(weekOf), status: { not: TopicStatus.ARCHIVED } } });
    if (existing && !replace) throw new ConflictException('这周已经有选题清单了，如需重新生成请选择替换');
    const s = await this.settings();
    const total = s.weeklyQuota.XHS;
    if (!total) throw new BadRequestException('每周小红书配额为 0，请先在设置里调整');
    // 已确认的选题占用配额，只补齐剩下的
    const kept = await this.prisma.topic.groupBy({
      by: ['audience'],
      where: { weekOf: toDate(weekOf), status: { notIn: [TopicStatus.PROPOSED, TopicStatus.ARCHIVED] } },
      _count: { _all: true },
    });
    const keptOf = (a: Audience) => kept.find((k) => k.audience === a)?._count._all ?? 0;
    const C = Math.max(0, Math.round(total * s.cRatio) - keptOf(Audience.C));
    const B = Math.max(0, total - Math.round(total * s.cRatio) - keptOf(Audience.B));
    if (!C && !B) throw new ConflictException('这周的选题已经确认满额，不需要再生成');
    const input = await this.context(weekOf, { C, B });
    const res = await this.ai.run(weeklyTopics, input, { userId, refType: 'week', refId: weekOf, check: this.problems(input) });
    const topics = this.normalize(input, res.output.topics);
    await this.prisma.$transaction([
      // 替换时只清掉还没确认的建议，已确认的选题保留
      this.prisma.topic.deleteMany({ where: { weekOf: toDate(weekOf), status: TopicStatus.PROPOSED } }),
      this.prisma.topic.createMany({
        data: topics.map((t) => ({
          title: t.title,
          audience: t.audience,
          category: t.category,
          platforms: [Platform.XHS],
          seasonTag: t.seasonTag ?? null,
          reason: t.reason,
          suggestedDate: toDate(t.suggestedDate),
          weekOf: toDate(weekOf),
          source: TopicSource.AI,
          status: TopicStatus.PROPOSED,
        })),
      }),
    ]);
    return this.weekly(weekOf);
  }

  /** 替换清单里的一个选题：同客群重新出一个不重复的。 */
  async replaceOne(id: string, userId?: string) {
    const topic = await this.prisma.topic.findUnique({ where: { id } });
    if (!topic) throw new NotFoundException('选题不存在');
    if (topic.status !== TopicStatus.PROPOSED || !topic.weekOf) throw new ConflictException('只能替换待确认的选题');
    const weekOf = topic.weekOf.toISOString().slice(0, 10);
    const siblings = await this.prisma.topic.findMany({ where: { weekOf: topic.weekOf }, select: { title: true } });
    const input = await this.context(weekOf, { C: topic.audience === 'C' ? 1 : 0, B: topic.audience === 'B' ? 1 : 0 }, siblings.map((t) => t.title));
    const res = await this.ai.run(weeklyTopics, input, { userId, refType: 'topic', refId: id, check: this.problems(input) });
    const [t] = this.normalize(input, res.output.topics);
    if (!t) throw new BadRequestException('AI 没有给出新的选题，请再试一次');
    return this.prisma.topic.update({
      where: { id },
      data: { title: t.title, category: t.category, reason: t.reason, seasonTag: t.seasonTag ?? null, suggestedDate: toDate(t.suggestedDate), source: TopicSource.AI },
    });
  }

  /** 确认清单：勾选的进入选题库（待用）并批量生成稿件，没勾选的归档。 */
  async confirm(input: z.infer<typeof ConfirmInput>, userId: string) {
    const week = toDate(input.weekOf);
    const proposed = await this.prisma.topic.findMany({ where: { weekOf: week, status: TopicStatus.PROPOSED } });
    const chosen = proposed.filter((t) => input.topicIds.includes(t.id));
    if (!chosen.length) throw new BadRequestException('勾选的选题不在这周的待确认清单里');
    await this.prisma.$transaction([
      this.prisma.topic.updateMany({ where: { id: { in: chosen.map((t) => t.id) } }, data: { status: TopicStatus.IDLE } }),
      this.prisma.topic.updateMany({
        where: { weekOf: week, status: TopicStatus.PROPOSED, id: { notIn: chosen.map((t) => t.id) } },
        data: { status: TopicStatus.ARCHIVED },
      }),
    ]);
    const drafts = [];
    for (const t of chosen) drafts.push(await this.drafts.generate(t.id, input.versions, userId));
    return { topics: chosen.length, drafts };
  }

  /** 每周四 9:00（北京时间）自动生成下周选题清单。 */
  @Cron('0 0 9 * * 4', { name: 'weekly-topics', timeZone: 'Asia/Shanghai' })
  async scheduledWeekly() {
    if (this.config.get('CRON_ENABLED', 'true') === 'false') return;
    const s = await this.settings();
    if (!s.autoGenerate) return;
    try {
      await this.generateWeekly(nextMonday());
      this.log.log('已生成下周选题清单');
      await this.notify.toRoles([Role.CONTENT], '【选题清单】下周的选题清单已生成，请到工作台“选题”里确认。');
    } catch (e) {
      if (!(e instanceof ConflictException)) this.log.error(`自动生成下周选题失败：${(e as Error).message}`);
    }
  }
}

@Controller('topics')
class TopicsController {
  constructor(
    private readonly topics: TopicsService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get('settings')
  settings() {
    return this.topics.settings();
  }

  @Roles(Role.CONTENT)
  @Put('settings')
  async saveSettings(@CurrentUser() me: AuthUser, @Body(new ZodPipe(SettingsSchema)) body: Settings) {
    const saved = await this.topics.saveSettings(body);
    await this.audit.log(me.id, 'topics.settings', SETTINGS_KEY, body);
    return saved;
  }

  @Get('categories')
  categories() {
    return this.topics.categories();
  }

  @Roles(Role.CONTENT)
  @Post('categories')
  async addCategory(@Body(new ZodPipe(CategoryInput)) body: z.infer<typeof CategoryInput>) {
    await this.topics.categories();
    const max = await this.prisma.topicCategory.aggregate({ where: { audience: body.audience }, _max: { sort: true } });
    try {
      return await this.prisma.topicCategory.create({ data: { ...body, sort: (max._max.sort ?? 0) + 1 } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('这个类别已经有了');
      throw e;
    }
  }

  @Roles(Role.CONTENT)
  @Delete('categories/:id')
  async removeCategory(@Param('id') id: string) {
    await this.prisma.topicCategory.delete({ where: { id } });
    return { ok: true };
  }

  @Get('weekly')
  weekly(@Query('weekOf') weekOf?: string) {
    if (weekOf && !Ymd.safeParse(weekOf).success) throw new BadRequestException('日期格式应为 YYYY-MM-DD');
    return this.topics.weekly(weekOf);
  }

  @Roles(Role.CONTENT)
  @Post('weekly/generate')
  generate(@CurrentUser() me: AuthUser, @Body(new ZodPipe(GenerateInput)) body: z.infer<typeof GenerateInput>) {
    return this.topics.generateWeekly(body.weekOf, body.replace, me.id);
  }

  @Roles(Role.CONTENT)
  @Post('weekly/confirm')
  confirm(@CurrentUser() me: AuthUser, @Body(new ZodPipe(ConfirmInput)) body: z.infer<typeof ConfirmInput>) {
    return this.topics.confirm(body, me.id);
  }

  /** 选题库：按状态、客群、关键词筛选；默认不含待确认和归档。 */
  @Get()
  list(@Query('status') status?: string, @Query('audience') audience?: string, @Query('q') q?: string) {
    const statuses = status?.split(',').filter((s): s is TopicStatus => s in TopicStatus);
    return this.prisma.topic.findMany({
      where: {
        status: statuses?.length ? { in: statuses } : { notIn: [TopicStatus.PROPOSED, TopicStatus.ARCHIVED] },
        ...(audience === 'C' || audience === 'B' ? { audience } : {}),
        ...(q ? { title: { contains: q, mode: 'insensitive' as const } } : {}),
      },
      include: { _count: { select: { drafts: true } } },
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
  }

  @Roles(Role.CONTENT)
  @Post()
  create(@Body(new ZodPipe(TopicInput)) body: z.infer<typeof TopicInput>) {
    const { weekOf, suggestedDate, ...rest } = body;
    return this.prisma.topic.create({
      data: {
        ...rest,
        suggestedDate: toDate(suggestedDate),
        weekOf: toDate(weekOf),
        source: TopicSource.MANUAL,
        status: weekOf ? TopicStatus.PROPOSED : TopicStatus.IDLE,
      },
    });
  }

  @Roles(Role.CONTENT)
  @Patch(':id')
  update(@Param('id') id: string, @Body(new ZodPipe(TopicPatch)) body: z.infer<typeof TopicPatch>) {
    const { suggestedDate, ...rest } = body;
    return this.prisma.topic.update({
      where: { id },
      data: { ...rest, ...(suggestedDate !== undefined ? { suggestedDate: toDate(suggestedDate) } : {}) },
    });
  }

  @Roles(Role.CONTENT)
  @Post(':id/replace')
  replace(@CurrentUser() me: AuthUser, @Param('id') id: string) {
    return this.topics.replaceOne(id, me.id);
  }

  /** 没有稿件的选题可以删除，有稿件的只能归档。 */
  @Roles(Role.CONTENT)
  @Delete(':id')
  async remove(@Param('id') id: string) {
    const n = await this.prisma.draft.count({ where: { topicId: id } });
    if (n) throw new ConflictException('这个选题已经有稿件，只能归档');
    await this.prisma.topic.delete({ where: { id } });
    return { ok: true };
  }
}

@Module({ imports: [DraftsModule], controllers: [TopicsController], providers: [TopicsService] })
export class TopicsModule {}
