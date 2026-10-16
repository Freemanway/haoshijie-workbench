/**
 * 提示词模板。每个模板带版本号，调用日志里记录“模板名@版本”，改提示词时升版本，便于追溯哪篇稿件用的哪版提示词。
 * mock 是演示模型的输出规则，只在没配置真实模型时使用。
 */
import { SeasonNode, XHS_LIMITS } from '@hsj/shared';
import { z } from 'zod';

export interface PromptTemplate<I, O> {
  name: string;
  version: number;
  temperature: number;
  system: string;
  user: (input: I) => string;
  output: z.ZodType<O, z.ZodTypeDef, unknown>;
  mock: (input: I) => O;
}

const COMPLIANCE = `合规红线（必须遵守）：
- 只能使用“品牌资料”里给出的事实（品种、产地、上市时间、价格规格等），资料里没有的不要编造，宁可不写。
- 不得出现医疗功效或疗效承诺（如治便秘、降血压、抗癌、排毒、润肠通便），营养相关只能用“富含膳食纤维”这类有依据的表述。
- 不得使用“最好、第一、顶级、100%”等极限用语。
- 不得出现微信号、电话、二维码、“加V”等站外导流信息，引导咨询只说“私信我”或“看主页”。`;

const facts = (items: { title: string; content: string }[]) =>
  items.length ? items.map((f, i) => `${i + 1}. 【${f.title}】${f.content}`).join('\n') : '（暂无品牌资料，只写不涉及具体事实的内容）';

// ---------- 每周选题 ----------

export interface TopicsInput {
  weekOf: string;
  weekEnd: string;
  counts: { C: number; B: number };
  categories: { C: string[]; B: string[] };
  seasonNodes: SeasonNode[];
  lastWeek: { title: string; reads: number; likes: number; saves: number }[];
  hotQuestions: { question: string; count: number }[];
  avoidTitles: string[];
  facts: { title: string; content: string }[];
}

const TopicOut = z.object({
  title: z.string().min(1),
  audience: z.enum(['C', 'B']),
  category: z.string().min(1),
  reason: z.string().min(1),
  suggestedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  seasonTag: z.string().nullish(),
});
export type TopicOut = z.infer<typeof TopicOut>;

const MOCK_TITLES: Record<string, string[]> = {
  营养食养: ['秋天吃无花果的3个小讲究', '一颗无花果里有什么营养'],
  品种对比: ['波姬红和青皮无花果怎么选', '3个无花果品种口感横评'],
  开箱: ['开箱｜产地直发的无花果礼盒', '盲盒礼盒开出了什么'],
  储存食用: ['无花果买回家怎么放不坏', '无花果的5种好吃做法'],
  伴手礼与企业礼赠: ['秋日伴手礼就送这一盒', '公司团购礼盒怎么挑'],
  产地纪实: ['凌晨4点的无花果园', '跟果农摘一天无花果'],
  产地优势: ['干热河谷为什么种得出好无花果', '一张图看懂我们的产区'],
  错峰空档: ['冬天也有鲜无花果：错峰上市', '市场空档期的鲜果货源'],
  采摘打包实拍: ['从枝头到冷链：打包实拍', '一箱无花果的出园流程'],
  供货稳定性: ['稳定供货靠什么：基地+冷链', '旺季不断货的秘密'],
  合作采购政策: ['果商合作政策一次说清', '起订量与账期说明'],
};

export const weeklyTopics: PromptTemplate<TopicsInput, { topics: TopicOut[] }> = {
  name: 'weekly_topics',
  version: 1,
  temperature: 0.8,
  system: `你是“好时节”无花果品牌的小红书内容策划。好时节做无花果产地直供：C 端面向 30–40 岁中产女性，B 端面向小 B 果商和代理商。
你的任务是为下一周策划选题，每个选题都要说清为什么这周做它。
${COMPLIANCE}
只输出 JSON，不要输出其他文字。`,
  user: (i) => `请为 ${i.weekOf} 至 ${i.weekEnd} 这一周策划小红书选题：C 端 ${i.counts.C} 个、B 端 ${i.counts.B} 个。

可用类别（category 必须从这里选，尽量不重复）：
- C 端：${i.categories.C.join('、')}
- B 端：${i.categories.B.join('、')}

这一周前后的季节节点：${i.seasonNodes.length ? i.seasonNodes.map((n) => `${n.name}（${n.start} 至 ${n.end}）`).join('、') : '无'}
近两周发布作品的数据：${i.lastWeek.length ? i.lastWeek.map((p) => `《${p.title}》阅读 ${p.reads} 点赞 ${p.likes} 收藏 ${p.saves}`).join('；') : '暂无'}
近 7 天私信高频问题：${i.hotQuestions.length ? i.hotQuestions.map((q) => `${q.question}（${q.count} 次）`).join('；') : '暂无'}
最近已有选题（不要重复）：${i.avoidTitles.length ? i.avoidTitles.join('；') : '无'}

品牌资料：
${facts(i.facts)}

输出格式：
{"topics":[{"title":"选题标题，20 字以内","audience":"C 或 B","category":"类别","reason":"选题理由，结合节点、数据或私信问题，一两句话","suggestedDate":"YYYY-MM-DD，在这一周内，同一天不超过 1 篇","seasonTag":"相关季节节点名，没有则为 null"}]}`,
  output: z.object({ topics: z.array(TopicOut) }),
  mock: (i) => {
    const topics: TopicOut[] = [];
    let day = 0;
    for (const audience of ['C', 'B'] as const) {
      const cats = i.categories[audience];
      for (let k = 0; k < i.counts[audience]; k++) {
        const category = cats[k % cats.length] ?? '产地纪实';
        const pool = MOCK_TITLES[category] ?? [`${category}：好时节无花果`];
        let title = pool.find((t) => !i.avoidTitles.includes(t)) ?? `${pool[0]}（${k + 2}）`;
        while (i.avoidTitles.includes(title) || topics.some((t) => t.title === title)) title += '·续';
        const node = i.seasonNodes[0];
        topics.push({
          title,
          audience,
          category,
          reason: node ? `临近${node.name}，${audience === 'C' ? '送礼和尝鲜需求上升' : '果商在备货'}，适合发这类内容。` : `${category}是${audience} 端客户常问的话题。`,
          suggestedDate: addDaysYmd(i.weekOf, day++ % 7),
          seasonTag: node?.name ?? null,
        });
      }
    }
    return { topics };
  },
};

function addDaysYmd(ymd: string, days: number) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------- 小红书稿件 ----------

export interface DraftTopic {
  title: string;
  audience: 'C' | 'B';
  category: string;
  seasonTag?: string | null;
  reason?: string | null;
}

export interface XhsDraftInput {
  topic: DraftTopic;
  facts: { title: string; content: string }[];
  /** 知识库里的合规口径（哪些说法要换成什么） */
  rules?: { avoid: string; instead: string }[];
  versions: number;
}

const rulesText = (rules?: { avoid: string; instead: string }[]) =>
  rules?.length ? `\n\n品牌合规口径（这些说法不要用，按右边的写）：\n${rules.map((r) => `- 不写“${r.avoid}”→ ${r.instead}`).join('\n')}` : '';

const XhsVersion = z.object({
  title: z.string(),
  body: z.string(),
  tags: z.array(z.string()).transform((t) => t.map((x) => x.replace(/^#/, '').trim()).filter(Boolean)),
  coverPrompt: z.string().default(''),
  imageTips: z.array(z.string()).default([]),
});
export type XhsVersion = z.infer<typeof XhsVersion>;

const SPEC = `规格：标题不超过 ${XHS_LIMITS.title} 字（含 emoji）；正文不超过 ${XHS_LIMITS.body} 字，分段、口语化，可少量使用 emoji；话题标签 ${XHS_LIMITS.tagsMin}–${XHS_LIMITS.tagsMax} 个，不带 #；首图提示词用于文生图，描述画面、构图、光线和风格；配图建议 3–6 条，说明每张图拍什么。`;

const VERSION_FORMAT = `{"title":"标题","body":"正文","tags":["标签"],"coverPrompt":"首图提示词","imageTips":["配图建议"]}`;

export const xhsDraft: PromptTemplate<XhsDraftInput, { versions: XhsVersion[] }> = {
  name: 'xhs_draft',
  version: 1,
  temperature: 0.9,
  system: `你是“好时节”无花果品牌的小红书文案。C 端读者是 30–40 岁中产女性，语气真诚、有生活感，像朋友分享；B 端读者是果商和代理商，语气专业、讲清产地、供货周期和合作方式，结尾引导私信咨询合作。
${COMPLIANCE}
${SPEC}
只输出 JSON，不要输出其他文字。`,
  user: (i) => `选题：${i.topic.title}
客群：${i.topic.audience === 'C' ? 'C 端消费者' : 'B 端果商/代理商'}
类别：${i.topic.category}${i.topic.seasonTag ? `\n季节节点：${i.topic.seasonTag}` : ''}${i.topic.reason ? `\n选题理由：${i.topic.reason}` : ''}

品牌资料（唯一事实依据）：
${facts(i.facts)}${rulesText(i.rules)}

请写 ${i.versions} 个风格不同的版本（例如一个偏故事、一个偏干货），输出：
{"versions":[${VERSION_FORMAT}]}`,
  output: z.object({ versions: z.array(XhsVersion).min(1) }),
  mock: (i) => ({
    versions: Array.from({ length: i.versions }, (_, k) => mockVersion(i.topic, i.facts, k)),
  }),
};

function clip(s: string, n: number) {
  return [...s].slice(0, n).join('');
}

function mockVersion(topic: DraftTopic, f: { title: string; content: string }[], k: number): XhsVersion {
  const lead = k % 2 === 0 ? '姐妹们，今天聊聊' : '干货整理｜';
  const title = clip(`${k % 2 === 0 ? '' : '📌'}${topic.title}`, XHS_LIMITS.title);
  const points = f.slice(k, k + 3).map((x, n) => `${n + 1}️⃣ ${x.title}：${x.content}`);
  const body = [
    `${lead}${topic.title}🍈`,
    ...(points.length ? points : ['我们在产地守着每一棵果树，成熟了才摘。']),
    topic.audience === 'C' ? '想了解品种和规格可以私信我～' : '果商朋友想了解供货和合作方式，欢迎私信详谈。',
  ].join('\n\n');
  return {
    title,
    body: clip(body, XHS_LIMITS.body),
    tags: ['无花果', '好时节', topic.category, topic.audience === 'C' ? '秋天的第一口鲜果' : '水果批发', '产地直发', ...(topic.seasonTag ? [topic.seasonTag] : [])],
    coverPrompt: `清晨果园里刚摘下的无花果切面特写，果肉饱满，暖色自然光，浅景深，小红书封面风格，${k % 2 === 0 ? '生活感' : '干净留白'}`,
    imageTips: ['果园枝头实拍', '切面特写', '礼盒或打包场景'],
  };
}

// ---------- 改写 ----------

export type RewriteMode = 'rewrite' | 'tone' | 'shorter' | 'longer' | 'reject_reason';
export const REWRITE_MODES: Record<RewriteMode, string> = {
  rewrite: '整篇重写',
  tone: '改语气',
  shorter: '缩短',
  longer: '扩写',
  reject_reason: '按驳回原因重写',
};

export interface RewriteInput {
  topic: DraftTopic;
  draft: XhsVersion;
  mode: RewriteMode;
  /** mode=tone 时的目标语气；mode=reject_reason 时的驳回原因；其他模式可附加要求 */
  instruction?: string;
  facts: { title: string; content: string }[];
  rules?: { avoid: string; instead: string }[];
}

const MODE_ASK: Record<RewriteMode, (i: RewriteInput) => string> = {
  rewrite: (i) => `换一个角度整篇重写，标题和开头都要不同。${i.instruction ? `额外要求：${i.instruction}` : ''}`,
  tone: (i) => `保持内容和事实不变，把语气改成：${i.instruction || '更轻松亲切'}。`,
  shorter: (i) => `精简到原来一半左右的篇幅，保留最有用的信息。${i.instruction ?? ''}`,
  longer: (i) => `在不编造事实的前提下扩写，补充细节和场景（仍不超过 ${XHS_LIMITS.body} 字）。${i.instruction ?? ''}`,
  reject_reason: (i) => `审核人驳回了这篇稿件，原因是：“${i.instruction ?? ''}”。请逐条按原因修改，其他部分尽量保留。`,
};

export const rewrite: PromptTemplate<RewriteInput, XhsVersion> = {
  name: 'xhs_rewrite',
  version: 1,
  temperature: 0.7,
  system: xhsDraft.system,
  user: (i) => `选题：${i.topic.title}（${i.topic.audience === 'C' ? 'C 端' : 'B 端'}，${i.topic.category}）

当前稿件：
${JSON.stringify(i.draft, null, 2)}

修改要求：${MODE_ASK[i.mode](i)}

品牌资料（唯一事实依据）：
${facts(i.facts)}${rulesText(i.rules)}

输出修改后的完整稿件：
${VERSION_FORMAT}`,
  output: XhsVersion,
  mock: (i) => {
    const d = i.draft;
    const paras = d.body.split(/\n+/).filter(Boolean);
    switch (i.mode) {
      case 'shorter':
        return { ...d, body: paras.slice(0, Math.max(1, Math.ceil(paras.length / 2))).join('\n\n') };
      case 'longer':
        return { ...d, body: clip(`${d.body}\n\n${i.facts.map((f) => `· ${f.content}`).join('\n') || '每一颗都是当天采摘、当天打包。'}`, XHS_LIMITS.body) };
      case 'tone':
        return { ...d, body: `【${i.instruction || '轻松'}版】\n${d.body}` };
      case 'reject_reason':
        return { ...d, body: `${d.body}\n\n（已按审核意见修改：${i.instruction ?? ''}）` };
      default:
        return { ...d, title: clip(`换个角度：${i.topic.title}`, XHS_LIMITS.title), body: [...paras].reverse().join('\n\n') };
    }
  },
};

