# 开发容器（3100）

开发容器直接读取当前源码，运行 Nuxt 开发模式和 WebGL 组件监听任务。
首次构建安装依赖，日常修改页面和接口不需要重新构建镜像。

## 首次启动

在服务器项目目录执行：

```bash
cd /home/liuwb/test/Chronoval-liuwb/Chronoval
mkdir -p ../Chronoval-dev-state/data ../Chronoval-dev-state/storage
docker compose -f compose.dev.yaml up -d --build
docker compose -f compose.dev.yaml logs -f --tail=100
```

默认访问 http://192.168.31.99:3100。首次访问需要完成安装向导，创建独立的测试管理员。
第一次打开页面时还需要编译前端依赖，可能需要等待数分钟；后续访问和修改复用开发缓存。
测试数据库和上传文件位于项目相邻目录 `../Chronoval-dev-state/data` 与
`../Chronoval-dev-state/storage`。不会挂载正式容器的数据、图库或机器学习服务。
地名种子仅从源码的 `data/map_info` 只读挂载。

项目源码在容器中只读，开发依赖、`.nuxt`、`.output` 和内部组件的 `dist`
使用独立匿名卷。容器内不会读取源码目录的 `.env`。
不要在测试站点配置正式站点的 S3、OpenList 或扫描目录，以保持测试数据独立。

## 修改代码后的操作

- 修改服务器项目目录下的 Vue、CSS、页面、接口或服务代码，保存后等待自动更新。
  前端一般自动更新；服务端重新编译后，再次发起请求即可。必要时刷新浏览器。
- 修改 `packages/webgl-image/src` 后，组件监听任务自动重新构建内部组件。
- Windows 上的另一份代码不会自动同步。需要先把修改同步到服务器上述源码目录。
- 配置修改或开发服务异常时，可以重启：

```bash
docker compose -f compose.dev.yaml restart
```

修改 `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、内部组件的
`package.json`、`Dockerfile.dev` 或入口脚本后，重建镜像并更新依赖卷：

```bash
docker compose -f compose.dev.yaml up -d --build --force-recreate --renew-anon-volumes
```

该命令更新开发依赖与生成缓存；相邻目录中的测试数据库和上传文件继续保留。
修改 Compose 的环境变量、挂载或资源限制后，使用 `up -d` 重新创建容器，
单纯 `restart` 不会应用 Compose 配置变化。

## 快速测试和日常管理

```bash
docker compose -f compose.dev.yaml exec web pnpm test:permissions
docker compose -f compose.dev.yaml exec web pnpm test:assets
docker compose -f compose.dev.yaml exec web pnpm test:livephoto
docker compose -f compose.dev.yaml ps
docker compose -f compose.dev.yaml logs -f --tail=100
docker compose -f compose.dev.yaml stop
docker compose -f compose.dev.yaml start
```

默认容器内存上限为 5 GiB，内存与交换空间合计上限 6 GiB，CPU 上限 2 核。
每个 Node 进程的老生代堆上限为 3072 MiB；容器总上限包含所有进程。
这些运行限制不限制 Docker 镜像构建过程。
容器设置为 `unless-stopped`，Docker 服务重启后会自动恢复，手动停止后保持停止。

如需更换访问地址，在命令环境中设置 `CHRONOVAL_DEV_HOSTS` 和
`CHRONOVAL_DEV_SITE_URL`，然后 `up -d`；默认使用服务器局域网 IP 和 3100 端口。
可用 `CHRONOVAL_DEV_STATE_DIR` 更改测试数据目录。

这是开发服务器。开发模式和回归测试通过后，发布时仍需构建正式镜像，
验证生产打包及运行依赖。数据库结构变化也需要在测试库中单独验证，热更新
不会代替数据库结构更新。
