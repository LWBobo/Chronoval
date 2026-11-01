<script setup lang="ts">
definePageMeta({ layout: 'dashboard' })
</script>
<template>
  <UDashboardPanel>
    <template #body>
      <PhotoWorkspace admin />
    </template>
  </UDashboardPanel>
</template>
