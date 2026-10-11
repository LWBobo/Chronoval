# 机器学习

智能搜图、人脸和 OCR 跑在独立服务 `chronoval-ml` 里。上传和扫描库仍然先完成缩略图和 EXIF，再异步入队。侧车不可用时，浏览和入库不受影响，失败任务可以重试。

## 部署

Compose 会同时启动两个服务，并把 `CHRONOVAL_ML_URL` 设为 `http://chronoval-ml:3003`。CLIP 和 `buffalo_l` 在构建 `chronoval-ml` 镜像时从本机 `models/` 拷进 `/opt/models`。容器网络访问不了 Hugging Face 和 GitHub，所以不要等第一次调用再下载。

侧车源码在 Chronoval 同级目录 `chronoval-ml`：

```bash
docker compose up -d --build
```

不用 Compose 时，用环境变量 `CHRONOVAL_ML_URL` 指向侧车（默认 `http://127.0.0.1:3003`）。后台「设置 → 机器学习」里填写的地址会覆盖环境变量。

## 任务

| 任务 | 写入内容 |
| --- | --- |
| 智能搜图 | 照片的 CLIP 向量 |
| 人脸检测 | 相对坐标 0–1 的人脸框和向量，并接着做人脸归属 |
| 人物聚合 | 把人脸归到人物。全局一次只跑一个 |
| OCR | 文字和 FTS5 索引，并入智能搜索 |

送给侧车的图是最长边不超过 1280 像素的 JPEG。

CPU 上 CLIP 和人脸检测各同时 1 个，OCR 最多 2 个。人物聚合始终串行。默认每 24 小时再扫一遍未归属的人脸（`ML_NIGHTLY_INTERVAL_MS`）。

## 模型与阈值

| 设置 | 默认 | 含义 |
| --- | --- | --- |
| CLIP 图像模型 | `ViT-B-32/openai` | 发给侧车的 `名称/预训练权重`。文本塔是与它对齐的 `clip-ViT-B-32-multilingual-v1` |
| 最低相似度 | `0.2` | 低于该余弦相似度、或明显差于最佳结果的照片不会返回 |
| CLIP 返回数量 | `50` | 语义结果上限 |
| 人脸模型 | `buffalo_l` | InsightFace 模型包 |
| 最低置信度 | `0.7` | 检测阈值 |
| 最大距离 | `0.5` | 判为同一人的余弦距离 |
| 最少人脸数 | `3` | 建人所需的邻近脸数量 |

改模型不会改写已经存下的向量。在队列页或机器学习设置里点「补跑缺失」或「全量重跑」。

默认镜像是 CPU。要用 GPU，需用 CUDA 版 PyTorch 和 `onnxruntime-gpu` 重建 `chronoval-ml`。CLIP 在 PyTorch 能看到 GPU 时使用 CUDA；人脸只在 ONNX Runtime 提供 `CUDAExecutionProvider` 时使用 CUDA。

## 怎么用

- **搜索**（`/search`）对访客开放。可以按语义、图中文字或两者一起搜，并和日期、相簿，以及画廊里的标签、相机、镜头、城市、评分筛选一起生效。
- **人物**（`/people`）未登录也能看。改名、隐藏、合并，以及在照片上改派人脸，需要登录。未缩放时查看器会画人脸框；登录后可以改派。
- 关闭 ML 总开关后不再入队新任务，已有的向量、人脸和人物不会被删掉。
