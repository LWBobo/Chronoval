# 运行依赖打包检查（2026-11-01）

## 本次问题与修复

1. **扫描/上传的文件类型识别失败。** `file-type@22.0.1` 的 `fileTypeFromFile()` 通过运行时动态导入加载 `strtok3`，常规依赖跟踪只包含 `strtok3/core`。现有 `.output` 确认缺少 `lib/index.js` 和 `lib/FileTokenizer.js`。在 Nitro 的 `externals.traceInclude` 中加入从 `file-type` 所属依赖目录解析出的 Node 入口，同时跟踪该入口的依赖，不新增直接依赖或改变文件识别规则。
2. **最终镜像遗漏视频工具。** 原 `runtime_deps` 安装并暂存了 `ffmpeg/ffprobe`，但 `scratch` 阶段没有复制它们。最终阶段改为继承完整 `runtime_deps`，保留工具、共享库、Perl 模块及证书，Node 启动路径使用官方镜像的 `/usr/local/bin/node`。
3. **系统统计依赖命令环境。** `systeminformation` 的磁盘统计调用 shell 与 `df`，原 `scratch` 镜像仅复制部分目录，缺少 `/bin/sh` 和 BusyBox 命令。继承运行依赖阶段一并解决，代价是最终镜像保留 Node 基础镜像中的其他工具，体积可能增加。不将编译阶段的 Python/GCC 带入普通构建的运行镜像。
4. **手动数据库任务资源路径错误。** `db:migrate` 原先根据任务模块的位置拼接迁移目录，Nitro 将模块移动到 chunks 后路径失效。改为与启动插件相同的工作目录路径 `./server/database/migrations`。未改变表结构或执行实际迁移。

## 检查范围

- 全项目服务端的包导入、动态导入、文件读取和外部命令调用；核对 Docker 构建阶段与运行阶段。
- 对服务器现有 `.output/server` 的 1,399 个 JavaScript 脚本、8,883 条非内置模块引用进行静态解析。该目录为已有产物，并非本次修改后的新构建，不能替代新镜像验证。
- 剩余未解析引用逐组核查：WebSocket 的可选加速库、Takumi 其他平台/本地开发回退、Sharp 编译开发包和 macOS 温度传感器，均不能按 Linux 生产环境必需模块缺失处理。
- 核查 Sharp、SQLite、Takumi 原生库入口，HEIC/WASM 依赖，GeoIP 离线数据，ExifTool/Perl，二维码，S3 SDK/签名，以及数据库迁移文件与离线地名种子的打包路径。
- HEIC 解码依赖初始化、二维码 PNG 编码、GeoIP 查询、BMP 模块、离线 S3 签名、系统统计模块及 Takumi 宿主平台加载已在现有产物上单独执行检查。HEIC 使用非 HEIC 输入验证解码器加载和格式拒绝，不代表真实 HEIC 转换已验收。

## 防止同类问题再次发布

`scripts/verify-runtime-dependencies.mjs` 仅使用 Node 内置模块实现检查逻辑，复制到 `.output/server` 后执行，依赖解析遵循服务端 ESM 导出条件，并拒绝从产物外部加载源码目录的依赖。

Docker 最终阶段复制代码、设置工具路径后，在 `--network=none` 下执行此检查，覆盖文件类型识别（PNG/JPEG/MP4）、内存 SQLite、Sharp 小图处理、HEIC 解码依赖加载、BMP、二维码、离线 GeoIP、Takumi 原生入口、S3 本地签名、磁盘命令环境及 FFmpeg/FFprobe/ExifTool。检查仅使用临时样本和内存数据库，不启动应用，不访问真实照片或站点数据库，不请求 S3。

`scripts/runtime-packaging.test.mjs` 加入默认测试入口。测试从真实依赖跟踪结果构造隔离产物，实际调用 `fileTypeFromFile()`，验证动态入口和关联文件齐全，并检查源码依赖回退会被拒绝，以及迁移任务移动到 chunks 后的目录解析。

## 构建与验证边界

本次不执行镜像构建、部署或重启，不更改数据库和照片。原生库与媒体工具在新镜像中的实际检查由用户后续构建时执行；不能将静态扫描或现有产物检查等同于新镜像已通过。

隔离检查目录中，原有 98 项行为回归及新增 3 项打包/路径回归共 **101/101 通过，无跳过**。这不包含新镜像内的 11 组运行依赖自检；后者在用户自行构建镜像时运行。

保留服务器已有的编译工具阿里云镜像源修改。现有 `chronoval-build-deps:node24-v1`、`chronoval-runtime-deps:node24-v1` 的阶段替换命令仍可使用：运行依赖镜像必须是完整的 `runtime_deps` 阶段镜像，不能用以前最终的 `scratch` 应用镜像代替。此次未增加或升级 npm/系统依赖，旧 `runtime_deps` 中完整的已安装工具仍可继承。
