# Node 24.22.2 on Alpine. V8 的优化编译器在给超大 JSON（图标集）生成
# sourcemap 时会崩（!IsFreeSpaceOrFillerMap）。关掉 Turbofan/Maglev。
# 活堆超过 4096MB。
FROM node:24.22.2-alpine AS base
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

# node-gyp 直接使用官方 Node 镜像自带的头文件，避免源码编译时联网下载
ENV npm_config_nodedir=/usr/local

# 构建容器默认网卡连不上外网，下载步骤改走宿主机网络
RUN --network=host corepack enable && corepack prepare pnpm@10.34.1 --activate

FROM base AS deps
WORKDIR /usr/src/app

# node-gyp 编译工具链：better-sqlite3 预编译下载失败时回退到源码编译
RUN --network=host \
    sed -i 's#https://dl-cdn.alpinelinux.org#https://mirrors.aliyun.com#g' /etc/apk/repositories \
    && apk add --no-cache --timeout 60 python3 make g++

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/webgl-image/package.json ./packages/webgl-image/
# 与 Debian 构建分开，避免把 glibc 的可选原生包拿来在 musl 上用。
RUN --network=host --mount=type=cache,id=pnpm-musl,target=/pnpm/store \
    pnpm install --frozen-lockfile

FROM deps AS build
WORKDIR /usr/src/app
# Node old-space limits in MiB, per process (not a total container memory cap).
ARG BUILD_DEPS_HEAP=4096
ARG BUILD_HEAP=6144
# Inherit the native dependencies and the system libraries they were built with.
COPY . .
# Call both CLIs directly so native crashes retain their actual exit status.
RUN cd packages/webgl-image && NODE_OPTIONS="--max-old-space-size=${BUILD_DEPS_HEAP}" \
    node ./node_modules/vite/bin/vite.js build
# --no-turbofan/--no-maglev are not allowed in NODE_OPTIONS.
RUN node --max-old-space-size=${BUILD_HEAP} --no-turbofan --no-maglev \
    ./node_modules/nuxt/bin/nuxt.mjs build
RUN find ./.output -type f -name '*.map' -delete

FROM node:24.22.2-alpine AS runtime_deps
ARG ALPINE_MIRROR=https://mirrors.aliyun.com
RUN --network=host sed -i "s#https://dl-cdn.alpinelinux.org#${ALPINE_MIRROR}#g" /etc/apk/repositories \
	&& apk add --no-cache --timeout 60 ca-certificates perl exiftool ffmpeg

# Keep the complete runtime filesystem: media tools, their shared libraries,
# Perl modules, and the shell utilities used by systeminformation.
# The runtime_deps stage can still be replaced with a prebuilt dependency image.
FROM runtime_deps AS runtime
WORKDIR /app
RUN mkdir -p /app/data

COPY --from=build /usr/src/app/.output ./.output
COPY --from=build /usr/src/app/server/database/migrations ./server/database/migrations
# 地名种子：只读打进镜像；启动时按需写入挂载卷上的 SQLite（不把 DB 打进镜像）
COPY data/map_info/geocode_places_90000.csv ./server/assets/geocode/geocode_places.csv
COPY server/assets/geocode/seed.json ./server/assets/geocode/seed.json

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

# Catch missing dynamically loaded packages, native binaries and media tools at
# image build time. This check uses temporary fixtures and an in-memory database.
COPY scripts/verify-runtime-dependencies.mjs ./.output/server/verify-runtime-dependencies.mjs
RUN --network=none /usr/local/bin/node ./.output/server/verify-runtime-dependencies.mjs

CMD ["/usr/local/bin/node", ".output/server/index.mjs"]
