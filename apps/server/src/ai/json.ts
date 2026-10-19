/** 从模型输出中取出 JSON（兼容包在 ```json 代码块里的情况）。 */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.search(/[[{]/);
  const end = Math.max(raw.lastIndexOf('}'), raw.lastIndexOf(']'));
  if (start < 0 || end < start) throw new Error('模型输出里没有 JSON');
  return JSON.parse(raw.slice(start, end + 1));
}
