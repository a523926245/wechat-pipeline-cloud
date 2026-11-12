# syntax=docker/dockerfile:1

# ── 前端构建 ──
FROM node:22-slim AS web-build
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ── 后端依赖 + Prisma client ──
FROM node:22-slim AS server-deps
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
# prisma CLI 在 devDependencies，client 生成阶段需要全量安装
RUN npm ci
COPY server/prisma/schema.prisma ./prisma/schema.prisma
RUN npx prisma generate

# ── 运行镜像 ──
FROM node:22-slim
ENV NODE_ENV=production \
    PORT=8787 \
    LANG=C.UTF-8
WORKDIR /app

# server：源码 + 依赖（含生成好的 client）
COPY --from=server-deps /app/server/node_modules ./server/node_modules
COPY server/ ./server/

# web：静态构建产物（单容器部署时可由反代或 express.static 托管）
COPY --from=web-build /app/web/dist ./web/dist

COPY config/ ./config/
COPY deploy/app.env.example ./deploy/app.env.example

EXPOSE 8787
WORKDIR /app/server
CMD ["node", "--experimental-strip-types", "src/index.ts"]
