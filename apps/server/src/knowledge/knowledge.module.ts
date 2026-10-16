import { Body, Controller, Delete, Get, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { Audience, Role } from '@prisma/client';
import { z } from 'zod';
import { Roles } from '../common/auth.decorators';
import { ZodPipe } from '../common/zod.pipe';
import { PrismaService } from '../prisma/prisma.service';

const KINDS = ['variety', 'origin', 'season', 'price', 'compliance'] as const;
const FAQ_CATEGORIES = ['价格规格', '品种区别', '上市时间', '发货与配送范围', '保存方法', '售后', '企业采购', '代理政策'] as const;

const ItemInput = z.object({
  kind: z.enum(KINDS),
  title: z.string().trim().min(1, '请填写标题'),
  content: z.string().trim().min(1, '请填写内容'),
});
const FaqInput = z.object({
  category: z.enum(FAQ_CATEGORIES),
  question: z.string().trim().min(1, '请填写问题'),
  answer: z.string().trim().min(1, '请填写答案'),
  audience: z.nativeEnum(Audience).nullable().default(null),
});
const AssetInput = z.object({
  title: z.string().trim().min(1, '请填写素材名称'),
  url: z.string().url('请填写素材地址'),
  kind: z.enum(['image', 'video']),
  tags: z.array(z.string().trim().min(1)).default([]),
});

/**
 * M2 品牌知识库：AI 生成与自动回复的唯一事实依据。
 * 写操作限内容运营（管理员总是放行），所有成员可读。
 */
@Controller('knowledge')
class KnowledgeController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('meta')
  meta() {
    return { kinds: KINDS, faqCategories: FAQ_CATEGORIES };
  }

  @Get('items')
  items(@Query('kind') kind?: string) {
    return this.prisma.knowledgeItem.findMany({ where: kind ? { kind } : undefined, orderBy: { updatedAt: 'desc' } });
  }

  @Roles(Role.CONTENT)
  @Post('items')
  createItem(@Body(new ZodPipe(ItemInput)) body: z.infer<typeof ItemInput>) {
    return this.prisma.knowledgeItem.create({ data: body });
  }

  @Roles(Role.CONTENT)
  @Patch('items/:id')
  updateItem(@Param('id') id: string, @Body(new ZodPipe(ItemInput.partial())) body: Partial<z.infer<typeof ItemInput>>) {
    return this.prisma.knowledgeItem.update({ where: { id }, data: body });
  }

  @Roles(Role.CONTENT)
  @Delete('items/:id')
  async removeItem(@Param('id') id: string) {
    await this.prisma.knowledgeItem.delete({ where: { id } });
    return { ok: true };
  }

  @Get('faqs')
  faqs(@Query('category') category?: string) {
    return this.prisma.faqItem.findMany({ where: category ? { category } : undefined, orderBy: { updatedAt: 'desc' } });
  }

  @Roles(Role.CONTENT)
  @Post('faqs')
  createFaq(@Body(new ZodPipe(FaqInput)) body: z.infer<typeof FaqInput>) {
    return this.prisma.faqItem.create({ data: body });
  }

  @Roles(Role.CONTENT)
  @Patch('faqs/:id')
  updateFaq(@Param('id') id: string, @Body(new ZodPipe(FaqInput.partial())) body: Partial<z.infer<typeof FaqInput>>) {
    return this.prisma.faqItem.update({ where: { id }, data: body });
  }

  @Roles(Role.CONTENT)
  @Delete('faqs/:id')
  async removeFaq(@Param('id') id: string) {
    await this.prisma.faqItem.delete({ where: { id } });
    return { ok: true };
  }

  /**
   * 知识检索：先用关键词匹配知识条目与 FAQ。
   * 语义检索（pgvector）等模型网关 M4-1 定下向量模型后替换这里的实现，接口不变。
   */
  @Get('search')
  async search(@Query('q') q = '') {
    const term = q.trim();
    if (!term) return { items: [], faqs: [] };
    const like = { contains: term, mode: 'insensitive' as const };
    const [items, faqs] = await Promise.all([
      this.prisma.knowledgeItem.findMany({ where: { OR: [{ title: like }, { content: like }] }, take: 10 }),
      this.prisma.faqItem.findMany({ where: { OR: [{ question: like }, { answer: like }] }, take: 10 }),
    ]);
    return { items, faqs };
  }

  @Get('assets')
  assets(@Query('tag') tag?: string) {
    return this.prisma.asset.findMany({ where: tag ? { tags: { has: tag } } : undefined, orderBy: { createdAt: 'desc' } });
  }

  /** 按标签推荐素材：命中标签越多越靠前。 */
  @Get('assets/recommend')
  async recommend(@Query('tags') tags = '') {
    const want = tags.split(',').map((t) => t.trim()).filter(Boolean);
    if (!want.length) return [];
    const found = await this.prisma.asset.findMany({ where: { tags: { hasSome: want } } });
    const score = (t: string[]) => t.filter((x) => want.includes(x)).length;
    return found.sort((a, b) => score(b.tags) - score(a.tags)).slice(0, 8);
  }

  @Roles(Role.CONTENT)
  @Post('assets')
  createAsset(@Body(new ZodPipe(AssetInput)) body: z.infer<typeof AssetInput>) {
    return this.prisma.asset.create({ data: body });
  }

  @Roles(Role.CONTENT)
  @Patch('assets/:id')
  updateAsset(@Param('id') id: string, @Body(new ZodPipe(AssetInput.partial())) body: Partial<z.infer<typeof AssetInput>>) {
    return this.prisma.asset.update({ where: { id }, data: body });
  }

  @Roles(Role.CONTENT)
  @Delete('assets/:id')
  async removeAsset(@Param('id') id: string) {
    await this.prisma.asset.delete({ where: { id } });
    return { ok: true };
  }
}

@Module({ controllers: [KnowledgeController] })
export class KnowledgeModule {}
