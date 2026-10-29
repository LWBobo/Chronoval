interface FilterOptions {
  tags: string[]
  cameras: string[]
  lenses: string[]
  cities: string[]
  ratings: number // 改为单个数字，表示最低评分
  search: string // 搜索关键词
}

interface FacetPhoto {
  tags?: string[] | null
  mlTags?: string[] | null
  city?: string | null
  exif?: {
    Make?: string
    Model?: string
    LensMake?: string
    LensModel?: string
    Rating?: number
  } | null
}

/** EXIF 关键词和已打上的机器学习标签，同名只保留一次。 */
function facetTagNames(photo: FacetPhoto) {
  const names: string[] = []
  const seen = new Set<string>()
  for (const tag of [...(photo.tags || []), ...(photo.mlTags || [])]) {
    if (!tag || seen.has(tag)) continue
    seen.add(tag)
    names.push(tag)
  }
  return names
}

/** EXIF / 标签分面是否命中。语义搜索结果与画廊分面做 AND 时共用。 */
export function photoMatchesFacets(
  photo: FacetPhoto,
  filters: Pick<
    FilterOptions,
    'tags' | 'cameras' | 'lenses' | 'cities' | 'ratings'
  >,
) {
  if (filters.tags.length > 0) {
    const photoTags = facetTagNames(photo)
    if (!filters.tags.some((tag) => photoTags.includes(tag))) return false
  }

  if (filters.cameras.length > 0) {
    const photoCamera =
      photo.exif?.Make && photo.exif?.Model
        ? `${photo.exif.Make} ${photo.exif.Model}`
        : null
    if (!photoCamera || !filters.cameras.includes(photoCamera)) return false
  }

  if (filters.lenses.length > 0) {
    const photoLens =
      photo.exif?.LensMake && photo.exif?.LensModel
        ? `${photo.exif.LensMake} ${photo.exif.LensModel}`
        : photo.exif?.LensModel || null
    if (!photoLens || !filters.lenses.includes(photoLens)) return false
  }

  if (filters.cities.length > 0) {
    if (!photo.city || !filters.cities.includes(photo.city)) return false
  }

  if (filters.ratings > 0) {
    if ((photo.exif?.Rating || 0) < filters.ratings) return false
  }

  return true
}

interface FilterStats {
  tags: Map<string, number>
  cameras: Map<string, number>
  lenses: Map<string, number>
  cities: Map<string, number>
  ratings: Map<number, number>
}

// 全局筛选状态管理
const globalFilters = ref<FilterOptions>({
  tags: [],
  cameras: [],
  lenses: [],
  cities: [],
  ratings: 0,
  search: '',
})

// 搜索输入防抖：减轻每敲一个字符就全库重算筛选项的成本
const debouncedSearch = ref(globalFilters.value.search)
let searchDebounceTimer: ReturnType<typeof setTimeout> | undefined
watch(
  () => globalFilters.value.search,
  (val) => {
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer)
    searchDebounceTimer = setTimeout(() => {
      debouncedSearch.value = val
    }, 300)
  },
)

export function usePhotoFilters() {
  const { photos } = usePhotos()
  const { sortedPhotos } = usePhotoSort()

  // 使用全局筛选状态
  const activeFilters = globalFilters

  // 计算可用的筛选选项及其数量
  const filterStats = computed((): FilterStats => {
    const stats: FilterStats = {
      tags: new Map(),
      cameras: new Map(),
      lenses: new Map(),
      cities: new Map(),
      ratings: new Map(),
    }

    photos.value.forEach((photo) => {
      for (const tag of facetTagNames(photo)) {
        stats.tags.set(tag, (stats.tags.get(tag) || 0) + 1)
      }

      // 相机统计 (从 EXIF 获取)
      if (photo.exif?.Make && photo.exif?.Model) {
        const camera = `${photo.exif.Make} ${photo.exif.Model}`
        stats.cameras.set(camera, (stats.cameras.get(camera) || 0) + 1)
      }

      // 镜头统计 (从 EXIF 获取)
      if (photo.exif?.LensMake && photo.exif?.LensModel) {
        const lens = `${photo.exif.LensMake} ${photo.exif.LensModel}`
        stats.lenses.set(lens, (stats.lenses.get(lens) || 0) + 1)
      } else if (photo.exif?.LensModel) {
        const lens = photo.exif.LensModel
        stats.lenses.set(lens, (stats.lenses.get(lens) || 0) + 1)
      }

      // 城市统计
      if (photo.city) {
        stats.cities.set(photo.city, (stats.cities.get(photo.city) || 0) + 1)
      }

      // 评分统计 (从 EXIF Rating 获取)
      if (photo.exif?.Rating && photo.exif.Rating > 0) {
        const rating = photo.exif.Rating
        stats.ratings.set(rating, (stats.ratings.get(rating) || 0) + 1)
      }
    })

    return stats
  })

  // 获取排序后的筛选选项
  const availableFilters = computed(() => {
    return {
      tags: Array.from(filterStats.value.tags.entries())
        .sort((a, b) => b[1] - a[1]) // 按数量降序排列
        .map(([tag, count]) => ({ label: tag, count })),

      cameras: Array.from(filterStats.value.cameras.entries())
        .sort((a, b) => a[0].localeCompare(b[0])) // 按名称字母顺序排列
        .map(([camera, count]) => ({ label: camera, count })),

      lenses: Array.from(filterStats.value.lenses.entries())
        .sort((a, b) => a[0].localeCompare(b[0])) // 按名称字母顺序排列
        .map(([lens, count]) => ({ label: lens, count })),

      cities: Array.from(filterStats.value.cities.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([city, count]) => ({ label: city, count })),

      ratings: Array.from(filterStats.value.ratings.entries())
        .sort((a, b) => b[0] - a[0]) // 按评分降序排列
        .map(([rating, count]) => ({ label: rating, count })),
    }
  })

  // 计算已选择的筛选项数量
  const selectedCounts = computed(() => {
    return {
      tags: activeFilters.value.tags.length,
      cameras: activeFilters.value.cameras.length,
      lenses: activeFilters.value.lenses.length,
      cities: activeFilters.value.cities.length,
      ratings: activeFilters.value.ratings > 0 ? 1 : 0,
      search: activeFilters.value.search.length > 0 ? 1 : 0,
    }
  })

  // 筛选后的照片（应用排序）
  const filteredPhotos = computed(() => {
    // 先获取排序后的照片，再应用筛选
    return sortedPhotos.value.filter((photo) => {
      // 搜索筛选（使用防抖后的关键词）
      if (debouncedSearch.value) {
        const searchTerm = debouncedSearch.value.toLowerCase()
        const searchableFields = [
          facetTagNames(photo).join(' '),
          photo.exif?.Make || '',
          photo.exif?.Model || '',
          photo.exif?.LensMake || '',
          photo.exif?.LensModel || '',
          photo.city || '',
          photo.country || '',
          photo.title || '',
          photo.description || '',
          photo.storageKey || '',
          photo.originalUrl || '',
          photo.locationName || '',
        ]
          .join(' ')
          .toLowerCase()

        if (!searchableFields.includes(searchTerm)) {
          return false
        }
      }

      if (!photoMatchesFacets(photo, activeFilters.value)) return false

      return true
    })
  })

  // 切换筛选项
  const toggleFilter = (type: keyof FilterOptions, value: string | number) => {
    const filters = activeFilters.value[type] as any[]
    const index = filters.indexOf(value)

    if (index === -1) {
      filters.push(value)
    } else {
      filters.splice(index, 1)
    }
  }

  // 清除所有筛选
  const clearAllFilters = () => {
    activeFilters.value = {
      tags: [],
      cameras: [],
      lenses: [],
      cities: [],
      ratings: 0,
      search: '',
    }
  }

  // 清除指定类型的筛选
  const clearFilterType = (type: keyof FilterOptions) => {
    if (type === 'ratings' || type === 'search') {
      ;(activeFilters.value as any)[type] = type === 'ratings' ? 0 : ''
    } else {
      ;(activeFilters.value as any)[type] = []
    }
  }

  // 检查筛选项是否被选中
  const isFilterSelected = (
    type: keyof FilterOptions,
    value: string | number,
  ) => {
    return (activeFilters.value[type] as any[]).includes(value)
  }

  // 检查是否有任何筛选项被激活
  const hasActiveFilters = computed(() => {
    return (
      activeFilters.value.tags.length > 0 ||
      activeFilters.value.cameras.length > 0 ||
      activeFilters.value.lenses.length > 0 ||
      activeFilters.value.cities.length > 0 ||
      activeFilters.value.ratings > 0 ||
      activeFilters.value.search.length > 0
    )
  })

  return {
    activeFilters: activeFilters,
    availableFilters,
    selectedCounts,
    filteredPhotos,
    hasActiveFilters,
    toggleFilter,
    clearAllFilters,
    clearFilterType,
    isFilterSelected,
  }
}
