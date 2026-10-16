import { Body, Controller, Delete, Get, Injectable, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { Platform, Role } from '@prisma/client';
import { RiskEngine, type RiskLevel, type RiskRule } from '@hsj/shared';
import { z } from 'zod';
import { AuditService } from '../audit/audit.module';
import { AuthUser, CurrentUser, Roles } from '../common/auth.decorators';
import { ZodPipe } from '../common/zod.pipe';
import { PrismaService } from '../prisma/prisma.service';

const LEVELS = ['block', 'warn', 'pass'] as const;

const WordInput = z.object({
  word: z.string().trim().min(1, '请填写词'),
  category: z.string().trim().min(1, '请填写类别'),
  level: z.enum(LEVELS),
  platform: z.nativeEnum(Platform).nullable().default(null),
  whitelist: z.boolean().default(false),
  suggestion: z.string().trim().optional(),
});
const CheckInput = z.object({
  text: z.string(),
  platform: z.nativeEnum(Platform).optional(),
  /** 带上来源时记录命中日志，用于每周高频词汇总 */
  source: z.enum(['draft', 'reply']).optional(),
  sourceId: z.string().optional(),
});

/**
 * M5 风控：词库存在数据库里，按平台各编译一个引擎并缓存，词库一改就失效重建。
 * 平台专属词 + 通用词（platform 为空）一起生效。
 */
@Injectable()
export class RiskService {
  private cache = new Map<string, Promise<RiskEngine>>();

  constructor(private readonly prisma: PrismaService) {}

  engine(platform?: Platform) {
    const key = platform ?? 'ALL';
    let e = this.cache.get(key);
    if (!e) {
      e = this.build(platform);
      e.catch(() => this.cache.delete(key));
      this.cache.set(key, e);
    }
    return e;
  }

  invalidate() {
    this.cache.clear();
  }

  async check(input: z.infer<typeof CheckInput>) {
    const hits = (await this.engine(input.platform)).scan(input.text);
    if (input.source && input.sourceId && hits.length) {
      await this.prisma.riskHitLog.createMany({
        data: hits.map((h) => ({ source: input.source!, sourceId: input.sourceId!, word: h.word, level: h.level, category: h.category })),
      });
    }
    return { blocked: hits.some((h) => h.level === 'block'), hits };
  }

  private async build(platform?: Platform) {
    const words = await this.prisma.riskWord.findMany({
      where: { OR: [{ platform: null }, ...(platform ? [{ platform }] : [])] },
    });
    const rules = new Map<string, RiskRule>();
    const suggestions: Record<string, string> = {};
    const whitelist: string[] = [];
    for (const w of words) {
      if (w.whitelist) {
        whitelist.push(w.word);
        continue;
      }
      const key = `${w.category}|${w.level}`;
      if (!rules.has(key)) rules.set(key, { category: w.category, level: w.level as RiskLevel, words: [] });
      rules.get(key)!.words.push(w.word);
      if (w.suggestion) suggestions[w.word] = w.suggestion;
    }
    return new RiskEngine([...rules.values()], suggestions, whitelist);
  }
}

@Controller('risk')
class RiskController {
  constructor(
    private readonly risk: RiskService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Post('check')
  check(@Body(new ZodPipe(CheckInput)) body: z.infer<typeof CheckInput>) {
    return this.risk.check(body);
  }

  @Get('words')
  words(@Query('q') q?: string) {
    return this.prisma.riskWord.findMany({
      where: q ? { word: { contains: q } } : undefined,
      orderBy: [{ category: 'asc' }, { word: 'asc' }],
    });
  }

  @Roles(Role.REVIEWER)
  @Post('words')
  async create(@CurrentUser() me: AuthUser, @Body(new ZodPipe(WordInput)) body: z.infer<typeof WordInput>) {
    const word = await this.prisma.riskWord.create({ data: body });
    this.risk.invalidate();
    await this.audit.log(me.id, 'risk_word.create', word.id, body);
    return word;
  }

  @Roles(Role.REVIEWER)
  @Patch('words/:id')
  async update(
    @CurrentUser() me: AuthUser,
    @Param('id') id: string,
    @Body(new ZodPipe(WordInput.partial())) body: Partial<z.infer<typeof WordInput>>,
  ) {
    const word = await this.prisma.riskWord.update({ where: { id }, data: body });
    this.risk.invalidate();
    await this.audit.log(me.id, 'risk_word.update', id, body);
    return word;
  }

  @Roles(Role.REVIEWER)
  @Delete('words/:id')
  async remove(@CurrentUser() me: AuthUser, @Param('id') id: string) {
    await this.prisma.riskWord.delete({ where: { id } });
    this.risk.invalidate();
    await this.audit.log(me.id, 'risk_word.delete', id);
    return { ok: true };
  }

  /** 近 N 天（默认 7 天）高频命中词，用于优化 AI 生成提示。 */
  @Get('stats/top-words')
  async topWords(@Query('days') days = '7') {
    const since = new Date(Date.now() - Math.min(Number(days) || 7, 90) * 86_400_000);
    const rows = await this.prisma.riskHitLog.groupBy({
      by: ['word', 'level', 'category'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
      orderBy: { _count: { word: 'desc' } },
      take: 20,
    });
    return rows.map((r) => ({ word: r.word, level: r.level, category: r.category, count: r._count._all }));
  }
}

@Module({ controllers: [RiskController], providers: [RiskService], exports: [RiskService] })
export class RiskModule {}
