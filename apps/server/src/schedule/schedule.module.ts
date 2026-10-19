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
  Query,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { draftText } from '@hsj/shared';
import { DraftStatus, Prisma, Role, TopicStatus } from '@prisma/client';
import type { Response } from 'express';
import JSZip from 'jszip';
import { z } from 'zod';
import { AuthUser, CurrentUser, Roles } from '../common/auth.decorators';
import { ZodPipe } from '../common/zod.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { NotifyService } from '../wecom/wecom.module';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const BJ = 8 * HOUR;

/** 北京时间当天 0 点。 */
export function bjDayStart(d: Date) {
  return new Date(Math.floor((d.getTime() + BJ) / DAY) * DAY - BJ);
}

const When = z.coerce.date({ invalid_type_error: '请填写发布时间' });
const CreateInput = z.object({
  draftId: z.string().min(1),
  accountIds: z.array(z.string()).min(1, '至少选择一个账号'),
  publishAt: When,
});
const UpdateInput = z.object({ publishAt: When.optional(), accountId: z.string().optional() });
const RangeQuery = z.object({ from: When, to: When });
const PublishInput = z.object({ postUrl: z.string().trim().url('请填写作品链接') });
const FailInput = z.object({ reason: z.string().trim().min(1, '请填写失败原因').max(500) });
const MetricInput = z.object({
  checkpoint: z.enum(['24h', '7d']),
  reads: z.number().int().min(0),
  likes: z.number().int().min(0),
  saves: z.number().int().min(0),
  comments: z.number().int().min(0),
});

/** 可以排期的稿件状态：审核通过、已排期（再加账号）、发布失败（重新排）。 */
const SCHEDULABLE: DraftStatus[] = [DraftStatus.APPROVED, DraftStatus.SCHEDULED, DraftStatus.PUBLISH_FAILED];

const itemInclude = {
  account: { select: { id: true, name: true, platform: true, dailyPostCap: true } },
  draft: {
    select: {
      id: true,
      status: true,
      platform: true,
      topic: { select: { id: true, title: true, audience: true, category: true } },
      versions: { where: { chosen: true }, select: { id: true, title: true, body: true, tags: true, coverPrompt: true, imageTips: true } },
    },
  },
  metrics: { orderBy: { recordedAt: 'asc' } },
} satisfies Prisma.ScheduleItemInclude;
type Item = Prisma.ScheduleItemGetPayload<{ include: typeof itemInclude }>;

function shape(i: Item) {
  const { versions, ...draft } = i.draft;
  return { ...i, draft: { ...draft, version: versions[0] ?? null } };
}

/**
 * M7 排期与发布：一期是“半自动”——系统到点提醒、准备好素材包，运营在小红书 App 里手动发，发完回填链接和数据。
 */
@Injectable()
export class ScheduleService {
  private readonly log = new Logger('Schedule');

  constructor(
    private readonly prisma: PrismaService,
    private readonly notify: NotifyService,
    private readonly config: ConfigService,
  ) {}

  private async item(id: string) {
    const i = await this.prisma.scheduleItem.findUnique({ where: { id }, include: itemInclude });
    if (!i) throw new NotFoundException('排期不存在');
    return i;
  }

  /** 同一账号同一天（北京时间）已排的篇数不能超过发布频率上限。 */
  private async assertCap(accountId: string, at: Date, excludeId?: string) {
    const account = await this.prisma.platformAccount.findUnique({ where: { id: accountId } });
    if (!account) throw new BadRequestException('账号不存在');
    const start = bjDayStart(at);
    const n = await this.prisma.scheduleItem.count({
      where: { accountId, publishAt: { gte: start, lt: new Date(start.getTime() + DAY) }, failedReason: null, ...(excludeId ? { id: { not: excludeId } } : {}) },
    });
    if (n >= account.dailyPostCap) throw new ConflictException(`账号“${account.name}”当天已排 ${n} 篇，达到每日上限 ${account.dailyPostCap} 篇`);
    return account;
  }

  async list(from: Date, to: Date) {
    const items = await this.prisma.scheduleItem.findMany({ where: { publishAt: { gte: from, lt: to } }, include: itemInclude, orderBy: { publishAt: 'asc' } });
    return items.map(shape);
  }

  /** 今天要发的 + 之前过点还没发的（失败的不算，需要先改期）。 */
  async today(now = new Date()) {
    const end = new Date(bjDayStart(now).getTime() + DAY);
    const items = await this.prisma.scheduleItem.findMany({
      where: { publishAt: { lt: end }, publishedAt: null, failedReason: null },
      include: itemInclude,
      orderBy: { publishAt: 'asc' },
    });
    return items.map(shape);
  }

  /** 发布满 24 小时 / 7 天还没回填数据的作品。 */
  async metricsDue(now = new Date()) {
    const items = await this.prisma.scheduleItem.findMany({
      where: { publishedAt: { lte: new Date(now.getTime() - DAY) } },
      include: itemInclude,
      orderBy: { publishedAt: 'asc' },
    });
    return items
      .map((i) => {
        const done = new Set(i.metrics.map((m) => m.checkpoint));
        const due = ['24h', ...(i.publishedAt!.getTime() <= now.getTime() - 7 * DAY ? ['7d'] : [])].filter((c) => !done.has(c));
        return { ...shape(i), due };
      })
      .filter((i) => i.due.length);
  }

  async create(input: z.infer<typeof CreateInput>) {
    const draft = await this.prisma.draft.findUnique({ where: { id: input.draftId }, include: { schedules: true } });
    if (!draft) throw new NotFoundException('稿件不存在');
    if (!SCHEDULABLE.includes(draft.status)) throw new ConflictException('只有审核通过的稿件可以排期');
    const ids = [...new Set(input.accountIds)];
    const taken = ids.filter((a) => draft.schedules.some((s) => s.accountId === a && !s.failedReason));
    if (taken.length) throw new ConflictException('这篇稿件已经排在所选账号上了');
    for (const a of ids) await this.assertCap(a, input.publishAt);
    await this.prisma.$transaction([
      ...ids.map((accountId) => this.prisma.scheduleItem.create({ data: { draftId: draft.id, accountId, publishAt: input.publishAt } })),
      this.prisma.draft.update({ where: { id: draft.id }, data: { status: DraftStatus.SCHEDULED } }),
      this.prisma.topic.update({ where: { id: draft.topicId }, data: { status: TopicStatus.SCHEDULED } }),
    ]);
    const accounts = new Set([...draft.schedules.filter((s) => !s.failedReason).map((s) => s.accountId), ...ids]);
    return {
      ok: true,
      // PRD 10.2：多账号发同一篇容易被判搬运，提醒做差异化
      warning: accounts.size > 1 ? `这篇稿件会发到 ${accounts.size} 个账号，建议每个账号改写标题和开头、换封面，避免内容重复被限流。` : null,
    };
  }

  /** 改期或换账号（日历拖拽）；发布失败的改期后重新进入待发布。 */
  async update(id: string, input: z.infer<typeof UpdateInput>) {
    const i = await this.item(id);
    if (i.publishedAt) throw new ConflictException('已发布的排期不能修改');
    const publishAt = input.publishAt ?? i.publishAt;
    const accountId = input.accountId ?? i.accountId;
    await this.assertCap(accountId, publishAt, id);
    await this.prisma.scheduleItem.update({ where: { id }, data: { publishAt, accountId, failedReason: null, remindedAt: null } });
    if (i.draft.status === DraftStatus.PUBLISH_FAILED) await this.prisma.draft.update({ where: { id: i.draftId }, data: { status: DraftStatus.SCHEDULED } });
    return shape(await this.item(id));
  }

  async remove(id: string) {
    const i = await this.item(id);
    if (i.publishedAt) throw new ConflictException('已发布的排期不能删除');
    await this.prisma.scheduleItem.delete({ where: { id } });
    await this.syncDraft(i.draftId);
    return { ok: true };
  }

  /** 根据剩下的排期推算稿件和选题状态。 */
  private async syncDraft(draftId: string) {
    const draft = await this.prisma.draft.findUniqueOrThrow({ where: { id: draftId }, include: { schedules: true } });
    const s = draft.schedules;
    let status: DraftStatus;
    if (!s.length) status = DraftStatus.APPROVED;
    else if (s.some((x) => x.failedReason)) status = DraftStatus.PUBLISH_FAILED;
    else if (s.every((x) => x.publishedAt)) status = DraftStatus.PUBLISHED;
    else status = DraftStatus.SCHEDULED;
    await this.prisma.draft.update({ where: { id: draftId }, data: { status } });
    const topicStatus = status === DraftStatus.PUBLISHED || s.some((x) => x.publishedAt) ? TopicStatus.PUBLISHED : s.length ? TopicStatus.SCHEDULED : TopicStatus.IDLE;
    await this.prisma.topic.update({ where: { id: draft.topicId }, data: { status: topicStatus } });
  }

  async publish(id: string, postUrl: string) {
    const i = await this.item(id);
    if (i.publishedAt) throw new ConflictException('已经回填过了');
    await this.prisma.scheduleItem.update({ where: { id }, data: { publishedAt: new Date(), postUrl, failedReason: null } });
    await this.syncDraft(i.draftId);
    return shape(await this.item(id));
  }

  async fail(id: string, reason: string) {
    const i = await this.item(id);
    if (i.publishedAt) throw new ConflictException('已发布的排期不能标记失败');
    await this.prisma.scheduleItem.update({ where: { id }, data: { failedReason: reason } });
    await this.syncDraft(i.draftId);
    return shape(await this.item(id));
  }

  async metrics(id: string, input: z.infer<typeof MetricInput>, me: AuthUser) {
    const i = await this.item(id);
    if (!i.publishedAt) throw new ConflictException('还没发布，不能回填数据');
    const { checkpoint, ...nums } = input;
    await this.prisma.postMetric.upsert({
      where: { scheduleItemId_checkpoint: { scheduleItemId: id, checkpoint } },
      create: { scheduleItemId: id, checkpoint, ...nums, userId: me.id },
      update: { ...nums, userId: me.id, recordedAt: new Date() },
    });
    // 主表保留最新一次（7 天优先于 24 小时）
    const latest = await this.prisma.postMetric.findFirst({ where: { scheduleItemId: id }, orderBy: { checkpoint: 'desc' } });
    const { reads, likes, saves, comments } = latest!;
    await this.prisma.scheduleItem.update({ where: { id }, data: { reads, likes, saves, comments } });
    return shape(await this.item(id));
  }

  /** 素材包：文案、配图建议，以及素材库里标签对得上的图片（下载不到的跳过）。 */
  async pack(id: string) {
    const i = await this.item(id);
    const v = i.draft.versions[0];
    if (!v) throw new BadRequestException('稿件还没有采用的版本');
    const zip = new JSZip();
    zip.file('完整文案.txt', draftText(v));
    zip.file('标题.txt', v.title);
    zip.file('正文.txt', v.body);
    zip.file('话题.txt', v.tags.map((t) => `#${t}`).join(' '));
    zip.file('配图建议.txt', [v.coverPrompt ? `封面：${v.coverPrompt}` : null, ...v.imageTips.map((t, n) => `图${n + 1}：${t}`)].filter(Boolean).join('\n'));
    const tags = [...v.tags, i.draft.topic.category];
    const assets = await this.prisma.asset.findMany({ where: { kind: 'image', tags: { hasSome: tags } }, take: 9, orderBy: { createdAt: 'desc' } });
    const missed: string[] = [];
    for (const [n, a] of assets.entries()) {
      try {
        if (!/^https?:\/\//.test(a.url)) throw new Error('不是网络地址');
        const res = await fetch(a.url, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const ext = (res.headers.get('content-type') ?? '').split('/')[1]?.split(';')[0] || 'jpg';
        zip.file(`图片/${String(n + 1).padStart(2, '0')}-${a.title.replace(/[\\/:*?"<>|]/g, '_')}.${ext}`, Buffer.from(await res.arrayBuffer()));
      } catch (e) {
        missed.push(`${a.title}（${a.url}）：${(e as Error).message}`);
      }
    }
    if (missed.length) zip.file('未能下载的素材.txt', missed.join('\n'));
    const name = `${i.publishAt.toISOString().slice(0, 10)}-${i.account.name}-${i.draft.topic.title}`.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
    return { name: `${name}.zip`, data: await zip.generateAsync({ type: 'nodebuffer' }) };
  }

  private get cronOn() {
    return this.config.get('CRON_ENABLED', 'true') !== 'false';
  }

  /** 每分钟：到点的排期提醒内容运营去发。 */
  @Cron('0 * * * * *', { name: 'publish-remind' })
  async remindDue(now = new Date(), force = false) {
    if (!force && !this.cronOn) return 0;
    const due = await this.prisma.scheduleItem.findMany({
      where: { publishAt: { lte: now }, remindedAt: null, publishedAt: null, failedReason: null },
      include: itemInclude,
    });
    for (const i of due) {
      await this.notify.toRoles([Role.CONTENT], `【到点发布】${i.account.name}：《${i.draft.topic.title}》该发了。到工作台“排期”复制文案、下载素材包，发完回填链接。`);
      await this.prisma.scheduleItem.update({ where: { id: i.id }, data: { remindedAt: now } });
    }
    if (due.length) this.log.log(`已提醒 ${due.length} 条到点排期`);
    return due.length;
  }

  /** 每小时：发布满 24 小时、7 天提醒回填数据。 */
  @Cron('0 5 * * * *', { name: 'metrics-remind' })
  async remindMetrics(now = new Date(), force = false) {
    if (!force && !this.cronOn) return 0;
    let n = 0;
    for (const [field, age, label] of [
      ['remind24At', DAY, '24 小时'],
      ['remind7dAt', 7 * DAY, '7 天'],
    ] as const) {
      const items = await this.prisma.scheduleItem.findMany({
        where: { publishedAt: { lte: new Date(now.getTime() - age) }, [field]: null },
        include: itemInclude,
      });
      for (const i of items) {
        await this.notify.toRoles([Role.CONTENT], `【回填数据】${i.account.name}：《${i.draft.topic.title}》发布满 ${label}了，请到工作台“排期”回填阅读、点赞、收藏、评论数。`);
        await this.prisma.scheduleItem.update({ where: { id: i.id }, data: { [field]: now } });
        n++;
      }
    }
    return n;
  }
}

@Controller('schedule')
export class ScheduleController {
  constructor(private readonly schedule: ScheduleService) {}

  @Get()
  list(@Query(new ZodPipe(RangeQuery)) q: z.infer<typeof RangeQuery>) {
    return this.schedule.list(q.from, q.to);
  }

  @Get('today')
  today() {
    return this.schedule.today();
  }

  @Get('metrics-due')
  metricsDue() {
    return this.schedule.metricsDue();
  }

  @Post()
  @Roles(Role.CONTENT)
  create(@Body(new ZodPipe(CreateInput)) body: z.infer<typeof CreateInput>) {
    return this.schedule.create(body);
  }

  @Patch(':id')
  @Roles(Role.CONTENT)
  update(@Param('id') id: string, @Body(new ZodPipe(UpdateInput)) body: z.infer<typeof UpdateInput>) {
    return this.schedule.update(id, body);
  }

  @Delete(':id')
  @Roles(Role.CONTENT)
  remove(@Param('id') id: string) {
    return this.schedule.remove(id);
  }

  @Get(':id/package')
  @Roles(Role.CONTENT)
  async pack(@Param('id') id: string, @Res() res: Response) {
    const { name, data } = await this.schedule.pack(id);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.send(data);
  }

  @Post(':id/publish')
  @Roles(Role.CONTENT)
  publish(@Param('id') id: string, @Body(new ZodPipe(PublishInput)) body: z.infer<typeof PublishInput>) {
    return this.schedule.publish(id, body.postUrl);
  }

  @Post(':id/fail')
  @Roles(Role.CONTENT)
  fail(@Param('id') id: string, @Body(new ZodPipe(FailInput)) body: z.infer<typeof FailInput>) {
    return this.schedule.fail(id, body.reason);
  }

  @Post(':id/metrics')
  @Roles(Role.CONTENT)
  metrics(@Param('id') id: string, @Body(new ZodPipe(MetricInput)) body: z.infer<typeof MetricInput>, @CurrentUser() me: AuthUser) {
    return this.schedule.metrics(id, body, me);
  }
}

@Module({ providers: [ScheduleService], controllers: [ScheduleController] })
export class ScheduleModule {}
