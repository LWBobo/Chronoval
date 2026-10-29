import { and, eq } from 'drizzle-orm'

const NAMESPACE = 'ml'

export function getMlState(key: string): string | null {
  return (
    useDB()
      .select({ value: tables.settings.value })
      .from(tables.settings)
      .where(
        and(
          eq(tables.settings.namespace, NAMESPACE),
          eq(tables.settings.key, key),
        ),
      )
      .get()?.value ?? null
  )
}

export function setMlState(key: string, value: string) {
  useDB()
    .insert(tables.settings)
    .values({
      namespace: NAMESPACE,
      key,
      type: 'string',
      value,
      isPublic: false,
      isReadonly: true,
      isSecret: false,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [tables.settings.namespace, tables.settings.key],
      set: { value, updatedAt: new Date() },
    })
    .run()
}

export function deleteMlState(key: string) {
  useDB()
    .delete(tables.settings)
    .where(
      and(
        eq(tables.settings.namespace, NAMESPACE),
        eq(tables.settings.key, key),
      ),
    )
    .run()
}
