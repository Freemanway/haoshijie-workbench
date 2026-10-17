/** 大模型适配层。国内主流模型（DeepSeek、通义千问、豆包、Kimi、智谱等）都提供 OpenAI 兼容接口，配置地址和密钥即可切换。 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  chat(messages: ChatMessage[], opts: { json: boolean; temperature: number }): Promise<ChatResult>;
}

export class OpenAiCompatibleProvider implements LlmProvider {
  constructor(
    readonly name: string,
    readonly model: string,
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly jsonMode: boolean,
    private readonly timeoutMs = 90_000,
  ) {}

  async chat(messages: ChatMessage[], opts: { json: boolean; temperature: number }): Promise<ChatResult> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: opts.temperature,
        ...(opts.json && this.jsonMode ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`模型接口返回 ${res.status}：${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error('模型没有返回内容');
    return { text, inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0 };
  }
}

/**
 * 演示模型：没配置真实模型时使用，按提示词模板自带的 mock 规则生成固定结构的结果。
 * 只用于本地开发和测试，界面上会提示“当前为演示模型”。
 */
export class MockProvider implements LlmProvider {
  readonly name = 'mock';
  readonly model = 'mock';
  constructor(private readonly respond: (messages: ChatMessage[]) => string) {}

  async chat(messages: ChatMessage[]): Promise<ChatResult> {
    const text = this.respond(messages);
    const chars = messages.reduce((n, m) => n + m.content.length, 0);
    return { text, inputTokens: Math.ceil(chars / 1.5), outputTokens: Math.ceil(text.length / 1.5) };
  }
}
