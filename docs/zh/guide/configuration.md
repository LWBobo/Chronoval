# 配置项说明

无论是使用 Docker 还是 Docker Compose (.env) 方式部署，均通过环境变量进行配置。

## 环境变量列表

| 环境变量                                 | 说明                                                 | 默认值                                | 必需                                                                  |
| ---------------------------------------- | ---------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------- |
| CFRAME_ADMIN_EMAIL                       | 初始管理员用户的邮箱                                 | `admin@chronoframe.com`               | 是                                                                    |
| CFRAME_ADMIN_NAME                        | 初始管理员用户的用户名                               | `Chronoframe`                         | 否                                                                    |
| CFRAME_ADMIN_PASSWORD                    | 初始管理员用户的密码                                 | `CF1234@!`                            | 否                                                                    |
| NUXT_PUBLIC_APP_TITLE                    | 应用标题                                             | `Chronoval`                         | 否                                                                    |
| NUXT_PUBLIC_APP_SLOGAN                   | 应用口号                                             | 无                                    | 否                                                                    |
| NUXT_PUBLIC_APP_AUTHOR                   | 应用作者                                             | 无                                    | 否                                                                    |
| NUXT_PUBLIC_APP_AVATAR_URL               | 应用头像 URL                                         | 无                                    | 否                                                                    |
| NUXT_PUBLIC_COLOR_MODE_PREFERENCE        | 颜色模式偏好，可选 `light`、`dark`、`system`         | system                                | 否                                                                    |
| NUXT_PUBLIC_MAP_PROVIDER                 | 地图提供者，可选 `mapbox`、`maplibre`                | `maplibre`                            | 否                                                                    |
| NUXT_PUBLIC_MAPBOX_ACCESS_TOKEN          | Mapbox 访问令牌(可限制 URL)，用于地图服务            | 无                                    | 当 `NUXT_PUBLIC_MAP_PROVIDER` 为 `mapbox` 时必需                      |
| NUXT_NOMINATIM_BASE_URL                  | Nominatim 反向地理编码服务的基础 URL                 | `https://nominatim.openstreetmap.org` | 否                                                                    |
| NUXT_MAPBOX_ACCESS_TOKEN                 | Mapbox 访问令牌(无 URL 限制)，用于位置信息服务       | 无                                    | 否                                                                    |
| NUXT_STORAGE_PROVIDER                    | 存储提供者，支持 `local`、`s3`、`openlist`           | `local`                               | 是                                                                    |
| NUXT_PROVIDER_LOCAL_PATH                 | 本地存储路径（上传落 photos/、全量缩略图统一落 thumbnails/） | `/app/storage`                   | 否                                                                    |
| NUXT_PROVIDER_LOCAL_BASE_URL             | 本地存储的访问 URL                                   | `/storage`                            | 否                                                                    |
| NUXT_PROVIDER_LOCAL_PREFIX               | 本地存储子目录前缀                                   | `photos/`                             | 否                                                                    |
| LIBRARY_ENABLED                          | 是否启用自动扫描（对外部扫描库生效）                 | `true`                                | 否                                                                    |
| LIBRARY_SCAN_INTERVAL_MS                 | 外部扫描库自动重扫间隔（毫秒）                       | `300000`（5 分钟）                    | 否                                                                    |
| PIPELINE_COMPLETED_RETENTION_DAYS        | 已完成队列任务保留天数；失败任务不自动删除，`0` 表示关闭自动清理 | `30`                         | 否                                                                    |
| NUXT_PROVIDER_S3_ENDPOINT                | S3 兼容存储服务的 Endpoint                           | 无                                    | 当 `NUXT_STORAGE_PROVIDER` 为 `s3` 时必需                             |
| NUXT_PROVIDER_S3_BUCKET                  | S3 存储桶名称                                        | `chronoframe`                         | 当 `NUXT_STORAGE_PROVIDER` 为 `s3` 时必需                             |
| NUXT_PROVIDER_S3_REGION                  | S3 存储桶区域                                        | `auto`                                | 当 `NUXT_STORAGE_PROVIDER` 为 `s3` 时必需                             |
| NUXT_PROVIDER_S3_ACCESS_KEY_ID           | S3 访问密钥 ID                                       | 无                                    | 当 `NUXT_STORAGE_PROVIDER` 为 `s3` 时必需                             |
| NUXT_PROVIDER_S3_SECRET_ACCESS_KEY       | S3 访问密钥                                          | 无                                    | 当 `NUXT_STORAGE_PROVIDER` 为 `s3` 时必需                             |
| NUXT_PROVIDER_S3_PREFIX                  | S3 存储前缀                                          | `photos/`                             | 否                                                                    |
| NUXT_PROVIDER_S3_CDN_URL                 | S3 存储的 CDN 地址                                   | 无                                    | 否                                                                    |
| NUXT_PROVIDER_OPENLIST_BASE_URL          | OpenList 服务器 URL                                  | 无                                    | 当 `NUXT_STORAGE_PROVIDER` 为 `openlist` 时必需                       |
| NUXT_PROVIDER_OPENLIST_ROOT_PATH         | OpenList 根路径                                      | 无                                    | 当 `NUXT_STORAGE_PROVIDER` 为 `openlist` 时必需                       |
| NUXT_PROVIDER_OPENLIST_TOKEN             | OpenList API 令牌                                    | 无                                    | 当 `NUXT_STORAGE_PROVIDER` 为 `openlist` 时必需（用于 OpenList 认证） |
| NUXT_PROVIDER_OPENLIST_ENDPOINT_UPLOAD   | OpenList 上传端点                                    | `/api/fs/put`                         | 否                                                                    |
| NUXT_PROVIDER_OPENLIST_ENDPOINT_DOWNLOAD | OpenList 下载端点                                    | 无                                    | 否                                                                    |
| NUXT_PROVIDER_OPENLIST_ENDPOINT_LIST     | OpenList 列表端点                                    | 无                                    | 否                                                                    |
| NUXT_PROVIDER_OPENLIST_ENDPOINT_DELETE   | OpenList 删除端点                                    | `/api/fs/remove`                      | 否                                                                    |
| NUXT_PROVIDER_OPENLIST_ENDPOINT_META     | OpenList 元数据端点                                  | `/api/fs/get`                         | 否                                                                    |
| NUXT_PROVIDER_OPENLIST_PATH_FIELD        | OpenList 路径字段名                                  | `path`                                | 否                                                                    |
| NUXT_PROVIDER_OPENLIST_CDN_URL           | OpenList CDN 地址                                    | 无                                    | 否                                                                    |
| NUXT_PUBLIC_OAUTH_GITHUB_ENABLED         | 是否启用 GitHub OAuth 登录                           | `false`                               | 否                                                                    |
| NUXT_OAUTH_GITHUB_CLIENT_ID              | GitHub OAuth 应用的 Client ID                        | 无                                    | 否(可选,用于 GitHub 登录)                                             |
| NUXT_OAUTH_GITHUB_CLIENT_SECRET          | GitHub OAuth 应用的 Client Secret                    | 无                                    | 否(可选,用于 GitHub 登录)                                             |
| NUXT_SESSION_PASSWORD                    | 用于加密会话的密码，32 位随机字符串                  | 无                                    | 是                                                                    |
| NUXT_PUBLIC_GTAG_ID                      | Google Analytics 追踪 ID                             | 无                                    | 否                                                                    |
| NUXT_PUBLIC_ANALYTICS_MATOMO_ENABLED     | 是否启用 Matomo 分析追踪                             | `false`                               | 否                                                                    |
| NUXT_PUBLIC_ANALYTICS_MATOMO_URL         | Matomo 实例 URL 地址(如: https://matomo.example.com) | 无                                    | 否(启用 Matomo 时必需)                                                |
| NUXT_PUBLIC_ANALYTICS_MATOMO_SITE_ID     | Matomo 站点 ID                                       | 无                                    | 否(启用 Matomo 时必需)                                                |
| NUXT_UPLOAD_MIME_WHITELIST_ENABLED       | 是否启用上传文件 MIME 类型白名单验证                 | `true`                                | 否                                                                    |
| NUXT_UPLOAD_MIME_WHITELIST               | 上传文件允许的 MIME 类型列表（逗号分隔）             | 见下方说明                            | 否                                                                    |
| ALLOW_INSECURE_COOKIE                    | 是否允许非安全 Cookie（仅在开发环境使用）            | `false`                               | 否                                                                    |
| CHRONOVAL_ML_URL                         | 机器学习侧车根地址                                   | `http://127.0.0.1:3003`               | 否                                                                    |
| ML_NIGHTLY_INTERVAL_MS                   | 人物聚合夜间扫描间隔                                 | `86400000`（24 小时）                 | 否                                                                    |
| ML_NIGHTLY_INITIAL_DELAY_MS              | 首次人物聚合扫描延迟                                 | `300000`（5 分钟）                    | 否                                                                    |
| CHRONOVAL_PMTILES_CACHE_MEM_MB           | `/map/pmtiles` Range 内存 LRU 上限（MB）             | `256`                                 | 否                                                                    |
| CHRONOVAL_PMTILES_CACHE_DISK_MB          | Range 磁盘缓存上限（MB；`0` 关闭）                   | `2048`                                | 否                                                                    |
| CHRONOVAL_PMTILES_CACHE_IDLE_MS          | 空闲多久后清空内存并清理磁盘缓存（毫秒）             | `600000`（10 分钟）                   | 否                                                                    |

智能搜图、人物与 OCR 见 [机器学习](/zh/guide/ml)。

## 上传文件类型白名单

`NUXT_UPLOAD_MIME_WHITELIST` 的默认值包含以下 MIME 类型：

- `image/jpeg` - JPEG 图片
- `image/png` - PNG 图片
- `image/webp` - WebP 图片
- `image/gif` - GIF 图片
- `image/bmp` - BMP 图片
- `image/tiff` - TIFF 图片
- `image/heic` - HEIC 图片（Apple）
- `image/heif` - HEIF 图片
- `video/quicktime` - QuickTime 视频（MOV）
- `video/mp4` - MP4 视频

如需自定义白名单，请使用逗号分隔的 MIME 类型字符串，例如：

```
NUXT_UPLOAD_MIME_WHITELIST=image/jpeg,image/png,video/mp4
```

如需禁用白名单验证（允许任何文件类型），可设置：

```
NUXT_UPLOAD_MIME_WHITELIST_ENABLED=false
```

## 小带宽时间线地图

时间线工具栏提供“自动 / 省流 / 流畅”三种网络模式。自动模式会参考浏览器的省流设置、有效网络类型、估算下行带宽和往返延迟；无法检测网络时默认采用省流模式。用户的选择保存在当前浏览器中。

省流模式会限制自动播放的落地缩放级别、关闭跨缩放级别瓦片预取，并在远距离地点之间使用一次地图跳转，避免下载移动路径沿途短暂出现的瓦片。PMTiles Range 数据会在浏览器 Cache Storage 中保留最多约 64 MB，重复访问同一路线时优先读取本地缓存。

设置页的“时间线 PMTiles 文件”可以填写一个位于 `/app/map` 的轻量地图档案，例如 `timeline-lite.pmtiles`。配置后，省流模式优先使用该档案；留空时继续使用主 PMTiles。轻量档案建议只保留 0–10 级的陆地、水域、行政边界、主要道路和地点名称。

地图 Marker 使用独立的 96/256px WebP 缩略图。生成结果缓存在 `/app/data/map-thumbnail-cache/v1`，不需要新增 Docker 挂载。

### Nginx Proxy Manager

在 Proxy Host 中启用 HTTP/2 与 Websockets Support，并在 Advanced 中加入以下配置。Nitro 对 PMTiles Range 响应发送 `X-Accel-Buffering: no`，Nginx Proxy Manager 会立即转发小范围数据，避免先写入代理临时文件。

```nginx
gzip on;
gzip_vary on;
gzip_proxied any;
gzip_comp_level 5;
gzip_min_length 1024;
gzip_types
  text/plain
  text/css
  text/xml
  application/json
  application/javascript
  application/xml
  application/manifest+json
  image/svg+xml;
```

启用 Websockets Support 后，Nginx Proxy Manager 会自动生成 `proxy_http_version 1.1;`，不要在 Advanced 中重复添加，否则该 Proxy Host 会因指令重复而显示 Offline。PMTiles 接口已经通过 `X-Accel-Buffering: no` 单独关闭响应缓冲，因此也不需要在整个 Proxy Host 上设置 `proxy_request_buffering` 或 `proxy_max_temp_file_size`。

不要为 `/map/pmtiles` 配置忽略 `Range` 请求头的普通整文件缓存。该接口必须将浏览器的 `Range` 请求原样转发，并保留上游返回的 `206`、`Content-Range`、`Content-Length`、`ETag` 和 `Accept-Ranges` 响应头。
