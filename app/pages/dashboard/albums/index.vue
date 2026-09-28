<script lang="ts" setup>
import type { Album, Photo } from '~~/server/utils/db'
import { useStorage } from '@vueuse/core'
import { onMounted } from 'vue'

definePageMeta({
  layout: 'dashboard',
})

useHead({
  title: () => $t('title.albums'),
})

interface AlbumItem extends Album {
  photoCount?: number
  photoIds?: string[]
  coverPhoto?: Photo | null
  // 外部库（扫描库）相簿字段；kind='scan' 时 id 不存在，改用 libId/mount/relPath
  kind?: 'manual' | 'scan'
  libId?: number
  mount?: string
  relPath?: string
  link?: string
  /** 扫描库公开 URL 标识（sha256 短前缀），无自定义 slug 时的 UID/公开链接 */
  urlKey?: string | null
  hasCustom?: boolean
  hasChildren?: boolean
  children?: AlbumItem[]
  external?: boolean
}

const albums = ref<AlbumItem[]>([])
// 初始为 true：首次渲染先显示加载态，避免在数据加载完成前误显示「没有相簿」
const isLoadingAlbums = ref(true)
const searchQuery = ref('')
// 视图模式：grid=大型卡片图，medium=中型卡片（比大还小、比列表还大），list=紧凑列表。
// 用 useStorage：SSR 默认 grid，客户端水合后从 localStorage 恢复用户的切换记忆，并在变更时自动持久化。
const viewMode = useStorage<'grid' | 'list' | 'medium'>('albums.viewMode', 'grid')

const filteredAlbums = computed<AlbumItem[]>(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return albums.value
  return albums.value.filter((album) => {
    const haystack = [
      album.title,
      album.description,
      album.slug,
      album.relPath,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    return haystack.includes(q)
  })
})

const { t, locale } = useI18n()
// 按系统语言取单复数名词：取 key_one / key_few / key_many / key_other
const pluralNoun = (base: string, n: number) => {
  const category = new Intl.PluralRules(locale.value || 'en').select(n)
  return t(`${base}_${category}`)
}
const albumCountWord = computed(() =>
  pluralNoun('dashboard.albums.totalCount', filteredAlbums.value.length),
)
const searchResultWord = computed(() =>
  pluralNoun('dashboard.albums.searchResult', filteredAlbums.value.length),
)
const allPhotos = ref<Photo[]>([])

const isAlbumSlideoverOpen = ref(false)
const isDeleteConfirmOpen = ref(false)

const currentAlbum = ref<AlbumItem | null>(null)

const loadAlbums = async () => {
  isLoadingAlbums.value = true
  try {
    const response = await $fetch('/api/albums')
    // 手动相簿用 photoIds 数量；外部库相簿使用其自带 photoCount，避免被重置为 0
    albums.value = (response as any[]).map((album) => ({
      ...album,
      photoCount:
        album.kind === 'scan'
          ? album.photoCount ?? 0
          : album.photoIds?.length || 0,
    }))

    for (const album of albums.value) {
      if (album.coverPhotoId && allPhotos.value.length > 0) {
        const coverPhoto = allPhotos.value.find(
          (p) => p.id === album.coverPhotoId,
        )
        if (coverPhoto) {
          album.coverPhoto = coverPhoto
        }
      }
    }
  } catch (error) {
    console.error('Failed to load albums:', error)
    useToast().add({
      title: $t('dashboard.albums.messages.loadError'),
      color: 'error',
    })
  } finally {
    isLoadingAlbums.value = false
  }
}

const loadPhotos = async () => {
  try {
    const { photos } = usePhotos()
    allPhotos.value = photos.value
  } catch (error) {
    console.error('Failed to load photos:', error)
  }
}

const openCreateSlideover = () => {
  currentAlbum.value = null
  isAlbumSlideoverOpen.value = true
}

// —— 外部库（扫描库）相簿支持 ——

const isScanAlbum = (album: AlbumItem | null | undefined) =>
  album?.kind === 'scan'

// 有子相簿的相簿集：点击黑色按钮跳转到独立的子相簿管理页（版面零位移）
const manageChildren = (album: AlbumItem) => {
  navigateTo({
    path: '/dashboard/albums/children',
    query: {
      libId: String(album.libId ?? ''),
      path: album.relPath ?? '',
    },
  })
}

// 编辑/新建统一交给共享组件 AlbumEditSlideover 处理（选项与子相簿管理页完全一致）
const openEditSlideover = (album: AlbumItem) => {
  currentAlbum.value = album
  isAlbumSlideoverOpen.value = true
}

const openDeleteConfirm = (album: AlbumItem) => {
  currentAlbum.value = album
  isDeleteConfirmOpen.value = true
}

// 删除确认弹窗：外部库相簿=清除自定义配置；手动相册=删除相册
const isResetScanConfirm = computed(
  () => isScanAlbum(currentAlbum.value),
)

const confirmDestructive = () => {
  if (isResetScanConfirm.value && currentAlbum.value) {
    void resetScanAlbumMeta(currentAlbum.value)
  } else {
    void deleteAlbum()
  }
}

// 外部库相簿：清除其自定义元数据（还原为默认推导值）
const resetScanAlbumMeta = async (album: AlbumItem) => {
  isSubmittingForm.value = true
  try {
    await $fetch('/api/albums/scan-meta', {
      method: 'PUT',
      body: { libId: album.libId, path: album.relPath ?? '', clear: true },
    })
    useToast().add({
      title: $t('dashboard.albums.messages.resetSuccess'),
      color: 'success',
    })
    isDeleteConfirmOpen.value = false
    await loadAlbums()
  } catch (error) {
    console.error('Failed to reset scan album:', error)
    useToast().add({
      title: $t('dashboard.albums.messages.resetError'),
      color: 'error',
    })
  } finally {
    isSubmittingForm.value = false
  }
}

const isSubmittingForm = ref(false)

const deleteAlbum = async () => {
  if (!currentAlbum.value) return

  try {
    await $fetch(`/api/albums/${currentAlbum.value.id}`, {
      method: 'DELETE',
    })

    useToast().add({
      title: $t('dashboard.albums.messages.deleteSuccess'),
      color: 'success',
    })

    isDeleteConfirmOpen.value = false
    await loadAlbums()
  } catch (error) {
    console.error('Failed to delete album:', error)
    useToast().add({
      title: $t('dashboard.albums.messages.deleteError'),
      color: 'error',
    })
  }
}

// —— 卡片网格辅助 ——

const albumKey = (album: AlbumItem) =>
  isScanAlbum(album)
    ? `scan:${album.libId}:${album.relPath ?? ''}`
    : `manual:${album.id}`

const openAlbum = (album: AlbumItem) => {
  let link: string
  if (isScanAlbum(album)) {
    link = album.link || `/albums/scan/${album.libId}`
  } else if (album.slug) {
    link = `/albums/s/${encodeURIComponent(album.slug)}`
  } else {
    link = `/albums/${album.uid ?? album.id}`
  }
  window.open(link, '_blank', 'noopener')
}

onMounted(async () => {
  await Promise.all([loadPhotos(), loadAlbums()])
})
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <UDashboardNavbar :title="$t('title.albums')">
        <template #right>
          <UButton
            icon="tabler:plus"
            color="primary"
            @click="openCreateSlideover"
          >
            {{ $t('dashboard.albums.createButton') }}
          </UButton>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="flex flex-col gap-6">
        <!-- 页面标题、搜索与统计 -->
        <div class="flex flex-col gap-4">
          <div class="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 class="text-lg font-semibold text-(--ui-text)">
                {{ $t('dashboard.albums.title') }}
              </h2>
              <p class="mt-0.5 text-sm text-(--ui-text-muted)">
                {{ $t('dashboard.albums.subtitle') }}
              </p>
            </div>
            <div class="flex items-center gap-2">
              <UInput
                v-model="searchQuery"
                icon="tabler:search"
                class="w-40 sm:w-52"
                :placeholder="$t('dashboard.albums.searchPlaceholder')"
              />
              <UButtonGroup size="sm">
                <UButton
                  :color="viewMode === 'grid' ? 'primary' : 'neutral'"
                  :variant="viewMode === 'grid' ? 'solid' : 'soft'"
                  icon="tabler:layout-grid"
                  :aria-label="$t('dashboard.albums.viewGrid')"
                  :title="$t('dashboard.albums.viewGrid')"
                  @click="viewMode = 'grid'"
                />
                <UButton
                  :color="viewMode === 'medium' ? 'primary' : 'neutral'"
                  :variant="viewMode === 'medium' ? 'solid' : 'soft'"
                  icon="tabler:layout-cards"
                  :aria-label="$t('dashboard.albums.viewMedium')"
                  :title="$t('dashboard.albums.viewMedium')"
                  @click="viewMode = 'medium'"
                />
                <UButton
                  :color="viewMode === 'list' ? 'primary' : 'neutral'"
                  :variant="viewMode === 'list' ? 'solid' : 'soft'"
                  icon="tabler:list"
                  :aria-label="$t('dashboard.albums.viewList')"
                  :title="$t('dashboard.albums.viewList')"
                  @click="viewMode = 'list'"
                />
              </UButtonGroup>
            </div>
          </div>

          <div class="flex items-center gap-1.5 text-xs text-(--ui-text-muted)">
            <Icon name="tabler:album" size="15" />
            <span v-if="searchQuery.trim()" class="tabular-nums">
              <span class="font-semibold text-(--ui-text)">{{
                filteredAlbums.length
              }}</span>
              {{ searchResultWord }}
            </span>
            <span v-else class="tabular-nums">
              <span class="font-semibold text-(--ui-text)">{{
                filteredAlbums.length
              }}</span>
              {{ albumCountWord }}
            </span>
          </div>
        </div>

        <!-- 相簿列表（网格 / 紧凑列表） -->
        <div v-if="filteredAlbums.length > 0" class="mb-2 pb-2 sm:mb-0 sm:pb-6">
          <!-- 网格：卡片视图 -->
          <div
            v-if="viewMode === 'grid'"
            class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 sm:gap-5"
          >
          <template v-for="album in filteredAlbums" :key="albumKey(album)">
            <div class="min-w-0 flex flex-col">
              <AlbumCard
                :album="album"
                size="md"
                @manage-children="manageChildren(album)"
                @edit="openEditSlideover(album)"
                @reset="openDeleteConfirm(album)"
                @delete="openDeleteConfirm(album)"
                @view="openAlbum(album)"
              />
            </div>
          </template>
          </div>

          <!-- 中型网格：以大型卡片为参考，卡片更紧凑（sm 尺寸），比大还小、比列表还大。
               移动端（<lg）维持 grid-cols-2；桌面端比大视图多一档列数以让卡片更小 -->
          <div
            v-else-if="viewMode === 'medium'"
            class="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4 xl:grid-cols-6"
          >
          <template v-for="album in filteredAlbums" :key="albumKey(album)">
            <div class="min-w-0 flex flex-col">
              <AlbumCard
                :album="album"
                size="card"
                @manage-children="manageChildren(album)"
                @edit="openEditSlideover(album)"
                @reset="openDeleteConfirm(album)"
                @delete="openDeleteConfirm(album)"
                @view="openAlbum(album)"
              />
            </div>
          </template>
          </div>

          <!-- 紧凑列表：相簿较多时的省空间视图 -->
          <div v-else class="flex flex-col gap-2">
            <div
              v-for="album in filteredAlbums"
              :key="albumKey(album)"
              class="min-w-0"
            >
              <AlbumCard
                :album="album"
                size="row"
                @manage-children="manageChildren(album)"
                @edit="openEditSlideover(album)"
                @reset="openDeleteConfirm(album)"
                @delete="openDeleteConfirm(album)"
                @view="openAlbum(album)"
              />
            </div>
          </div>
          </div>

        <div
          v-else-if="albums.length > 0 && searchQuery.trim()"
          class="flex flex-col items-center justify-center py-12 text-center"
        >
          <Icon
            name="tabler:search-off"
            size="48"
            class="text-gray-400 dark:text-gray-600 mb-4"
          />
          <h3 class="text-lg font-semibold text-gray-700 dark:text-gray-300">
            {{ $t('dashboard.albums.searchEmpty') }}
          </h3>
          <p class="text-sm text-gray-500 dark:text-gray-400 mt-2">
            {{
              $t('dashboard.albums.searchEmptyTip', {
                keyword: searchQuery.trim(),
              })
            }}
          </p>
          <UButton
            variant="soft"
            color="neutral"
            class="mt-4"
            @click="searchQuery = ''"
          >
            {{ $t('dashboard.albums.searchClear') }}
          </UButton>
        </div>

        <div
          v-else-if="!isLoadingAlbums"
          class="flex flex-col items-center justify-center py-12 text-center"
        >
          <Icon
            name="tabler:album"
            size="48"
            class="text-gray-400 dark:text-gray-600 mb-4"
          />
          <h3 class="text-lg font-semibold text-gray-700 dark:text-gray-300">
            {{ $t('dashboard.albums.noAlbums') }}
          </h3>
          <p class="text-sm text-gray-500 dark:text-gray-400 mt-2 mb-4">
            {{ $t('dashboard.albums.noAlbumsTip') }}
          </p>
          <UButton
            icon="tabler:plus"
            @click="openCreateSlideover"
          >
            {{ $t('dashboard.albums.createButton') }}
          </UButton>
        </div>
        <div
          v-else
          class="flex items-center justify-center py-12"
        >
          <Icon
            name="tabler:loader"
            size="32"
            class="animate-spin text-primary-500"
          />
        </div>

        <!-- 新建/编辑相簿滑窗：与子相簿管理页共用同一组件（编辑选项完全一致） -->
        <AlbumEditSlideover
          v-model:open="isAlbumSlideoverOpen"
          :album="currentAlbum"
          @saved="loadAlbums"
        />

        <UModal v-model:open="isDeleteConfirmOpen">
          <template #content>
            <div class="p-6 space-y-4">
              <div class="flex items-center gap-3">
                <div
                  class="shrink-0 w-10 h-10 bg-error-100 dark:bg-error-900/30 rounded-full flex items-center justify-center"
                >
                  <Icon
                    name="tabler:alert-circle"
                    class="text-error-500"
                  />
                </div>
                <div>
                  <h3 class="text-lg font-semibold">
                    {{
                      isResetScanConfirm
                        ? $t('dashboard.albums.reset.title')
                        : $t('dashboard.albums.delete.title')
                    }}
                  </h3>
                  <p class="text-sm text-gray-600 dark:text-gray-400 mt-1">
                    {{
                      isResetScanConfirm
                        ? $t('dashboard.albums.reset.message', {
                            title: currentAlbum?.title,
                          })
                        : $t('dashboard.albums.delete.message', {
                            title: currentAlbum?.title,
                          })
                    }}
                  </p>
                </div>
              </div>

              <div class="flex justify-end gap-2 pt-4">
                <UButton
                  variant="ghost"
                  color="neutral"
                  @click="isDeleteConfirmOpen = false"
                >
                  {{ $t('dashboard.albums.delete.cancel') }}
                </UButton>
                <UButton
                  :color="isResetScanConfirm ? 'warning' : 'error'"
                  :icon="isResetScanConfirm ? 'tabler:eraser' : 'tabler:trash'"
                  @click="confirmDestructive"
                >
                  {{
                    isResetScanConfirm
                      ? $t('dashboard.albums.reset.confirm')
                      : $t('dashboard.albums.delete.confirm')
                  }}
                </UButton>
              </div>
            </div>
          </template>
        </UModal>
      </div>
    </template>
  </UDashboardPanel>
</template>

<style scoped></style>
