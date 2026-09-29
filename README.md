<p align="center">
  <img src="docs/public/logo.png" width="90" alt="Chronoval">
</p>

<h1 align="center">Chronoval</h1>

<p align="center">
  自托管的个人摄影画廊 · 一个容器同时提供页面与 API
</p>

<p align="center">
  <img alt="Nuxt" src="https://img.shields.io/badge/Nuxt-4-00DC82">
  <img alt="Vue" src="https://img.shields.io/badge/Vue-3-42b883">
  <img alt="Docker" src="https://img.shields.io/badge/Docker-%E2%9C%93-2496ED">
  <img alt="SQLite" src="https://img.shields.io/badge/SQLite-%E2%9C%93-003B57">
  <img alt="version" src="https://img.shields.io/badge/Version-v1.0.0.5-green">
  <img alt="license" src="https://img.shields.io/badge/License-MIT-blue">
</p>

照片 / 视频上传即展示，放入外部扫描库即被自动识别；WebGL 高清查看、Exif 信息、地图浏览、分享链接，管理后台一键搞定。内置音乐盒与相簿 BGM，多音源切换框架已就位。

## 特性

**存储与安全**

- 🔐 **上传加密**：后台上传的照片以加密形式存储为 blob，未授权无法直接读取原图，支持缩略图遮罩预览
- 📁 **本地目录即存储（外部库引用）**：照片/视频目录只读挂载即可，文件原样留在你的目录里，放进即自动识别、生成缩略图，绝不改写、更不搬移
- 🗂️ **文件夹即相簿**：外部库下的每个文件夹自动汇聚成一个相簿（含任意层级子相簿），目录即相簿，无需手动整理
- 🔓 **库级免密解锁**：扫描相簿任一次输对密码即签发库级 Cookie，本次会话内整个扫描库（含全部子相簿）免密浏览，无需逐相簿重复输入

**查看与浏览**

- 🧭 **360° 全景查看**：支持全景照片的 360 自由视角浏览（`PanoramaViewer`）
- 🖼️ **WebGL 高性能查看器**：高清缩放、平移、雾面过渡，多机位
- 🏷️ **Exif 信息**：相机参数、拍摄时间、地理位置展示
- 🎬 **Live/Motion Photo 播放**：Apple Live Photo（图片 + MOV 自动配对）与 Google Motion Photo 自动识别，查看器长按即播放实况视频，移动端触觉反馈、捏合缩放自动停止，视口内自动预加载
- ▶️ **视频播放与缩略图**：独立视频在相册中直接内联播放（原生控制条），卡片自动生成封面缩略图——服务端 ffmpeg 抽帧生成 poster，缺失或失败时前端浏览器抽帧兜底，播放即显示、无需等待转码
- 🗺️ **地图浏览**：MapLibre / Mapbox 聚合拍摄位置，反向地理编码识别城市
- 🧩 **多格式支持**：
  - 图片：JPEG / PNG / WebP / GIF / BMP / TIFF / AVIF / HEIC / HEIF / SVG
  - 相机 RAW：CR2 / CR3 / CRW / NEF / NRW / ARW / SRF / SR2 / RAF / ORF / RW2 / PEF / DNG / SRW / X3F / DCR / KDC / IIQ / 3FR / ERF / MRW（服务端提取内嵌 JPEG 预览，放 RAW 即自动识别）
  - 视频：MP4 / MOV / M4V / MKV / WebM / AVI / MTS / M2TS

**音乐与音频**

- 🎵 **音乐盒**：上传音乐即播，黑胶碟片旋转 + 唱臂摆放下压的拟真播放器；点击碟片切换全屏歌词模式（LRC 逐句高亮、自动滚动），再点返回碟片；收起后变为底部迷你播放条
- 🎶 **相簿 BGM**：相簿管理开启后，相簿左侧中部显示半透明音乐图标，可按住拖到屏幕任意位置；点击展开迷你播放器（碟片 + 标题 + 进度条），音源取自音乐盒
- 🔄 **多音源切换框架**：默认本地音源，酷狗音乐 / 网易云音乐 / QQ 音乐（均支持手机号登录）已预留接入框架，即将上线

**分享与协作**

- 📤 **分享链接**：公开链接 / 嵌入代码 / 原生 Web Share / 下载原图
- ❤️ **反应互动**：照片 Reactions（点赞/表情）可视化

**管理后台**

- 🗂️ **相册管理**：创建、排序、封面；主/子相簿统一编辑；上传队列实时进度
- 📊 **系统监控**：实时日志、健康状态、日历热图
- 🗑️ **回收站**：删除照片可恢复

## 快速开始

镜像已构建并发布到 GHCR，几行命令即可启动：

```bash
git clone https://github.com/XiaoMengr/Chronoval.git && cd Chronoval

cp .env.example .env
mkdir -p data/library   # 外部扫描库（界面添加后放图即自动识别）
docker compose up -d

# 打开 http://localhost:3000，按向导设置管理员
# 之后在「扫描库」里添加一个外部目录（如 /app/library）即可放图自动识别；
# 上传照片则实时落入 /app/storage，上传即显示、无需扫描。
```

## 文档

| 文档 | 说明 |
| --- | --- |
| [一分钟启动](docs/quickstart-deploy.md) | 极简 3 步部署 |
| [部署指南](docs/deployment.md) | Docker / 镜像 / 目录映射 / 备份 |
| [快速上手](docs/guide/getting-started.md) | 安装 / 配置 / 升级 |
| [配置参考](docs/configuration.md) | 全部环境变量 |
| [完整文档站](docs/index.md) | 全部文档索引 |

> 镜像由 GitHub Actions 自动构建并推送至 GHCR：`ghcr.io/xiaomengr/chronoval:latest`（另有 `nightly` 与版本标签如 `1.0.0.5`，amd64/arm64 多架构）

[MIT](LICENSE) · 基于 [ChronoFrame](https://github.com/HoshinoSuzumi/chronoframe)（MIT）定制，视图参考 [Afilmory](https://github.com/Afilmory/Afilmory)
