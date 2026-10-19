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
    tags: ['无花果', '好时节', topic.category, topic.audience === 'C' ? '秋日鲜果' : '水果批发', '产地直发', ...(topic.seasonTag ? [topic.seasonTag] : [])],
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


// ---------- 私信接待（M8） ----------

export interface ChatTurn {
  sender: string; // customer | ai | agent | system
  text: string;
}

export interface InboxReplyInput {
  platformName: string;
  accountAudience: 'C' | 'B';
  history: ChatTurn[];
  message: string;
  kind: 'dm' | 'comment';
  faqs: { question: string; answer: string }[];
  facts: { title: string; content: string }[];
  rules?: { avoid: string; instead: string }[];
  /** 按客群配置的引流话术（只用平台官方组件，不带微信号和电话） */
  diversion: { C: string; B: string };
  /** 收集手机号、地址前要告知的用途（个人信息保护法告知同意） */
  privacyNotice?: string;
}

const InboxReplyOut = z.object({
  audience: z.enum(['C', 'B', 'unknown']),
  intent: z.enum(['high', 'medium', 'low']),
  /** 客户明确要求人工 */
  wantsHuman: z.boolean(),
  /** 投诉、售后、情绪负面 */
  negative: z.boolean(),
  /** B 端询价、问起订量、谈代理合作 */
  bizDeal: z.boolean(),
  /** 回答用到了 FAQ 或品牌资料；资料里找不到答案时为 false */
  matched: z.boolean(),
  reply: z.string().min(1),
});
export type InboxReplyOut = z.infer<typeof InboxReplyOut>;

const turns = (h: ChatTurn[]) =>
  h.length ? h.map((t) => `${t.sender === 'customer' ? '客户' : t.sender === 'agent' ? '客服' : t.sender === 'ai' ? '你' : '系统'}：${t.text}`).join('\n') : '（第一句）';

const faqText = (faqs: { question: string; answer: string }[]) =>
  faqs.length ? faqs.map((f, n) => `${n + 1}. 问：${f.question}\n   答：${f.answer}`).join('\n') : '（没有匹配的 FAQ）';

const has = (s: string, words: string[]) => words.some((w) => s.includes(w));

export const inboxReply: PromptTemplate<InboxReplyInput, InboxReplyOut> = {
  name: 'inbox_reply',
  version: 1,
  temperature: 0.3,
  system: `你是“好时节”无花果品牌在小红书的客服，替品牌回复私信和评论区的咨询。好时节做无花果产地直供：C 端是 30–40 岁中产女性，自己吃或送礼；B 端是果商、代理商、企业采购。
要求：
- 只根据“FAQ”和“品牌资料”回答，资料里没有的（价格、库存、发货时间等）不要编，说“我帮你问一下同事”并把 matched 设为 false。
- 回复简短口语化，1–3 句，不超过 120 字，像真人客服；评论区回复更短，引导“私信我”。
- C 端侧重品种推荐、礼赠场景，需要深入沟通时用 C 端引流话术；B 端侧重供货周期、起订量、对接人，用 B 端引流话术。
- 判断客群：问起订量、批发价、代理、长期供货、开发票走公司 → B；自己吃、送人、尝鲜 → C；看不出来 → unknown。
- 判断意向：问价格、规格、下单方式、发货 → high；问品种、口感、保存 → medium；闲聊 → low。
- 客户要求人工、投诉售后或情绪不满、B 端谈价格和合作时，照常礼貌回复一句，并把对应字段设为 true，系统会转人工。
${COMPLIANCE}
只输出 JSON，不要输出其他文字。`,
  user: (i) => `平台：${i.platformName}（${i.kind === 'comment' ? '作品评论区' : '私信'}）
账号主要客群：${i.accountAudience === 'C' ? 'C 端消费者' : 'B 端果商'}

之前的对话：
${turns(i.history)}

客户刚发来：${i.message}

FAQ：
${faqText(i.faqs)}

品牌资料：
${facts(i.facts)}${rulesText(i.rules)}

引流话术（需要时原样或稍作改写使用）：
- C 端：${i.diversion.C}
- B 端：${i.diversion.B}${i.privacyNotice ? `\n\n需要客户留手机号或收货地址时，先告知用途：${i.privacyNotice}` : ''}

输出：
{"audience":"C|B|unknown","intent":"high|medium|low","wantsHuman":false,"negative":false,"bizDeal":false,"matched":true,"reply":"回复内容"}`,
  output: InboxReplyOut,
  mock: (i) => {
    const m = i.message;
    const bizDeal = has(m, ['代理', '起订', '批发', '拿货', '多少斤', '供货', '合作', '采购']);
    const audience = bizDeal || has(m, ['公司', '开票']) ? 'B' : has(m, ['送人', '送礼', '自己吃', '尝鲜', '好吃']) ? 'C' : i.accountAudience === 'B' ? 'unknown' : 'C';
    const wantsHuman = has(m, ['人工', '真人', '客服']);
    const negative = has(m, ['投诉', '烂了', '坏了', '退款', '差评', '太差', '生气']);
    const faq = i.faqs[0];
    const intent = has(m, ['多少钱', '价格', '怎么买', '下单', '发货', '规格']) || bizDeal ? 'high' : faq ? 'medium' : 'low';
    const reply = faq
      ? `${faq.answer}${i.kind === 'comment' ? ' 更多可以私信我哦～' : ''}`
      : bizDeal
        ? `感谢关注好时节！合作和价格我请招商同事跟你细聊。${i.diversion.B}`
        : '这个问题我帮你问一下同事，稍后回复你～';
    return { audience, intent, wantsHuman, negative, bizDeal, matched: Boolean(faq), reply };
  },
};

export interface CustomerSummaryInput {
  platformName: string;
  accountName: string;
  sourcePostUrl?: string | null;
  history: ChatTurn[];
  faqs: { question: string; answer: string }[];
  facts: { title: string; content: string }[];
}

const CustomerSummaryOut = z.object({
  summary: z.string().min(1),
  suggestedReply: z.string().min(1),
});
export type CustomerSummaryOut = z.infer<typeof CustomerSummaryOut>;

/** 转人工后给客服看的客户摘要和建议回复（客服确认后才发出）。 */
export const customerSummary: PromptTemplate<CustomerSummaryInput, CustomerSummaryOut> = {
  name: 'customer_summary',
  version: 1,
  temperature: 0.3,
  system: `你是“好时节”无花果品牌的客服主管，帮接手的客服快速了解客户。
summary：3 句以内，写清客户是谁（C 端自己吃/送礼，或 B 端果商/代理/企业采购）、想要什么（品种、数量、预算、时间、地区）、卡在哪里、情绪如何；没提到的不写。
suggestedReply：客服接下来可以发的一句回复，1–3 句，口语化，只用 FAQ 和品牌资料里的事实。
${COMPLIANCE}
只输出 JSON，不要输出其他文字。`,
  user: (i) => `平台：${i.platformName}，账号：${i.accountName}${i.sourcePostUrl ? `，客户来自作品 ${i.sourcePostUrl}` : ''}

对话：
${turns(i.history)}

FAQ：
${faqText(i.faqs)}

品牌资料：
${facts(i.facts)}

输出：{"summary":"客户摘要","suggestedReply":"建议回复"}`,
  output: CustomerSummaryOut,
  mock: (i) => {
    const asks = i.history.filter((t) => t.sender === 'customer').map((t) => t.text);
    const last = asks.at(-1) ?? '';
    return {
      summary: `客户共发了 ${asks.length} 条消息，最近一条：“${clip(last, 40)}”。${asks.some((a) => has(a, ['代理', '起订', '批发', '拿货'])) ? '像是 B 端果商，在问合作。' : '像是 C 端消费者。'}`,
      suggestedReply: i.faqs[0]?.answer ?? '你好，我是好时节的客服，刚看了你的问题，我来帮你处理～',
    };
  },
};

// ---------- 线索（M10） ----------

export interface LeadExtractInput {
  audience: 'C' | 'B' | null;
  history: ChatTurn[];
}

const LeadExtractOut = z.object({
  audience: z.enum(['C', 'B', 'unknown']),
  intent: z.enum(['high', 'medium', 'low']),
  name: z.string().nullable(),
  wechat: z.string().nullable(),
  /** C 端：scene 自吃/送礼/企业采购，quantity 份数；B 端：city、channel 渠道类型、volume 预计采购量、mode 合作方式 */
  detail: z.record(z.string(), z.string().nullable()),
  /** 一句话意向，用于列表展示 */
  summary: z.string(),
});
export type LeadExtractOut = z.infer<typeof LeadExtractOut>;

/** 从私信对话里提取线索字段（PRD 6.1“AI 从对话提取”）。手机号由程序按规则识别，不交给模型。 */
export const leadExtract: PromptTemplate<LeadExtractInput, LeadExtractOut> = {
  name: 'lead_extract',
  version: 1,
  temperature: 0,
  system: `你是“好时节”无花果品牌的客资专员，从客户和客服的对话里提取线索信息。只写对话里客户明确说过的内容，没提到的填 null，不要猜。
audience：B 端果商、代理、企业批量采购为 B，自己吃、送人为 C，看不出来为 unknown。
intent：问价格、规格、下单、发货为 high；问品种、口感、保存为 medium；其他为 low。
detail：C 端填 scene（自吃/送礼/企业采购）和 quantity（份数或斤数）；B 端填 city（所在城市）、channel（渠道类型，如水果店、商超、社区团购、电商）、volume（预计采购量）、mode（合作方式，如批发、代理、长期供货）。
summary：一句话说清客户要什么，20 字以内。
只输出 JSON，不要输出其他文字。`,
  user: (i) => `目前判断的客群：${i.audience ?? '未知'}

对话：
${turns(i.history)}

输出：{"audience":"C|B|unknown","intent":"high|medium|low","name":null,"wechat":null,"detail":{},"summary":"一句话意向"}`,
  output: LeadExtractOut,
  mock: (i): LeadExtractOut => {
    const said = i.history.filter((t) => t.sender === 'customer').map((t) => t.text).join(' ');
    const b = has(said, ['代理', '起订', '批发', '拿货', '供货', '水果店', '商超']) || i.audience === 'B';
    const city = /([一-龥]{2,4})(市|这边|地区)/.exec(said)?.[1] ?? null;
    const qty = /(\d+)\s*(份|盒|箱|斤)/.exec(said);
    const wechat = /(?:微信|vx|VX|wx)[号:： ]*([A-Za-z][-_A-Za-z0-9]{5,19})/.exec(said)?.[1] ?? null;
    const name = /我(?:叫|是)([一-龥]{2,3})(?![一-龥]*(?:店|公司|老板))/.exec(said)?.[1] ?? null;
    const intent = has(said, ['多少钱', '价格', '怎么买', '下单', '发货', '规格', '起订']) ? 'high' : has(said, ['品种', '口感', '保存', '好吃']) ? 'medium' : 'low';
    return b
      ? { audience: 'B', intent, name, wechat, detail: { city, channel: has(said, ['水果店']) ? '水果店' : has(said, ['商超']) ? '商超' : null, volume: qty ? qty[0] : null, mode: has(said, ['代理']) ? '代理' : has(said, ['批发', '拿货']) ? '批发' : null }, summary: has(said, ['代理']) ? '咨询代理合作' : '咨询批发供货' }
      : { audience: has(said, ['送', '自己吃', '尝鲜']) || i.audience === 'C' ? 'C' : 'unknown', intent, name, wechat, detail: { scene: has(said, ['送']) ? '送礼' : has(said, ['公司', '员工', '福利']) ? '企业采购' : has(said, ['自己吃', '尝鲜']) ? '自吃' : null, quantity: qty ? qty[0] : null }, summary: has(said, ['送']) ? '想买无花果送人' : '咨询无花果' };
  },
};

export interface LeadScriptInput {
  audience: 'C' | 'B';
  status: string;
  intentSummary: string | null;
  detail: Record<string, string | null> | null;
  followUps: { note: string; at: string }[];
  history: ChatTurn[];
  facts: { title: string; content: string }[];
}

const LeadScriptOut = z.object({
  advice: z.string().min(1),
  scripts: z.array(z.string().min(1)).min(1).max(3),
});
export type LeadScriptOut = z.infer<typeof LeadScriptOut>;

/** 线索详情里的“推荐话术”：给负责人下一步怎么跟、可以直接发的话。 */
export const leadScript: PromptTemplate<LeadScriptInput, LeadScriptOut> = {
  name: 'lead_script',
  version: 1,
  temperature: 0.5,
  system: `你是“好时节”无花果品牌的销售主管，帮负责人跟进线索。
advice：下一步怎么跟，1–2 句（比如先确认什么、推荐什么规格、什么时候再联系）。
scripts：1–3 条可以直接在企业微信里发的话，口语化，每条 60 字以内，只用品牌资料里的事实；C 端侧重品种、礼盒、团购群福利，B 端侧重供货周期、起订量、对接方式。
${COMPLIANCE}
只输出 JSON，不要输出其他文字。`,
  user: (i) => `客群：${i.audience === 'C' ? 'C 端消费者' : 'B 端果商'}，状态：${i.status}
意向：${i.intentSummary ?? '未知'}；${Object.entries(i.detail ?? {}).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('，') || '无更多信息'}

跟进记录：
${i.followUps.map((f) => `- ${f.at} ${f.note}`).join('\n') || '（还没有）'}

私信对话：
${turns(i.history)}

品牌资料：
${facts(i.facts)}

输出：{"advice":"下一步建议","scripts":["话术1","话术2"]}`,
  output: LeadScriptOut,
  mock: (i) =>
    i.audience === 'B'
      ? { advice: '先确认对方所在城市和渠道类型，再发供货方案和起订量说明。', scripts: ['你好，我是好时节招商，方便说下你在哪个城市、做什么渠道吗？我按你的情况发供货方案。', '我们产地直发，供货周期和起订量我整理了一份说明，发你看看～'] }
      : { advice: i.followUps.length ? '已经联系过，可以邀请进团购群看当季实拍和优惠。' : '先打个招呼，问清楚是自己吃还是送人，再推荐规格。', scripts: ['你好呀，我是好时节的小鲜～想问下是自己吃还是送人呢？我帮你推荐合适的规格。', '这周有新到的鲜果，团购群里有实拍和优惠，需要的话我拉你进群～'] },
};
