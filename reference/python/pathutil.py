# -*- coding: utf-8 -*-
"""统一路径基准。

所有脚本都从这里取路径，不再各自拼接 __file__。
好处：以后调整目录结构（或整个搬到别的盘），只改这一个文件就够了。

目录约定（PROJECT_ROOT 之下）：
    config/            配置：账号映射、标题前缀、文风 DNA
    data/angles/       选题库存（每赛道一个 JSON）
    data/history/      发布历史（去重依据）
    content/articles/  文章 HTML 成稿
    content/covers/    封面图
    docs/              文档（SOP 手册）
    var/logs/          运行日志、计划快照
    scripts/           本文件所在的脚本目录
"""
import os

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPTS_DIR)

CONFIG_DIR = os.path.join(PROJECT_ROOT, "config")
DATA_DIR = os.path.join(PROJECT_ROOT, "data")
ANGLES_DIR = os.path.join(DATA_DIR, "angles")
HISTORY_DIR = os.path.join(DATA_DIR, "history")
CONTENT_DIR = os.path.join(PROJECT_ROOT, "content")
DOCS_DIR = os.path.join(PROJECT_ROOT, "docs")
VAR_DIR = os.path.join(PROJECT_ROOT, "var")
LOG_DIR = os.path.join(VAR_DIR, "logs")

ARTICLES_DIR = os.path.join(CONTENT_DIR, "articles")
COVERS_DIR = os.path.join(CONTENT_DIR, "covers")

CONFIG_PATH = os.path.join(CONFIG_DIR, "config.json")
STYLE_DNA_PATH = os.path.join(CONFIG_DIR, "style_dna.json")
HISTORY_PATH = os.path.join(HISTORY_DIR, "articles_history.json")
DEFAULT_COVER = os.path.join(COVERS_DIR, "default-cover.png")
PIPELINE_DOC = os.path.join(DOCS_DIR, "PIPELINE.md")


def ensure_runtime_dirs():
    """确保运行期需要的目录都存在（内容目录可能还没产出）。"""
    for d in (ANGLES_DIR, HISTORY_DIR, ARTICLES_DIR, COVERS_DIR, LOG_DIR):
        os.makedirs(d, exist_ok=True)


def resolve(p):
    """把「可能是绝对路径 / 相对项目根 / 相对旧扁平布局」的路径，统一解析到新结构。

    兼容两种写法，避免迁移后旧配置文件里的相对路径突然失效：
      - "data/angles/angles_育儿.json"（推荐，相对项目根）
      - "angles_育儿.json"（旧写法，自动去 data/angles/ 找）
    """
    if os.path.isabs(p):
        return p
    cand = os.path.join(PROJECT_ROOT, p)
    if os.path.exists(cand):
        return cand
    for sub in (ANGLES_DIR, CONFIG_DIR, HISTORY_DIR, ARTICLES_DIR, COVERS_DIR):
        alt = os.path.join(sub, os.path.basename(p))
        if os.path.exists(alt):
            return alt
    return cand  # 还不存在的话，按「相对项目根」返回，供创建方使用


def angles_path(name_or_track):
    """取某个赛道的角度库路径。传文件名或赛道名都行。"""
    n = str(name_or_track)
    if not n.endswith(".json"):
        n = "angles_%s.json" % n
    if not n.startswith("angles_"):
        n = "angles_" + n
    return resolve(os.path.join("data/angles", n))


if __name__ == "__main__":
    print("PROJECT_ROOT :", PROJECT_ROOT)
    for label, v in (("CONFIG_PATH", CONFIG_PATH), ("ANGLES_DIR", ANGLES_DIR),
                     ("HISTORY_PATH", HISTORY_PATH), ("ARTICLES_DIR", ARTICLES_DIR),
                     ("COVERS_DIR", COVERS_DIR), ("DEFAULT_COVER", DEFAULT_COVER)):
        print("%-14s: %s   [%s]" % (label, v, "存在" if os.path.exists(v) else "缺失"))
