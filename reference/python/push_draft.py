#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
公众号草稿箱推送脚本（内容驱动版）

用法:
  python push_draft.py --content 文章.html --account 戏精漫话 [--title 标题]
                       [--digest 摘要] [--cover 封面.png] [--track 育儿] [--record] [--dry-run]

参数:
  --content  文章HTML文件（必需）。脚本提取 h1(主标题)/h2(小标题)/p(正文)，套微信内联样式
  --account  账号名 -> 读 ~/.wechat_accounts/<名称>.env；省略则用 ~/.wechat_publish.env
  --title    覆盖自动提取的标题
  --digest   摘要，默认取首段前54字
  --cover    封面图路径；文件不存在则创建无封面草稿
  --track    所属赛道，配合 --record 写入历史库（用于去重）
  --angle    角度ID（如 育儿-039），推送成功后自动标记该角度已用（防重复创作）
  --record   推送成功后写入 articles_history.json
  --date     记账日期 YYYY-MM-DD，默认今天。补写往日缺篇时用，配合 daily_plan.py --backlog 使用
  --dry-run  只校验凭据 + 预览解析结果，不调用微信接口、不推送
"""
import os, sys, json, re, urllib.request, urllib.error, subprocess, datetime
from html.parser import HTMLParser

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pathutil

# 占位凭据识别：未填真实值的账号一律拒绝推送
PLACEHOLDER_RE = re.compile(r"填入|placeholder|todo|xxx|your_", re.I)

def creds_valid(appid, secret):
    """真实凭据判定：APPID 18位且 wx 开头；SECRET >=20 位；且不含占位提示文字。"""
    if not appid or not secret:
        return False
    if len(appid) != 18 or not appid.startswith("wx"):
        return False
    if len(secret) < 20:
        return False
    if PLACEHOLDER_RE.search(appid) or PLACEHOLDER_RE.search(secret):
        return False
    return True

BASE = pathutil.PROJECT_ROOT          # 项目根目录（脚本在 scripts/ 子目录下）
SCRIPTS_DIR = pathutil.SCRIPTS_DIR
HISTORY_PATH = pathutil.HISTORY_PATH
DEFAULT_COVER = pathutil.DEFAULT_COVER
CURL = r"C:\WINDOWS\system32\curl.exe"

# ---------- 参数解析 ----------
def flag(name):
    return name in sys.argv[1:]

def argval(name, default=None):
    args = sys.argv[1:]
    for i, a in enumerate(args):
        if a == name and i + 1 < len(args):
            return args[i + 1]
    return default

DRY_RUN = flag("--dry-run")
RECORD = flag("--record")
ACCOUNT = argval("--account")
CONTENT = argval("--content")
TITLE = argval("--title")
DIGEST = argval("--digest")
COVER = argval("--cover")
TRACK = argval("--track")
ANGLE = argval("--angle")     # 角度ID（如 育儿-039）；推送成功后自动标记该角度已用
UPDATE_ID = argval("--update")   # 指定则更新已有草稿，而非新建
AS_OF_DATE = argval("--date")    # 记账日期（补写往日缺篇时用），默认今天；格式 YYYY-MM-DD

# 记账日期：正常创作=今天；补跑 backlog 时显式指定往日，让 daily_plan.py 的缺账闭合
RECORD_DATE = AS_OF_DATE or datetime.date.today().isoformat()
try:
    datetime.date.fromisoformat(RECORD_DATE)
except ValueError:
    print("❌ --date 格式应为 YYYY-MM-DD，收到：%s" % RECORD_DATE)
    sys.exit(1)

# ---------- 凭据 ----------
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

if ACCOUNT:
    ENV_PATH = os.path.expanduser("~/.wechat_accounts/%s.env" % ACCOUNT)
else:
    ENV_PATH = os.path.expanduser("~/.wechat_publish.env")

if not os.path.exists(ENV_PATH):
    print("❌ 凭据文件不存在: %s" % ENV_PATH)
    sys.exit(1)

env = load_env(ENV_PATH)
APPID = env.get("WECHAT_APPID", "")
SECRET = env.get("WECHAT_SECRET", "")
AUTHOR = env.get("WECHAT_AUTHOR", "koo AI")
print("账号: %s" % (ACCOUNT if ACCOUNT else "默认(.wechat_publish.env)"))
print("凭据: APPID长度=%d, SECRET长度=%d, AUTHOR=%s" % (len(APPID), len(SECRET), AUTHOR))
if not creds_valid(APPID, SECRET):
    print("❌ 该账号凭据为占位或无效，拒绝推送（规则：只发给填了真实凭据的账号）。")
    print("   请先填入真实 AppID/Secret: %s" % ENV_PATH)
    sys.exit(1)

# ---------- 解析文章 HTML ----------
# 行内强调标记：\x01 普通加粗  \x02 关键句(品牌红)  \x03 闭合
M_B, M_K, M_C = "\x01", "\x02", "\x03"
EM_OPEN = '<strong style="font-weight:700;color:#111;">'
KEY_OPEN = '<strong style="font-weight:700;color:rgb(255,76,65);">'
EM_CLOSE = "</strong>"


def render_inline(text):
    """把行内强调标记还原成微信可保留的内联标签，并修复未闭合。"""
    out = text.replace(M_K, KEY_OPEN).replace(M_B, EM_OPEN).replace(M_C, EM_CLOSE)
    if out.count("<strong") > out.count("</strong>"):
        out += EM_CLOSE * (out.count("<strong") - out.count("</strong>"))
    return out


class Extractor(HTMLParser):
    """提取 h1(标题) 与 h2/p(正文块)，忽略 style/script/img；保留 strong/em 强调。"""
    def __init__(self):
        super().__init__()
        self.title = None
        self.blocks = []      # [(tag, text)]
        self._cur = None
        self._buf = []
        self._skip = False    # 跳过 class=num 的序号 span，避免与自动编号重复
        self._emph = []       # 行内强调栈

    def handle_starttag(self, tag, attrs):
        if tag in ("h1", "h2", "p"):
            self._cur = tag
            self._buf = []
            self._skip = False
            self._emph = []
        if tag == "span":
            cls = " ".join(v for k, v in attrs if k == "class").lower()
            if any(w in cls for w in ("num", "seq", "order", "index")):
                self._skip = True
        # 行内强调：<strong>/<b> 普通加粗；class 含 key/hl 用品牌红
        if tag in ("strong", "b", "em", "i") and self._cur and not self._skip:
            cls = " ".join(v for k, v in attrs if k == "class").lower()
            if any(w in cls for w in ("key", "hl", "highlight")):
                self._emph.append("k")
                self._buf.append(M_K)
            else:
                self._emph.append("b")
                self._buf.append(M_B)

    def handle_endtag(self, tag):
        if tag in ("strong", "b", "em", "i") and self._emph:
            self._emph.pop()
            self._buf.append(M_C)
            return
        if tag == "span" and self._skip:
            self._skip = False
            return
        if tag == self._cur and tag in ("h1", "h2", "p"):
            text = "".join(self._buf).strip()
            if text:
                if tag == "h1" and self.title is None:
                    self.title = text
                else:
                    self.blocks.append((tag, text))
            self._cur = None
            self._buf = []

    def handle_data(self, data):
        if self._cur and not self._skip:
            self._buf.append(data)

    def handle_entityref(self, name):
        if self._cur:
            import html as _h
            self._buf.append(_h.unescape("&%s;" % name))

if not CONTENT:
    print("❌ 缺少 --content <文章HTML文件>")
    sys.exit(1)
if not os.path.exists(CONTENT):
    print("❌ 文章文件不存在: %s" % CONTENT)
    sys.exit(1)

with open(CONTENT, encoding="utf-8") as f:
    raw_html = f.read()

ex = Extractor()
ex.feed(raw_html)
title = TITLE or ex.title or ""
if not title:
    print("❌ 未能从文章中提取标题，请用 --title 指定")
    sys.exit(1)

# 全局标题前缀（可配置于 config.json 的 title_prefix），幂等：已有则不重复添加
def load_title_prefix():
    try:
        cfg = json.load(open(pathutil.CONFIG_PATH, encoding="utf-8"))
        p = cfg.get("title_prefix", "【话】")
        return p if isinstance(p, str) else "【话】"
    except Exception:
        return "【话】"

TITLE_PREFIX = load_title_prefix()
if TITLE_PREFIX and not title.startswith(TITLE_PREFIX):
    title = TITLE_PREFIX + title
if not ex.blocks:
    print("❌ 未能从文章中提取正文（需含 h2/p 标签）")
    sys.exit(1)

EMPH_RE = re.compile(r"[\x01\x02\x03]")
h2_count = sum(1 for t, _ in ex.blocks if t == "h2")
p_count = sum(1 for t, _ in ex.blocks if t == "p")
chars = sum(len(EMPH_RE.sub("", txt)) for _, txt in ex.blocks)
bold_n = sum(txt.count(M_B) + txt.count(M_K) for _, txt in ex.blocks)
print("文章解析: 标题=%s | 小标题%d个 | 段落%d个 | 约%d字 | 加粗%d处"
      % (title, h2_count, p_count, chars, bold_n))

# ---------- 生成微信内联样式正文 ----------
P_STYLE = 'style="margin:0 0 16px;line-height:1.85;color:#333;"'
H2_STYLE = ('style="text-align:center;font-size:22px;font-weight:700;'
            'color:rgb(255,76,65);margin:30px 0 14px;'
            'font-family:-apple-system,\'PingFang SC\',\'Microsoft YaHei\',sans-serif;"')

def strip_dup_seq(text, idx):
    """兜底：若小标题已手写序号且恰好等于自动编号，剥掉它，避免出现「11 11…」。"""
    m = re.match(r"^\s*0?%d\s*[\.、]?\s*(?=[\u4e00-\u9fffA-Za-z])" % idx, text)
    return text[m.end():] if m else text

parts = []
h2_index = 0
for tag, text in ex.blocks:
    if tag == "h2":
        h2_index += 1
        seq = "%02d" % h2_index
        text = strip_dup_seq(text, h2_index)
        inner = ('<span style="color:rgb(0,82,255);font-style:italic;font-weight:700;">%s</span>'
                 '&nbsp;%s' % (seq, text))
        parts.append("<h2 %s>%s</h2>" % (H2_STYLE, render_inline(inner)))
    else:
        parts.append("<p %s>%s</p>" % (P_STYLE, render_inline(text)))
content_html = ('<section style="font-family:-apple-system,\'PingFang SC\',\'Microsoft YaHei\','
                'sans-serif;font-size:17px;color:#333;padding:4px 2px;">'
                + "".join(parts) + "</section>")

first_p = next((txt for t, txt in ex.blocks if t == "p"), "")
first_p = EMPH_RE.sub("", first_p)
digest = DIGEST or (first_p[:54] + ("…" if len(first_p) > 54 else ""))
if UPDATE_ID and not COVER:
    cover_path = None   # 更新模式未指定封面 -> 保留草稿原有封面
else:
    cover_path = COVER or DEFAULT_COVER
if cover_path and not os.path.exists(cover_path):
    print("⚠️ 封面图不存在: %s（将创建无封面草稿）" % cover_path)
    cover_path = None

if DRY_RUN:
    print("\n[DRY-RUN] 校验通过，预览如下（未推送）:")
    print("  标题: %s" % title)
    print("  摘要: %s" % digest)
    print("  封面: %s" % (cover_path or "无"))
    print("  赛道: %s | 角度: %s | 记录历史: %s" % (TRACK or "未指定", ANGLE or "未指定", RECORD))
    print("  正文前120字: %s" % "".join(txt for _, txt in ex.blocks)[:120])
    heads = [EMPH_RE.sub("", t) for tg, t in ex.blocks if tg == "h2"][:3]
    print("  小标题前3个(应无写死序号): %s" % " | ".join(heads))
    sys.exit(0)

# ---------- 取 access_token ----------
def http_get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))

token_url = ("https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential"
             "&appid=%s&secret=%s" % (APPID, SECRET))
try:
    tok = http_get(token_url)
except Exception as e:
    print("获取 access_token 失败:", e)
    sys.exit(1)
if "access_token" not in tok:
    print("access_token 返回异常:", tok)
    if tok.get("errcode") == 40164:
        import re
        m = re.search(r"invalid ip ([\d.]+)", tok.get("errmsg", ""))
        print("➡️ IP白名单未包含当前出口IP%s，请到公众号后台「设置与开发→基本配置→IP白名单」添加"
              % ((" " + m.group(1)) if m else ""))
    sys.exit(1)
TOKEN = tok["access_token"]
print("access_token 获取成功, expires_in=%s" % tok.get("expires_in"))

# ---------- 上传封面 ----------
def upload_image(token, img):
    url = ("https://api.weixin.qq.com/cgi-bin/material/add_material"
           "?access_token=%s&type=image" % token)
    r = subprocess.run([CURL, "-s", "-F", "media=@%s" % img, url],
                       capture_output=True, text=True, timeout=60)
    try:
        return json.loads(r.stdout)
    except Exception:
        return {"raw": r.stdout, "stderr": r.stderr}

THUMB = ""
if cover_path:
    up = upload_image(TOKEN, cover_path)
    THUMB = up.get("media_id", "")
    print("封面上传: %s" % ("成功 media_id=%s" % THUMB if THUMB else "失败 %s" % up))
else:
    print("封面: %s" % ("更新模式，保留草稿原封面" if UPDATE_ID else "无（创建无封面草稿）"))

# ---------- 创建 / 更新草稿 ----------
def http_post_json(url, payload):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST",
                                 headers={"Content-Type": "application/json",
                                          "User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


if UPDATE_ID:
    # 更新已有草稿：保留原作者/摘要/封面(除非本次指定)，只覆盖正文与标题
    g = http_post_json("https://api.weixin.qq.com/cgi-bin/draft/get?access_token=%s" % TOKEN,
                       {"media_id": UPDATE_ID})
    if "news_item" not in g:
        print("❌ 读取原草稿失败:", json.dumps(g, ensure_ascii=False)[:300])
        sys.exit(1)
    old = g["news_item"][0]
    article = {
        "title": title,   # 已含全局前缀处理
        "author": old.get("author", AUTHOR),
        "digest": DIGEST or old.get("digest", ""),
        "content": content_html,
        "thumb_media_id": THUMB or old.get("thumb_media_id", ""),
        "need_open_comment": int(old.get("need_open_comment", 1) or 0),
        "only_fans_can_comment": int(old.get("only_fans_can_comment", 0) or 0),
    }
    resp = http_post_json(
        "https://api.weixin.qq.com/cgi-bin/draft/update?access_token=%s" % TOKEN,
        {"media_id": UPDATE_ID, "index": 0, "articles": article})
    if resp.get("errcode") == 0:
        resp = {"media_id": UPDATE_ID}
    else:
        print("❌ draft/update 失败:", json.dumps(resp, ensure_ascii=False)[:300])
        sys.exit(1)
else:
    article = {
        "title": title,
        "author": AUTHOR,
        "digest": digest,
        "content": content_html,
        "thumb_media_id": THUMB,
        "need_open_comment": 1,
        "only_fans_can_comment": 0,
    }
    resp = http_post_json(
        "https://api.weixin.qq.com/cgi-bin/draft/add?access_token=%s" % TOKEN,
        {"articles": [article]})

def mark_angle_used(angle_id, account, when=None):
    """把角度库中的该角度标记为已用，避免日后重复创作同一角度。"""
    try:
        cfg = json.load(open(pathutil.CONFIG_PATH, encoding="utf-8"))
    except Exception:
        return None
    for tname, tcfg in cfg.get("tracks", {}).items():
        ap = pathutil.angles_path(tcfg.get("angles_file", ""))
        if not os.path.exists(ap):
            continue
        d = json.load(open(ap, encoding="utf-8"))
        for a in d.get("angles", []):
            if a.get("id") == angle_id:
                a["used"] = True
                a["used_by"] = account or "默认"
                a["used_date"] = when or datetime.date.today().isoformat()
                json.dump(d, open(ap, "w", encoding="utf-8"),
                          ensure_ascii=False, indent=2)
                free = sum(1 for x in d.get("angles", []) if not x.get("used"))
                return tname, free, len(d.get("angles", []))
    return None


if resp.get("media_id"):
    print("\n✅ %s media_id = %s" % ("草稿更新成功！" if UPDATE_ID else "草稿创建成功！",
                                     resp["media_id"]))
    print("查看: https://mp.weixin.qq.com （内容管理 → 草稿箱）")
    # ---------- 标记角度已用 ----------
    if ANGLE:
        r = mark_angle_used(ANGLE, ACCOUNT or "默认", RECORD_DATE)
        if r:
            tname, free, total = r
            print("🎯 角度已标记: %s（%s 赛道剩余 %d/%d）" % (ANGLE, tname, free, total))
        else:
            print("⚠️ 未找到角度 %s，请确认 ID 是否写错" % ANGLE)
    # ---------- 写入历史库（去重基础；更新草稿不重复记账） ----------
    if RECORD and UPDATE_ID:
        print("📝 更新模式：历史库已有该篇记录，未重复写入")
    if RECORD and not UPDATE_ID:
        hist = {"version": 1, "articles": []}
        if os.path.exists(HISTORY_PATH):
            try:
                hist = json.load(open(HISTORY_PATH, encoding="utf-8"))
            except Exception:
                pass
        hist.setdefault("articles", []).append({
            "date": RECORD_DATE,
            "track": TRACK or "",
            "account": ACCOUNT or "默认",
            "title": title,
            "digest": digest,
            "angle_ref": ANGLE or "",
            "media_id": resp["media_id"],
            "blocks": h2_count,
            "chars": chars,
        })
        with open(HISTORY_PATH, "w", encoding="utf-8") as f:
            json.dump(hist, f, ensure_ascii=False, indent=2)
        print("📝 已写入历史库: %s（%d 条）" % (HISTORY_PATH, len(hist["articles"])))
else:
    print("\n❌ 草稿创建未返回 media_id:", resp)
    sys.exit(1)
