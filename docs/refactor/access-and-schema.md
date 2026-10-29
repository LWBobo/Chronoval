# 数据库与可见性重构方案

本文描述当前表为什么变多，以及后续重构要收成什么样。重构按文末阶段做，不要一次改完。

目标只有两件事：

1. 照片能不能被看到，只由一张授权表加上成员关系决定。
2. 同一类数据只留一张表。向量、人脸框、队列表继续独立，因为它们不是权限，也不是同一类实体。

不在这次范围里：地图 PMTiles、水印清除、瀑布流排版、机器学习模型本身。那些功能保留，只改它们读写的表。

## 1. 从 origin/main 到现在多了什么

`origin/main` 已有 12 张表：

| 表 | 作用 |
| --- | --- |
| `users` | 账号，`is_admin` 表示管理员 |
| `login_logs` | 登录审计 |
| `photos` | 照片与视频 |
| `pipeline_queue` | 上传后的处理队列 |
| `photo_reactions` | 匿名表态 |
| `music` | 相簿背景音乐 |
| `albums` | 手工相簿 |
| `album_photos` | 手工相簿里的照片 |
| `scan_libraries` | 扫描目录 |
| `scan_album_meta` | 扫描目录当成相簿后的标题、密码、布局 |
| `settings` | 键值配置 |
| `settings_storage_providers` | 上传文件的存储后端 |

`origin/main..HEAD` 在这些表上继续加列，并新增机器学习相关的表。照片是否出现在首页，现在要同时看：

- `albums.visibility`、`albums.is_hidden`、`albums.hide_from_gallery`
- `albums.password_hash`、`password_exempt_mode`、`password_exempt_users`
- `scan_libraries.display_mode`、`enabled`、`password_hash`
- `scan_album_meta` 上几乎同样的一套隐藏、密码、免密字段
- `people.visibility`、`people.is_hidden`
- 代码里的 `server/utils/access.ts` 路由表，以及 `photo-access.ts`、`gallery-visibility.ts` 两套运行时判断

`albums` 和 `scan_album_meta` 已经是两份相簿：标题、介绍、封面、布局、随机动画、语录、背景音乐、slug、密码、免密名单各写一遍。扫描子目录没有自己的行，访问时用路径前缀去匹配 `scan_album_meta`。这是首页 SQL 又长又容易漏的原因。

接口权限和照片可见性不是一件事。`access.ts` 只决定能不能调用某个 `/api`。照片可见性决定调用之后结果里有没有这张图。重构不要把路由规则搬进数据库。

## 2. 现有功能必须继续满足的规则

这些是已经上线的行为，重构后保持不变。

- 未登录、已登录、管理员是三种观众。管理员看全部照片。
- 手工相簿可见范围：所有人、仅登录、仅管理员。没有密码时，仅登录的照片在登录后出现在首页。
- 相簿设了访问密码：首页永远不放这些照片。只有打开相簿并解锁、或免密、或管理员，才能看见。
- 免密：所有登录用户，或指定用户。
- 一张照片属于多个相簿时，按其中最严的一档决定能不能看。公开相簿和仅登录相簿各有一张相同照片时，未登录在两个相簿、首页和搜索里都看不到它。这是相对现有代码的改动：现在的实现是任一相簿允许就可见，重构后改为取严。
- `hide_from_gallery` 只影响首页，不影响相簿页和搜索。
- 扫描库 `gallery` 进首页、不进相册页；`album` 进相册页、不进首页；`both` 两边都进。禁用的扫描库两边都不进。
- 扫描子目录可以单独隐藏、单独设密码。未单独设置时沿父目录继承。
- 人物相册只在人物页显示，不进相册页。它的可见范围仍是所有人、仅登录、仅管理员，并参与照片取严。照片里只要有一个当前观众看不见的人物相册，整张照片不出现。一个人改回公开后，如果另一个人仍是仅登录或仅管理员，照片继续隐藏。
- 人脸漏检时，管理员可以不依赖检测框，直接新建一本人物相册并往里加照片。首页顶栏进入的人物页要列出这本相册。之后机器学习认出同一个人，新照片自动进入这本手建相册。
- 机器学习标签、CLIP、OCR、人脸向量继续按现有产品工作。
- 回收站照片任何前台都不出现。
- 未知 `/api` 默认只有管理员能调。

## 3. 设计原则

参考 Immich 的做法，但不要照搬它的用户、合作伙伴、共享链接三套表。Chronoval 仍是单租户家庭相册，角色只有访客、登录用户、管理员。

1. 一个实体一张表。手工相簿和扫描文件夹都是「集合」。
2. 谁能看，只写在 `access_grants`。集合上不再放 `is_hidden`、`visibility`、免密 JSON。
3. 照片自己不默认复制一份授权。一张照片的有效档位等于它所属全部集合里最严的那一档，人物相册也是其中一种集合。
4. 首页是否出现是展示开关，不是权限。权限拒绝的照片，展示开关不能把它放出来。
5. 一对一的向量可以留在旁表，避免 `photos` 每一行都带大块二进制。不要为了少表把向量塞进 `photos`。
6. 密码只存哈希。管理端需要改密码时重新输入，不再回显明文。
7. 接口能不能调，继续放在代码里的路由表。数据库管的是资源能被谁看见。

## 4. 目标表

下面是重构完成后应存在的表。箭头右侧是被它吃掉的现表。

### 4.1 保留不动

| 表 | 原因 |
| --- | --- |
| `users` | 账号。增加 `role`，见 4.2 |
| `login_logs` | 审计，和照片无关 |
| `pipeline_queue` | 异步任务，生命周期和照片不同 |
| `photo_reactions` | 按指纹记表态，不是权限 |
| `music` | 音频文件元数据 |
| `settings` | 站点配置。顺带吃掉 `ml_state` |
| `settings_storage_providers` | 上传存储后端，不是扫描目录 |
| `photo_embeddings` | CLIP 向量，一行一个大 blob |
| `face_embeddings` | 人脸向量，同上 |
| `photo_ocr` | OCR 正文，配合 FTS |
| `ml_tag_aliases` | 一个标签多条同义词，不能并进标签行 |
| `photo_ml_tags` | 照片与标签的多对多，还要记下自动或人工、采用或排除 |

`users` 增加：

```sql
ALTER TABLE users ADD role text NOT NULL DEFAULT 'user';
-- admin / user
UPDATE users SET role = 'admin' WHERE is_admin = 1;
```

读权限时只看 `role`。`is_admin` 保留到应用改完再删，避免一次迁移拆掉会话。

### 4.2 新的核心：集合

`collections` 取代 `albums` 和 `scan_album_meta`。

```sql
CREATE TABLE collections (
  id integer PRIMARY KEY,
  kind text NOT NULL,                 -- manual | folder | person
  parent_id integer REFERENCES collections(id) ON DELETE CASCADE,
  library_id integer REFERENCES libraries(id) ON DELETE CASCADE,
  rel_path text NOT NULL DEFAULT '',  -- folder 用；manual 恒为 ''
  title text,
  description text,
  cover_photo_id text REFERENCES photos(id) ON DELETE SET NULL,
  bgm_music_id integer REFERENCES music(id) ON DELETE SET NULL,
  uid text UNIQUE,
  slug text UNIQUE,
  url_key text UNIQUE,
  layout text NOT NULL DEFAULT 'waterfall',
  show_on_gallery integer NOT NULL DEFAULT 1,
  show_on_albums integer NOT NULL DEFAULT 1,
  child_in_parent integer NOT NULL DEFAULT 1,
  child_position text NOT NULL DEFAULT 'start',
  random_animation text NOT NULL DEFAULT 'default',
  random_quotes_enabled integer NOT NULL DEFAULT 1,
  random_quotes text,
  random_quotes_tag text,
  password_hash text,                 -- 非空表示还要解锁；明文密码删除
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);

CREATE UNIQUE INDEX collections_folder_unique
  ON collections(library_id, rel_path)
  WHERE kind = 'folder';
```

字段怎么来：

| 新列 | 旧来源 |
| --- | --- |
| `kind=manual` | 每一行 `albums` |
| `kind=folder` | 每个扫描库根，加每一条 `scan_album_meta`。没有 meta 的子目录不预建行，第一次被设置时再插入 |
| `kind=person` | 每一个 `people` 一行。这是人物相册，见下文 |
| `show_on_gallery` | 手工相簿：`hide_from_gallery=0`。扫描库：`display_mode` 为 `gallery` 或 `both` |
| `show_on_albums` | 手工相簿恒为 1。扫描库：`display_mode` 为 `album` 或 `both` |
| `password_hash` | 两边的 `password_hash`。`password` 明文列丢弃 |
| `random_animation` | 已有列。`random_wheel_animation` 丢弃，以 `random_animation` 为准 |

`libraries` 取代 `scan_libraries`，只留目录本身：

```sql
CREATE TABLE libraries (
  id integer PRIMARY KEY,
  name text NOT NULL,
  root_path text NOT NULL,
  enabled integer NOT NULL DEFAULT 1,
  watch_interval_ms integer NOT NULL DEFAULT 60000,
  last_scan_at integer,
  last_scan_result text,
  disabled_at integer,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
```

`display_mode`、相簿密码、urlKey、子相簿插页，都挪到该库根那条 `collections`。库被禁用时，它下面的照片直接不可见，不必再写授权。

`collection_photos` 取代 `album_photos`，结构不变：`(collection_id, photo_id)` 唯一，外加 `position`。只给 `kind=manual` 使用。文件夹集合的照片不写入此表，仍由 `photos.library_id + library_path` 是否落在 `rel_path` 下决定。这样扫描入库不用给每张照片插成员行。

人物相册是 `kind=person` 的集合，不是第四套权限。`people` 仍保留，只放识别信息：姓名、封面脸 `thumbnail_face_id`、`face_count`。增加 `people.collection_id`，唯一指向它的那条集合。新建人物时先建集合，再写 `people`。删人物时删这条集合。`people.visibility` 不再使用，授权写到该集合的 `access_grants` 上，`resource_type` 只有 `collection`。

三处入口按 `kind` 分开，照片权限仍把人物相册算进取严：

| 入口 | 列出的集合 |
| --- | --- |
| 相册页 `/albums` 与相簿设置 | `manual`、`folder`，且 `show_on_albums=1` |
| 人物页 `/people` 与人物设置 | 只有 `person` |
| 首页照片 | 不列人物相册卡片。人物相册的授权档位仍参与照片取严 |

`kind=person` 固定 `show_on_albums=0`，不读 `show_on_gallery`。否则「人物相册不出现在相册页」会被误当成 `show_on_gallery=0`，所有认出人脸的照片都会从首页消失。人物相册不设密码，`password_hash` 保持空。成员不写 `collection_photos`，由 `faces.person_id` 指向 `people`，再经 `people.collection_id` 找到这本相册。自动识别和手动补入都是成员。

`people` 增加 `origin`，取值为 `ml` 或 `manual`。聚类新建的是 `ml`。管理端手建的是 `manual`，不要求事先有人脸框。

手建入口在 `/dashboard/people`，按钮为「新建人物」：

1. 姓名必填，去掉首尾空白后不能为空。默认授权为 `public`，创建时可以改成 `login` 或 `admin`。
2. 先插入 `kind=person` 的集合和一条 `access_grants`，再插入 `people`：`origin=manual`，`collection_id` 指向该集合，`thumbnail_face_id` 为空，`face_count` 为 0。
3. 创建完成后用第 4.6 节的选择器往这本相册加照片。此时还没有照片也可以保存，管理页要留下这张卡片。
4. 机器学习合并、以及「没有脸又没有名字就删除」的清理，跳过 `origin=manual`。手建人物只有管理员删除时才消失。清空姓名也不删除。

前台列表是首页顶栏「人物」打开的 `/people`。现在的实现只数 `asset_faces` 里的检测框，并且 `visibleFaces.length === 0` 时直接丢掉，所以只加了手动照片的人物不会出现。重构后的列出条件：

- 观众档位打得开这本 `kind=person` 集合。
- 至少有一张成员照片是当前观众可见的。成员含检测框和 `source=manual` 的行，按照片 id 去重。一张都没有则不出现在前台，避免空头像；管理页仍显示。
- 封面优先用 `thumbnail_face_id` 的人脸切图。没有脸框时，用第一张可见成员照片的 `thumbnail_url`，整图放进圆形头像。不能因为没有脸框就滤掉这个人。

`face_count` 改为可见成员照片数，而不是脸框行数。同一张照片上两张脸仍算一张照片。

手建相册在有了锚点脸之后，后续识别到的同一个人自动成为成员。锚点是「这张脸就是这个人」的检测框，带有向量。没有锚点时，不能把别的照片并进来，因为合影里分不清是哪一张脸。

`faces` 增加 `pinned`。为 1 表示这张脸固定属于当前 `person_id`，全量重聚类时不清空。下面三种情况写成 1：

- 管理员在照片上把某一张脸指定给这个人物。
- 手动加入的照片检测完之后只有一张脸，这张脸就是锚点。
- 迁移时，已经挂在 `origin=manual` 人物上的检测框。

手动加入一张照片后的处理：

1. 若这张照片还没跑过检测，排进现有的人脸检测队列。检测完成再做下面两步，不要在没有框的时候猜。
2. 只有一张脸：`person_id` 设为手建人物，`pinned=1`。这张脸已属于一个没有姓名的 `origin=ml` 人物时，改挂到手建人物，不保留两本相册。那个无名人物里、与这张锚点的余弦距离不大于 `faceMaxDistance` 的其他脸一并改过来。改完后无名人物若已经没有脸，删除该人物及其 `kind=person` 集合。
3. 有多张脸：一张都不自动指定。管理员点选其中一张作为锚点。其余脸留给别人。

识别任务 `processFaceRecognition` 保持「邻居里已经有人物就并入，否则新建」。补充三条：

- 未归属脸与任一 `pinned=1` 的锚点距离不大于 `faceMaxDistance` 时，并入该锚点的人物，禁止为这一簇新建 `origin=ml` 人物。手建人物和机器学习人物都算合法邻居。
- 并入只改这张脸的 `person_id`。照片因此出现在人物相册里，不再额外插入手动成员行。同一张合影上的其他脸可以属于其他人物。
- 距离内同时贴近两个不同人物时，取更近的锚点。距离相同则不自动并入，留给管理员合并。已有姓名的人物，或另一本 `origin=manual` 相册，不会被整本吸入手建人物。

全量重置 `resetMlPersonClustering` 只清空 `pinned=0` 的 `person_id`。锚点留下来，重置后的新脸仍能回到这本手建相册。

### 4.3 授权表：所有展示都读它

这是唯一的权限表。

```sql
CREATE TABLE access_grants (
  id integer PRIMARY KEY,
  resource_type text NOT NULL,   -- 只有 collection
  resource_id text NOT NULL,     -- collections.id 的文本。人物相册用它自己的集合 id
  audience text NOT NULL,        -- public | login | admin | user
  user_id integer REFERENCES users(id) ON DELETE CASCADE,
  created_at integer NOT NULL
);

CREATE UNIQUE INDEX access_grants_unique
  ON access_grants(resource_type, resource_id, audience, ifnull(user_id, 0));
```

一行的意思是：这类观众可以看这个资源。

| 现有设置 | 写入的行 |
| --- | --- |
| 所有人可见 | `audience=public` |
| 仅登录 | `audience=login` |
| 仅管理员 | `audience=admin` |
| 指定用户免密 | 每个用户一行 `audience=user` |
| 任意登录用户免密 | `audience=login`，并且集合上仍有 `password_hash` |
| 人物仅登录 / 仅管理员 | 同样三档，写在该人物的 `kind=person` 集合上 |

没有 `public` 行、只有 `login` 行时，访客看不见。管理员不查这张表，代码里直接放行。

密码不是 audience。`collections.password_hash` 非空时，除了授权还要本会话已解锁，除非观众是管理员，或命中 `user` / `login` 免密行。解锁状态继续放 cookie，不建会话表。

删除这些列，避免两套真相：

- `albums.visibility`、`is_hidden`、`password_exempt_mode`、`password_exempt_users`、`password`
- `scan_album_meta` 上的同名列
- `people.visibility`、`people.is_hidden`
- `scan_libraries.password_hash`、`display_mode`

### 4.4 照片可见性算法

档位从宽到严是 `public` < `login` < `admin`，记作 0、1、2。观众自己的档位：未登录 0，已登录 1，管理员 2。管理员看全部未删除、且所属扫描库仍启用的照片，不再往下比较。

一张照片不单独存权限。它的有效档位是所属范围内的最大值（最严的一档）：

- 每一条 `collection_photos` 指向的手工集合，取该集合授权的档位。
- 扫描照片再加它所在的那一个文件夹集合。从照片目录向根找第一条自己写了 `access_grants` 或 `password_hash` 的文件夹集合；没有则用库根集合。一张扫描照片只算这一个文件夹，不要把路径上每个祖先都算进去。
- 每一张脸上的人物相册，包括 `faces.source=manual`。经 `faces.person_id` 找到 `people.collection_id`，取那条 `kind=person` 集合的档位。
- 上面一个都没有时（只上传、未放进任何相簿、也没有人物），有效档位为 `public`。

集合或人物上若同时有多条档位授权，取最严的一条，避免宽授权把严授权抵消。`audience=user` 的免密行不参与档位，只参与密码。

观众能看见这张照片，当且仅当：

1. `deleted_at` 为空，且所属库 `enabled=1`。没有库的上传照片跳过库检查。
2. 观众档位大于等于照片有效档位。
3. 所属的每一个设了 `password_hash` 的集合，当前观众都已解锁，或对该集合免密。有一个集合的密码过不了，这张照片在首页、搜索、地图和另一个相簿里都不出现。管理员已在前面放行。

因此：照片同时在公开相簿和仅登录相簿时，有效档位是 `login`。未登录用户打开那个公开相簿，也看不到这一张；同相簿里只属于公开相簿的其他照片仍可见。登录后，这张照片在两个相簿里都可见。若这张照片还属于一个仅管理员的人物相册，有效档位升到 `admin`，普通登录用户也看不到。该人物相册本身只出现在人物页，不出现在相册页。

首页在第 2、3 条之外再取严，不放宽：

- 任一所属的 `manual` 或 `folder` 集合 `show_on_gallery=0`，首页不放这张照片。`kind=person` 不参与这一条。相簿页和搜索仍按上面的档位显示。
- 任一所属集合有密码且当前观众不免密，首页不放。解锁cookie 不能把它送回首页。

相簿页只列出观众打得开的 `manual` 与 `folder` 集合：观众档位大于等于该集合自己的档位，且该集合的密码已解锁或免密。人物页只列出打得开的 `person` 集合，封面用 `people.thumbnail_face_id`。两边打开之后，里面仍逐张用照片有效档位过滤，不能因为这本相册是公开的就把更严成员带出来。

搜索、地图、人物页使用和第 2、3 条相同的条件，不看 `show_on_gallery`。

实现只留 `photoVisibleSql(viewer, surface)`。`surface` 为 `gallery` 或 `discover`。首页传 `gallery`，其余入口传 `discover`。不要为每张照片写回计算结果；改一个相簿的授权后，所有成员立刻按新档位生效。`collection_photos(photo_id)` 和 `faces(photo_id)` 上要有索引，供这个聚合查询使用。

伪代码：

```text
rank = max(每个所属集合的档位)  -- 含人物相册；没有则 0
visible =
  deleted_at is null
  and library_enabled
  and viewer_rank >= rank
  and every password collection is unlocked or exempt
  and (surface != gallery or (every manual/folder collection show_on_gallery = 1 and no password wall))
```

### 4.5 可以合并或删除的机器学习表

| 现表 | 处理 |
| --- | --- |
| `ml_tag_vectors` | 删表。`model`、`embedding`、`dim`、`embedded_prompt` 改成 `ml_tags` 的列。一行标签本来就只有一份向量 |
| `ml_state` | 删表。水位写入 `settings`，命名空间 `ml` |
| `photo_face_scans` | 删表。`photos` 增加 `face_scanned_at`。非空表示扫过，包括零张脸 |
| `person_photos` | 删表。在 `faces` 里用 `source=manual` 且坐标可空表示管理员补入的照片 |
| `asset_faces` | 改名为 `faces`，或保留表名只改注释。不要新建第三张人脸表 |

`ml_tags`、`ml_tag_aliases`、`photo_ml_tags` 留下。同义词是一对多，照片标签上还有来源和拒绝决定，并进一行会丢数据。

`photo_embeddings`、`face_embeddings` 留下。它们和业务行一对一，但二进制大，放进 `photos` 会让首页列表查询变慢。

### 4.6 往手工相簿和人物相册里添加照片

添加照片不新建表。手工相簿写入 `collection_photos`，人物相册写入 `faces` 且 `source=manual`、坐标为空。扫描文件夹集合不能用这个入口，它的成员由路径决定。

两个页面共用一个组件 `PhotoPickerModal`：

- 相簿设置：`AlbumEditSlideover` 仅在 `kind=manual` 且相簿已经保存、有 id 时，在表单底部放「添加照片」。新建未保存时按钮禁用，提示先保存相簿。`kind=folder` 不渲染该按钮。
- 人物相册：`/dashboard/people` 上现有的「添加照片」改为打开同一个组件。目标是该人物的 `kind=person` 集合，不再单独维护一套弹窗。

弹窗行为：

1. 打开后请求第一页候选，不预加载全部照片。
2. 顶部搜索框。输入停 300ms 后从第一页重查。匹配标题、照片 id、扫描相对路径、城市、地点名。关键字里的 `%` 和 `_` 去掉后再 `LIKE`。
3. 缩略图网格。点一张即选中，再点取消。可选一张，也可连续点多张。已在当前相簿或当前人物里的格子标「已加入」，不能再选，也不计入提交。
4. 底部显示已选数量。提供「选中本页」和「清空」。确认按钮在已选为 0 时禁用。一次最多提交 500 张；超出时禁止继续点选并提示。
5. 列表滚到底部再取下一页，每页 48 张。翻页不清除已选。搜索条件变化时清空已选，避免把上一批关键字下的 id 加进去。
6. 确认后关闭弹窗。相簿设置页更新照片数；人物卡片更新照片数。返回 `{ added, already }`，用现有提示文案即可。

候选接口只有一个，管理员路由：

```text
GET /api/picker/photos?collectionId=<id>&q=<text>&cursor=<dateTaken,id>&limit=48
```

返回 `{ items: [{ id, title, thumbnailUrl, dateTaken, already }], nextCursor }`。`already` 在服务端按集合种类算：`manual` 查 `collection_photos`；`person` 查 `faces` 里该人物的任意来源（自动脸和手动补入都算已加入）；`folder` 不提供这个接口。排序为 `date_taken` 降序，空日期放最后，再用 `id` 降序断开并列。游标用上一页最后一条的 `dateTaken` 和 `id`，不用 `OFFSET`，这样入库过程中翻页不会跳行或重复。

只列出 `deleted_at` 为空、且所属库仍启用的照片。这是管理端候选，不套用首页的 `show_on_gallery`，否则管理员无法把「不进首页」的照片放进相簿。仍排除回收站。

写入只用一个接口 `POST /api/collections/:id/photos`，body `{ photoIds }`。按 `kind` 分落点：

| `kind` | 写入 |
| --- | --- |
| `manual` | `collection_photos`，`position` 在当前最大值上每次加 10。相簿还没有封面时，用本次第一张作 `cover_photo_id`。已存在的 `(collection_id, photo_id)` 跳过 |
| `person` | `faces` 插入 `source=manual`、坐标为空的一行，`person_id` 取 `people.collection_id` 等于该集合的那个人。该人物已经有这张照片的脸或手动行时跳过。不改已经识别出的其他人脸。一张照片可以同时在多个人物相册里 |
| `folder` | 返回 400。成员由扫描路径决定 |

接口校验 id 属于未删除照片，非法 id 跳过不报整批失败。目标不存在返回 404。一次超过 500 张返回 400。

从照片管理页勾选后「加入相簿 / 加入人物」的现有批量入口保留，调用同一对写入函数。选择器只是另一个调用方。

## 5. 迁移顺序

每一步都要能单独上线。SQLite 不方便一次重建，按「加新表、回填、改读写、删旧表」做。

### 阶段 A：加新表并回填

1. 建 `libraries`，从 `scan_libraries` 复制 id、路径、启用状态、扫描时间。
2. 建 `collections`、`collection_photos`、`access_grants`。
3. 每个 `albums` 行复制为 `kind=manual` 的集合，`collection_photos` 复制 `album_photos`。
4. 每个扫描库建一条 `kind=folder`、`rel_path=''` 的根集合。每条 `scan_album_meta` 再建子集合，`parent_id` 按路径最长前缀接上。
5. 按第 4.3 节的对照表写 `access_grants`。`visibility=public` 或旧的 `is_hidden=0` 且没有 visibility 时写 `public`。`login` 或旧 `is_hidden=1` 写 `login`。`admin` 写 `admin`。免密 JSON 里的邮箱匹配 `users.email` 后写 `user` 行；匹配不到的邮箱记日志，不静默丢弃，迁移脚本打印名单。
6. 每个 `people` 建一条 `kind=person` 的集合，`show_on_albums=0`，`people.collection_id` 指过去。人物原来的 `visibility` 写成该集合的 `access_grants`，不再使用 `resource_type=person`。已有人物的 `origin` 写成 `ml`。只有 `person_photos`、没有脸框、并且有姓名的，写成 `manual`。
7. `photos` 增加 `library_id`、`face_scanned_at`。用 `library_mount` 名字回填 `library_id`。`photo_face_scans` 的时间写入 `face_scanned_at`。
8. `ml_tags` 增加向量列，从 `ml_tag_vectors` 拷贝。
9. `faces.source=manual` 吃掉 `person_photos`：没有对应脸框的补一行坐标为空的脸。

此阶段应用仍读旧表。用只读 SQL 抽查：每张旧相簿的可见范围，和新授权行一致；抽 20 张扫描照片，新旧首页条件结果相同。

### 阶段 B：应用改读新表

1. `photoVisibleSql` 只查 `access_grants`、`collections`、`libraries`、`faces`。
2. 相簿设置页写集合和授权，不再写 `visibility` 与免密 JSON。
3. 人物设置页改写该人物集合的授权，并提供「新建人物」。相册页查询排除 `kind=person`。前台 `/people` 按第 4.2 节的成员规则列出，手建人物在加过至少一张可见照片后出现。添加照片改用第 4.6 节的 `PhotoPickerModal`，人物成员写入 `faces.source=manual`。
4. 扫描入库把 `library_id` 写上。文件夹集合在管理员第一次改这个目录时创建，不要为每个子目录预插空行。
5. 首页、搜索、地图、人物、相簿照片列表全部改为这一个 SQL。
6. 路由表 `server/utils/access.ts` 保持原样。

上线后观察一轮。旧表仍在，发现不一致可以退回读取。

### 阶段 C：删除旧结构

确认没有代码再读这些对象后删除：

- 表：`albums`、`album_photos`、`scan_album_meta`、`scan_libraries`、`ml_tag_vectors`、`ml_state`、`photo_face_scans`、`person_photos`
- 列：`photos.library_mount`（由 `library_id` 代替）、`users.is_admin`（由 `role` 代替）、所有明文 `password`、`random_wheel_animation`、`people.is_hidden`

删除前做一次数据库文件备份。SQLite 删列用重建表的方式，按现有迁移风格写新的 SQL 文件，不要改已经发布的迁移。

## 6. 不要做的合并

- 不要把 CLIP、人脸向量、OCR 并成一张 `photo_ai`。三者更新时间不同，OCR 还要走全文索引。
- 不要把队列并进 `photos`。失败重试和照片生命周期不同。
- 不要为每张照片写一条 `access_grants`。几十万张照片会使授权表变成照片表的复制品，首页查询更慢。
- 不要把路由白名单放进数据库。那是部署行为，不是用户数据，放代码里才能在评审时看见谁把接口公开了。
- 不要引入角色表、权限点表、资源树。当前没有多角色，`users.role` 两个值够用。以后真要共享给外部账号，再加 `audience=link` 的授权行，而不是现在就建分享系统。

## 7. 重构后的数量

业务表从现在约 24 张收到约 18 张。减少的是重复的相簿元数据和一对一附属表，不是把向量和关系表压扁。

照片是否显示只经过 `access_grants` 这一张权限表，再加上集合成员、扫描路径或人物脸、库是否启用。人物相册是 `kind=person` 的集合，只在人物页列出，它的授权仍参与取严。一张照片有多个所属时，取这些授权里最严的档位，而不是任一通过即可。设置页上的「所有人 / 仅登录 / 仅管理员 / 密码 / 免密」都写成这张表的行。
