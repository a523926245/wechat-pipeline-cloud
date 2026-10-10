#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
每日选题计划器（调度层）

职责：回答「今天该给哪个号写哪几篇、要避开什么」，本身不写稿。
创作由 agent 依选出的角度完成，推送交 push_draft.py。

用法:
  python daily_plan.py                     # 输出今日创作任务清单
  python daily_plan.py --json              # JSON 输出，供自动化流程消费
  python daily_plan.py --account 戏精漫话   # 只看指定账号
  python daily_plan.py --all               # 连未填凭据的账号也列出（默认只列可发布的）
  python daily_plan.py --backlog-days 7    # 回扫最近 7 天，哪些账号当天没写满（漏跑/失败兜底）

规则:
  - 只有填了真实凭据的账号才排产（与 push_draft.py 同一判定）
  - 同一赛道多账号时，角度从赛道公共池取，天然跨号不重复
  - 每个账号每天 posts_per_account_per_day 篇，当天已写的不重复排
"""
import os, sys, json, re, datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pathutil

CONFIG_PATH = pathutil.CONFIG_PATH
HISTORY_PATH = pathutil.HISTORY_PATH
ACC_DIR = os.path.expanduser("~/.wechat_accounts")

PLACEHOLDER_RE = re.compile(r"填入|placeholder|todo|xxx|your_", re.I)


def flag(name):
    return name in sys.argv[1:]


def argval(name, default=None):
    args = sys.argv[1:]
    for i, a in enumerate(args):
        if a == name and i + 1 < len(args):
            return args[i + 1]
    return default


def load_env(path):
    env = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def account_ready(acc):
    """账号凭据是否真实可用（与 push_draft.py 判定完全一致）。"""
    p = os.path.join(ACC_DIR, "%s.env" % acc)
    if not os.path.exists(p):
        return False, "env文件缺失"
    e = load_env(p)
    aid, sec = e.get("WECHAT_APPID", ""), e.get("WECHAT_SECRET", "")
    if not aid or not sec:
        return False, "凭据为空"
    if len(aid) != 18 or not aid.startswith("wx"):
        return False, "AppID格式不符"
    if len(sec) < 20:
        return False, "Secret过短"
    if PLACEHOLDER_RE.search(aid) or PLACEHOLDER_RE.search(sec):
        return False, "仍是占位符"
    return True, ""


def today_str():
    return datetime.date.today().isoformat()


def scan_backlog(arts, per_day, usable, days):
    """回扫最近 days 天（不含今天），找出当天没写满配额的账号日期组合。

    用途：定时任务可能因机器关机、接口报错、进程中断而漏跑，这类缺口不会自动消失。
    补写时用 push_draft.py --date <当天日期> 记账，缺口才会真正闭合。
    """
    if days <= 0 or not usable:
        return []
    today = datetime.date.today()
    window_start = (today - datetime.timedelta(days=days)).isoformat()

    # 每个账号只在「它第一次有记录之后」才算缺账：
    # 避免把流水线启用之前的日子、或新账号加入之前的日子误报成漏跑
    first_seen, done = {}, {}
    for a in arts:
        d, acc = a.get("date", ""), a.get("account", "")
        if not d or acc not in usable:
            continue
        if acc not in first_seen or d < first_seen[acc]:
            first_seen[acc] = d
        if window_start <= d < today.isoformat():
            done[(d, acc)] = done.get((d, acc), 0) + 1

    out = []
    for i in range(days, 0, -1):
        d = (today - datetime.timedelta(days=i)).isoformat()
        for acc in usable:
            floor = first_seen.get(acc, today.isoformat())
            if d < floor:            # 该账号当时还没上线（或流水线尚未启用）
                continue
            got = done.get((d, acc), 0)
            if got < per_day:
                out.append({"date": d, "account": acc, "got": got, "miss": per_day - got})
    return out


def build_plan(target_account=None, show_all=False, backlog_days=3):
    cfg = json.load(open(CONFIG_PATH, encoding="utf-8"))
    per_day = int(cfg.get("posts_per_account_per_day", 2))
    today = today_str()

    hist = {"articles": []}
    if os.path.exists(HISTORY_PATH):
        try:
            hist = json.load(open(HISTORY_PATH, encoding="utf-8"))
        except Exception:
            pass
    arts = hist.get("articles", [])

    # 今日已完成统计 + 当天已占用角度
    done_today, angles_today = {}, set()
    for a in arts:
        if a.get("date") == today:
            done_today[a.get("account", "")] = done_today.get(a.get("account", ""), 0) + 1
            if a.get("angle_ref"):
                angles_today.add(a["angle_ref"])

    tasks, skipped, warnings = [], [], []

    for track, tcfg in cfg.get("tracks", {}).items():
        usable, note = [], []
        for acc in tcfg.get("accounts", []):
            ok, why = account_ready(acc)
            if target_account and acc != target_account:
                continue
            if ok:
                usable.append(acc)
            else:
                note.append("%s(%s)" % (acc, why))
                skipped.append({"account": acc, "track": track, "reason": why})
        if note:
            warnings.append("[%s] 跳过未就绪账号: %s" % (track, "、".join(note)))

        # 该赛道历史作品（供 agent 做观点层去重）
        past = [{"date": a.get("date", ""), "title": a.get("title", "")}
                for a in arts if a.get("track") == track]
        past = past[-8:]  # 只给最近 8 条，避免上下文过长

        # 角度池：赛道级公共池 + 排除今日已用的
        af = tcfg.get("angles_file", "")
        ap = pathutil.angles_path(af)
        if not os.path.exists(ap):
            warnings.append("[%s] 角度库缺失: %s" % (track, af))
            continue
        angles = json.load(open(ap, encoding="utf-8")).get("angles", [])
        free = [a for a in angles if not a.get("used") and a["id"] not in angles_today]

        pool = free[:]          # 跨账号共享，取一个少一个
        for acc in usable:
            already = done_today.get(acc, 0)
            need = max(0, per_day - already)
            picked, short = [], 0
            for _ in range(need):
                if not pool:
                    short += 1
                    continue
                picked.append({"id": pool[0]["id"], "theme": pool[0].get("theme", ""),
                               "angle": pool[0].get("angle", "")})
                pool.pop(0)
            if short:
                warnings.append("[%s][%s] 角度不足，缺 %d 篇——请补充角度库" % (track, acc, short))
            tasks.append({
                "track": track, "account": acc, "need": need,
                "already_today": already,
                "angles": picked,
                "short": short,
                "avoid": past,
            })

        # 枯竭预警：给出可直接执行的补库命令，agent 看到就能顺手补
        if usable:
            burn = per_day * len(usable)
            days = len(free) // burn if burn else 0
            if days <= 10:
                warnings.append(
                    "[%s] 角度库存告急：剩 %d 个，按 %d 篇/天仅够约 %d 天。"
                    "请先扩库再创作：python scripts/add_angles.py --track %s "
                    "--file var/candidates_%s.json（候选参考 config/topic_seeds.json 的维度组合生成）"
                    % (track, len(free), burn, days, track, track))

    backlog = scan_backlog(arts, per_day, sorted({t["account"] for t in tasks}), backlog_days)

    return {"date": today, "per_day": per_day, "tasks": tasks,
            "skipped": skipped, "warnings": warnings, "backlog": backlog}


def main():
    as_json = flag("--json")
    show_all = flag("--all")
    target = argval("--account")
    bd = argval("--backlog-days", "3")
    try:
        backlog_days = int(bd)
    except ValueError:
        backlog_days = 3
    plan = build_plan(target, show_all, backlog_days)

    if as_json:
        print(json.dumps(plan, ensure_ascii=False, indent=2))
        return

    total_need = sum(t["need"] for t in plan["tasks"])
    total_pick = sum(len(t["angles"]) for t in plan["tasks"])
    accts = sorted({t["account"] for t in plan["tasks"]})
    print("=" * 58)
    print("今日创作计划  %s" % plan["date"])
    print("=" * 58)
    print("可发布账号 %d 个：%s" % (len(accts), "、".join(accts) if accts else "（无）"))
    print("应产出 %d 篇，本次已选出选题 %d 个" % (total_need, total_pick))
    print()

    if not plan["tasks"]:
        print("⚠️ 今日无排产：没有填了真实凭据的账号。")
        print("   填好 ~/.wechat_accounts/<账号名>.env 后自动纳入，无需改配置。")
    for t in plan["tasks"]:
        print("── [%s] %s ──" % (t["track"], t["account"]))
        if t["already_today"]:
            print("   今日已完成 %d 篇，还需 %d 篇" % (t["already_today"], t["need"]))
        else:
            print("   今日需 %d 篇" % t["need"])
        if not t["angles"]:
            msg = "   今日配额已满，无需新选题" if t["need"] == 0 \
                else "   ⚠️ 角度库不足，选不出选题，请先补库"
            print(msg)
        for i, a in enumerate(t["angles"], 1):
            print("   %d) %s  [%s]" % (i, a["id"], a["theme"]))
            print("      %s" % a["angle"])
        if t["avoid"]:
            print("   去重参考（该赛道近作，勿撞观点）：")
            for x in t["avoid"][-3:]:
                print("      · %s  %s" % (x["date"], x["title"][:40]))
        print()

    if plan["backlog"]:
        print("🧾 往日缺账（定时任务漏跑/失败的兜底检查，最近 %d 天）：" % backlog_days)
        for b in plan["backlog"]:
            print("   · %s  %s  当天只有 %d 篇，缺 %d 篇" % (b["date"], b["account"], b["got"], b["miss"]))
        print("   补写时用 daily_plan.py --account <账号> 取选题，推送带上 --date <该日期> 记账，缺口才会闭合。")
        print()

    if plan["skipped"]:
        print("⏭ 跳过（未填真实凭据）：%s"
              % "、".join("%s/%s" % (s["track"], s["account"]) for s in plan["skipped"]))
        print()
    if plan["warnings"]:
        print("⚠️ 提醒：")
        for w in plan["warnings"]:
            print("   · %s" % w)
        print()
    print("选定选题后：创作 → push_draft.py --content <文章.html> --account <账号> "
          "--angle <角度ID> --track <赛道> --cover <封面>")


if __name__ == "__main__":
    main()
