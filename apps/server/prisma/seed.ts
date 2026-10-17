/**
 * 初始数据：风控初始词库（PRD 7.1）、首位管理员、知识库与 FAQ 骨架、选题类别预置（PRD 4.1）。
 * 可重复执行，已存在的数据不会重复插入。
 * 运行：pnpm --filter @hsj/server db:seed
 */
import { PrismaClient, Role } from '@prisma/client';
import { DEFAULT_RULES, DEFAULT_SUGGESTIONS, DEFAULT_TOPIC_CATEGORIES } from '@hsj/shared';

const prisma = new PrismaClient();

async function main() {
  // 风控词库
  for (const rule of DEFAULT_RULES) {
    for (const word of rule.words) {
      const exists = await prisma.riskWord.findFirst({ where: { word, platform: null } });
      if (!exists) {
        await prisma.riskWord.create({
          data: { word, category: rule.category, level: rule.level, suggestion: DEFAULT_SUGGESTIONS[word] },
        });
      }
    }
  }
  // 小红书专业号自动回复禁止出现微信、电话（2025-01-07 起），在小红书上升级为拦截
  for (const word of ['微信号', '电话', 'VX', '薇信']) {
    const exists = await prisma.riskWord.findFirst({ where: { word, platform: 'XHS' } });
    if (!exists) {
      await prisma.riskWord.create({
        data: { word, category: '平台引流敏感词', level: 'block', platform: 'XHS', suggestion: '官方留资卡或社媒名片' },
      });
    }
  }
  // 食养知识类：放行但提示核对依据
  if (!(await prisma.riskWord.findFirst({ where: { word: '富含膳食纤维' } }))) {
    await prisma.riskWord.create({ data: { word: '富含膳食纤维', category: '食养知识类表述', level: 'pass', whitelist: true } });
  }

  // 首位管理员：用企业微信成员账号登录
  const adminWecomId = process.env.SEED_ADMIN_WECOM_ID;
  if (adminWecomId) {
    await prisma.user.upsert({
      where: { wecomId: adminWecomId },
      update: {},
      create: { wecomId: adminWecomId, name: process.env.SEED_ADMIN_NAME ?? '管理员', roles: [Role.ADMIN] },
    });
  }

  // 知识库骨架：内容待运营补充
  if ((await prisma.knowledgeItem.count()) === 0) {
    await prisma.knowledgeItem.createMany({
      data: [
        { kind: 'variety', title: '金傲芬', content: '果皮金黄，果肉琥珀色，甜度高。（上市时间、规格待运营补充）' },
        { kind: 'variety', title: '青皮', content: '外皮青绿，口感清爽，籽感明显。（上市时间、规格待运营补充）' },
        { kind: 'variety', title: '格莱斯', content: '个头较小，软糯，适合剥皮直接吃。（上市时间、规格待运营补充）' },
        { kind: 'origin', title: '产地', content: '云南干热河谷：光照足、昼夜温差大，鲜果在主流产区下市后成熟，错峰上市。' },
        { kind: 'compliance', title: '养胃', content: '改为：口感绵软，适合早餐搭配' },
        { kind: 'compliance', title: '润肠通便', content: '改为：富含膳食纤维（以检测报告为准）' },
      ],
    });
  }
  if ((await prisma.faqItem.count()) === 0) {
    await prisma.faqItem.createMany({
      data: [
        { category: '价格规格', question: '多少钱一盒？', answer: '以当季团购活动为准，AI 不自行报价。' },
        { category: '保存方法', question: '无花果怎么保存？', answer: '常温 1 天内吃完；冷藏单层平铺，3 天内口感最好。' },
        { category: '代理政策', question: '有没有代理价？', answer: '代理与批发由招商负责人一对一沟通。', audience: 'B' },
      ],
    });
  }
  // 选题类别：C 端 6 类、B 端 5 类
  for (const audience of ['C', 'B'] as const) {
    await prisma.topicCategory.createMany({
      data: DEFAULT_TOPIC_CATEGORIES[audience].map((name, sort) => ({ audience, name, sort })),
      skipDuplicates: true,
    });
  }
}

main()
  .then(() => console.log('初始数据已写入'))
  .finally(() => prisma.$disconnect());
