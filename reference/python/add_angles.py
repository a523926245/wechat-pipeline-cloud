#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""往赛道角度库追加新选题，带观点层去重。

静态角度库必然枯竭（40 个育儿角度按 2 篇/天只够约 20 天）。
本脚本负责「机械部分」：编号、去重、写库；候选本身由 agent（LLM）生成，
保证组合出来的选题是有意义的句子，而不是维度表硬拼。

去重在三层上做：
  1. 字面重复：与现有 angle 文本的 bigram Jaccard 相似度超阈值 → 拒
  2. 观点近似：与历史库文章标题比相似度（阈值略松）→ 拒
  3. 主题过密：同一 theme 下堆积过多未用选题 → 拒（防止全挤在一个话题上）

用法:
  python add_angles.py --track 育儿 --file candidates.json         # 从文件读候选
  python add_angles.py --track 育儿 --json '[{"theme":"专注","angle":"..."}]'
  python add_angles.py --track 育儿 --file c.json --dry-run        # 只体检不写库
  python add_angles.py --track 育儿 --show-themes                  # 查看主题分布
"""
import os, sys, json, re, datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pathutil

# 默认同一主题下允许堆积的未用选题上限，超了说明该换个方向写
THEME_CAP = 8
# 相似度阈值（经实测校准，见下方说明）：
#   用 bigram Jaccard 比对时用 0.50，实测「明显同义改写」的相似度只有 0.36~0.46，
#   会被整条漏掉 —— 阈值必须压到同义改写能落进来的位置。
SIM_ANGLE = 0.45      # 与现有选题比
SIM_HISTORY = 0.35    # 与历史文章标题比（标题短、用词差异大，阈值更严）


def argval(name, default=None):
    a = sys.argv[1:]
    for i, x in enumerate(a):
        if x == name and i + 1 < len(a):
            return a[i + 1]
    return default


def flag(name):
    return name in sys.argv[1:]


PUNCT = re.compile(r"[\s，。、？！；：\"'“”‘’（）()《》,.!?;:\[\]\-—…]+")


def norm(s):
    return PUNCT.sub("", str(s or "")).lower()


def grams(s, n=2):
    """中文 bigram 集合：比单字更能反映短语层面的重合。"""
    s = norm(s)
    if len(s) < 2:
        return {s} if s else set()
    return {s[i:i + n] for i in range(len(s) - n + 1)}


def _jaccard(ga, gb):
    return len(ga & gb) / len(ga | gb)


def _containment(ga, gb):
    return len(ga & gb) / min(len(ga), len(gb))


MIN_GRAMS_FOR_CT = 8   # 太短的句子不算包含率，避免短句偶然命中


def dup_score(a, b):
    """判重综合分：0~1，越大越像。

    单看 Jaccard 会被漏两组典型改写：
      - 「A替换了个别词」：整体重合比例不够高，但核心几乎全覆盖
      - 「B 是 A 的扩写」：多出来的内容稀释了比例
    所以再补一个包含率（交集 / 较短一方），并对短句停用，避免误伤。
    """
    ga, gb = grams(a), grams(b)
    if not ga or not gb:
        return 0.0
    j = _jaccard(ga, gb)
    if min(len(ga), len(gb)) < MIN_GRAMS_FOR_CT:
        return j
    c = _containment(ga, gb)
    return max(j, c - 0.15)


def sim(a, b):
    """保留给外部调用：纯 Jaccard 相似度。"""
    ga, gb = grams(a), grams(b)
    if not ga or not gb:
        return 0.0
    return _jaccard(ga, gb)


def next_id(existing, track):
    """生成下一个角度 ID：取现有最大编号 +1，避免覆盖。"""
    mx = 0
    for a in existing:
        m = re.search(r"(\d+)\s*$", str(a.get("id", "")))
        if m:
            mx = max(mx, int(m.group(1)))
    return "%s-%03d" % (track, mx + 1)


def load_history_titles():
    titles = []
    if os.path.exists(pathutil.HISTORY_PATH):
        try:
            h = json.load(open(pathutil.HISTORY_PATH, encoding="utf-8"))
            titles = [a.get("title", "") for a in h.get("articles", [])]
        except Exception:
            pass
    return titles


def main():
    global SIM_ANGLE, SIM_HISTORY, THEME_CAP
    track = argval("--track")
    if not track:
        print("❌ 需要 --track <赛道>")
        sys.exit(1)

    ap = pathutil.angles_path(track)
    if not os.path.exists(ap):
        print("❌ 找不到角度库: %s" % ap)
        sys.exit(1)
    data = json.load(open(ap, encoding="utf-8"))
    angles = data.setdefault("angles", [])

    if flag("--show-themes"):
        cnt = {}
        for a in angles:
            if not a.get("used"):
                cnt[a.get("theme", "未分类")] = cnt.get(a.get("theme", "未分类"), 0) + 1
        print("「%s」未用选题的主题分布（共 %d 个）：" % (track, sum(cnt.values())))
        for k, v in sorted(cnt.items(), key=lambda x: -x[1]):
            flag_over = "  ← 已超上限 %d，建议换方向" % THEME_CAP if v >= THEME_CAP else ""
            print("   %-10s %2d%s" % (k, v, flag_over))
        return

    src_file, src_json = argval("--file"), argval("--json")
    if src_json:
        cands = json.loads(src_json)
    elif src_file:
        cands = json.load(open(src_file, encoding="utf-8"))
    else:
        print("❌ 需要 --file xxx.json 或 --json '[...]'")
        sys.exit(1)
    if isinstance(cands, dict):
        cands = cands.get("candidates", cands.get("angles", []))

    source = argval("--source", argval("--tag", "llm"))
    dry = flag("--dry-run")
    SIM_ANGLE = float(argval("--sim-angle", SIM_ANGLE))
    SIM_HISTORY = float(argval("--sim-history", SIM_HISTORY))
    THEME_CAP = int(argval("--theme-cap", THEME_CAP))

    # 比对基线：现有未用+已用的选题文本，以及历史文章标题
    existing_texts = [(a.get("id", ""), a.get("angle", "")) for a in angles]
    hist_titles = load_history_titles()
    theme_cnt = {}
    for a in angles:
        if not a.get("used"):
            theme_cnt[a.get("theme", "")] = theme_cnt.get(a.get("theme", ""), 0) + 1

    accepted, rejected = [], []
    tmp_theme = dict(theme_cnt)
    today = datetime.date.today().isoformat()

    for c in cands:
        theme = str(c.get("theme", "") or "").strip()
        angle = str(c.get("angle", "") or "").strip()
        if not angle or len(angle) < 6:
            rejected.append((c, "描述过短/为空"))
            continue
        if len(angle) > 120:
            rejected.append((c, "超过120字，选题描述应是一句话"))
            continue

        # 1) 与现有选题观点重复
        dup = [(i, dup_score(angle, t)) for i, t in existing_texts]
        dup.sort(key=lambda x: -x[1])
        if dup and dup[0][1] >= SIM_ANGLE:
            rejected.append((c, "与已有选题 %s 重复（相似度 %.2f）" % (dup[0][0], dup[0][1])))
            continue

        # 2) 与已发文章内容近似
        hd = [(t, dup_score(angle, t)) for t in hist_titles]
        hd.sort(key=lambda x: -x[1])
        if hd and hd[0][1] >= SIM_HISTORY:
            rejected.append((c, "与已发《%s》观点近似（%.2f）" % (hd[0][0][:24], hd[0][1])))
            continue

        # 3) 主题过密
        if tmp_theme.get(theme, 0) >= THEME_CAP:
            rejected.append((c, "主题「%s」未用选题已达 %d 个上限" % (theme, THEME_CAP)))
            continue

        tmp_theme[theme] = tmp_theme.get(theme, 0) + 1
        item = {
            "id": c.get("id") or next_id(angles + accepted, track),
            "theme": theme,
            "angle": angle,
            "used": False, "used_by": None, "used_date": None,
            "source": source,
            "created_at": today,
        }
        if c.get("note"):
            item["note"] = c["note"]
        accepted.append(item)
        existing_texts.append((item["id"], angle))

    print("候选 %d 个 → 采纳 %d，拒绝 %d" % (len(cands), len(accepted), len(rejected)))
    if rejected:
        print("\n被拒明细（不是错误，是去重在起作用）：")
        for c, why in rejected:
            print("   ✗ %s\n     → %s" % (str(c.get("angle", c))[:46], why))
    if not accepted:
        print("\n无新增。")
        return

    if dry:
        print("\n[DRY-RUN] 预览，未写入。将新增：")
        for a in accepted:
            print("   %s [%s] %s" % (a["id"], a["theme"], a["angle"]))
        return

    angles.extend(accepted)
    json.dump(data, open(ap, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    free = sum(1 for a in angles if not a.get("used"))
    print("\n✅ 已写入 %s：新增 %d 个，未用总数 %d/%d"
          % (os.path.basename(ap), len(accepted), free, len(angles)))


if __name__ == "__main__":
    main()
