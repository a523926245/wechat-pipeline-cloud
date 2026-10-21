# 部署

把云端版装到一台 Linux 服务器上。默认按 **Debian/Ubuntu** 写，RHEL/CentOS 差异见文末表格。

```
安装位置        /opt/wechat-pipeline-cloud
环境变量        /etc/wechat-pipeline-cloud/app.env   （权限 600）
运行用户        wpc（system 账号，无登录 shell）
监听            127.0.0.1:8787（只听本机，由 Nginx 对外）
日志            /opt/wechat-pipeline-cloud/var/logs/app-YYYY-MM-DD.log
内容            /opt/wechat-pipeline-cloud/var/content/{articles,covers,comics}
```

---

## 一、一键部署（推荐）

```bash
sudo bash /opt/wechat-pipeline-cloud/deploy/install.sh     # 已在本机时
sudo bash deploy/install.sh                                # 在仓库里时
```

可选参数：`--skip-build`（dist 已就绪）、`--skip-nginx`（只装后端）、`--skip-systemd`（容器内跑）。
脚本每一步都会先打印 STEP 说明、再打印等价的手工命令，任一步失败都能照着打印内容接着做。
**第 7 步（数据库结构）默认会停下来让你选**，不会替你做不可逆的决定——见下文「三、迁移基线」。

---

## 二、手工部署（想逐条自己来）

```bash
# 1. Node >= 22.6（--experimental-strip-types 的硬要求，package.json 的 engines 写 >=20 是错的）
node -v

# 2. 建用户与目录
sudo useradd --system --home /opt/wechat-pipeline-cloud --shell /usr/sbin/nologin wpc
sudo mkdir -p /etc/wechat-pipeline-cloud \
              /opt/wechat-pipeline-cloud/var/logs \
              /opt/wechat-pipeline-cloud/var/content/articles \
              /opt/wechat-pipeline-cloud/var/content/covers \
              /opt/wechat-pipeline-cloud/var/content/comics

# 3. 同步代码（排除 node_modules / .git / 日志）
sudo rsync -a --exclude node_modules --exclude .git --exclude var/logs ./ /opt/wechat-pipeline-cloud/

# 4. 装依赖
cd /opt/wechat-pipeline-cloud/server && sudo npm ci --omit=dev
cd /opt/wechat-pipeline-cloud/web    && sudo npm ci

# 5. 构建前端（必须 npm run build：内置 --max-old-space-size=8192，裸 vite build 会 OOM）
cd /opt/wechat-pipeline-cloud/web && sudo npm run build
ls web/dist/index.html     # 必须有

# 6. 环境变量
sudo cp /opt/wechat-pipeline-cloud/deploy/app.env.example /etc/wechat-pipeline-cloud/app.env
sudo chmod 600 /etc/wechat-pipeline-cloud/app.env
sudo vi /etc/wechat-pipeline-cloud/app.env     # 至少改 DATABASE_URL 与 APP_SECRET_KEY
# 主密钥：openssl rand -base64 32

# 7. Prisma 客户端（只跑 generate，绝不要在这台机器上跑 sqlite 系列脚本）
cd /opt/wechat-pipeline-cloud/server && sudo npm run prisma:generate

# 8. 数据库结构 —— 见下一节，这里最容易踩坑

# 9. systemd
sudo cp /opt/wechat-pipeline-cloud/deploy/systemd/*.service \
        /opt/wechat-pipeline-cloud/deploy/systemd/*.timer /etc/systemd/system/
#   node 不在 /usr/bin/node（nvm 常见）时必须改 ExecStart：
sudo sed -i "s#ExecStart=/usr/bin/node#ExecStart=$(command -v node)#" \
        /etc/systemd/system/wechat-pipeline*.service
sudo chown -R wpc:wpc /opt/wechat-pipeline-cloud/var
sudo systemctl daemon-reload
sudo systemctl enable --now wechat-pipeline

# 10. 调度定时器
sudo systemctl enable --now wechat-pipeline-scheduler.timer

# 11. Nginx + 日志轮转
sudo ln -sf /opt/wechat-pipeline-cloud/deploy/nginx/wechat-pipeline.conf \
            /etc/nginx/sites-enabled/wechat-pipeline.conf
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx          # -t 不过绝不 reload
sudo cp /opt/wechat-pipeline-cloud/deploy/logrotate/wechat-pipeline /etc/logrotate.d/
```

---

## 三、迁移基线（第 8 步，必读）

仓库里**没有 `prisma/migrations`**，所以 `npm run prisma:deploy` 第一次必失败。建一次基线：

```bash
cd /opt/wechat-pipeline-cloud/server
mkdir -p prisma/migrations/0_init
npx prisma migrate diff --from-empty \
    --to-schema-datasource prisma/schema.prisma --script \
    > prisma/migrations/0_init/migration.sql
npx prisma migrate deploy
```

如果库里已经有结构（比如先用 `db push` 建过），用 `npx prisma migrate resolve --applied 0_init`
把它标记为已应用，否则 deploy 会重复执行建表语句。

> `install.sh` 第 7 步检测到无迁移目录时会中断并打印上面这组命令。
> 强行跳过请用 `ALLOW_DB_PUSH=1`（走 `prisma db push`，**不产生迁移文件、无法回滚**）。

**改了 `prisma/schema.prisma` 之后**（例如本轮新增的 `Article.coverMediaId` / `coverUploaded`），
必须再建一个迁移：
```bash
npx prisma migrate dev --name add_cover_media_id
```

---

## 四、调度：Timer 还是常驻

| 方案 | 单元 | 适用 |
|---|---|---|
| **systemd Timer（默认）** | `wechat-pipeline-scheduler.timer` `.service` | 每天固定时刻跑一次。省资源；`Persistent=true` 关机错过会补跑；进程不存在也就不会漏跑 |
| 常驻守护 | `npm run scheduler` | 需要 60 秒心跳、到点即推的场景。要多写一个 `Restart=always` 的 service，本仓库未提供 |

Timer 改时间只改一行：`OnCalendar=*-*-* 06:05`。
`RandomizedDelaySec=180` 是故意的——避免多台机器同时打微信接口被限流。

---

## 五、上线前置项（本轮代码**没有**解决，必须人工处理）

| # | 项 | 说明 |
|---|---|---|
| 1 | **`/api/*` 裸奔** | 全仓零鉴权：`ADMIN_PASSWORD` / `JWT_SECRET` 定义了但没有引用，CORS 全开。任何人都能读凭据掩码、改模型、推草稿。**必须**配 Nginx basic auth 或限制来源 IP——`nginx/wechat-pipeline.conf` 里已写好可抄的注释样板 |
| 2 | **`APP_SECRET_KEY` 不可变** | 一旦有凭据写入就永远不能改，改了所有已存 AppSecret 都解不开。改前先备份 |
| 3 | **`/api/health` 会撒谎** | DB 挂了它仍返回 200，只把 `ok:false` 放在 body 里。Nginx/Docker 探活别只看状态码 |
| 4 | **日志目录硬编码** | `logger.ts` 写死 `<项目根>/var/logs`，不读环境变量。必须保证 `wpc` 对该目录可写，并装 logrotate |
| 5 | **logrotate 必须 copytruncate** | pino 持有 fd 且不响应 SIGHUP，默认的 create 方案会让日志继续写进已改名文件 |
| 6 | **`engines.node` 写错了** | 写的是 `>=20`，实际需要 `>=22.6` |
| 7 | **微信 IP 白名单** | 服务器公网出口 IP 必须加进公众号后台白名单，否则所有接口报 40164（代码对该码不重试） |
| 8 | **数据库备份** | 至少每天一次 `mysqldump`；`APP_SECRET_KEY` 与备份要分开存放 |
| 9 | **helmet 默认 CSP** | `app.ts` 用了 helmet。若 Element Plus 的内联样式/图标异常，先怀疑 CSP，可临时关掉定位 |
| 10 | **`DATABASE_URL` 有默认值陷阱** | 不设就静默连 SQLite，会出现「跑起来了但连的是本地文件」的假象。**验收第一条就是确认 `driver` 是 `mysql`** |

---

## 六、验收清单

```bash
# 1. 活着，且连的是 MySQL
curl -s http://127.0.0.1:8787/api/health | head -c 300
#    driver 必须是 mysql

# 2. SPA 首页与深链刷新（try_files 生效）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1/
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1/articles/1
#    两条都要 200；第二条 404 = Nginx fallback 没配

# 3. /api/content 静态可达（封面）
curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1/api/content/covers/<文件名>.png'
#    404 说明 Nginx 把 /api/content 的路径 rewrite 掉了（proxy_pass 不能带 URI 尾缀）

# 4. 调度已排上
systemctl list-timers wechat-pipeline-scheduler.timer

# 5. 优雅退出
systemctl restart wechat-pipeline && journalctl -u wechat-pipeline -n 20

# 6. 日志轮转可跑
sudo logrotate -d /etc/logrotate.d/wechat-pipeline

# 7. 长缓存生效（带 hash 的 assets 应返回 Cache-Control: public, immutable）
curl -sI http://127.0.0.1/assets/$(ls web/dist/assets | head -1) | grep -i cache-control
```

---

## 七、排障速查

| 现象 | 原因 |
|---|---|
| `systemctl start` 立刻失败，`status=203/EXEC` | `ExecStart` 的 node 路径不对（systemd 不读 login shell 的 PATH）。`which node` 后 `sed -i` 改 |
| 服务起不来，日志说 `APP_SECRET_KEY 必须…` | app.env 没被读到。检查 `EnvironmentFile` 路径、文件权限、以及值**是否带了引号**（systemd 不剥引号） |
| 界面 500，日志 `Expected String`（Json 字段） | 在生产机上跑过 `schema:sqlite` / `sqlite:generate`，SQLite 版客户端覆盖了生成目录。重跑 `npm run prisma:generate` |
| 前端能看封面缩略图，推到微信没封面 | 两个可能：① 库里 `coverPath` 是旧机器的绝对路径 → 跑 `npm run fix:cover-paths -- --apply`；② Nginx 把 `/api/content` 路径 rewrite 了 |
| 每次推送都往永久素材库传一张新图 | 老版本行为。新代码会回填 `coverMediaId` 并复用；若仍复现，检查 `Article.coverUploaded` 是否有值 |
| 生图/写作接口 504 | Nginx `proxy_read_timeout`（330s）小于后端 `LLM_TIMEOUT_MS`（300s）时就会掐断。两者要一起调 |
| 重跑迁移后文章整表翻倍 | 库里还是旧幂等键（含数组下标）。跑 `npm run fix:article-idem -- --apply`，并确认输出「剩余旧键 0」 |

---

## 八、RHEL / CentOS 差异

| 项 | Debian/Ubuntu | RHEL/CentOS |
|---|---|---|
| 装包 | `apt install -y nginx` | `dnf install -y nginx`（或 `yum`） |
| 站点目录 | `/etc/nginx/sites-available` + `sites-enabled` | 无 `sites-*`，直接放 `/etc/nginx/conf.d/wechat-pipeline.conf`（主配置已 include） |
| 建库 | `apt install -y mariadb-server` | `dnf install -y mysql-server` |
| SELinux | 无 | 反代会被拦：`setsebool -P httpd_can_network_connect 1`；或 `audit2allow` 生成策略 |
| 防火墙 | `ufw allow 80/tcp` | `firewall-cmd --permanent --add-service=http && firewall-cmd --reload` |
| htpasswd | `apt install -y apache2-utils` | `dnf install -y httpd-tools` |
| Node | nodesource 的 `setup_22.x` | 同上，或 `dnf module enable nodejs:22` |
| 日志轮转 | `/etc/logrotate.d/` | 相同 |

`install.sh` 里写死的 `sites-enabled` 路径在 RHEL 上要手动改一处；其余步骤通用。

---

## 九、回滚

```bash
sudo systemctl stop wechat-pipeline
# 代码：重新 rsync 旧版本（或 git checkout 上一个 tag）
cd /opt/wechat-pipeline-cloud/server && npx prisma migrate deploy   # 结构只向前，需另建 down 迁移
sudo systemctl start wechat-pipeline
```

数据库结构没有自动回滚：`prisma migrate` 不做 down。要回滚结构得手写迁移 SQL。
所以**结构变更前先备份**。
