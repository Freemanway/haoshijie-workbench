/**
 * 检查大模型是否接通：读取 apps/server/.env 里的 LLM_* 配置，发一次简单请求，再用小红书稿件模板实际生成一篇，
 * 检查输出格式和规格。用法：pnpm --filter @hsj/server llm:check
 */
import { checkXhsDraft } from '@hsj/shared';
import { extractJson } from '../src/ai/json';
import { xhsDraft } from '../src/ai/prompts';
import { OpenAiCompatibleProvider } from '../src/ai/providers';

async function main() {
  const { LLM_PROVIDER, LLM_BASE_URL, LLM_API_KEY, LLM_MODEL, LLM_JSON_MODE } = process.env;
  if (!LLM_BASE_URL || !LLM_API_KEY || !LLM_MODEL) {
    console.error('没有配置大模型：请在 apps/server/.env 里填写 LLM_BASE_URL、LLM_API_KEY、LLM_MODEL');
    process.exit(1);
  }
  const provider = new OpenAiCompatibleProvider(LLM_PROVIDER || 'openai-compatible', LLM_MODEL, LLM_BASE_URL, LLM_API_KEY, LLM_JSON_MODE !== 'false');
  console.log(`模型：${provider.name} / ${provider.model}（${LLM_BASE_URL}）`);

  let t = Date.now();
  const ping = await provider.chat([{ role: 'user', content: '只输出 JSON：{"ok":true}' }], { json: true, temperature: 0 });
  console.log(`1. 连通：${Date.now() - t} ms，返回 ${ping.text.trim()}`);

  const input = {
    topic: { title: '无花果买回家怎么放不坏', audience: 'C' as const, category: '储存食用', seasonTag: null, reason: null },
    facts: [{ title: '保存方法', content: '常温 1 天内吃完；冷藏单层平铺，3 天内口感最好。' }],
    rules: [{ avoid: '润肠通便', instead: '富含膳食纤维（以检测报告为准）' }],
    versions: 2,
  };
  t = Date.now();
  const res = await provider.chat(
    [
      { role: 'system', content: xhsDraft.system },
      { role: 'user', content: xhsDraft.user(input) },
    ],
    { json: true, temperature: xhsDraft.temperature },
  );
  const parsed = xhsDraft.output.safeParse(extractJson(res.text));
  if (!parsed.success) {
    console.error(`2. 稿件生成：输出格式不对\n${res.text}`);
    process.exit(1);
  }
  console.log(`2. 稿件生成：${Date.now() - t} ms，输入 ${res.inputTokens} tokens，输出 ${res.outputTokens} tokens`);
  parsed.data.versions.forEach((v, i) => {
    const p = checkXhsDraft(v);
    console.log(`   版本 ${i + 1}《${v.title}》${p.length ? `规格问题：${p.join('；')}` : '规格符合'}`);
  });
}

main().catch((e) => {
  console.error(`调用失败：${(e as Error).message}`);
  process.exit(1);
});
