import { sql } from 'drizzle-orm'
import {
  sqliteTable,
  text,
  integer,
  real,
  blob,
  uniqueIndex,
  index,
  primaryKey,
  check,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core'
import type { NeededExif } from '~~/shared/types/photo'
import type { StorageConfig } from '../services/storage'

type PipelineQueuePayload =
  | {
      type: 'photo'
      storageKey: string
      eraseLocation?: boolean
    }
  | {
      type: 'live-photo-video'
      storageKey: string
    }
  | {
      type: 'photo-reverse-geocoding'
      photoId: string
      latitude?: number | null
      longitude?: number | null
    }
  | {
      type: 'photo-erase-location'
      photoId: string
    }
  | {
      type: 'photo-smart-search'
      photoId: string
    }
  | {
      type: 'photo-face-detection'
      photoId: string
      /** Full reindex batch: defer recognition until all detections finish. */
      reindexBatch?: boolean
    }
  | {
      type: 'photo-face-recognition'
      faceId?: string
      deferred?: boolean
    }
  | {
      type: 'photo-ocr'
      photoId: string
    }

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  username: text('name').notNull().unique(),
  email: text('email').notNull().unique(),
  password: text('password'),
  avatar: text('avatar'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  isAdmin: integer('is_admin').default(0).notNull(),
  /** admin / user。读权限以本列为准，is_admin 仅作迁移过渡。 */
  role: text('role', { enum: ['admin', 'user'] }).notNull().default('user'),
  // 两次验证（TOTP）：secret 在开启前先生成并暂存，用户用验证器扫码确认后才置 enabled
  totpSecret: text('totp_secret'),
  totpEnabled: integer('totp_enabled', { mode: 'boolean' })
    .default(false)
    .notNull(),
})

// 登入记录：记录每次登入尝试（成功/失败/待两步验证），用于账户安全审计。
// userId 对未知账户（登录邮箱不存在）为 null，此时以 email 留存失败足迹。
export const loginLogs = sqliteTable(
  'login_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    // 关联用户；登入邮箱不存在时（失败尝试）为 null
    userId: integer('user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    // 尝试登入的邮箱（冗余保存，便于未知账户失败记录定位）
    email: text('email').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    // IP 归属地（离线库解析，失败/内网为 null）
    country: text('country'),
    region: text('region'),
    city: text('city'),
    // 认证途径：password 邮箱密码 / two-factor 两步验证 / github OAuth
    method: text('method', {
      enum: ['password', 'two-factor', 'github'],
    })
      .default('password')
      .notNull(),
    // 结果：challenge=密码正确但需两步验证（待验证）
    status: text('status', {
      enum: ['success', 'failed', 'challenge'],
    }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    index('idx_login_logs_user_created').on(table.userId, table.createdAt),
    index('idx_login_logs_email_created').on(table.email, table.createdAt),
  ],
)

export const photos = sqliteTable('photos', {
  id: text('id').primaryKey(),
  title: text('title'),
  description: text('description'),
  width: integer('width'),
  height: integer('height'),
  aspectRatio: real('aspect_ratio'),
  dateTaken: text('date_taken'),
  storageKey: text('storage_key'),
  thumbnailKey: text('thumbnail_key'),
  fileSize: integer('file_size'),
  lastModified: text('last_modified'),
  originalUrl: text('original_url'),
  thumbnailUrl: text('thumbnail_url'),
  thumbnailHash: text('thumbnail_hash'),
  tags: text('tags', { mode: 'json' }).$type<string[]>(),
  exif: text('exif', { mode: 'json' }).$type<NeededExif>(),
  // 地理位置信息
  latitude: real('latitude'),
  longitude: real('longitude'),
  country: text('country'),
  city: text('city'),
  locationName: text('location_name'),
  // LivePhoto 相关字段
  isLivePhoto: integer('is_live_photo').default(0).notNull(),
  livePhotoVideoUrl: text('live_photo_video_url'),
  livePhotoVideoKey: text('live_photo_video_key'),
  // 360 全景手动标记：null=自动判定；1=强制全景；0=强制非全景
  isPanorama: integer('is_panorama'),
  // 360 全景固定初始视角（度）：null=不固定；前台打开全景时按该视角进入
  panoYaw: real('pano_yaw'),
  panoPitch: real('pano_pitch'),
  // 媒体类型：image 图片 / video 视频
  type: text('type', { enum: ['image', 'video'] })
    .default('image')
    .notNull(),
  // 来源：upload 后台上传 / library 本地目录映射
  source: text('source', { enum: ['upload', 'library'] })
    .default('upload')
    .notNull(),
  // 本地库文件：映射目录 + 目录内相对路径
  libraryMount: text('library_mount'),
  /** 所属扫描库。上传照片为空。挂载名仍是 scan_<library_id>。 */
  libraryId: integer('library_id').references(() => libraries.id, {
    onDelete: 'cascade',
  }),
  /** 人脸检测完成时间。非空表示扫过，包括零张脸。 */
  faceScannedAt: integer('face_scanned_at', { mode: 'timestamp' }),
  libraryPath: text('library_path'),
  // 回收站软删除标记：null=正常；非 null=已移入回收站（该时间戳即删除时刻）
  deletedAt: integer('deleted_at', { mode: 'timestamp' }),
}, (table) => [
  index('idx_photos_gallery_order')
    .on(sql`${table.dateTaken} DESC`, sql`${table.id} ASC`)
    .where(sql`${table.deletedAt} IS NULL`),
  index('idx_photos_geo_timeline')
    .on(sql`${table.dateTaken} ASC`, sql`${table.id} ASC`)
    .where(
      sql`${table.deletedAt} IS NULL AND ${table.latitude} IS NOT NULL AND ${table.longitude} IS NOT NULL`,
    ),
  index('idx_photos_library_path').on(table.libraryId, table.libraryPath),
  index('idx_photos_library_deleted').on(table.libraryId, table.deletedAt),
  index('idx_photos_mount_path').on(table.libraryMount, table.libraryPath),
  check(
    'photos_latitude_check',
    sql`${table.latitude} IS NULL OR (${table.latitude} >= -90 AND ${table.latitude} <= 90)`,
  ),
  check(
    'photos_longitude_check',
    sql`${table.longitude} IS NULL OR (${table.longitude} >= -180 AND ${table.longitude} <= 180)`,
  ),
])

export const pipelineQueue = sqliteTable('pipeline_queue', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  payload: text('payload', { mode: 'json' })
    .$type<PipelineQueuePayload>()
    .notNull()
    .default({
      type: 'photo',
      storageKey: '',
    } satisfies PipelineQueuePayload),
  priority: integer('priority').default(0).notNull(),
  attempts: integer('attempts').default(0).notNull(),
  maxAttempts: integer('max_attempts').default(3).notNull(),
  status: text('status', {
    enum: [
      'pending', // Waiting to be processed
      'in-stages', // Currently being processed
      'completed', // Successfully processed
      'failed', // Processing failed
    ],
  })
    .notNull()
    .default('pending'),
  statusStage: text('status_stage', {
    enum: [
      'preprocessing',
      'metadata',
      'thumbnail',
      'exif',
      'motion-photo',
      'reverse-geocoding',
      'live-photo',
      'location-erase',
      'smart-search',
      'face-detection',
      'face-recognition',
      'ocr',
    ],
  }),
  errorMessage: text('error_message'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
}, (table) => [
  index('idx_pipeline_queue_pending').on(
    table.status,
    sql`${table.priority} DESC`,
    sql`${table.createdAt} ASC`,
  ),
  index('idx_pipeline_queue_status_completed').on(
    table.status,
    table.completedAt,
  ),
])

// 照片表态表
export const photoReactions = sqliteTable(
  'photo_reactions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    photoId: text('photo_id')
      .notNull()
      .references(() => photos.id, { onDelete: 'cascade' }),
    reactionType: text('reaction_type', {
      enum: ['like', 'love', 'amazing', 'funny', 'wow', 'sad', 'fire', 'sparkle'],
    }).notNull(),
    // 使用指纹而不是 IP 地址，更准确且支持匿名用户
    fingerprint: text('fingerprint').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex('photo_reactions_photo_fingerprint_unique').on(
      table.photoId,
      table.fingerprint,
    ),
    index('idx_photo_reactions_photo_type').on(
      table.photoId,
      table.reactionType,
    ),
    index('idx_photo_reactions_fingerprint_created').on(
      table.fingerprint,
      table.createdAt,
    ),
  ],
)

// 音乐盒（BGM）：管理员上传的背景音乐，可绑定到相簿/照片画廊，
// 进入相簿时自动播放。实际音频文件存于存储后端（storage provider），
// 此表仅存元数据与存储 key。
export const music = sqliteTable('music', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  // 显示标题（默认取文件名，可编辑）
  title: text('title').notNull(),
  // 原始文件名
  filename: text('filename').notNull(),
  // 存储后端中的对象 key（形如 music/{id}/<file>）
  storageKey: text('storage_key').notNull().unique(),
  // MIME 类型（audio/mpeg 等）
  mimeType: text('mime_type').notNull().default('audio/mpeg'),
  // 时长（秒，解析自文件；未知为 null）
  duration: real('duration'),
  fileSize: integer('file_size').notNull().default(0),
  // 歌词（LRC 格式文本；为空表示无歌词）
  lyrics: text('lyrics'),
  // 自定义封面：存储后端对象键 + 公开访问 URL（为空表示未设置）
  coverKey: text('cover_key'),
  coverUrl: text('cover_url'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

export const settings = sqliteTable(
  'settings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    namespace: text('namespace').notNull().default('common'),
    key: text('key').notNull(),
    type: text('type', {
      enum: ['string', 'number', 'boolean', 'json'],
    }).notNull(),
    value: text('value'),
    defaultValue: text('default_value'),
    label: text('label'),
    description: text('description'),
    isPublic: integer('is_public', { mode: 'boolean' })
      .default(false)
      .notNull(),
    isReadonly: integer('is_readonly', { mode: 'boolean' })
      .default(false)
      .notNull(),
    isSecret: integer('is_secret', { mode: 'boolean' })
      .default(false)
      .notNull(),
    enum: text('enum', { mode: 'json' }).$type<string[] | null>(),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedBy: integer('updated_by').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [uniqueIndex('idx_namespace_key').on(t.namespace, t.key)],
)

export const settingsStorageProviders = sqliteTable(
  'settings_storage_providers',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    provider: text('provider', {
      enum: ['s3', 'local', 'openlist'],
    }).notNull(),
    config: text('config', { mode: 'json' }).$type<StorageConfig>().notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
)

/**
 * 扫描目录本身。展示方式、密码和子相簿插页在该库根集合上，不在本表。
 */
export const libraries = sqliteTable('libraries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  urlKey: text('url_key').unique(),
  rootPath: text('root_path').notNull().unique(),
  provider: text('provider', { enum: ['local'] }).default('local').notNull(),
  displayMode: text('display_mode', { enum: ['gallery', 'album', 'both'] })
    .default('gallery')
    .notNull(),
  childInParent: integer('child_in_parent', { mode: 'boolean' })
    .default(true)
    .notNull(),
  childPosition: text('child_position', { enum: ['start', 'end'] })
    .default('start')
    .notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).default(true).notNull(),
  watchIntervalMs: integer('watch_interval_ms').default(60000).notNull(),
  lastScanAt: integer('last_scan_at', { mode: 'timestamp' }),
  lastScanResult: text('last_scan_result'),
  disabledAt: integer('disabled_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

/** 手工相簿、扫描文件夹、人物相册。谁能看写在 access_grants。 */
export const collections = sqliteTable(
  'collections',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind', { enum: ['manual', 'folder', 'person'] }).notNull(),
    parentId: integer('parent_id').references(
      (): AnySQLiteColumn => collections.id,
      { onDelete: 'set null' },
    ),
    libraryId: integer('library_id').references(() => libraries.id, {
      onDelete: 'cascade',
    }),
    relPath: text('rel_path').notNull().default(''),
    title: text('title'),
    description: text('description'),
    coverPhotoId: text('cover_photo_id').references(() => photos.id, {
      onDelete: 'set null',
    }),
    bgmMusicId: integer('bgm_music_id').references(() => music.id, {
      onDelete: 'set null',
    }),
    uid: text('uid'),
    slug: text('slug'),
    urlKey: text('url_key'),
    layout: text('layout', {
      enum: ['waterfall', 'grid', 'immersive', 'timeline'],
    })
      .notNull()
      .default('waterfall'),
    showOnGallery: integer('show_on_gallery', { mode: 'boolean' })
      .notNull()
      .default(true),
    showOnAlbums: integer('show_on_albums', { mode: 'boolean' })
      .notNull()
      .default(true),
    childInParent: integer('child_in_parent', { mode: 'boolean' })
      .notNull()
      .default(true),
    childPosition: text('child_position', { enum: ['start', 'end'] })
      .notNull()
      .default('start'),
    randomAnimation: text('random_animation', {
      enum: ['default', 'wheel', 'compat'],
    })
      .notNull()
      .default('default'),
    randomQuotesEnabled: integer('random_quotes_enabled', { mode: 'boolean' })
      .notNull()
      .default(true),
    randomQuotes: text('random_quotes'),
    randomQuotesTag: text('random_quotes_tag', { enum: ['ancient', 'modern'] }),
    passwordHash: text('password_hash'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex('collections_uid_unique').on(table.uid),
    uniqueIndex('collections_slug_unique').on(table.slug),
    uniqueIndex('collections_url_key_unique').on(table.urlKey),
    uniqueIndex('collections_folder_path_unique')
      .on(table.libraryId, table.relPath)
      .where(sql`${table.kind} = 'folder'`),
    index('idx_collections_library_parent').on(table.libraryId, table.parentId),
    check(
      'collections_kind_scope_check',
      sql`(${table.kind} = 'folder' AND ${table.libraryId} IS NOT NULL) OR (${table.kind} IN ('manual', 'person') AND ${table.libraryId} IS NULL)`,
    ),
    check(
      'collections_manual_identity_check',
      sql`${table.kind} != 'manual' OR (${table.title} IS NOT NULL AND ${table.uid} IS NOT NULL)`,
    ),
  ],
)

/** 手工相簿成员。文件夹与人物相册不使用本表。 */
export const collectionPhotos = sqliteTable(
  'collection_photos',
  {
    collectionId: integer('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    photoId: text('photo_id')
      .notNull()
      .references(() => photos.id, { onDelete: 'cascade' }),
    position: real('position').notNull().default(1000000),
    addedAt: integer('added_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    primaryKey({ columns: [table.collectionId, table.photoId] }),
    index('idx_collection_photos_photo').on(table.photoId),
  ],
)

/**
 * 谁能看一个集合。audience=user 且 user_id 为空表示全体登录用户免密，不参与档位。
 */
export const accessGrants = sqliteTable(
  'access_grants',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    collectionId: integer('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    audience: text('audience', {
      enum: ['public', 'login', 'admin', 'user'],
    }).notNull(),
    userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex('access_grants_principal_unique')
      .on(table.collectionId, table.audience, table.userId)
      .where(sql`${table.userId} IS NOT NULL`),
    uniqueIndex('access_grants_scope_unique')
      .on(table.collectionId, table.audience)
      .where(sql`${table.userId} IS NULL`),
    index('idx_access_grants_collection').on(table.collectionId),
    index('idx_access_grants_user').on(table.userId),
    check(
      'access_grants_user_scope_check',
      sql`${table.audience} = 'user' OR ${table.userId} IS NULL`,
    ),
    check(
      'access_grants_audience_check',
      sql`${table.audience} IN ('public', 'login', 'admin', 'user')`,
    ),
  ],
)

// —— ML / AI：内容搜索、人脸、人物、OCR ——

/** CLIP 图像向量（一期 SQLite blob；检索时可暴力余弦） */
export const photoEmbeddings = sqliteTable(
  'photo_embeddings',
  {
    photoId: text('photo_id')
      .primaryKey()
      .references(() => photos.id, { onDelete: 'cascade' }),
    model: text('model').notNull(),
    embedding: blob('embedding', { mode: 'buffer' }).notNull(),
    dim: integer('dim').notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [index('idx_photo_embeddings_model').on(table.model)],
)

/** 人物（一期单租户扁平模型；owner_id 预留给以后的多用户） */
export const people = sqliteTable(
  'people',
  {
    id: text('id').primaryKey(),
    name: text('name'),
    /** Reserved. Null while Chronoval is single-tenant. */
    ownerId: text('owner_id'),
    /** 对应的 kind=person 集合。授权写在该集合上。 */
    collectionId: integer('collection_id')
      .unique()
      .references(() => collections.id, { onDelete: 'cascade' }),
    /** ml=聚类生成；manual=管理员手建，清理任务不得删除。 */
    origin: text('origin', { enum: ['ml', 'manual'] }).notNull().default('ml'),
    thumbnailFaceId: text('thumbnail_face_id'),
    faceCount: integer('face_count').default(0).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [index('idx_people_name').on(table.name)],
)

/** 检测到的人脸框 */
export const assetFaces = sqliteTable(
  'asset_faces',
  {
    id: text('id').primaryKey(),
    photoId: text('photo_id')
      .notNull()
      .references(() => photos.id, { onDelete: 'cascade' }),
    personId: text('person_id').references(() => people.id, {
      onDelete: 'set null',
    }),
    /** 相对坐标 0–1，便于不同分辨率缩略图对齐 */
    x1: real('x1').notNull(),
    y1: real('y1').notNull(),
    x2: real('x2').notNull(),
    y2: real('y2').notNull(),
    imageWidth: integer('image_width').notNull(),
    imageHeight: integer('image_height').notNull(),
    score: real('score').notNull(),
    source: text('source', { enum: ['ml', 'manual'] })
      .default('ml')
      .notNull(),
    /** 1=固定归此人物，全量重聚类不清空。手建锚点使用。 */
    pinned: integer('pinned', { mode: 'boolean' }).default(false).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    index('idx_asset_faces_photo').on(table.photoId),
    index('idx_asset_faces_person').on(table.personId),
  ],
)

/** 人脸 ArcFace embedding */
export const faceEmbeddings = sqliteTable('face_embeddings', {
  faceId: text('face_id')
    .primaryKey()
    .references(() => assetFaces.id, { onDelete: 'cascade' }),
  model: text('model').notNull(),
  embedding: blob('embedding', { mode: 'buffer' }).notNull(),
  dim: integer('dim').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

/** OCR 全文（配合 FTS5 虚拟表 photo_ocr_fts） */
export const photoOcr = sqliteTable('photo_ocr', {
  photoId: text('photo_id')
    .primaryKey()
    .references(() => photos.id, { onDelete: 'cascade' }),
  text: text('text').notNull().default(''),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

/**
 * 管理员维护的搜图候选标签。模型只能从这里面打标签。
 * nameKey / aliasKey 用于大小写不敏感的唯一约束。
 */
export const mlTags = sqliteTable(
  'ml_tags',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    nameKey: text('name_key').notNull(),
    prompt: text('prompt').notNull(),
    /** 标签 prompt 的向量缓存，与标签同生命周期。 */
    vectorModel: text('vector_model'),
    vectorPrompt: text('vector_prompt'),
    embedding: blob('embedding', { mode: 'buffer' }),
    dim: integer('dim'),
    enabled: integer('enabled', { mode: 'boolean' }).default(true).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [uniqueIndex('ml_tags_name_key_unique').on(table.nameKey)],
)

/** 一个标签多行同义词。aliasKey 全局唯一，同一个词不能挂到两个标签上。 */
export const mlTagAliases = sqliteTable(
  'ml_tag_aliases',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    tagId: integer('tag_id')
      .notNull()
      .references(() => mlTags.id, { onDelete: 'cascade' }),
    alias: text('alias').notNull(),
    aliasKey: text('alias_key').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex('ml_tag_aliases_alias_key_unique').on(table.aliasKey),
    index('idx_ml_tag_aliases_tag').on(table.tagId),
  ],
)

/**
 * 照片和候选标签的多对多关系。人工记录锁住该行，重跑识别不会覆盖。
 * decision=reject 表示管理员明确排除，自动打标会跳过。
 */
export const photoMlTags = sqliteTable(
  'photo_ml_tags',
  {
    photoId: text('photo_id')
      .notNull()
      .references(() => photos.id, { onDelete: 'cascade' }),
    tagId: integer('tag_id')
      .notNull()
      .references(() => mlTags.id, { onDelete: 'cascade' }),
    source: text('source', { enum: ['auto', 'manual'] }).notNull(),
    decision: text('decision', { enum: ['apply', 'reject'] }).notNull(),
    score: real('score'),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    primaryKey({ columns: [table.photoId, table.tagId] }),
    index('idx_photo_ml_tags_tag').on(table.tagId),
  ],
)

/**
 * 本地常见地点库：选点搜索优先查此表，未命中再走外部地理编码。
 * aliases 用英文分号 `;` 分隔；坐标为 WGS84。
 */
export const geocodePlaces = sqliteTable(
  'geocode_places',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** 展示用主名称（中文），如「郑州市」 */
    name: text('name').notNull(),
    /** 英文名，可选 */
    nameEn: text('name_en'),
    /** 别名，英文分号分隔，如「郑州;Zhengzhou」 */
    aliases: text('aliases'),
    /** 全拼（小写、空格分隔），如「zheng zhou shi」 */
    pinyin: text('pinyin'),
    /** 简拼（小写无空格），如「zzs」 */
    pinyinAbbr: text('pinyin_abbr'),
    /** 纬度 WGS84，南纬为负 */
    latitude: real('latitude').notNull(),
    /** 经度 WGS84，西经为负 */
    longitude: real('longitude').notNull(),
    /** 国家，建议填「中国」 */
    country: text('country'),
    /** 省 / 直辖市 / 自治区 */
    province: text('province'),
    /** 地级市或直辖市城区名 */
    city: text('city'),
    /** 区 / 县 / 县级市 */
    district: text('district'),
    /**
     * 地点类型：
     * province | city | district | town | poi | landmark | other
     */
    placeType: text('place_type'),
    /** 行政区划代码（国标或自定义），可选 */
    adminCode: text('admin_code'),
    /** 排序权重，越大越靠前；省会/热门景点可调高 */
    priority: integer('priority').default(0).notNull(),
    /** 是否参与搜索：1 启用，0 禁用 */
    enabled: integer('enabled', { mode: 'boolean' }).default(true).notNull(),
    /** 数据来源备注，如「手工」「高德导出」 */
    source: text('source'),
    /** 自由备注 */
    notes: text('notes'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    index('idx_geocode_places_enabled_priority').on(
      table.enabled,
      table.priority,
    ),
    index('idx_geocode_places_name').on(table.name),
    index('idx_geocode_places_city').on(table.city),
    index('idx_geocode_places_province').on(table.province),
    index('idx_geocode_places_district').on(table.district),
    index('idx_geocode_places_place_type').on(table.placeType),
    check(
      'geocode_places_latitude_check',
      sql`${table.latitude} >= -90 AND ${table.latitude} <= 90`,
    ),
    check(
      'geocode_places_longitude_check',
      sql`${table.longitude} >= -180 AND ${table.longitude} <= 180`,
    ),
  ],
)

/** Small idempotent initialization markers, including the geocode seed version. */
export const appMeta = sqliteTable('app_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})
