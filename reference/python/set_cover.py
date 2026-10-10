#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""替换草稿封面（保留正文与其余字段原样回传）。

用法:
  python set_cover.py --account 戏精漫话 --media-id <草稿media_id> --cover <封面.png>

流程：draft/get 读原稿 → material/add_material 上传新封面 → draft/update 仅替换 thumb_media_id
注意：draft/update 必须把原内容的其余字段一并回传，否则会被清空。
"""
import os, sys, json, subprocess, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pathutil


def argval(name, default=None):
    a = sys.argv[1:]
    for i, x in enumerate(a):
        if x == name and i + 1 < len(a):
            return a[i + 1]
    return default


ACCOUNT = argval("--account")
MEDIA_ID = argval("--media-id")
COVER = argval("--cover")

if not (ACCOUNT and MEDIA_ID and COVER):
    print(__doc__)
    sys.exit(1)

ENV_PATH = os.path.expanduser("~/.wechat_accounts/%s.env" % ACCOUNT)
if not COVER or not os.path.exists(COVER):
    alt = os.path.join(pathutil.COVERS_DIR, os.path.basename(COVER or ""))
    if os.path.exists(alt):
        COVER = alt
    else:
        print("❌ 封面不存在: %s" % COVER)
        sys.exit(1)


def load_env(p):
    env = {}
    if not os.path.exists(p):
        print("❌ 凭据文件不存在: %s" % p)
        sys.exit(1)
    for line in open(p, encoding="utf-8"):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def api(url, payload=None):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload else None
    req = urllib.request.Request(url, data=data, method="POST",
                                 headers={"Content-Type": "application/json",
                                          "User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


env = load_env(ENV_PATH)
appid, secret = env.get("WECHAT_APPID", ""), env.get("WECHAT_SECRET", "")
if not appid or not secret:
    print("❌ 凭据为空: %s" % ENV_PATH)
    sys.exit(1)

tok = api("https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential"
          "&appid=%s&secret=%s" % (appid, secret))
if "access_token" not in tok:
    print("token 失败:", json.dumps(tok, ensure_ascii=False)[:300])
    sys.exit(1)
T = tok["access_token"]
print("1/4 token OK")

g = api("https://api.weixin.qq.com/cgi-bin/draft/get?access_token=" + T, {"media_id": MEDIA_ID})
if "news_item" not in g:
    print("draft/get 失败:", json.dumps(g, ensure_ascii=False)[:300])
    sys.exit(1)
item = g["news_item"][0]
print("2/4 草稿读取 OK: 《%s》" % item.get("title"))

up = subprocess.run(
    [r"C:\WINDOWS\system32\curl.exe", "-s", "-X", "POST", "-F", "media=@%s" % COVER,
     "https://api.weixin.qq.com/cgi-bin/material/add_material?access_token=%s&type=image" % T],
    capture_output=True, text=True, timeout=180)
try:
    upr = json.loads(up.stdout)
except Exception:
    print("上传响应异常:", up.stdout[:300])
    sys.exit(1)
if "media_id" not in upr:
    print("封面上传失败:", json.dumps(upr, ensure_ascii=False)[:300])
    sys.exit(1)
print("3/4 新封面上传 OK")

articles = {
    "title": item.get("title", ""),
    "author": item.get("author", ""),
    "digest": item.get("digest", ""),
    "content": item.get("content", ""),
    "thumb_media_id": upr["media_id"],
    "need_open_comment": int(item.get("need_open_comment", 0) or 0),
    "only_fans_can_comment": int(item.get("only_fans_can_comment", 0) or 0),
}
u = api("https://api.weixin.qq.com/cgi-bin/draft/update?access_token=" + T,
        {"media_id": MEDIA_ID, "index": 0, "articles": articles})
if u.get("errcode") == 0:
    print("4/4 封面替换成功! 草稿《%s》" % item.get("title"))
else:
    print("draft/update 失败:", json.dumps(u, ensure_ascii=False)[:300])
    sys.exit(1)
