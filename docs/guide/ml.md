# Machine learning

Chronoval keeps CLIP, face recognition, and OCR in a separate service, `chronoval-ml`. Uploads and library scans still finish thumbnails and EXIF first, then enqueue ML jobs. If the sidecar is down, browsing and imports continue; failed jobs can be retried.

## Deploy

Compose starts both services and sets `CHRONOVAL_ML_URL=http://chronoval-ml:3003`. CLIP and `buffalo_l` are copied from the build machine's `models/` directory into `/opt/models` when the `chronoval-ml` image is built. The container network cannot reach Hugging Face or GitHub, so weights are not downloaded on first use.

Build the sidecar from the sibling `chronoval-ml` directory:

```bash
docker compose up -d --build
```

Outside Compose, point Chronoval at the sidecar with `CHRONOVAL_ML_URL` (default `http://127.0.0.1:3003`). The same value can be set in **Dashboard → Settings → Machine learning**. A saved URL overrides the environment variable.

## What runs

| Job | What it stores |
| --- | --- |
| Smart search | CLIP embedding for the photo |
| Face detection | Face box (relative 0–1) and embedding, then a recognition job |
| Face recognition | Assigns faces to people. Runs one at a time. |
| OCR | Text plus an FTS5 index, merged into smart search |

Images sent to the sidecar are JPEG with the longest edge at most 1280 pixels.

On CPU, CLIP and face detection run one at a time, OCR up to two at a time. Recognition is always serial. A nightly sweep queues recognition again (default every 24 hours, `ML_NIGHTLY_INTERVAL_MS`).

## Models and thresholds

| Setting | Default | Meaning |
| --- | --- | --- |
| CLIP image model | `ViT-B-32/openai` | `name/pretrained` sent to the sidecar. Text uses `clip-ViT-B-32-multilingual-v1`, aligned to that image space |
| Minimum similarity | `0.2` | Hits below this cosine similarity, or well below the best hit, are dropped |
| CLIP top-K | `50` | Maximum semantic hits |
| Face model | `buffalo_l` | InsightFace pack |
| Min score | `0.7` | Detection confidence |
| Max distance | `0.5` | Cosine distance for the same person |
| Min faces | `3` | Neighbors required before a person is created |

Changing a model does not rewrite existing vectors. Use **Queue missing** or **Reindex all** on the queue page or the machine-learning settings page.

The default Docker image is CPU. For a GPU, rebuild `chronoval-ml` with a CUDA PyTorch wheel and `onnxruntime-gpu`. CLIP uses CUDA when PyTorch sees a GPU. Faces use CUDA only when ONNX Runtime lists `CUDAExecutionProvider`.

## Using it

- **Search** (`/search`) is available to visitors. Results can be semantic, OCR, or both, and can be combined with date, album, and the same tag / camera / lens / city / rating filters as the gallery.
- **People** (`/people`) is visible without login. Naming, hiding, merging, and reassigning a face require a signed-in user. Face boxes appear on the photo viewer when the image is not zoomed; signed-in users can reassign a box.
- Turning ML off stops new jobs. It does not delete embeddings, faces, or people already stored.
