<script setup lang="ts">
import { createClientId } from '~/utils/client-id'
import type { CollectionAccessInput } from '~~/shared/types/permissions'
const props=defineProps<{collections:Array<{collectionId:number;title:string}>}>()
const emit=defineEmits<{saved:[]}>()
const selected=ref<number[]>([]),loading=ref(false),error=ref(''),results=ref<any[]>([])
const visibility=ref('keep'),viewers=ref<number[]>([]),passwordAction=ref<'keep'|'set'|'clear'>('keep'),newPassword=ref(''),reason=ref('')
const replaceExemption=ref(false),exemption=ref<'none'|'logged_in'|'selected'>('none'),exemptUsers=ref<number[]>([])
const request=ref<any>(null)
const {t}=useI18n()
watch([selected,visibility,viewers,passwordAction,newPassword,reason,replaceExemption,exemption,exemptUsers],()=>{request.value=null;results.value=[]},{deep:true})
watch(()=>props.collections,()=>{const existing=new Set(props.collections.map(item=>item.collectionId));selected.value=selected.value.filter(id=>existing.has(id))})
async function save(){
  if(loading.value||!selected.value.length)return
  loading.value=true;error.value=''
  try{
    if(!request.value){
      const items=[]
      for(const id of selected.value){
        const row:any=await $fetch(`/api/admin/collections/${id}/access`)
        const nextVisibility=visibility.value==='keep'?row.visibility:visibility.value
        const mode=passwordAction.value==='clear'?'none':replaceExemption.value?exemption.value:row.passwordExemptMode
        const access:CollectionAccessInput={expectedAclVersion:row.aclVersion,visibility:nextVisibility,viewerIds:nextVisibility==='selected'?(visibility.value==='selected'?[...viewers.value]:row.viewerIds):[],passwordAction:passwordAction.value,passwordExemptMode:mode,passwordExemptUserIds:mode==='selected'?(replaceExemption.value?[...exemptUsers.value]:row.passwordExemptUserIds):[],reason:reason.value}
        if(passwordAction.value==='set')access.newPassword=newPassword.value
        items.push({collectionId:id,access})
      }
      request.value={operationId:createClientId(),items}
    }
    const response:any=await $fetch('/api/admin/collections/access/batch',{method:'POST',body:request.value})
    results.value=response.results
    if(results.value.some(item=>item.success))emit('saved')
    if(results.value.every(item=>item.success)){selected.value=[];newPassword.value='';request.value=null}
  }catch(e:any){error.value=e?.data?.message||e.message}
  finally{loading.value=false}
}
</script>
<template>
  <details class="my-3 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
    <summary class="cursor-pointer font-medium">{{ $t('permissions.batchEdit') }}</summary>
    <div class="mt-3 space-y-3">
      <USelectMenu v-model="selected" :items="collections" value-key="collectionId" label-key="title" multiple class="w-full" :placeholder="$t('permissions.selectAlbums')" />
      <p class="text-xs text-neutral-500">{{ $t('permissions.batchHint') }}</p>
      <USelect v-model="visibility" :items="['keep','public','login','selected','admin'].map(value=>({value,label:$t(`permissions.${value}`)}))" />
      <UserPicker v-if="visibility==='selected'" v-model="viewers" regular-only />
      <USelect v-model="passwordAction" :items="['keep','set','clear'].map(value=>({value,label:$t(`permissions.password_${value}`)}))" />
      <UInput v-if="passwordAction==='set'" v-model="newPassword" type="password" autocomplete="new-password" :maxlength="128" :placeholder="$t('permissions.newPassword')" />
      <template v-if="passwordAction!=='clear'"><UCheckbox v-model="replaceExemption" :label="$t('permissions.replaceExemption')" /><USelect v-if="replaceExemption" v-model="exemption" :items="['none','logged_in','selected'].map(value=>({value,label:$t(`permissions.exempt_${value}`)}))" /><UserPicker v-if="replaceExemption&&exemption==='selected'" v-model="exemptUsers" regular-only /></template>
      <UInput v-model="reason" :placeholder="$t('permissions.reason')" class="w-full" :maxlength="1000" />
      <p v-if="visibility==='public'" class="text-sm text-amber-700">{{ $t('permissions.batchPublicWarning',{count:selected.length}) }}</p>
      <UButton :loading="loading" :disabled="!selected.length||selected.length>100||!reason.trim()" @click="save">{{ $t('permissions.batchSave',{count:selected.length}) }}</UButton>
      <p v-if="error" class="text-red-600" role="alert">{{ error }}</p>
      <ul class="text-sm"><li v-for="item in results" :key="item.collectionId" :class="item.success?'text-green-700':'text-red-600'">{{ item.collectionId }} · {{ item.success?$t('permissions.saved'):item.message }}</li></ul>
    </div>
  </details>
</template>
