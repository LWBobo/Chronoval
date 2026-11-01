export async function getCollectionVersions(ids: number[]): Promise<Record<string, number>> {
  const rows = await Promise.all([...new Set(ids)].map(async id => {
    const row: any = await $fetch(`/api/admin/collections/${id}/access`)
    return [String(id), row.aclVersion] as const
  }))
  return Object.fromEntries(rows)
}

export async function getPersonVersions(ids: string[]): Promise<Record<string, number>> {
  if (!ids.length) return {}
  const result: any = await $fetch('/api/people', { query: { manage: 1 } })
  const selected = result.people.filter((person: any) => ids.includes(person.id))
  if (selected.length !== new Set(ids).size) throw new Error('Person list changed; refresh and try again')
  return getCollectionVersions(selected.map((person: any) => person.collectionId))
}
