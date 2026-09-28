<script lang="ts" setup>
import { useStorage } from '@vueuse/core'
import { onMounted, watch } from 'vue'

interface AlbumItem {
  id?: number
  title: string
  description?: string | null
  isHidden?: boolean
  photoCount?: number
  photoIds?: string[]
  coverPhotoId?: string | null
  covers?: { thumbnailUrl: string | null }[]
  coverPhoto?: { thumbnailUrl: string | null } | null
  slug?: string | null
  urlKey?: string | null
  link?: string
  hasCustom?: boolean
  hasChildren?: boolean
  children?: AlbumItem[]
  kind?: 'manual' | 'scan'
  libId?: number
  mount?: string
  relPath?: string
  passwordProtected?: boolean
}

definePageMeta({
  layout: 'dashboard',
})

useHead({
  title: () => $t('title.albumChildren'),
})

const route = useRoute()
const toast = useToast()

const libId = computed(() => String(route.query.libId ?? ''))
const parentPath = computed(() => String(route.query.path ?? ''))

const parentAlbum = ref<AlbumItem | null>(null)
const isLoading = ref(true)

// 视图模式：继承主相簿页（大 grid / 中 medium / 小 list），共用同一 storage key，
// 保证在主相簿管理与子相簿管理之间往返切换时布局状态保持一致。
const viewMode = useStorage<'grid' | 'list' | 'medium'>(
  'albums.viewMode',
  'grid',
)

const children = computed<AlbumItem[]>(() => parentAlbum.value?.children || [])

// 从 /api/albums 树状返回中定位任意层级节点：先找库根（relPath=''），再逐层下钻 children
const locateNode = (roots: any[], relPath: string): any => {
  const root = roots.find(
    (a) => a.kind === 'scan' && String(a.libId) === libId.value,
  )
  if (!root) return null
  if (!relPath) return root
  const segs = relPath.split('/').filter(Boolean)
  let node: any = root
  for (let i = 0; i < segs.length; i++) {
    const target = segs.slice(0, i + 1).join('/')
    node = (node.children || []).find(
      (c: any) => (c.relPath ?? '') === target,
    )
    if (!node) return null
  }
  return node
}

const loadParent = async () => {
  isLoading.value = true
  try {
    const res = (await $fetch('/api/albums')) as any[]
    const found = locateNode(res, parentPath.value)
    parentAlbum.value = (found as AlbumItem) ?? null
    if (!found) {
      toast.add({
        title: $t('dashboard.albums.children.notFound'),
        color: 'warning',
      })
    }
  } catch (error) {
    console.error('Failed to load album collection:', error)
    toast.add({
      title: $t('dashboard.albums.messages.loadError'),
      color: 'error',
    })
  } finally {
    isLoading.value = false
  }
}

onMounted(() => {
  loadParent()
  // 路由参数变化（进入更深层子相簿 / 返回上一层）时重新加载当前层级
  watch(
    () => [route.query.libId, route.query.path],
    () => {
      loadParent()
    },
  )
})

// 返回按钮：逐层返回上一层子相簿管理页；顶层相簿返回相簿管理页
const backToAlbums = () => {
  const rel = parentAlbum.value?.relPath ?? ''
  if (!rel) {
    navigateTo('/dashboard/albums')
    return
  }
  const upper = rel.split('/').slice(0, -1).join('/')
  navigateTo({
    path: '/dashboard/albums/children',
    query: { libId: libId.value, path: upper },
  })
}

// 递归进入更深一层子相簿的管理页（支持任意层级）
const manageChildren = (child: AlbumItem) => {
  navigateTo({
    path: '/dashboard/albums/children',
    query: {
      libId: String(child.libId ?? libId.value),
      path: child.relPath ?? '',
    },
  })
}

const openAlbum = (child: AlbumItem) => {
  const link = child.link || `/albums/scan/${child.libId}`
  window.open(link, '_blank', 'noopener')
}

// —— 编辑子相簿 ——
// 编辑选项与主相簿完全一致：标题/描述/封面/布局/随机动画/语录/密码/BGM/自定义URL 等，
// 统一由共享组件 AlbumEditSlideover 处理（子相簿为扫描相簿，保存走 scan-meta）。
const editingChild = ref<AlbumItem | null>(null)
const isEditSlideoverOpen = ref(false)

const openEdit = (child: AlbumItem) => {
  editingChild.value = child
  isEditSlideoverOpen.value = true
}

// —— 重置子相簿（清除自定义配置）——
const resetTarget = ref<AlbumItem | null>(null)
const isResetModalOpen = ref(false)
const isResetting = ref(false)

const openReset = (child: AlbumItem) => {
  resetTarget.value = child
  isResetModalOpen.value = true
}

const confirmReset = async () => {
  if (!parentAlbum.value || !resetTarget.value) return
  isResetting.value = true
  try {
    await $fetch('/api/albums/scan-meta', {
      method: 'PUT',
      body: {
        libId: parentAlbum.value.libId,
        path: resetTarget.value.relPath ?? '',
        clear: true,
      },
    })
    toast.add({
      title: $t('dashboard.albums.messages.resetSuccess'),
      color: 'success',
    })
    isResetModalOpen.value = false
    await loadParent()
  } catch (error) {
    console.error('Failed to reset child album:', error)
    toast.add({
      title: $t('dashboard.albums.messages.resetError'),
      color: 'error',
    })
  } finally {
    isResetting.value = false
  }
}

const totalPhotos = computed(() =>
  children.value.reduce((sum, c) => sum + (c.photoCount || 0), 0),
)
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <UDashboardNavbar :title="$t('dashboard.albums.children.title')">
        <template #right>
          <UButton
            icon="tabler:arrow-left"
            variant="soft"
            color="neutral"
            @click="backToAlbums"
          >
            {{
              parentAlbum?.relPath
                ? $t('dashboard.albums.children.backUpper')
                : $t('dashboard.albums.children.back')
            }}
          </UButton>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="flex flex-col gap-6 p-4 sm:p-6">
        <!-- 加载态 -->
        <div
          v-if="isLoading"
          class="flex flex-col items-center justify-center py-16 text-center"
        >
          <Icon
            name="tabler:loader"
            size="32"
            class="animate-spin text-primary-500"
          />
        </div>

        <template v-else-if="parentAlbum">
          <!-- 父相簿（当前层级相簿）概览 -->
          <div class="flex items-center gap-4">
            <div
              class="relative h-16 w-24 shrink-0 overflow-hidden rounded-xl bg-(--ui-bg-elevated) ring-1 ring-(--ui-border)"
            >
              <img
                v-if="parentAlbum.coverPhoto?.thumbnailUrl || parentAlbum.covers?.[0]?.thumbnailUrl"
                :src="
                  parentAlbum.coverPhoto?.thumbnailUrl ||
                  parentAlbum.covers?.[0]?.thumbnailUrl ||
                  ''
                "
                class="h-full w-full object-cover"
                :alt="$t('ui.photo.altFallback')"
              />
              <Icon
                v-else
                name="tabler:folder-heart"
                size="28"
                class="absolute inset-0 m-auto text-(--ui-text-muted)"
              />
            </div>
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <h2 class="truncate text-lg font-semibold text-(--ui-text)">
                  {{ parentAlbum.title }}
                </h2>
                <span
                  class="flex items-center gap-1 rounded-full bg-black px-2 py-0.5 text-[11px] font-semibold text-white shadow-sm ring-1 ring-white/20"
                >
                  <Icon name="tabler:folder-heart" size="11" />
                  {{ children.length }}
                  {{ $t('dashboard.albums.subAlbums') }}
                </span>
              </div>
              <p class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-(--ui-text-muted)">
                <span class="flex items-center gap-1 tabular-nums">
                  <Icon name="tabler:photo" size="13" />
                  {{ totalPhotos }}
                  {{ $t('dashboard.albums.children.photoTotal') }}
                </span>
                <span v-if="parentAlbum.description" class="truncate">
                  {{ parentAlbum.description }}
                </span>
              </p>
            </div>
          </div>

          <!-- 子相簿列表 -->
          <div v-if="children.length > 0">
            <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
              <h3 class="flex items-center gap-2 text-sm font-semibold text-(--ui-text)">
                <Icon name="tabler:stack-2" size="16" class="text-primary-500" />
                {{ $t('dashboard.albums.children.listTitle') }}
              </h3>
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

            <!-- 大布局：卡片视图 -->
            <div
              v-if="viewMode === 'grid'"
              class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 sm:gap-5"
            >
              <template v-for="child in children" :key="`${child.libId}:${child.relPath}`">
                <div class="min-w-0 flex flex-col">
                  <AlbumCard
                    :album="child"
                    size="md"
                    @manage-children="manageChildren(child)"
                    @view="openAlbum(child)"
                    @edit="openEdit(child)"
                    @reset="openReset(child)"
                    @delete="openReset(child)"
                  />
                </div>
              </template>
            </div>

            <!-- 中布局：紧凑卡片 -->
            <div
              v-else-if="viewMode === 'medium'"
              class="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4 xl:grid-cols-6"
            >
              <template v-for="child in children" :key="`${child.libId}:${child.relPath}`">
                <div class="min-w-0 flex flex-col">
                  <AlbumCard
                    :album="child"
                    size="card"
                    @manage-children="manageChildren(child)"
                    @view="openAlbum(child)"
                    @edit="openEdit(child)"
                    @reset="openReset(child)"
                    @delete="openReset(child)"
                  />
                </div>
              </template>
            </div>

            <!-- 小布局：紧凑列表 -->
            <div v-else class="flex flex-col gap-2">
              <div
                v-for="child in children"
                :key="`${child.libId}:${child.relPath}`"
                class="min-w-0"
              >
                <AlbumCard
                  :album="child"
                  size="row"
                  @manage-children="manageChildren(child)"
                  @view="openAlbum(child)"
                  @edit="openEdit(child)"
                  @reset="openReset(child)"
                  @delete="openReset(child)"
                />
              </div>
            </div>
          </div>

          <!-- 空态 -->
          <div
            v-else
            class="flex flex-col items-center justify-center rounded-2xl border border-dashed border-(--ui-border) py-16 text-center"
          >
            <Icon
              name="tabler:folder-off"
              size="40"
              class="mb-3 text-(--ui-text-muted)"
            />
            <p class="text-sm text-(--ui-text-muted)">
              {{ $t('dashboard.albums.noSubAlbums') }}
            </p>
          </div>
        </template>

        <!-- 未找到相簿集 -->
        <div
          v-else
          class="flex flex-col items-center justify-center py-16 text-center"
        >
          <Icon
            name="tabler:search-off"
            size="40"
            class="mb-3 text-(--ui-text-muted)"
          />
          <p class="mb-4 text-sm text-(--ui-text-muted)">
            {{ $t('dashboard.albums.children.notFound') }}
          </p>
          <UButton
            icon="tabler:arrow-left"
            variant="soft"
            @click="backToAlbums"
          >
            {{ $t('dashboard.albums.children.back') }}
          </UButton>
        </div>
      </div>

      <!-- 编辑子相簿：与主相簿共用共享滑窗组件（编辑选项完全一致） -->
      <AlbumEditSlideover
        v-model:open="isEditSlideoverOpen"
        :album="editingChild"
        @saved="loadParent"
      />

      <!-- 重置子相簿确认 -->
      <UModal v-model:open="isResetModalOpen">
        <template #content>
          <div class="p-4 sm:p-6">
            <div class="flex items-start gap-3">
              <div
                class="grid size-9 shrink-0 place-items-center rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400"
              >
                <Icon name="tabler:eraser" size="18" />
              </div>
              <div class="min-w-0">
                <h2 class="text-base font-semibold text-(--ui-text)">
                  {{ $t('dashboard.albums.children.resetTitle') }}
                </h2>
                <p class="mt-1 text-sm text-(--ui-text-muted)">
                  {{ $t('dashboard.albums.children.resetDesc') }}
                  <span class="font-medium text-(--ui-text)">
                    {{ resetTarget?.title }}
                  </span>
                </p>
              </div>
            </div>
            <div class="mt-5 flex justify-end gap-2">
              <UButton
                variant="ghost"
                color="neutral"
                :disabled="isResetting"
                @click="isResetModalOpen = false"
              >
                {{ $t('common.cancel') }}
              </UButton>
              <UButton
                color="warning"
                variant="solid"
                icon="tabler:eraser"
                :loading="isResetting"
                @click="confirmReset"
              >
                {{ $t('dashboard.albums.children.resetConfirm') }}
              </UButton>
            </div>
          </div>
        </template>
      </UModal>
    </template>
  </UDashboardPanel>
</template>
