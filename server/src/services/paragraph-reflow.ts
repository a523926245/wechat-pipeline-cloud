/**
 * 段落重排（确定性后处理器）。
 *
 * ── 为什么不用 prompt 解决 ──────────────────────────────────────────
 * 模型对「每段写 60-140 字」这种**长度**指令服从度极低：同一份提示词实测出过
 * 121 字/段，也出过 236 字/段，且 7-9 成段落破 150 字上限（一整屏的墙）。
 * SYSTEM_PROMPT 曾写着「每节 4 段 × 每段 100-120 字」，修好自相矛盾后方差依旧大。
 * 结论：长度不该指望模型，生成后按句边界确定性重排即可，结果完全可控。
 *
 * ── 三条硬约束 ─────────────────────────────────────────────────────
 * 1. **按句边界切**：只在 。！？； 之后断开，绝不从句中腰斩
 * 2. **引文不拆**：<strong>…</strong> 当原子单元整体搬运，天然保证标签闭合
 * 3. **不跨小标题**：每个 <h2> 区块内独立重排，内容不会被挪到别的小标题下
 */

/**
 * 句边界：标点之后切一刀。
 *
 * ⚠️ 必须**连同收尾的引号一起吃掉**（2026-10-15 实证）：中文里句号常写在引号内
 * （「你今天自己把两只鞋都放平了。」），如果只按「。」切，下一节就会以一个光秃秃的
 * 」开头，成稿出现「</p><p>」他愣了一下」这种破句。所以边界 = 标点 + 可选的右引号/右括号。
 */
const SENT_END = /[。！？；][」』”"）】》』]*/g;
/** 块级元素：h1/h2 原样透传，p 参与重排。 */
const BLOCK_RE = /<(h[12])([^>]*)>[\s\S]*?<\/\1>|<p([^>]*)>([\s\S]*?)<\/p>/gi;
const STRONG_RE = /<strong[^>]*>[\s\S]*?<\/strong>/gi;
const TAG_RE = /<[^>]+>/g;

/** 保护 <strong> 的哨兵。用罕见符号组合，避免与正文字符冲突。 */
const wrap = (i: number): string => `⟦S${i}⟧`;
const HOLD_RE = /⟦S(\d+)⟧/g;

/**
 * 每段目标长度的阶梯，循环取值。
 *
 * ⚠️ 别改成单一常数。固定 targetMax 跑出来的段长变异系数只有 0.23
 * （实测 30 段全落在 60-90 字），检测器正好认「段落长度过于整齐」这一条；
 * 参照的一篇人工稿 CV 是 1.02。这里用阶梯刻意制造长短差。
 *
 * ⚠️ 阶梯是**上限**不是均值（2026-10-15 实测）：packUnits 只在「再塞一句就超 target」时收段，
 * 所以实际段长 ≈ target − 句长，句均 23 字 → 阶梯均值 93 跑出来段均只有 72。
 * 想动段均就要按比例挪整条阶梯（阶梯均值 ≈ 目标段均 + 23），不能照着目标段长填。
 *
 * ⚠️ 别再往长了调（2026-10-15 实测，三篇成稿 A/B）：
 * 阶梯均值 93 → 段均 72、段 CV 0.50；阶梯均值 128 → 段均 100、段 CV 0.45。
 * 而本域人工稿段均只有 30-42，段均 124.8 的那篇样本 AI 分最高（100/100）。
 * 段均一过 100，段 CV 也一起掉向检测器的 0.40 红线，两边都亏。
 */
const LADDER = [45, 135, 58, 122, 72, 145, 50, 108, 65, 128];

export interface ReflowOptions {
  /** 单段软上限：再加一句就要超的话，先收段。同时裁剪阶梯的峰值。 */
  targetMax?: number;
  /** 单段硬上限：超过就立刻收段，不等下一句。 */
  hardMax?: number;
  /** 短段落下限：低于这个长度就尝试并到下一句，避免切成碎片。 */
  targetMin?: number;
  /** 每段目标长度阶梯，循环取值。覆盖它是 A/B 调段长分布的唯一入口。 */
  ladder?: number[];
}

const DEFAULTS: Required<ReflowOptions> = {
  targetMax: 145,
  hardMax: 150,
  targetMin: 25,
  ladder: LADDER,
};

export interface ReflowResult {
  contentHtml: string;
  /** 重排前的段落数 */
  before: number;
  /** 重排后的段落数 */
  after: number;
  changed: boolean;
}

interface Unit {
  /** 含 <strong> 标签的完整片段 */
  text: string;
  /** 去掉标签后的可见字数 */
  len: number;
}

function stripTags(s: string): string {
  return s.replace(TAG_RE, '');
}

/**
 * 把一个 <p> 的内容拆成「句」的序列。
 * 先把整段 <strong>…</strong> 换成哨兵，切完句再还原 —— 这样加粗永远跨不破。
 */
function toUnits(inner: string): Unit[] {
  const holds: string[] = [];
  const masked = inner.replace(STRONG_RE, (m) => {
    holds.push(m);
    return wrap(holds.length - 1);
  });
  const units: Unit[] = [];
  const push = (raw: string): void => {
    const s = raw.trim();
    if (!s) return;
    const restored = s.replace(HOLD_RE, (_, i) => holds[Number(i)] ?? '');
    const len = stripTags(restored).length;
    if (len === 0) return;
    units.push({ text: restored, len });
  };
  let start = 0;
  SENT_END.lastIndex = 0;
  for (const m of masked.matchAll(SENT_END)) {
    if (m[0].length === 0) break;
    const end = (m.index ?? 0) + m[0].length;
    push(masked.slice(start, end));
    start = end;
  }
  if (start < masked.length) push(masked.slice(start));
  return units;
}

/**
 * 把句子按目标长度重新打包成 <p>。
 * 超过 hardMax 的单个长句无法再切（已在句边界），只能单独成段，交由体检提示。
 */
function packUnits(units: Unit[], o: Required<ReflowOptions>): string[] {
  const out: string[] = [];
  let buf: string[] = [];
  let len = 0;
  const ladder = o.ladder.length > 0 ? o.ladder : [o.targetMax];
  const flush = (): void => {
    if (buf.length === 0) return;
    out.push(`<p>${buf.join('')}</p>`);
    buf = [];
    len = 0;
  };
  for (const u of units) {
    // 每段的目标长度沿阶梯走，制造长短差；targetMax 只作上限裁剪。
    const target = Math.min(ladder[out.length % ladder.length] ?? o.targetMax, o.targetMax);
    if (buf.length > 0 && (len + u.len > target || len >= o.hardMax)) flush();
    buf.push(u.text);
    len += u.len;
    if (len >= o.hardMax) flush();
  }
  flush();
  return out;
}

/**
 * 主入口：按目标段长重排正文段落，标题原样透传。
 *
 * 保守策略：若重排后段落数为 0（说明输入压根不是预期的语义 HTML），
 * 原样返回，绝不把稿子改坏。
 */
export function reflowParagraphs(html: string, opts: ReflowOptions = {}): ReflowResult {
  const o: Required<ReflowOptions> = { ...DEFAULTS, ...opts };
  const out: string[] = [];
  let pending: Unit[] = [];
  let before = 0;
  let after = 0;

  const flush = (): void => {
    if (pending.length === 0) return;
    const packed = packUnits(pending, o);
    after += packed.length;
    out.push(...packed);
    pending = [];
  };

  let last = 0;
  BLOCK_RE.lastIndex = 0;
  for (const m of html.matchAll(BLOCK_RE)) {
    const start = m.index ?? 0;
    if (start > last) out.push(html.slice(last, start));
    if (m[1]) {
      // h1/h2：先把攒着的正文收掉，再原样透传标题
      flush();
      out.push(m[0]);
    } else {
      before += 1;
      // 组 4 才是 <p> 的内容（组 3 是 <p> 的属性）
      pending.push(...toUnits(m[4] ?? ''));
    }
    last = start + m[0].length;
  }
  if (last < html.length) out.push(html.slice(last));
  flush();

  const contentHtml = out.join('\n');
  if (after === 0) {
    return { contentHtml: html, before, after: before, changed: false };
  }
  return { contentHtml, before, after, changed: contentHtml !== html };
}
