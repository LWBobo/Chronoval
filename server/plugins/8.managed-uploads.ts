import { whenDatabaseReady } from './0.db-migrate'
import { cleanupExpiredUploads } from '../services/uploads/cleanup'
import { recoverManagedWork } from '../services/photo-management/maintenance'

export default defineNitroPlugin(async(app)=>{
  await whenDatabaseReady()
  let running=false
  const run=async()=>{if(running)return;running=true;try{recoverManagedWork();await cleanupExpiredUploads()}catch(e){logger.dynamic('uploads').warn('Upload maintenance deferred',e)}finally{running=false}}
  const timer=setInterval(run,60000)
  timer.unref()
  app.hooks.hook('close',()=>clearInterval(timer))
  void run()
})
