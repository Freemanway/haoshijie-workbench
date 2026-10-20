/**
 * 上线前自检（M13-2）：检查生产环境的配置和基础数据，有“不通过”项时退出码为 1。
 *
 *   pnpm --filter @hsj/server preflight
 *
 * 只读，不改任何数据；可以在上线前和每次发版后各跑一次。
 */
import { PrismaClient } from '@prisma/client';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

type Level = 'ok' | 'warn' | 'fail';
const results: { level: Level; item: string; detail: string }[] = [];
const add = (level: Level, item: string, detail = '') => results.push({ level, item, detail });
const env = (k: string) => (process.env[k] ?? '').trim();

/** 境内常用的已备案大模型接口域名；不在表里的不一定不行，但要人工确认 */
const DOMESTIC_LLM_HOSTS = ['api.deepseek.com', 'dashscope.aliyuncs.com', 'ark.cn-beijing.volces.com', 'open.bigmodel.cn', 'api.moonshot.cn', 'qianfan.baidubce.com', 'api.hunyuan.cloud.tencent.com', 'api.minimax.chat', 'api.baichuan-ai.com'];

function checkEnv() {
  if (env('NODE_ENV') !== 'production') add('warn', 'NODE_ENV', '建议设为 production');
  if (env('AUTH_DEV_LOGIN') === 'true') add('fail', '开发登录', 'AUTH_DEV_LOGIN 必须为 false，否则任何人都能免扫码登录');
  else add('ok', '开发登录已关闭');

  const jwt = env('JWT_SECRET');
  if (!jwt || jwt === 'change-me' || jwt.length < 32) add('fail', 'JWT_SECRET', '请换成 32 位以上的随机串');
  else add('ok', 'JWT_SECRET');

  const fk = env('FIELD_ENCRYPTION_KEY');
  if (!fk) add('fail', 'FIELD_ENCRYPTION_KEY', '未配置，手机号和地址无法加密存储');
  else if (Buffer.from(fk, 'base64').length !== 32) add('fail', 'FIELD_ENCRYPTION_KEY', '应为 32 字节的 base64（openssl rand -base64 32）');
  else add('ok', 'FIELD_ENCRYPTION_KEY', '上线后不要再改，改了旧数据就解不开');

  const wecom = ['WECOM_CORP_ID', 'WECOM_AGENT_ID', 'WECOM_SECRET'].filter((k) => !env(k));
  if (wecom.length) add('fail', '企业微信自建应用', `缺少 ${wecom.join('、')}，无法扫码登录和推送提醒`);
  else add('ok', '企业微信自建应用');
  if (!env('WECOM_CALLBACK_TOKEN') || !env('WECOM_CALLBACK_AES_KEY')) add('warn', '企业微信回调', '未配置，加微后不会自动发欢迎语、打来源标签、关联线索');
  else add('ok', '企业微信回调');

  for (const k of ['WEB_ORIGIN', 'API_ORIGIN']) {
    const v = env(k);
    if (!v) add('fail', k, '未配置，扫码登录无法回跳');
    else if (!v.startsWith('https://')) add('warn', k, `${v} 不是 https，企业微信可信域名和扫码登录需要已备案的 https 域名`);
    else add('ok', k, v);
  }

  const llm = ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL'].filter((k) => !env(k));
  if (llm.length) add('fail', '大模型', `缺少 ${llm.join('、')}，会退回演示模型，回复和稿件都是固定示例`);
  else {
    let host = '';
    try {
      host = new URL(env('LLM_BASE_URL')).host;
    } catch {
      add('fail', '大模型', 'LLM_BASE_URL 不是合法地址');
    }
    if (host && !DOMESTIC_LLM_HOSTS.includes(host)) add('warn', '大模型', `${host} 不在常用境内模型清单里，请确认是境内已备案模型`);
    else if (host) add('ok', '大模型', `${env('LLM_MODEL')} @ ${host}；接通情况用 llm:check 验证`);
  }
  if (env('LLM_MOCK_LATENCY_MS')) add('warn', 'LLM_MOCK_LATENCY_MS', '只用于压测，生产环境应删掉');
  if (env('CRON_ENABLED') === 'false') add('warn', '定时任务', 'CRON_ENABLED=false，周报、选题、发布提醒、超时升级都不会运行');
  else add('ok', '定时任务已开启');
  const conc = Number(env('INBOX_CONCURRENCY') || 8);
  add('ok', '私信处理并发', `${conc}（按压测记录：并发 ≥ 每秒消息数 × 模型单次耗时秒数 × 1.5）`);
  if (!env('INBOX_WEBHOOK_SECRET')) add('ok', '私信接入', '未配置 INBOX_WEBHOOK_SECRET，走半自动（客服贴入）');
}

async function checkData(prisma: PrismaClient) {
  try {
    await prisma.$queryRaw`SELECT 1`;
    add('ok', '数据库连接');
  } catch (e) {
    add('fail', '数据库连接', (e as Error).message.split('\n')[0]);
    return;
  }

  const dir = join(__dirname, '../prisma/migrations');
  const local = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  const applied = new Set(
    (await prisma.$queryRaw<{ migration_name: string }[]>`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`).map((r) => r.migration_name),
  );
  const pending = local.filter((m) => !applied.has(m));
  if (pending.length) add('fail', '数据库迁移', `还有 ${pending.length} 个没执行：${pending.join('、')}，先运行 prisma:deploy`);
  else add('ok', '数据库迁移', `${local.length} 个都已执行`);

  const users = await prisma.user.findMany({ where: { active: true }, select: { wecomId: true, roles: true } });
  const has = (r: string) => users.filter((u) => u.roles.includes(r as never)).length;
  if (!has('ADMIN')) add('fail', '管理员', '没有启用的管理员，运行 db:seed 创建');
  else add('ok', '管理员', `${has('ADMIN')} 位`);
  if (!has('CS')) add('fail', '客服', '没有客服角色的成员，转人工的会话没人接');
  else add('ok', '客服', `${has('CS')} 位`);
  if (!has('BIZ')) add('warn', '招商', '没有招商角色的成员，B 端线索只能管理员分配');
  if (!has('REVIEWER')) add('warn', '审核人', '没有审核人，稿件只能由管理员审核');
  const testIds = users.filter((u) => ['admin', 'kefu', 'kefu2', 'zhaoshang', 'test'].includes(u.wecomId)).map((u) => u.wecomId);
  if (testIds.length) add('warn', '测试账号', `还有疑似测试成员：${testIds.join('、')}，上线前停用`);

  const xhs = await prisma.platformAccount.count({ where: { platform: 'XHS' } });
  if (!xhs) add('fail', '小红书账号', '还没有添加小红书账号');
  else add('ok', '小红书账号', `${xhs} 个`);

  const [kb, faq, words] = await Promise.all([prisma.knowledgeItem.count(), prisma.faqItem.count(), prisma.riskWord.count()]);
  if (!kb) add('fail', '品牌知识库', '没有知识条目，AI 只能转人工');
  else add('ok', '品牌知识库', `${kb} 条`);
  if (faq < 10) add('warn', 'FAQ', `只有 ${faq} 条，建议上线前补到常见问题全覆盖（价格、配送、保存、售后）`);
  else add('ok', 'FAQ', `${faq} 条`);
  if (!words) add('fail', '风控词库', '词库为空，回复和稿件不会被拦截');
  else add('ok', '风控词库', `${words} 个词`);

  const baseline = await prisma.setting.findUnique({ where: { key: 'report.baseline' } });
  if (!baseline) add('warn', '上线前基线', '还没录入，上线后无法对比效果；在“数据周报 > 对比上线前基线”里录入');
  else add('ok', '上线前基线');

  const inbox = await prisma.setting.findUnique({ where: { key: 'inbox' } });
  if (!inbox) add('warn', '接待设置', '还在用默认的工作时间和转人工时限，确认和客服排班一致');
}

async function main() {
  checkEnv();
  const prisma = new PrismaClient();
  try {
    await checkData(prisma);
  } finally {
    await prisma.$disconnect();
  }
  const mark = { ok: '✓', warn: '!', fail: '✗' };
  for (const r of results) console.log(`${mark[r.level]} ${r.item}${r.detail ? `：${r.detail}` : ''}`);
  const fails = results.filter((r) => r.level === 'fail').length;
  const warns = results.filter((r) => r.level === 'warn').length;
  console.log(`\n${fails ? `有 ${fails} 项不通过` : '全部必需项通过'}${warns ? `，${warns} 项需要确认` : ''}。`);
  if (fails) process.exitCode = 1;
}

void main();
