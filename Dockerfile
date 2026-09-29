# syntax=docker/dockerfile:1
FROM node:24.16.0-alpine3.22 AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

# Corepack 走 npmmirror，避免构建机访问不到 registry.npmjs.org
# 需要官方源时：docker build --build-arg NPM_REGISTRY=https://registry.npmjs.org .
ARG NPM_REGISTRY=https://registry.npmmirror.com
ENV COREPACK_NPM_REGISTRY=${NPM_REGISTRY}
ENV npm_config_registry=${NPM_REGISTRY}

# better-sqlite3 预编译二进制走 npmmirror，避免访问 GitHub Releases 超时
# 环境变量名遵循 prebuild-install 约定：${package_name}_binary_host_mirror
ENV npm_config_better_sqlite3_binary_host_mirror=https://registry.npmmirror.com/-/binary/better-sqlite3/

# 构建容器默认网卡连不上外网，下载步骤改走宿主机网络
RUN --network=host corepack enable && corepack prepare pnpm@10.34.1 --activate

FROM base AS deps
WORKDIR /usr/src/app

# node-gyp 编译工具链：better-sqlite3 预编译下载失败时回退到源码编译
RUN --network=host apk add --no-cache python3 make g++

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/webgl-image/package.json ./packages/webgl-image/
RUN --network=host --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /usr/src/app
COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY --from=deps /usr/src/app/packages/webgl-image/node_modules ./packages/webgl-image/node_modules
COPY . .
RUN NODE_OPTIONS="--max-old-space-size=4096" pnpm run build:deps
RUN NODE_OPTIONS="--max-old-space-size=8192" pnpm run build
RUN find ./.output -type f -name '*.map' -delete

FROM node:24.16.0-alpine3.22 AS runtime_deps
# Alpine 官方 CDN 在部分网络会返回 temporary error / Permission denied
# 默认换成阿里云镜像，可用 --build-arg ALPINE_MIRROR=https://dl-cdn.alpinelinux.org 改回
ARG ALPINE_MIRROR=https://mirrors.aliyun.com
RUN --network=host sed -i "s#https://dl-cdn.alpinelinux.org#${ALPINE_MIRROR}#g" /etc/apk/repositories \
	&& apk add --no-cache --timeout 60 ca-certificates perl exiftool ffmpeg \
	&& install -Dm755 "$(readlink -f /usr/bin/perl)" /opt/runtime-bin/perl \
	&& install -Dm755 "$(readlink -f /usr/bin/env)" /opt/runtime-bin/env \
	&& install -Dm755 "$(readlink -f /usr/bin/exiftool)" /opt/runtime-bin/exiftool \
	&& install -Dm755 "$(readlink -f /usr/bin/ffmpeg)" /opt/runtime-bin/ffmpeg \
	&& install -Dm755 "$(readlink -f /usr/bin/ffprobe)" /opt/runtime-bin/ffprobe \
	&& mkdir -p /opt/runtime-bin/appdirs/data

FROM scratch AS runtime
WORKDIR /app

COPY --from=runtime_deps /opt/runtime-bin/appdirs/data /app/data

COPY --from=runtime_deps /usr/local/bin/node /usr/bin/node
COPY --from=runtime_deps /opt/runtime-bin/perl /usr/bin/perl
COPY --from=runtime_deps /opt/runtime-bin/env /usr/bin/env
COPY --from=runtime_deps /opt/runtime-bin/exiftool /usr/bin/exiftool
COPY --from=runtime_deps /usr/lib /usr/lib
COPY --from=runtime_deps /usr/share /usr/share
COPY --from=runtime_deps /lib /lib
COPY --from=runtime_deps /etc/ssl /etc/ssl

COPY --from=build /usr/src/app/.output ./.output
COPY --from=build /usr/src/app/server/database/migrations ./server/database/migrations

EXPOSE 3000
VOLUME ["/app/data"]

ENV NODE_ENV=production
ENV NITRO_PORT=3000
ENV NITRO_HOST=0.0.0.0
ENV DATABASE_URL=./data/app.sqlite3
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
ENV EXIFTOOL_PATH=/usr/bin/exiftool
ENV FFMPEG_PATH=/usr/bin/ffmpeg
ENV FFPROBE_PATH=/usr/bin/ffprobe
ENV NUXT_STORAGE_PROVIDER=local
ENV NUXT_PROVIDER_LOCAL_PATH=/app/storage
ENV NUXT_PROVIDER_LOCAL_BASE_URL=/storage
ENV NUXT_PROVIDER_LOCAL_PREFIX=photos/
ENV LIBRARY_ENABLED=true
ENV LIBRARY_SCAN_INTERVAL_MS=300000

CMD ["/usr/bin/node", ".output/server/index.mjs"]