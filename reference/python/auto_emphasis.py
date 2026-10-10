# -*- coding: utf-8 -*-
"""
自动强调补全（后处理器）

背景：实测发现 LLM 对「加粗 N 处」这类格式指令执行不到位
（要求补到 9-11 处，实到 7 处），但对内容类要求（改写否定框架）
能有效落实。所以格式层不指望模型，改由脚本确定性补齐。

策略：只在现有加粗不足下限时才补，绝不重复加粗已强调的句子。
      按句式特征打分挑候选，优先口诀、祈使句、判断标准句。

用法：
  python scripts/auto_emphasis.py <文章.html>            # 预览将要补哪些
  python scripts/auto_emphasis.py <文章.html> --write    # 就地写回
  python scripts/auto_emphasis.py <文章.html> --min 9 --max 11 --write
"""
import os, re, sys

# 口径与 style_dna.json「强调标注规范 · 密度红线」一致：全篇 8-12 处，
# 红色强调（<strong class="key">）属二级加粗，计入总数。
DEFAULT_MIN, DEFAULT_MAX = 8, 12

# 祈使/方法句开头
IMPERATIVE = r"^(先|再|别|要|记住|试着|可以|不妨|不如|与其|下次|这时候|第一步|然后)"
# 判断标准句特征
JUDGE = r"(关键是|重点在|判断标准|分界线|真正的|核心是|标准只有一个|要看的是)"
# 对照话术
CONTRAST = r"(别说|改成|换成|说这句|那句)"

SENT_SPLIT = re.compile(r"(?<=[。！？；])")
P_RE = re.compile(r"<p[^>]*>(.*?)</p>", re.S)
TAG_RE = re.compile(r"<[^>]+>")


def strip_tags(s):
    return TAG_RE.sub("", s)


def score(sent):
    """给候选句打分，越高越值得强调"""
    s = 0
    if re.search(r"[「『“\"].{4,24}[」』”\"]", sent):
        s += 3                                   # 引号内多为可带走的口诀
    if re.search(IMPERATIVE, sent):
        s += 2
    if re.search(JUDGE, sent):
        s += 3
    if re.search(CONTRAST, sent):
        s += 2
    n = len(sent)
    if 10 <= n <= 40:
        s += 2
    elif n <= 60:
        s += 1
    else:
        s -= 2                                   # 太长的句子加粗反而糊
    if re.search(r"[，、].{0,6}[，、]", sent):
        s -= 1                                   # 逗号堆叠的并列句不宜整句加粗
    return s


def collect_candidates(html):
    """从所有 <p> 中收集未加粗的候选句"""
    cands = []
    seen = set()
    for m in P_RE.finditer(html):
        para = m.group(1)
        if "<strong" in para:
            # 该段已有强调，仍可从其余句子里挑，但降权
            penalty = 1
        else:
            penalty = 0
        for sent in SENT_SPLIT.split(strip_tags(para)):
            sent = sent.strip()
            if len(sent) < 8:
                continue
            if sent in seen:
                continue
            seen.add(sent)
            sc = score(sent) - penalty
            if sc > 0:
                cands.append((sc, len(sent), sent))
    cands.sort(key=lambda x: (-x[0], x[1]))
    return cands


def emphasis_count(html):
    return len(re.findall(r"<strong(?:\s[^>]*)?>", html))


def key_count(html):
    return len(re.findall(r'class="key"', html))


def add_bold(html, need):
    """按候选顺序补加粗，返回 (新html, 实际补了几处)"""
    cands = collect_candidates(html)
    added = 0
    for sc, ln, sent in cands:
        if added >= need:
            break
        idx = 0
        done = False
        while not done:
            pos = html.find(sent, idx)
            if pos < 0:
                break
            before = html[max(0, pos - 60):pos]
            # 该处若已被 strong 包裹则跳过
            if "<strong" in before and "</strong>" not in before:
                idx = pos + len(sent)
                continue
            html = html[:pos] + "<strong>" + sent + "</strong>" + html[pos + len(sent):]
            added += 1
            done = True
    return html, added


def promote_key(html, need):
    """把最强的普通加粗升级为红色 key"""
    if need <= 0:
        return html, 0
    # 优先选含判断特征的加粗
    pat = re.compile(r"<strong>(.*?)</strong>", re.S)
    best = []
    for m in pat.finditer(html):
        inner = strip_tags(m.group(1))
        sc = score(inner)
        if re.search(JUDGE, inner):
            sc += 4
        best.append((sc, m.start(), m.end(), inner))
    best.sort(key=lambda x: (-x[0], x[1]))
    picked = 0
    offset = 0
    for sc, st, en, inner in best:
        if picked >= need:
            break
        st += offset
        en += offset
        repl = '<strong class="key">%s</strong>' % inner
        html = html[:st] + repl + html[en:]
        offset += len(repl) - (en - st)
        picked += 1
    return html, picked


def process(html, min_n=DEFAULT_MIN, max_n=DEFAULT_MAX, key_min=2, key_max=3):
    cur = emphasis_count(html)
    need = 0
    if cur < min_n:
        need = min(min_n + (max_n - min_n) // 2, max_n) - cur
    html, added = add_bold(html, need) if need > 0 else (html, 0)

    kc = key_count(html)
    kneed = 0
    if kc < key_min:
        kneed = key_min - kc
    html, kadded = promote_key(html, kneed) if kneed > 0 else (html, 0)

    return html, {"原加粗": cur, "补加粗": added, "最终加粗": emphasis_count(html),
                  "原红字": kc, "补红字": kadded, "最终红字": key_count(html)}


def main():
    args = [a for a in sys.argv[1:]]
    if not args or args[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    path = args[0]
    write = "--write" in args
    min_n = int(argval(args, "--min", DEFAULT_MIN))
    max_n = int(argval(args, "--max", DEFAULT_MAX))
    html = open(path, encoding="utf-8").read()
    new, stat = process(html, min_n, max_n)
    print("文件: %s" % os.path.basename(path))
    print("  " + " | ".join("%s=%s" % (k, v) for k, v in stat.items()))
    if write:
        open(path, "w", encoding="utf-8").write(new)
        print("  已写回")
    else:
        print("  （预览模式，未写入。加 --write 生效）")
    return 0


def argval(args, key, default):
    for i, a in enumerate(args):
        if a == key and i + 1 < len(args):
            return args[i + 1]
    return default


if __name__ == "__main__":
    sys.exit(main())
