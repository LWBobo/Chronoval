# Chronoval 智能搜图与人物聚合 —— 工程改造文档

> 状态：**P0–P5 已落地，缺口已补齐** — 2026-10-09  
> 仍须真实模型联调：语义相关性、`buffalo_l` 聚类质量。  
> 对照项目：Immich（`/home/liuwb/test/immich`）  
> ML 独立仓库：`/home/liuwb/test/Chronoval-liuwb/chronoval-ml`  
> 产品决策（已确认）：
>
> 1. **按图片内容搜索**（自然语言 / CLIP 语义检索）— **公开访客可用**
> 2. **人物检测与聚合**（人脸识别 → People）— **人物页未登录可见**
> 3. **一期上 OCR**（与 CLIP 结果合并）
> 4. **ML 镜像自建**（`chronoval-ml:latest`）

本文说明 Chronoval 现状差距、推荐架构、分阶段改造范围、数据模型、任务流、API/UI 改动与验收标准。以下「实现核对」节对照代码现状。

---

## 1. 背景与目标

### 1.1 Immich 怎么做（摘要）

| 能力 | Immich 实现要点 |
|------|-----------------|
| 内容搜索 | OpenCLIP 产出图向量 → Postgres `smart_search` + 余弦近邻 |
| 人脸 | InsightFace buffalo（SCRFD 检测 + ArcFace 512-d） |
| 人物聚合 | Server 侧增量 DBSCAN（余弦距离 `maxDistance=0.5`，`minFaces=3`） |
| 部署 | 独立 `machine-learning` 服务；Server 只调 HTTP `/predict` |

### 1.2 Chronoval 现状（差距）

| 维度 | Chronoval 现状 | 缺口 |
|------|----------------|------|
| 架构 | Nuxt 单体 + 进程内 `WorkerPool` + **单容器** | 无 ML 侧车；重模型会抢 HTTP/流水线 |
| 入库 | 上传走 `pipeline-queue`；扫描库走 **LibraryScanner 内联** | ML 必须覆盖两条路径 |
| 搜索 | 前端 `usePhotoFilters` 对全量照片做标签/EXIF/城市/文件名子串匹配 | 无服务端语义检索 |
| 数据库 | **SQLite only**（`data/app.sqlite3`） | 无向量索引 / 无 face/person 表 |
| 依赖 | sharp / exiftool / ffmpeg / thumbhash | 无 ONNX / CLIP / InsightFace |
| 设置 | `DEFAULT_SETTINGS` + dashboard | 可扩，尚无 ML 命名空间 |

**结论：** 缩略图与 EXIF 流水线、队列、设置体系可复用；CLIP / 人脸 / OCR 与向量存储需从零建设。

---

## 2. 推荐总体架构

### 2.1 原则

1. **推理与业务解耦**：ML 独立进程/容器，Chronoval 通过 HTTP 调用（对齐 Immich）。
2. **不阻塞现有流水线**：缩略图/EXIF 成功后再异步入队 ML 任务。
3. **双路径一致**：上传队列与扫描库入库后，统一触发 ML。
4. **向量存储可演进**：一期可用「SQLite + 向量文件/扩展」；二期可迁 Postgres + pgvector。
5. **功能可开关**：设置项控制启用、模型、阈值、并发。

### 2.2 目标拓扑

```text
┌─────────────────────────────────────────────────────────┐
│  chronoval（现有单体）                                    │
│  Nuxt UI + Nitro API + WorkerPool + SQLite               │
│                                                          │
│  photo 流水线完成 thumbnail/exif 后                      │
│       └─ enqueue: smart-search / detect-faces / ocr      │
│  FacialRecognition（串行）← face embeddings              │
│  Search API ← CLIP 近邻 / OCR FTS / 原有 EXIF 过滤       │
└───────────────────────────┬─────────────────────────────┘
                            │ HTTP /predict
                            ▼
┌─────────────────────────────────────────────────────────┐
│  chronoval-ml（新建）                                    │
│  FastAPI / 同类轻服务 + ONNX Runtime                     │
│  · CLIP visual / textual                                 │
│  · Face detection + recognition (InsightFace buffalo)    │
│  · OCR（可选，PaddleOCR / rapidocr）                     │
└─────────────────────────────────────────────────────────┘
```

### 2.3 Compose 变更示意

```yaml
services:
  chronoval:
    # 现有
    environment:
      - CHRONOVAL_ML_URL=http://chronoval-ml:3003
    depends_on:
      - chronoval-ml

  chronoval-ml:
    image: chronoval/machine-learning:latest   # 新建
    ports:
      - "3003:3003"
    volumes:
      - ml-cache:/cache   # 模型缓存
    # 可选 GPU：deploy.resources / NVIDIA runtime
```

单机无 GPU 时 CPU ORT 可跑，但人脸全量重跑建议限制并发。

---

## 3. 分阶段实施计划

| 阶段 | 范围 | 交付物 | 预估量级 |
|------|------|--------|----------|
| **P0 基建** | ML 侧车骨架、HTTP 客户端、settings、队列任务类型 | 可调用的空/echo 服务 + `photo-ml` 任务能跑通 | S |
| **P1 内容搜索** | CLIP 编码、向量存储、搜索 API、搜索 UI | 「描述搜图」可用 | M |
| **P2 人脸检测** | 检测+embedding 入库、照片详情画框 | 单图可见人脸框 | M |
| **P3 人物聚合** | 增量聚类、People 页、合并/改派 | Explore「人物」可用 | L |
| **P4 OCR（可选）** | OCR + FTS5 | 按图内文字搜 | M |
| **P5 硬化** | 夜间任务、管理台重跑、GPU、向量库升级 | 生产可用 | M |

建议顺序：**P0 → P1 → P2 → P3**；OCR 可与 P2 并行。

---

## 4. 模块改造清单

### 4.1 新建：`packages/machine-learning` 或独立仓库 `chronoval-ml`

| 项 | 说明 |
|----|------|
| 技术选型 | Python 3.11+ + FastAPI + onnxruntime（可对齐 Immich `immich_ml` 结构精简 fork） |
| 接口 | `POST /predict`，multipart：`image` + JSON `entries` |
| entries | `clip.visual` / `clip.textual` / `facial-recognition.detection+recognition` / `ocr` |
| 模型 | CLIP：`ViT-B-32`；人脸：`buffalo_l`；OCR：可选 |
| 健康检查 | `GET /ping` |
| Docker | 多阶段构建；模型懒下载到 `/cache` |

**对照 Immich 可复用思路的文件（勿直接拷协议不兼容部分）：**

- `immich/machine-learning/immich_ml/main.py`
- `immich/machine-learning/immich_ml/models/facial_recognition/`
- `immich/machine-learning/immich_ml/models/clip/`

### 4.2 Server：ML 客户端与配置

| 文件/位置 | 改动 |
|-----------|------|
| `server/services/ml/`（新建） | `MlClient.detectFaces` / `encodeImage` / `encodeText` / `ocr` |
| `server/services/settings/contants.ts` | 新命名空间 `ml`：`enabled`、`url`、`clip.enabled`、`clip.model`、`face.enabled`、`face.model`、`face.minScore`、`face.maxDistance`、`face.minFaces`、`ocr.enabled` |
| `server/services/settings/ui-config.ts` | 后台「机器学习」表单 |
| `i18n/locales/*.json` | `settings.ml.*` |
| `app/pages/dashboard/settings/` | 新页或并入 advanced |
| `.env.example` / compose | `CHRONOVAL_ML_URL` |
| `docker-compose*.yml` / `Dockerfile` 文档 | 增加 ml 服务说明 |

### 4.3 流水线 / 队列

| 文件/位置 | 改动 |
|-----------|------|
| `server/database/schema.ts` | `pipeline_queue.statusStage` 增：`smart-search`、`face-detection`、`face-recognition`、`ocr`；payload 增任务类型 |
| `server/services/pipeline-queue/manager.ts` | 新 processor；`photo` 任务在 thumbnail（及 exif）完成后 **enqueue 后续 ML 任务**（勿塞进同事务阻塞） |
| `server/api/queue/add-task.post.ts` 等 | Zod 扩展 |
| `server/services/library/scanner.ts` | 入库成功后 `addTask({ type: 'photo-smart-search' \| 'photo-faces', photoId })` |
| `server/plugins/4.pipeline-queue.ts` | face-recognition **并发=1**；clip/ocr 可 1–2 |
| 管理台 `dashboard/queue.vue` | 展示新 stage；「补跑缺失 / 全量重跑」按钮 |

**任务拆分建议（对齐 Immich）：**

```text
photo (现有: preprocess → metadata → thumbnail → exif → …)
        │ 完成后
        ├─► photo-smart-search   （CLIP 写向量）
        ├─► photo-face-detection （检脸 + embedding；再触发 recognition）
        └─► photo-ocr            （可选）

photo-face-recognition（全局串行）
        │ 对未分配 person 的脸做近邻 + DBSCAN 核心点规则
```

### 4.4 数据模型（SQLite 一期）

新建表（Drizzle migration）：

#### `photo_embeddings`（内容搜索）

| 列 | 类型 | 说明 |
|----|------|------|
| photo_id | text PK/FK → photos | |
| model | text | 如 `ViT-B-32__openai` |
| embedding | blob | Float32Array 序列化；或外置 `.npy`/自定义文件 |
| dim | integer | 如 512 |
| updated_at | integer | |

检索一期：**暴力余弦**（图库 <5万可接受）；中期接 [sqlite-vec](https://github.com/asg017/sqlite-vec)；长期 Postgres+pgvector。

#### `asset_faces`

| 列 | 类型 | 说明 |
|----|------|------|
| id | text PK | |
| photo_id | text FK | |
| person_id | text nullable FK | |
| x1,y1,x2,y2 | real | 相对或绝对像素（建议存相对 0–1，抗缩略图变化） |
| image_width, image_height | integer | 检测时图像尺寸 |
| score | real | 检测置信度 |
| source | text | `ml` / `manual` |
| created_at | integer | |

#### `face_embeddings`

| 列 | 类型 | 说明 |
|----|------|------|
| face_id | text PK/FK | |
| model | text | `buffalo_l` |
| embedding | blob | 512-d float32 |
| updated_at | integer | |

#### `people`

| 列 | 类型 | 说明 |
|----|------|------|
| id | text PK | |
| name | text nullable | |
| is_hidden | integer | |
| thumbnail_face_id | text nullable | 封面脸 |
| face_count | integer | 可冗余缓存 |
| created_at / updated_at | integer | |

索引：`asset_faces(photo_id)`、`asset_faces(person_id)`、`people(name)`。

> Immich 有 `person_group` / `cluster_group` 多用户共享；Chronoval 当前偏单用户，**一期扁平 `people` 即可**，预留 `owner_id` 字段便于以后扩展。

### 4.5 服务层（新建）

| 服务 | 职责 | 对照 Immich |
|------|------|-------------|
| `SmartSearchService` | 编码缩略图、文本查询、Top-K 搜图 | `SmartInfoService` |
| `FaceDetectionService` | 调 ML、IoU 去重更新、写 face 表 | `PersonService.handleDetectFaces` |
| `FaceRecognitionService` | 近邻 + 核心点规则建人/归人 | `PersonService.handleRecognizeFaces` |
| `PersonService` | CRUD、合并、改派、隐藏、封面 | People API |
| `OcrService`（可选） | 写 `photo_ocr_text` + FTS5 | `OcrService` |

算法参数（写入 settings，默认对齐 Immich）：

| 键 | 默认 | 含义 |
|----|------|------|
| `ml.face.minScore` | 0.7 | 检测置信度 |
| `ml.face.maxDistance` | 0.5 | 余弦距离上限 |
| `ml.face.minFaces` | 3 | DBSCAN 核心点最小邻居数（含自身） |
| `ml.clip.topK` | 50 | 搜索返回上限 |

**人物聚合伪代码：**

```text
for face in unassigned_ml_faces:
  neighbors = topK(embedding, k=minFaces, distance <= maxDistance)
  if len(neighbors) < minFaces:
    defer later / nightly
  else if any neighbor has person_id:
    assign face to that person
  else:
    create person; assign face + neighbors without person
```

`face-recognition` 队列必须 **concurrency = 1**。

### 4.6 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/search/smart?q=&limit=` | 文本 → CLIP → 照片 ID 列表 |
| POST | `/api/search/smart` | 可附带 EXIF/日期/相册过滤 |
| GET | `/api/people` | 人物列表（支持 `minFaces`、隐藏过滤） |
| GET | `/api/people/:id` | 人物详情 + 照片分页 |
| PUT | `/api/people/:id` | 改名 / 隐藏 / 封面 |
| POST | `/api/people/merge` | 合并 |
| PUT | `/api/faces/:id` | 改派人物 |
| GET | `/api/photos/:id/faces` | 单图人脸框 |
| POST | `/api/ml/jobs/queue-all` | 管理：补跑 clip/faces/ocr（missing/all） |

权限：与现有 dashboard / 登录态一致；公开画廊若启用智能搜索需明确产品策略（建议仅登录用户）。

### 4.7 前端

| 区域 | 改动 |
|------|------|
| `AppTopHeader` / `FilterPanel` | 搜索框支持「语义搜索」模式；结果走服务端 API，不再仅本地 filter |
| `usePhotoFilters.ts` | 保留 EXIF 分面；语义结果与分面可 AND |
| 新建 `pages/people/index.vue` | 人物网格（封面脸 + 名字 + 数量） |
| 新建 `pages/people/[id].vue` | 该人照片时间线/瀑布流（复用现有 gallery 组件） |
| `components/photo/` 查看器 | 叠加人脸框；点击框跳转人物或改派 |
| `dashboard/settings` | ML 开关与阈值 |
| `dashboard/queue` / 新 `dashboard/ml.vue` | 任务进度、全量重跑 |
| 导航 | 顶栏或侧栏增加「人物」入口 |
| i18n | `ui.people.*`、`ui.search.smart*` |

首页时间线布局（已有 Immich 式 justified）可直接展示智能搜索结果集。

### 4.8 文档与运维

| 文档 | 内容 |
|------|------|
| `docs/guide/configuration.md`（及 zh） | ML URL、模型、GPU、磁盘 |
| `docs/deployment.md` | 双服务部署、资源建议 |
| 本文件 | 随实现更新状态 |

---

## 5. 与现有模块的衔接点（精确）

```text
上传完成
  app/pages/dashboard/photos.vue
    → POST /api/queue/add-task { type: photo }
      → pipeline-queue/manager.ts  processors.photo
        → thumbnail 成功后
          → addTask(smart-search)
          → addTask(face-detection)

扫描库
  server/services/library/scanner.ts  processFile 入库后
    → 同样 enqueue ML（避免只覆盖上传）

缩略图路径
  photos.thumbnailKey / thumbnailUrl
    → ML 客户端读本地 storage 或临时文件（扫描库可用原图缩小版）
  建议：统一用「最长边 ≤ 1280 的 JPEG/WebP」送 ML，控制带宽与显存

设置
  沿用 docs/development/how-to-add-setting.md 流程

前端照片源
  app.vue PhotosProvider 仍拉 /api/photos*
  语义搜索改为 /api/search/smart 返回 id[]，再映射本地缓存或二次拉取
```

---

## 6. 非功能要求

| 项 | 要求 |
|----|------|
| 失败隔离 | ML 宕机不阻断上传/缩略图；任务 failed 可重试 |
| 幂等 | 同 photo 重复跑 clip/faces 应 upsert，不产生重复脸（IoU>0.5 匹配更新） |
| 性能 | 上传路径 ML 异步；管理台全量重跑限速 |
| 隐私 | 人脸/向量仅本地；设置可一键关闭并停止入队 |
| 模型体积 | buffalo_l + CLIP 可能数百 MB～GB；镜像与首次下载需文档说明 |
| 资源 | CPU 机器建议 face 并发 1、clip 1；有 GPU 再提高 |

---

## 7. 风险与决策点

| 风险 | 缓解 |
|------|------|
| SQLite 暴力向量搜在十万级变慢 | 一期限制规模；中期 sqlite-vec；远期 Postgres |
| 进程内队列跑 ML 拖垮 API | **必须**侧车，禁止在 Nitro worker 内嵌 ONNX |
| 扫描库与上传行为不一致 | scanner 强制 enqueue；加「缺失补跑」任务 |
| 误合脸 / 过碎人物 | 暴露 maxDistance、minFaces；提供合并与改派 UI |
| 许可证 | InsightFace / CLIP / OCR 模型许可证需在 NOTICE 声明 |
| 单用户假设 | people 表预留 owner_id，避免二期推翻 |

**产品决策（实现前需确认）：**

1. 公开访客是否可用智能搜索？  
2. 人物页是否对未登录可见？  
3. 一期是否上 OCR？  
4. ML 镜像自建还是文档指引用户挂 Immich ML（协议需适配，不推荐强耦合）？

---

## 8. 验收标准

### P1 内容搜索

- [x] API `/api/search/smart` + 页面 `/search`（公开）  
- [x] CLIP 编码任务 `photo-smart-search`；关闭 `ml.clip.enabled` 可跳过  
- [x] 新上传 / 扫描入库后 `enqueueMlJobsForPhoto`  
- [x] `POST /api/search/smart` 支持日期 / 相簿 / 相机 / 镜头 / 城市 / 标签 / 评分，并与画廊分面 AND  
- [ ] **需联调**：真实模型下「海边的狗」等语义相关性（取决于 chronoval-ml 模型下载）

### P2–P3 人物

- [x] 人脸检测/识别任务 + `people` / `asset_faces` 表  
- [x] `/people`、`/people/:id` 公开页；详情 InfoPanel 人物入口  
- [x] 命名/合并/改派 API（需登录）  
- [x] Face Recognition 全局锁 `withRecognitionLock`  
- [x] 查看器人脸框（未缩放时）与登录后改派；人物页改名 / 隐藏 / 合并  
- [ ] **需联调**：真实 buffalo_l 下聚类质量与阈值调参

### OCR / 运维

- [x] `photo-ocr` + FTS5 + 智能搜索合并 OCR 命中  
- [x] `/api/ml/jobs/queue-all` 补跑；`9.ml-nightly` 夜间 recognition sweep  
- [x] `docker-compose.yml` 含 `chronoval-ml` + `CHRONOVAL_ML_URL`  
- [x] ML 不可达时入库/浏览不阻断（任务失败可重试）

### 实现核对（对照本仓库路径）

| 项 | 路径 |
|----|------|
| ML 侧车 | `../chronoval-ml`（FastAPI `/v1/clip|faces|ocr`） |
| Schema / 迁移 | `server/database/schema.ts`、`migrations/0042_ml_ai.sql` |
| 服务 | `server/services/ml/*` |
| 队列钩子 | `pipeline-queue/manager.ts`、`library/scanner.ts` |
| 设置 | `settings/contants.ts` namespace `ml`、`dashboard/settings/ml.vue` |
| 公开 API | `api/search/smart`、`api/people/*`、`api/ml/status` |
| UI | `pages/search.vue`、`pages/people/*`、顶栏入口 |

---

## 9. 建议目录结构（落地时）

```text
Chronoval/
  packages/
    machine-learning/          # 或独立 git 仓
      Dockerfile
      app/main.py
      app/models/...
  server/
    services/
      ml/
        client.ts
        smart-search.service.ts
        face-detection.service.ts
        face-recognition.service.ts
        person.service.ts
      pipeline-queue/manager.ts  # 扩展
    database/
      schema.ts                  # 新表
      migrations/xxxx_ml.sql
    api/
      search/smart.get.ts
      people/...
      faces/...
      ml/jobs/...
  app/
    pages/people/
    components/people/
    composables/useSmartSearch.ts
  docs/
    .develop/ml-content-search-and-people.md  # 本文
    guide/ml.md                               # 用户向（后续）
```

---

## 10. 工作量粗估（供排期）

| 项 | 人日（参考） |
|----|--------------|
| ML 侧车骨架 + Docker + 客户端 | 3–5 |
| CLIP 编码 + 存储 + 搜索 API + UI | 5–8 |
| 人脸检测入库 + 详情框 | 4–6 |
| 人物聚类 + People CRUD/合并 + 页面 | 8–12 |
| 扫描库/补跑/设置/文档/ hardening | 3–5 |
| OCR（可选） | 3–5 |
| **合计（不含 OCR）** | **约 23–36 人日** |

---

## 11. 总结

Chronoval 已具备：**双路径入库、缩略图、队列、设置、画廊 UI**。  
要对齐 Immich 的「内容搜图 + 人物聚合」，关键增量是：

1. **新建 ML 侧车**（CLIP + InsightFace）  
2. **扩展 pipeline 任务与表结构**（embedding / face / people）  
3. **Server 侧搜索与增量 DBSCAN 聚类**  
4. **前端搜索与人物页**  
5. **让扫描库与上传共用 ML 触发**

不建议在现有 Nitro 进程内直接跑深度学习模型；不建议一期就上多用户 `cluster_group` 复杂模型。先交付单用户可用的 CLIP 搜索与人物页，再按需升级向量库与 OCR。

---

## 附录 A：Immich 核心对照路径

| 主题 | Immich 路径 |
|------|-------------|
| 人脸检测 Job | `server/src/services/person.service.ts` → `handleDetectFaces` |
| 人物聚类 | 同上 → `handleRecognizeFaces` |
| 向量搜脸 | `server/src/repositories/search.repository.ts` → `searchFaces` |
| CLIP | `server/src/services/smart-info.service.ts` |
| ML HTTP | `server/src/repositories/machine-learning.repository.ts` |
| 算法说明 | `docs/docs/features/facial-recognition.md` |
| 调参 | `docs/docs/guides/better-facial-clusters.md` |

## 附录 B：Chronoval 关键衔接路径

| 主题 | 路径 |
|------|------|
| 照片表 | `server/database/schema.ts` → `photos` |
| 队列 | `server/services/pipeline-queue/manager.ts` |
| 扫描库 | `server/services/library/scanner.ts` |
| 过滤器 | `app/composables/usePhotoFilters.ts` |
| 加设置 | `docs/development/how-to-add-setting.md` |
| Compose | `docker-compose.yml`、`Dockerfile` |
