#!/usr/bin/env bash
#
# WeChat Pipeline Cloud — 一键部署（Debian/Ubuntu 系）
#
# 设计原则：**失败时能看懂、能接着手工做**。每一步都先打印 STEP 说明，
# 再打印等价的手工命令，然后再执行。任何一步挂掉，你都能照着打印出来的
# 命令自己往下走，不需要猜脚本干了什么。
#
# 用法：
#   sudo bash deploy/install.sh
#   sudo bash deploy/install.sh --skip-build      # 前端 dist 已就绪
#   sudo bash deploy/install.sh --skip-nginx      # 只装后端
#   sudo bash deploy/install.sh --skip-systemd    # 不用 systemd（如容器内跑）
#   ALLOW_DB_PUSH=1 sudo -E bash deploy/install.sh   # 允许 db push（不建迁移基线）
#
set -Eeuo pipefail

APP_DIR=/opt/wechat-pipeline-cloud
ENV_DIR=/etc/wechat-pipeline-cloud
ENV_FILE="$ENV_DIR/app.env"
APP_USER=wpc
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SKIP_BUILD=0
SKIP_NGINX=0
SKIP_SYSTEMD=0
for a in "$@"; do
  case "$a" in
    --skip-build) SKIP_BUILD=1 ;;
    --skip-nginx) SKIP_NGINX=1 ;;
    --skip-systemd) SKIP_SYSTEMD=1 ;;
    *) echo "未知参数: $a"; exit 2 ;;
  esac
done

step() { echo; echo "════════════════════════════════════════"; echo "STEP $1"; echo "════════════════════════════════════════"; }
info() { echo "  · $*"; }
cmd()  { echo "  $ $*"; }

# ─────────────────────────────────────────────────────────────
step "0/10  前置检查"
# ─────────────────────────────────────────────────────────────
if [[ "$(id -u)" -ne 0 ]]; then
  echo "需要 root 权限（要写 /opt、/etc、装 systemd 单元）"
  echo "  $ sudo bash $0"
  exit 1
fi

# --experimental-strip-types 需要 Node >= 22.6；engines 里写的 >=20 是错的
if ! command -v node >/dev/null 2>&1; then
  echo "未找到 node。先装 Node 22 LTS："
  cmd "curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs"
  exit 1
fi
NODE_VER="$(node -v | sed 's/^v//')"
NODE_MAJOR="${NODE_VER%%.*}"
NODE_MINOR="$(echo "$NODE_VER" | cut -d. -f2)"
if [[ "$NODE_MAJOR" -lt 22 ]] || { [[ "$NODE_MAJOR" -eq 22 ]] && [[ "$NODE_MINOR" -lt 6 ]]; }; then
  echo "Node 版本过低：$NODE_VER（需要 >= 22.6，因为要跑 --experimental-strip-types）"
  exit 1
fi
info "Node $NODE_VER OK"

# systemd 单元里写死了 /usr/bin/node，这里确认一下；nvm 装的通常不在这个路径
NODE_BIN="$(command -v node)"
if [[ "$NODE_BIN" != "/usr/bin/node" ]]; then
  echo "⚠️  当前 node 在 $NODE_BIN，不是 /usr/bin/node。"
  echo "   systemd 单元里 ExecStart 写的是 /usr/bin/node，请手动改成："
  cmd "sed -i 's#ExecStart=/usr/bin/node#ExecStart=$NODE_BIN#' $APP_DIR/deploy/systemd/*.service"
fi

# ─────────────────────────────────────────────────────────────
step "1/10  创建运行用户与目录"
# ─────────────────────────────────────────────────────────────
cmd "useradd --system --home $APP_DIR --shell /usr/sbin/nologin $APP_USER || true"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"

cmd "mkdir -p $ENV_DIR $APP_DIR/var/logs $APP_DIR/var/content/{articles,covers,comics}"
mkdir -p "$ENV_DIR"
mkdir -p "$APP_DIR/var/logs" "$APP_DIR/var/content/articles" "$APP_DIR/var/content/covers" "$APP_DIR/var/content/comics"

# ─────────────────────────────────────────────────────────────
step "2/10  同步代码到 $APP_DIR"
# ─────────────────────────────────────────────────────────────
cmd "rsync -a --exclude node_modules --exclude .git --exclude var/logs --exclude '*/dist' $REPO_DIR/ $APP_DIR/"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --exclude node_modules --exclude .git --exclude var/logs --exclude '*/dist' \
    "$REPO_DIR/" "$APP_DIR/"
else
  cmd "(无 rsync，改用 tar 管道)"
  tar -C "$REPO_DIR" --exclude=node_modules --exclude=.git --exclude=var/logs -cf - . \
    | tar -C "$APP_DIR" -xf -
fi
info "代码已同步（node_modules / .git / 日志 已排除）"

# ─────────────────────────────────────────────────────────────
step "3/10  安装依赖（server 与 web）"
# ─────────────────────────────────────────────────────────────
cmd "cd $APP_DIR/server && npm ci --omit=dev"
( cd "$APP_DIR/server" && npm ci --omit=dev )

cmd "cd $APP_DIR/web && npm ci"
( cd "$APP_DIR/web" && npm ci )

# ─────────────────────────────────────────────────────────────
step "4/10  构建前端"
# ─────────────────────────────────────────────────────────────
if [[ "$SKIP_BUILD" -eq 1 ]]; then
  info "--skip-build：跳过。请确保 $APP_DIR/web/dist 已存在"
else
  # package.json 里已内置 --max-old-space-size=8192，裸 vite build 会 OOM
  cmd "cd $APP_DIR/web && npm run build"
  ( cd "$APP_DIR/web" && npm run build )
fi
if [[ ! -f "$APP_DIR/web/dist/index.html" ]]; then
  echo "dist 缺失，Nginx 会 403/404。请跑一次 npm run build"
  exit 1
fi

# ─────────────────────────────────────────────────────────────
step "5/10  生成环境变量文件 $ENV_FILE"
# ─────────────────────────────────────────────────────────────
if [[ -f "$ENV_FILE" ]]; then
  info "已存在，保留不动（避免误改 APP_SECRET_KEY 导致已存凭据解不开）"
  cmd "cat $ENV_FILE"
else
  SECRET="$(openssl rand -base64 32)"
  cmd "cp $APP_DIR/deploy/app.env.example $ENV_FILE && 填入 DATABASE_URL / APP_SECRET_KEY"
  sed -e "s#^APP_SECRET_KEY=.*#APP_SECRET_KEY=$SECRET#" \
      -e "s#^DATABASE_URL=.*#DATABASE_URL=mysql://wechat:CHANGE_ME@127.0.0.1:3306/wechat_pipeline?connection_limit=10#" \
      "$APP_DIR/deploy/app.env.example" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo
  echo "⚠️  已生成随机 APP_SECRET_KEY，但 DATABASE_URL 还是占位串，必须手改："
  cmd "vi $ENV_FILE      # 把 CHANGE_ME 换成真实数据库口令"
  echo
  echo "  数据库不存在的话先建（MySQL 里执行）："
  cmd "mysql -uroot -p -e \"CREATE DATABASE wechat_pipeline CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\""
  cmd "mysql -uroot -p -e \"CREATE USER 'wechat'@'127.0.0.1' IDENTIFIED BY '真实口令'; GRANT ALL ON wechat_pipeline.* TO 'wechat'@'127.0.0.1'; FLUSH PRIVILEGES;\""
  echo
  read -r -p "  改好 DATABASE_URL 后按回车继续（Ctrl-C 可中断，改完再跑一次本脚本）... " _
fi

# ─────────────────────────────────────────────────────────────
step "6/10  生成 Prisma 客户端"
# ─────────────────────────────────────────────────────────────
# ⚠️ 只跑 prisma:generate（读 MySQL 真源 schema）。
#    绝不要在这台机器上跑 schema:sqlite / sqlite:generate —— 那会用 SQLite
#    版本覆盖同一个生成目录，导致 Json 字段写对象报 "Expected String"。
cmd "cd $APP_DIR/server && npm run prisma:generate"
( cd "$APP_DIR/server" && npm run prisma:generate )

# ─────────────────────────────────────────────────────────────
step "7/10  数据库结构"
# ─────────────────────────────────────────────────────────────
# 仓库里**没有 prisma/migrations**，`npm run prisma:deploy` 必然失败。
# 这里默认停下来让你自己选，避免脚本替你做不可逆的决定。
if [[ -d "$APP_DIR/server/prisma/migrations" ]] && \
   [[ -n "$(ls -A "$APP_DIR/server/prisma/migrations" 2>/dev/null)" ]]; then
  info "检测到迁移目录，执行 prisma migrate deploy"
  cmd "cd $APP_DIR/server && npm run prisma:deploy"
  ( cd "$APP_DIR/server" && npm run prisma:deploy )
elif [[ "${ALLOW_DB_PUSH:-0}" == "1" ]]; then
  info "ALLOW_DB_PUSH=1 → db push（**不产生迁移文件**，后续无法回滚）"
  cmd "cd $APP_DIR/server && npx prisma db push"
  ( cd "$APP_DIR/server" && npx prisma db push )
else
  echo "⚠️  没有迁移基线，`prisma migrate deploy` 会失败。请二选一："
  echo
  echo "  【推荐】建基线迁移（可回滚、可复现）："
  cmd "cd $APP_DIR/server"
  cmd "mkdir -p prisma/migrations/0_init"
  cmd "npx prisma migrate diff --from-empty --to-schema-datasource prisma/schema.prisma --script > prisma/migrations/0_init/migration.sql"
  cmd "npx prisma migrate deploy"
  echo
  echo "  【不推荐】直接 push（省事但不可逆）："
  cmd "ALLOW_DB_PUSH=1 bash $0"
  echo
  exit 1
fi

# ─────────────────────────────────────────────────────────────
step "8/10  安装 systemd 单元"
# ─────────────────────────────────────────────────────────────
if [[ "$SKIP_SYSTEMD" -eq 1 ]]; then
  info "--skip-systemd：跳过（容器内请自行跑 startServer）"
else
  cmd "cp $APP_DIR/deploy/systemd/*.service $APP_DIR/deploy/systemd/*.timer /etc/systemd/system/"
  cp "$APP_DIR"/deploy/systemd/*.service "$APP_DIR"/deploy/systemd/*.timer /etc/systemd/system/

  # node 不在 /usr/bin 时自动改写 ExecStart
  if [[ "$NODE_BIN" != "/usr/bin/node" ]]; then
    cmd "sed -i s#ExecStart=/usr/bin/node#ExecStart=$NODE_BIN# /etc/systemd/system/wechat-pipeline*.service"
    sed -i "s#ExecStart=/usr/bin/node#ExecStart=$NODE_BIN#" /etc/systemd/system/wechat-pipeline*.service
  fi

  cmd "chown -R $APP_USER:$APP_USER $APP_DIR/var $APP_DIR/server/var 2>/dev/null || true"
  chown -R "$APP_USER":"$APP_USER" "$APP_DIR/var" 2>/dev/null || true
  [[ -d "$APP_DIR/server/var" ]] && chown -R "$APP_USER":"$APP_USER" "$APP_DIR/server/var"

  cmd "systemctl daemon-reload && systemctl enable --now wechat-pipeline"
  systemctl daemon-reload
  systemctl enable --now wechat-pipeline
  info "服务已启动。看日志：journalctl -u wechat-pipeline -f"
fi

# ─────────────────────────────────────────────────────────────
step "9/10  Nginx 与日志轮转"
# ─────────────────────────────────────────────────────────────
if [[ "$SKIP_NGINX" -eq 1 ]]; then
  info "--skip-nginx：跳过"
else
  if ! command -v nginx >/dev/null 2>&1; then
    cmd "apt install -y nginx"
    apt-get install -y -qq nginx
  fi
  # Debian 系用 sites-enabled；RHEL 系请改放到 /etc/nginx/conf.d/
  cmd "ln -sf $APP_DIR/deploy/nginx/wechat-pipeline.conf /etc/nginx/sites-enabled/wechat-pipeline.conf"
  mkdir -p /etc/nginx/sites-enabled
  ln -sf "$APP_DIR/deploy/nginx/wechat-pipeline.conf" /etc/nginx/sites-enabled/wechat-pipeline.conf
  rm -f /etc/nginx/sites-enabled/default

  # nginx -t 不通过就绝不 reload：否则会把线上站点搞挂
  cmd "nginx -t"
  if nginx -t; then
    cmd "systemctl enable --now nginx && systemctl reload nginx"
    systemctl enable --now nginx
    systemctl reload nginx
  else
    echo "⚠️  nginx -t 未通过，已跳过 reload。配置仍在 sites-enabled 里，修好后手动："
    cmd "nginx -t && systemctl reload nginx"
    exit 1
  fi
fi

cmd "cp $APP_DIR/deploy/logrotate/wechat-pipeline /etc/logrotate.d/wechat-pipeline"
cp "$APP_DIR/deploy/logrotate/wechat-pipeline" /etc/logrotate.d/wechat-pipeline
info "日志轮转已装（copytruncate：pino 持有 fd 且不响应 SIGHUP）"

# ─────────────────────────────────────────────────────────────
step "10/10  验收"
# ─────────────────────────────────────────────────────────────
if [[ "$SKIP_SYSTEMD" -eq 0 ]]; then
  cmd "systemctl enable --now wechat-pipeline-scheduler.timer"
  systemctl enable --now wechat-pipeline-scheduler.timer || true
fi

cat <<EOF

部署完成。请逐条验收（任何一条不过都别上线）：

  1. 服务活着且连的是 MySQL（**不是 SQLite**）：
       curl -s http://127.0.0.1:8787/api/health | head -c 300
     看 driver 字段必须是 mysql。如果是 sqlite，说明 DATABASE_URL 没生效。

  2. 前端首页与深链刷新（SPA fallback）：
       curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1/
       curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1/articles/1
     两条都必须是 200。第二条是 404 说明 try_files 没生效。

  3. 封面静态目录可达（/api/content 必须被反代转发，不能被 rewrite 掉）：
       先在界面生成一张封面，再：
       curl -s -o /dev/null -w '%{http_code}\\n' 'http://127.0.0.1/api/content/covers/<文件名>.png'

  4. 调度已排上：
       systemctl list-timers wechat-pipeline-scheduler.timer

  5. 优雅退出（SIGTERM 后应立刻退出，不会拖满 20 秒）：
       systemctl restart wechat-pipeline && journalctl -u wechat-pipeline -n 20

  6. 日志在轮转：
       sudo logrotate -d /etc/logrotate.d/wechat-pipeline

⚠️ 上线前必做（本轮代码未解决）：
  · /api/* 目前**裸奔**，必须配 Nginx basic auth 或限制来源 IP
    （conf 里已写好注释样板，取消注释即可）
  · APP_SECRET_KEY 一旦有数据就永远不能改
  · 微信服务器 IP 白名单要加上本机公网出口 IP，否则报 40164
EOF
