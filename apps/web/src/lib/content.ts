export interface Topic {
  id: string;
  title: string;
  audience: 'C' | 'B';
  category: string;
  platforms: string[];
  seasonTag: string | null;
  status: string;
  source: string;
  reason: string | null;
  suggestedDate: string | null;
  weekOf: string | null;
  drafts?: { id: string; status: string }[];
  _count?: { drafts: number };
}

export const TOPIC_STATUS: Record<string, { text: string; color?: string }> = {
  PROPOSED: { text: '待确认', color: 'gold' },
  IDLE: { text: '待用', color: 'blue' },
  SCHEDULED: { text: '已排期', color: 'purple' },
  PUBLISHED: { text: '已发布', color: 'green' },
  ARCHIVED: { text: '归档' },
};
export const TOPIC_SOURCE: Record<string, string> = { AI: 'AI 生成', MANUAL: '人工录入', INBOX_FAQ: '私信反哺' };

export const DRAFT_STATUS: Record<string, { text: string; color?: string }> = {
  GENERATING: { text: '生成中', color: 'processing' },
  GENERATE_FAILED: { text: '生成失败', color: 'error' },
  DRAFT: { text: '草稿', color: 'default' },
  PENDING_REVIEW: { text: '待审核', color: 'gold' },
  APPROVED: { text: '已通过', color: 'green' },
  REJECTED: { text: '已驳回', color: 'red' },
  SCHEDULED: { text: '已排期', color: 'purple' },
  PUBLISHED: { text: '已发布', color: 'green' },
  PUBLISH_FAILED: { text: '发布失败', color: 'error' },
};

export const ymd = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '');
const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];
export const withWeekday = (iso: string | null | undefined) =>
  iso ? `${iso.slice(5, 10)} 周${WEEKDAY[new Date(`${iso.slice(0, 10)}T00:00:00Z`).getUTCDay()]}` : '—';
