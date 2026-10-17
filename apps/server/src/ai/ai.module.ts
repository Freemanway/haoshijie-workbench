import { Controller, Get, Global, Injectable, Logger, Module, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, Role } from '@prisma/client';
import { Roles } from '../common/auth.decorators';
import { PrismaService } from '../prisma/prisma.service';
import { PromptTemplate } from './prompts';
import { ChatMessage, LlmProvider, MockProvider, OpenAiCompatibleProvider } from './providers';

export interface RunContext {
  userId?: string;
  refType?: string;
  refId?: string;
  /** 输出通过结构校验后的业务校验，返回问题列表；有问题时带上问题重试一次 */
  check?: (out: unknown) => string[];
}

export interface RunResult<O> {
  output: O;
  callId: string;
  model: string;
  /** 重试后仍未解决的问题（例如字数超限），交给运营修改 */
  problems: string[];
}

/** 从模型输出中取出 JSON（兼容包在 ```json 代码块里的情况）。 */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.search(/[[{]/);
  const end = Math.max(raw.lastIndexOf('}'), raw.lastIndexOf(']'));
  if (start < 0 || end < start) throw new Error('模型输出里没有 JSON');
  return JSON.parse(raw.slice(start, end + 1));
}

/**
 * 模型网关（M4-1）：统一调用入口，负责选模型、套提示词模板、校验输出、失败重试，并把每次调用写入 LlmCall。
 * 业务代码只依赖这里，换模型只改环境变量。
 */
@Injectable()
export class AiService {
  private readonly log = new Logger('AiService');
  private readonly provider: LlmProvider | null;
  private readonly priceIn: number;
  private readonly priceOut: number;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const baseUrl = config.get<string>('LLM_BASE_URL');
    const apiKey = config.get<string>('LLM_API_KEY');
    const model = config.get<string>('LLM_MODEL');
    this.provider =
      baseUrl && apiKey && model
        ? new OpenAiCompatibleProvider(
            config.get('LLM_PROVIDER', 'openai-compatible'),
            model,
            baseUrl,
            apiKey,
            config.get('LLM_JSON_MODE', 'true') !== 'false',
          )
        : null;
    // 单价：元 / 百万 tokens
    this.priceIn = Number(config.get('LLM_PRICE_INPUT', '0')) || 0;
    this.priceOut = Number(config.get('LLM_PRICE_OUTPUT', '0')) || 0;
  }

  get status() {
    return this.provider
      ? { mock: false, provider: this.provider.name, model: this.provider.model }
      : { mock: true, provider: 'mock', model: 'mock' };
  }

  async run<I, O>(tpl: PromptTemplate<I, O>, input: I, ctx: RunContext = {}): Promise<RunResult<O>> {
    const provider = this.provider ?? new MockProvider(() => JSON.stringify(tpl.mock(input)));
    const messages: ChatMessage[] = [
      { role: 'system', content: tpl.system },
      { role: 'user', content: tpl.user(input) },
    ];
    let lastError = '';
    let best: { output: O; problems: string[]; callId: string } | null = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      const started = Date.now();
      let text: string | undefined;
      let usage = { inputTokens: 0, outputTokens: 0 };
      let output: O | undefined;
      let problems: string[] = [];
      try {
        const r = await provider.chat(messages, { json: true, temperature: tpl.temperature });
        text = r.text;
        usage = r;
        const parsed = tpl.output.safeParse(extractJson(r.text));
        if (!parsed.success) {
          throw new Error(`输出格式不对：${parsed.error.issues.map((x) => `${x.path.join('.')} ${x.message}`).join('；')}`);
        }
        output = parsed.data;
        problems = ctx.check?.(output) ?? [];
      } catch (e) {
        lastError = (e as Error).message;
      }
      const call = await this.prisma.llmCall.create({
        data: {
          purpose: tpl.name,
          template: `${tpl.name}@${tpl.version}`,
          provider: provider.name,
          model: provider.model,
          userId: ctx.userId,
          refType: ctx.refType,
          refId: ctx.refId,
          messages: messages as unknown as Prisma.InputJsonValue,
          output: text,
          ok: output !== undefined,
          error: output === undefined ? lastError : problems.length ? `规格问题：${problems.join('；')}` : null,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          costMilli: Math.round(((usage.inputTokens * this.priceIn + usage.outputTokens * this.priceOut) / 1e6) * 1000),
          latencyMs: Date.now() - started,
        },
      });

      if (output !== undefined) {
        if (!problems.length) return { output, callId: call.id, model: provider.model, problems };
        best = { output, problems, callId: call.id };
        lastError = `上次输出有这些问题，请修正后重新输出完整 JSON：${problems.join('；')}`;
      }
      if (text) messages.push({ role: 'assistant', content: text });
      messages.push({ role: 'user', content: output !== undefined ? lastError : `${lastError}。请严格按要求只输出 JSON。` });
      this.log.warn(`${tpl.name} 第 ${attempt + 1} 次输出不合格：${lastError}`);
    }
    if (best) return { ...best, model: provider.model };
    throw new Error(`AI 生成失败：${lastError}`);
  }
}

@Controller('ai')
class AiController {
  constructor(
    private readonly ai: AiService,
    private readonly prisma: PrismaService,
  ) {}

  /** 当前使用的模型；mock=true 表示未配置真实模型，界面提示“演示模型”。 */
  @Get('status')
  status() {
    return this.ai.status;
  }

  /** 近 N 天调用量与费用，按用途汇总。 */
  @Roles(Role.ADMIN)
  @Get('usage')
  async usage(@Query('days') days = '30') {
    const since = new Date(Date.now() - Math.min(Number(days) || 30, 365) * 86_400_000);
    const rows = await this.prisma.llmCall.groupBy({
      by: ['purpose', 'model'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
      _sum: { inputTokens: true, outputTokens: true, costMilli: true },
    });
    return rows.map((r) => ({
      purpose: r.purpose,
      model: r.model,
      calls: r._count._all,
      inputTokens: r._sum.inputTokens ?? 0,
      outputTokens: r._sum.outputTokens ?? 0,
      costYuan: (r._sum.costMilli ?? 0) / 1000,
    }));
  }

  /** 某个选题或稿件的全部 AI 调用记录，用于追溯。 */
  @Roles(Role.CONTENT, Role.REVIEWER)
  @Get('calls')
  calls(@Query('refType') refType: string, @Query('refId') refId: string) {
    return this.prisma.llmCall.findMany({ where: { refType, refId }, orderBy: { createdAt: 'asc' } });
  }
}

@Global()
@Module({ controllers: [AiController], providers: [AiService], exports: [AiService] })
export class AiModule {}
