import type { RiskHit } from '@hsj/shared';

/** 把风控命中的词标出来：拦截红色、警告橙色。 */
export function RiskHighlight({ text, hits }: { text: string; hits: RiskHit[] }) {
  const parts: React.ReactNode[] = [];
  let i = 0;
  [...hits].sort((a, b) => a.start - b.start).forEach((h, k) => {
    if (h.start < i) return;
    parts.push(text.slice(i, h.start));
    parts.push(
      <mark
        key={k}
        title={h.suggestion ? `建议改为：${h.suggestion}` : h.category}
        style={{ background: h.level === 'block' ? '#FBE4E2' : '#FBF0DC', padding: '0 2px' }}
      >
        {text.slice(h.start, h.end)}
      </mark>,
    );
    i = h.end;
  });
  parts.push(text.slice(i));
  return <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.9 }}>{parts}</div>;
}
