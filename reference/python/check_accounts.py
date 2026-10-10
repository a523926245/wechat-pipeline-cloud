#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
账号可用性检查：列出每个赛道下各账号的凭据状态，只把「填了真实凭据」的账号视为可发布。

用法:
  python check_accounts.py            # 打印可读表格
  python check_accounts.py --json     # 输出 JSON（供自动化流程读取）

规则：占位/无效的账号一律跳过，绝不推送。填好真实凭据后无需改配置，自动变为可用。
"""
import os, sys, json, re

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pathutil

CONFIG = pathutil.CONFIG_PATH
PLACEHOLDER_RE = re.compile(r"填入|placeholder|todo|xxx|your_", re.I)


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


def creds_valid(appid, secret):
    if not appid or not secret:
        return False
    if len(appid) != 18 or not appid.startswith("wx"):
        return False
    if len(secret) < 20:
        return False
    if PLACEHOLDER_RE.search(appid) or PLACEHOLDER_RE.search(secret):
        return False
    return True


def scan():
    cfg = json.load(open(CONFIG, encoding="utf-8"))
    rows = []
    for track, v in cfg["tracks"].items():
        for acc in v["accounts"]:
            path = os.path.expanduser("~/.wechat_accounts/%s.env" % acc)
            if not os.path.exists(path):
                rows.append({"track": track, "account": acc, "ready": False,
                             "reason": "env文件缺失", "path": path})
                continue
            env = load_env(path)
            aid = env.get("WECHAT_APPID", "")
            sec = env.get("WECHAT_SECRET", "")
            if creds_valid(aid, sec):
                rows.append({"track": track, "account": acc, "ready": True,
                             "reason": "真实凭据", "path": path})
            else:
                rows.append({"track": track, "account": acc, "ready": False,
                             "reason": "占位/无效(APPID%d位,SECRET%d位)" % (len(aid), len(sec)),
                             "path": path})
    return rows


if __name__ == "__main__":
    rows = scan()
    if "--json" in sys.argv[1:]:
        print(json.dumps({"ready": [r for r in rows if r["ready"]],
                          "skipped": [r for r in rows if not r["ready"]]},
                         ensure_ascii=False, indent=2))
        sys.exit(0)

    print("账号可用性检查（仅真实凭据可发布）")
    print("=" * 62)
    for r in rows:
        mark = "✓ 可发布" if r["ready"] else "✗ 跳过"
        print("[%s] %-10s %s  (%s)" % (r["track"], r["account"], mark, r["reason"]))
    ready = [r for r in rows if r["ready"]]
    print("=" * 62)
    print("可发布账号 %d 个: %s" % (len(ready), "、".join(r["account"] for r in ready) or "无"))
    print("跳过 %d 个（填好真实凭据后自动启用，无需改配置）" % (len(rows) - len(ready)))
