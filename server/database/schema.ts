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
  | { type: 'photo-process'; photoId: string; uploadSessionId: string }
  | { type: 'photo-purge'; photoId: string }
  | { type: 'upload-cleanup'; uploadSessionId: string }
  | { type: 'ownership-transfer' | 'ownership-transfer-cleanup'; transferId: string }
  | { type: 'user-deletion'; userId: number }
  | {
      type: 'photo'
      photoId: string
      eraseLocation?: boolean
    }
  | {
      type: 'live-photo-video'
      photoId: string
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
  | {
      /** 外部扫描库单文件重处理（扫描失败的文件入队重试，可在 /queue 队列管理查看） */
      type: 'library-file'
      /** 扫描库挂载名 */
      mount: string
      /** 库内相对路径 */
      libraryPath: string
      /** 文件 mtime（同一文件版本失败去重用） */
      lastModified?: string
      /** 扫描时的失败原因（供排查参考；重试以实际错误为准） */
      reason?: string
    }

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  username: text('username').notNull().unique(),
  usernameKey: text('username_key').notNull().unique(),
  displayName: text('display_name').notNull(),
  email: text('email').notNull().unique(),
  emailKey: text('email_key').notNull().unique(),
  password: text('password_hash'),
  avatar: text('avatar'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  role: text('role', { enum: ['admin', 'user'] }).notNull().default('user'),
  status: text('status', { enum: ['active', 'disabled', 'deleting', 'deleted'] }).notNull().default('active'),
  canUpload: integer('can_upload', { mode: 'boolean' }).notNull().default(true),
  mustChangePassword: integer('must_change_password', { mode: 'boolean' }).notNull().default(true),
  authVersion: integer('auth_version').notNull().default(1),
  version: integer('version').notNull().default(1),
  storageQuotaBytes: integer('storage_quota_bytes').default(21474836480),
  createdBy: integer('created_by').references((): AnySQLiteColumn => users.id, { onDelete: 'restrict' }),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  disabledAt: integer('disabled_at', { mode: 'timestamp' }),
  deletedAt: integer('deleted_at', { mode: 'timestamp' }),
  // 两次验证（TOTP）：secret 在开启前先生成并暂存，用户用验证器扫码确认后才置 enabled
  totpSecret: text('totp_secret'),
  totpEnabled: integer('totp_enabled', { mode: 'boolean' })
    .default(false)
    .notNull(),
}, (t) => [
  check('users_identity_check', sql`${t.username} = ${t.usernameKey} AND ${t.email} = ${t.emailKey}`),
  check('users_username_check', sql`length(${t.username}) BETWEEN 3 AND 32 AND ${t.username} GLOB '[a-z]*' AND ${t.username} NOT GLOB '*[^a-z0-9_-]*' AND ${t.username} NOT IN ('con','prn','aux','nul','com1','com2','com3','com4','com5','com6','com7','com8','com9','lpt1','lpt2','lpt3','lpt4','lpt5','lpt6','lpt7','lpt8','lpt9')`),
  check('users_email_normalized_check', sql`${t.email}=lower(trim(${t.email}))`),
  check('users_role_check', sql`${t.role} IN ('admin','user')`),
  check('users_status_check', sql`${t.status} IN ('active','disabled','deleting','deleted')`),
  check('users_versions_check', sql`${t.authVersion} >= 1 AND ${t.version} >= 1`),
  check('users_quota_check', sql`${t.storageQuotaBytes} IS NULL OR ${t.storageQuotaBytes} >= 0`),
  index('idx_users_status_role').on(t.status, t.role),
])

export const userStorageUsage = sqliteTable('user_storage_usage', {
  userId: integer('user_id').primaryKey().references(() => users.id, { onDelete: 'restrict' }),
  usedBytes: integer('used_bytes').notNull().default(0),
  reservedBytes: integer('reserved_bytes').notNull().default(0),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (t) => [check('usage_nonnegative_check', sql`${t.usedBytes} >= 0 AND ${t.reservedBytes} >= 0`)])

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
    email: text('account_email_snapshot'),
    loginIdentifier: text('login_identifier').notNull(),
    identifierType: text('identifier_type', { enum: ['username', 'email'] }).notNull(),
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
    index('idx_login_logs_identifier_created').on(table.loginIdentifier, table.createdAt),
  ],
)

export const photos = sqliteTable('photos', {
  id: text('id').primaryKey(),
  ownershipType: text('ownership_type', { enum: ['site', 'user'] }).notNull().default('site'),
  ownerId: integer('owner_id').references(() => users.id, { onDelete: 'restrict' }),
  uploadedBy: integer('uploaded_by').references(() => users.id, { onDelete: 'restrict' }),
  visibility: text('visibility', { enum: ['inherit', 'private', 'public', 'shared'] }).notNull().default('inherit'),
  processingStatus: text('processing_status', { enum: ['uploading', 'processing', 'ready', 'failed', 'purging'] }).notNull().default('ready'),
  processingErrorCode: text('processing_error_code'),
  transferState: text('transfer_state', { enum: ['idle', 'moving', 'cleanup_pending'] }).notNull().default('idle'),
  activeTransferId: text('active_transfer_id'),
  moderationStatus: text('moderation_status', { enum: ['visible', 'blocked'] }).notNull().default('visible'),
  moderationReason: text('moderation_reason'),
  aclVersion: integer('acl_version').notNull().default(1),
  metadataVersion: integer('metadata_version').notNull().default(1),
  originalFilename: text('original_filename'),
  uploadRelativePath: text('upload_relative_path'),
  storageRelativePath: text('storage_relative_path'),
  preserveOriginal: integer('preserve_original', { mode: 'boolean' }).notNull().default(true),
  stripLocation: integer('strip_location', { mode: 'boolean' }).notNull().default(false),
  originalBytes: integer('original_bytes').notNull().default(0),
  contentChecksum: text('content_checksum'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  title: text('title'),
  description: text('description'),
  width: integer('width'),
  height: integer('height'),
  aspectRatio: real('aspect_ratio'),
  dateTaken: text('date_taken'),
  fileSize: integer('file_size'),
  lastModified: text('last_modified'),
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
  check('photos_ownership_check', sql`(${table.ownershipType}='site' AND ${table.ownerId} IS NULL AND ${table.visibility}='inherit') OR (${table.ownershipType}='user' AND ${table.ownerId} IS NOT NULL AND ${table.visibility} IN ('private','public','shared'))`),
  check('photos_personal_source_check', sql`${table.ownershipType}!='user' OR (${table.source}='upload' AND ${table.libraryId} IS NULL AND ${table.libraryMount} IS NULL AND ${table.libraryPath} IS NULL AND ${table.preserveOriginal}=1)`),
  check('photos_processing_check', sql`${table.processingStatus} IN ('uploading','processing','ready','failed','purging')`),
  check('photos_transfer_check', sql`${table.transferState} IN ('idle','moving','cleanup_pending')`),
  check('photos_moderation_check', sql`${table.moderationStatus} IN ('visible','blocked')`),
  check('photos_versions_bytes_check', sql`${table.originalBytes} >= 0 AND ${table.aclVersion} >= 1 AND ${table.metadataVersion} >= 1`),
  index('idx_photos_owner_created').on(table.ownerId, table.createdAt, table.id),
  index('idx_photos_owner_deleted').on(table.ownerId, table.deletedAt),
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
      photoId: '',
    } satisfies PipelineQueuePayload),
  priority: integer('priority').default(0).notNull(),
  photoId: text('photo_id').references(() => photos.id, { onDelete: 'set null' }),
  uploadSessionId: text('upload_session_id').references(() => uploadSessions.id, { onDelete: 'set null' }),
  dedupeKey: text('dedupe_key'),
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
  uniqueIndex('idx_pipeline_active_dedupe').on(table.dedupeKey).where(sql`${table.status} IN ('pending','in-stages')`),
  index('idx_pipeline_queue_pending').on(
    table.status,
    sql`${table.priority} DESC`,
    sql`${table.createdAt} ASC`,
  ),
  index('idx_pipeline_queue_photo_status').on(table.photoId,table.status),
  index('idx_pipeline_queue_upload_status').on(table.uploadSessionId,table.status),
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
  deleting: integer('deleting', { mode: 'boolean' }).default(false).notNull(),
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

/** 三类集合共用权限字段，指定可见与密码免密关系分别保存。 */
export const collections = sqliteTable(
  'collections',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind', { enum: ['manual', 'folder', 'person'] }).notNull(),
    ownershipType: text('ownership_type', { enum: ['site', 'user'] }).notNull().default('site'),
    ownerId: integer('owner_id').references(() => users.id, { onDelete: 'restrict' }),
    visibility: text('visibility', { enum: ['public', 'login', 'selected', 'admin'] }).notNull().default('public'),
    aclVersion: integer('acl_version').notNull().default(1),
    passwordVersion: integer('password_version').notNull().default(1),
    passwordExemptMode: text('password_exempt_mode', { enum: ['none', 'logged_in', 'selected'] }).notNull().default('none'),
    parentId: integer('parent_id').references(
      (): AnySQLiteColumn => collections.id,
      { onDelete: 'restrict' },
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
    check('collections_visibility_check', sql`${table.visibility} IN ('public','login','selected','admin')`),
    check('collections_exempt_check', sql`${table.passwordExemptMode} IN ('none','logged_in','selected')`),
    check('collections_ownership_check', sql`(${table.ownershipType}='site' AND ${table.ownerId} IS NULL) OR (${table.ownershipType}='user' AND ${table.ownerId} IS NOT NULL AND ${table.kind}='person' AND ${table.visibility}='admin')`),
    check('collections_versions_check', sql`${table.aclVersion}>=1 AND ${table.passwordVersion}>=1`),
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

/** People are partitioned between site assets and each personal owner. */
export const people = sqliteTable(
  'people',
  {
    id: text('id').primaryKey(),
    name: text('name'),
    /** Null only for the site partition. */
    ownerId: integer('owner_id').references(() => users.id, { onDelete: 'restrict' }),
    ownershipType: text('ownership_type', { enum: ['site', 'user'] }).notNull().default('site'),
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
  (table) => [
    index('idx_people_name').on(table.name),
    index('idx_people_partition').on(table.ownershipType,table.ownerId),
    check('people_ownership_check',sql`(${table.ownershipType}='site' AND ${table.ownerId} IS NULL) OR (${table.ownershipType}='user' AND ${table.ownerId} IS NOT NULL)`),
    check('people_count_check',sql`${table.faceCount}>=0`),
  ],
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

/** Durable receipts keep retried batch permission changes from applying twice. */
export const mutationReceipts = sqliteTable('mutation_receipts', {
  id: text('id').primaryKey(),
  actorUserId: integer('actor_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  operationKey: text('operation_key').notNull(),
  requestDigest: text('request_digest').notNull(),
  resultJson: text('result_json', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (t) => [uniqueIndex('mutation_receipt_key_unique').on(t.actorUserId, t.operationKey)])

export const authChallengeUses = sqliteTable('auth_challenge_uses', {
  nonce: text('nonce').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
})

export const userDeletionTasks = sqliteTable('user_deletion_tasks', {
  id: text('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  actorUserId: integer('actor_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  mode: text('mode', { enum: ['transfer', 'purge'] }).notNull(),
  targetUserId: integer('target_user_id').references(() => users.id, { onDelete: 'restrict' }),
  idempotencyKey: text('idempotency_key').notNull(),
  requestDigest: text('request_digest').notNull(),
  reason: text('reason').notNull(),
  state: text('state', { enum: ['pending', 'running', 'failed', 'completed'] }).notNull().default('pending'),
  errorCode: text('error_code'),
  leaseToken: text('lease_token'),
  leaseExpiresAt: integer('lease_expires_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
}, (t) => [
  uniqueIndex('user_deletion_idempotency_unique').on(t.actorUserId, t.idempotencyKey),
  uniqueIndex('user_deletion_active_unique').on(t.userId).where(sql`${t.state}!='completed'`),
  check('user_deletion_state_check',sql`${t.state} IN ('pending','running','failed','completed')`),
  check('user_deletion_mode_check', sql`(${t.mode}='purge' AND ${t.targetUserId} IS NULL) OR (${t.mode}='transfer' AND ${t.targetUserId} IS NOT NULL AND ${t.targetUserId}!=${t.userId})`),
])

export const photoShares = sqliteTable('photo_shares', {
  photoId: text('photo_id').notNull().references(() => photos.id, { onDelete: 'cascade' }),
  recipientUserId: integer('recipient_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  grantedBy: integer('granted_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (t) => [primaryKey({ columns: [t.photoId, t.recipientUserId] }), index('idx_shares_recipient').on(t.recipientUserId, t.photoId)])

export const collectionViewers = sqliteTable('collection_viewers', {
  collectionId: integer('collection_id').notNull().references(() => collections.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  grantedBy: integer('granted_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (t) => [primaryKey({ columns: [t.collectionId, t.userId] }), index('idx_collection_viewers_user').on(t.userId, t.collectionId)])

export const collectionPasswordExemptions = sqliteTable('collection_password_exemptions', {
  collectionId: integer('collection_id').notNull().references(() => collections.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  grantedBy: integer('granted_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (t) => [primaryKey({ columns: [t.collectionId, t.userId] }), index('idx_collection_exempt_user').on(t.userId, t.collectionId)])

export const photoFiles = sqliteTable('photo_files', {
  id: text('id').primaryKey(),
  photoId: text('photo_id').notNull().references(() => photos.id, { onDelete: 'restrict' }),
  role: text('role', { enum: ['original', 'preview', 'thumbnail', 'live_video', 'poster', 'sanitized_download'] }).notNull(),
  originalFilename: text('original_filename'),
  uploadRelativePath: text('upload_relative_path'),
  locatorType: text('locator_type', { enum: ['provider', 'library', 'embedded'] }).notNull(),
  storageProviderId: integer('storage_provider_id').references(() => settingsStorageProviders.id, { onDelete: 'restrict' }),
  storageKey: text('storage_key'),
  libraryId: integer('library_id').references(() => libraries.id, { onDelete: 'restrict' }),
  libraryPath: text('library_path'),
  parentFileId: text('parent_file_id').references((): AnySQLiteColumn => photoFiles.id, { onDelete: 'restrict' }),
  byteOffset: integer('byte_offset'),
  byteLength: integer('byte_length'),
  mimeType: text('mime_type').notNull(),
  byteSize: integer('byte_size').notNull(),
  checksumSha256: text('checksum_sha256'),
  isBillableOriginal: integer('is_billable_original', { mode: 'boolean' }).notNull().default(false),
  state: text('state', { enum: ['staging', 'ready', 'deleting', 'deleted'] }).notNull().default('ready'),
  contentVersion: integer('content_version').notNull().default(1),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (t) => [
  uniqueIndex('photo_files_role_unique').on(t.photoId, t.role),
  uniqueIndex('photo_files_provider_key_unique').on(t.storageProviderId, t.storageKey).where(sql`${t.locatorType}='provider' AND ${t.state}!='deleted'`),
  uniqueIndex('photo_files_library_path_unique').on(t.libraryId, t.libraryPath).where(sql`${t.locatorType}='library' AND ${t.state}!='deleted'`),
  check('photo_files_id_check', sql`length(${t.id})=32 AND ${t.id} NOT GLOB '*[^a-f0-9]*'`),
  check('photo_files_checksum_check',sql`${t.checksumSha256} IS NULL OR (length(${t.checksumSha256})=64 AND ${t.checksumSha256} NOT GLOB '*[^a-f0-9]*')`),
  check('photo_files_billable_check',sql`${t.isBillableOriginal}=0 OR (${t.locatorType}='provider' AND ${t.role} IN ('original','live_video') AND ${t.uploadRelativePath} IS NOT NULL AND ${t.checksumSha256} IS NOT NULL)`),
  check('photo_files_role_check', sql`${t.role} IN ('original','preview','thumbnail','live_video','poster','sanitized_download')`),
  check('photo_files_state_check', sql`${t.state} IN ('staging','ready','deleting','deleted')`),
  check('photo_files_size_check', sql`${t.byteSize}>=0 AND ${t.contentVersion}>=1`),
  check('photo_files_locator_check', sql`(${t.locatorType}='provider' AND ${t.storageProviderId} IS NOT NULL AND ${t.storageKey} IS NOT NULL AND ${t.libraryId} IS NULL AND ${t.libraryPath} IS NULL AND ${t.parentFileId} IS NULL AND ${t.byteOffset} IS NULL AND ${t.byteLength} IS NULL) OR (${t.locatorType}='library' AND ${t.libraryId} IS NOT NULL AND ${t.libraryPath} IS NOT NULL AND ${t.storageProviderId} IS NULL AND ${t.storageKey} IS NULL AND ${t.parentFileId} IS NULL AND ${t.byteOffset} IS NULL AND ${t.byteLength} IS NULL) OR (${t.locatorType}='embedded' AND ${t.parentFileId} IS NOT NULL AND ${t.byteOffset} IS NOT NULL AND ${t.byteLength} IS NOT NULL AND ${t.byteOffset}>=0 AND ${t.byteLength}>0 AND ${t.storageProviderId} IS NULL AND ${t.storageKey} IS NULL AND ${t.libraryId} IS NULL AND ${t.libraryPath} IS NULL)`),
])

export const uploadSessions = sqliteTable('upload_sessions', {
  id: text('id').primaryKey(),
  actorUserId: integer('actor_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  ownerUserId: integer('owner_user_id').references(() => users.id, { onDelete: 'restrict' }),
  photoId: text('photo_id').unique().references(() => photos.id, { onDelete: 'set null' }),
  photoIdSnapshot: text('photo_id_snapshot').notNull().unique(),
  storageProviderId: integer('storage_provider_id').notNull().references(() => settingsStorageProviders.id, { onDelete: 'restrict' }),
  idempotencyKey: text('idempotency_key').notNull(),
  requestDigest: text('request_digest').notNull(),
  state: text('state', { enum: ['created', 'uploading', 'finalizing', 'committed', 'cancelled', 'expired'] }).notNull().default('created'),
  reservedBytes: integer('reserved_bytes').notNull().default(0),
  commitTaskId: integer('commit_task_id'),
  stagingCleanedAt: integer('staging_cleaned_at', { mode: 'timestamp' }),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (t) => [
  uniqueIndex('upload_sessions_idempotency_unique').on(t.actorUserId, t.idempotencyKey),
  index('idx_upload_sessions_expiry').on(t.state, t.expiresAt),
  check('upload_sessions_state_check', sql`${t.state} IN ('created','uploading','finalizing','committed','cancelled','expired')`),
  check('upload_sessions_reserved_check', sql`${t.reservedBytes}>=0`),
])

export const uploadParts = sqliteTable('upload_parts', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull().references(() => uploadSessions.id, { onDelete: 'restrict' }),
  role: text('role', { enum: ['original', 'live_video'] }).notNull(),
  originalFilename: text('original_filename').notNull(),
  uploadRelativePath: text('upload_relative_path').notNull(),
  declaredMime: text('declared_mime').notNull(),
  expectedBytes: integer('expected_bytes').notNull(),
  receivedBytes: integer('received_bytes').notNull().default(0),
  stagingKey: text('staging_key').notNull(),
  finalKey: text('final_key').notNull(),
  detectedMime: text('detected_mime'),
  checksumSha256: text('checksum_sha256'),
  state: text('state', { enum: ['pending', 'receiving', 'uploaded', 'validated', 'promoted', 'rejected', 'deleted'] }).notNull().default('pending'),
  leaseToken: text('lease_token'),
  leaseExpiresAt: integer('lease_expires_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (t) => [
  uniqueIndex('upload_parts_role_unique').on(t.sessionId, t.role),
  check('upload_parts_role_check', sql`${t.role} IN ('original','live_video')`),
  check('upload_parts_state_check', sql`${t.state} IN ('pending','receiving','uploaded','validated','promoted','rejected','deleted')`),
  check('upload_parts_size_check', sql`${t.expectedBytes}>0 AND ${t.receivedBytes}>=0`),
])

export const storagePathClaims = sqliteTable('storage_path_claims', {
  id: text('id').primaryKey(),
  storageProviderId: integer('storage_provider_id').notNull().references(() => settingsStorageProviders.id, { onDelete: 'restrict' }),
  storageKeyNormalized: text('storage_key_normalized').notNull(),
  holderType: text('holder_type', { enum: ['upload', 'file', 'transfer'] }).notNull(),
  holderId: text('holder_id').notNull(),
}, (t) => [uniqueIndex('storage_claim_key_unique').on(t.storageProviderId, t.storageKeyNormalized), index('idx_storage_claim_holder').on(t.holderType, t.holderId)])

export const photoOwnershipTransfers = sqliteTable('photo_ownership_transfers', {
  id: text('id').primaryKey(),
  photoId: text('photo_id').references(() => photos.id, { onDelete: 'set null' }),
  photoIdSnapshot: text('photo_id_snapshot').notNull(),
  fromUserId: integer('from_owner_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  toUserId: integer('to_owner_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  actorUserId: integer('actor_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  idempotencyKey: text('idempotency_key').notNull(),
  requestDigest: text('request_digest').notNull(),
  sourceAclVersion: integer('source_acl_version').notNull(),
  sourceMetadataVersion: integer('source_metadata_version').notNull(),
  state: text('state', { enum: ['preparing', 'copying', 'cutover', 'cleanup_pending', 'completed', 'rolling_back', 'failed'] }).notNull().default('preparing'),
  reason: text('reason').notNull(),
  originalAclJson: text('original_acl_json', { mode: 'json' }).$type<{ visibility: string; recipients: number[] }>().notNull(),
  reservedBytes: integer('expected_original_bytes').notNull(),
  targetReservedBytes: integer('target_reserved_bytes').notNull(),
  leaseToken: text('lease_token'),
  leaseEpoch: integer('lease_epoch').notNull().default(0),
  leaseExpiresAt: integer('lease_expires_at', { mode: 'timestamp' }),
  errorCode: text('error_code'),
  cutoverAt: integer('cutover_at', { mode: 'timestamp' }),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (t) => [
  uniqueIndex('ownership_transfer_idempotency_unique').on(t.actorUserId,t.idempotencyKey),
  uniqueIndex('ownership_transfer_active_unique').on(t.photoId).where(sql`${t.state} NOT IN ('completed','failed')`),
  index('idx_transfer_state').on(t.state,t.updatedAt),
  check('transfer_state_check',sql`${t.state} IN ('preparing','copying','cutover','cleanup_pending','completed','rolling_back','failed')`),
  check('transfer_parties_check',sql`${t.fromUserId}!=${t.toUserId}`),
  check('transfer_bytes_epoch_check',sql`${t.reservedBytes}>=0 AND ${t.targetReservedBytes}>=0 AND ${t.leaseEpoch}>=0`),
])

export const photoTransferFiles = sqliteTable('photo_transfer_files', {
  id: text('id').primaryKey(),
  transferId: text('transfer_id').notNull().references(() => photoOwnershipTransfers.id, { onDelete: 'restrict' }),
  fileId: text('file_id').notNull(),
  role: text('role').notNull(),
  sourceContentVersion: integer('source_content_version').notNull(),
  locatorType: text('locator_type', { enum: ['provider', 'embedded'] }).notNull(),
  storageProviderId: integer('storage_provider_id').references(() => settingsStorageProviders.id, { onDelete: 'restrict' }),
  sourceKey: text('source_key'),
  targetKey: text('target_key'),
  parentFileId: text('parent_file_id'),
  byteOffset: integer('byte_offset'),
  byteLength: integer('byte_length'),
  byteSize: integer('byte_size').notNull(),
  checksumSha256: text('checksum_sha256'),
  state: text('state', { enum: ['pending', 'copied', 'verified'] }).notNull().default('pending'),
  sourceDeleted: integer('source_deleted', { mode: 'boolean' }).notNull().default(false),
}, (t) => [
  uniqueIndex('transfer_file_unique').on(t.transferId, t.fileId),
  check('transfer_file_locator_check', sql`(${t.locatorType}='provider' AND ${t.storageProviderId} IS NOT NULL AND ${t.sourceKey} IS NOT NULL AND ${t.targetKey} IS NOT NULL AND ${t.parentFileId} IS NULL) OR (${t.locatorType}='embedded' AND ${t.storageProviderId} IS NULL AND ${t.sourceKey} IS NULL AND ${t.targetKey} IS NULL AND ${t.parentFileId} IS NOT NULL AND ${t.byteOffset} IS NOT NULL AND ${t.byteLength} IS NOT NULL AND ${t.byteOffset}>=0 AND ${t.byteLength}>0)`),
])

export const auditLogs = sqliteTable('audit_logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  actorUserId: integer('actor_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  action: text('action').notNull(),
  targetType: text('target_type').notNull(),
  targetId: text('target_id').notNull(),
  ownerUserId: integer('owner_user_id').references(() => users.id, { onDelete: 'restrict' }),
  reason: text('reason'),
  requestId: text('request_id'),
  beforeJson: text('before_json', { mode: 'json' }).$type<Record<string, unknown>>(),
  afterJson: text('after_json', { mode: 'json' }).$type<Record<string, unknown>>(),
  ip: text('ip'),
  userAgent: text('user_agent'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (t) => [index('idx_audit_created').on(t.createdAt, t.id), index('idx_audit_owner_created').on(t.ownerUserId, t.createdAt)])
