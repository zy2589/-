let exportPreferenceQueue=Promise.resolve();
const exportPreferenceFields=['exportFormat','exportResolution','exportFps','exportCodec','exportBitrate','exportQuality','exportRf','exportColorSpace'];
function persistAllExportPreferences(){
 const input=Object.fromEntries(exportPreferenceFields.map(id=>[id,$(id).value]));input.encoderDevice=selectedExportDevice();
 exportPreferenceQueue=exportPreferenceQueue.catch(()=>{}).then(()=>nativeCall('saveExportPreferences',input));
 exportPreferenceQueue.catch(e=>toast('导出设置保存失败：'+e.message));return exportPreferenceQueue;
}
async function restoreAllExportPreferences(){
 await exportPreferenceQueue.catch(()=>{});const saved=await nativeCall('loadExportPreferences');
 $('exportSpeedMode').value='original';$('exportSpeedValue').disabled=true;
 for(const id of exportPreferenceFields){const field=$(id);if(saved[id]!==undefined&&(!field.options||[...field.options].some(o=>o.value===saved[id])))field.value=saved[id];}
 if(saved.encoderDevice)applyExportDevice(saved.encoderDevice);
 updateExportSummary();
}
for(const id of [...exportPreferenceFields,'exportUseGpu','exportUseCpu'])for(const name of ['input','change'])$(id)?.addEventListener(name,()=>{if($('exportSpeedValue').disabled||$('exportSpeedValue').checkValidity())persistAllExportPreferences();});
$('ccProofread').addEventListener('change',()=>nativeCall('saveExportPreferences',{ccProofread:$('ccProofread').checked}).catch(e=>toast(e.message)));
nativeCall('loadExportPreferences').then(value=>{if(typeof value.ccProofread==='boolean')$('ccProofread').checked=value.ccProofread;}).catch(()=>{});
