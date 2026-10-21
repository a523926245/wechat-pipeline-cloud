/**
 * 冒烟用的文章样本。
 *
 * 抽出来是因为**成稿体检是真门禁**：任何要推送的冒烟样本都必须符合当前文风
 * （3-4 个小标题、复合长段落为主），否则会被 `lintArticle` 拦下，
 * 让本来在测封面/推送的用例因为内容不合规而假失败。
 *
 * 这里同时提供「新文风（合规）」与「旧文风（不合规）」两份，后者供体检冒烟做反向断言。
 */

/** 复合长段落：3 句、约 100 字，动作 + 心理 + 对话揉在一段。 */
function para(i: number, strong?: string): string {
  const s = `第${i}次我在客厅门口站住了，手上还攥着没拧干的抹布，窗外有人在收被子，晾衣杆敲在铁栏上当当响`;
  const t = '我想起我妈当年也是这么站着的，那时候我觉得她烦，现在轮到我，才知道站着比说话累';
  const u = strong
    ? `我蹲下去把抹布搭在椅背上，说了那句<strong>${strong}</strong>`
    : '我蹲下去把抹布搭在椅背上，什么也没说';
  return `<p>${s}。${t}。${u}。</p>`;
}

const SHORT = '<p>「我不想吃。」</p>';

/** 新文风（合规）：3 个小标题、16 个复合长段落 + 3 个短段落、约 1600 字。 */
export function newStyleHtml(): string {
  const parts = ['<h1>饭桌上的第三十七次</h1>'];
  parts.push(para(1, '先接住这句话'));
  parts.push('<h2>下午五点，厨房门口那句我不想吃</h2>');
  for (let i = 2; i <= 6; i += 1) parts.push(para(i));
  parts.push(SHORT);
  parts.push('<h2>我妈当年也是这么站着的</h2>');
  for (let i = 7; i <= 11; i += 1) parts.push(para(i, '别跟但是'));
  parts.push('<h2>先喘匀，再蹲下</h2>');
  for (let i = 12; i <= 16; i += 1) parts.push(para(i));
  parts.push(SHORT);
  parts.push(SHORT);
  return parts.join('\n');
}

/** 旧文风（不合规）：9 个小标题、通篇一句一段。 */
export function oldStyleHtml(): string {
  const parts = ['<h1>饭桌上的第三十七次</h1>'];
  for (let i = 1; i <= 9; i += 1) {
    parts.push(`<h2>第 ${i} 个小标题</h2>`);
    parts.push(`<p>这是第 ${i} 节的一句话。</p>`);
  }
  return parts.join('\n');
}
