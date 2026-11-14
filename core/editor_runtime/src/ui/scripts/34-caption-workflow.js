function refreshCaptionMeaningDialog() {
  if(!reviewDetailsDialog?.open)return;
  const review=state.reviewCaptions.find(r=>r.id===reviewDetailsDialog.reviewId);
  const detail=reviewDetailsDialog.querySelector('.review-details-text');
  if(review && detail)detail.textContent=reviewClipDetails(review);
}

var captionReviewShowAll=false;
$('reviewPendingOnly').onclick=()=>{captionReviewShowAll=false;renderIssues();};
$('reviewAll').onclick=()=>{captionReviewShowAll=true;renderIssues();};
$('realignCaptions').onclick=async()=>{
  if(state.autoTranscript?.trackId && isTrackLocked(state.autoTranscript.trackId))return toast('请先解锁字幕轨道');
  const button=$('realignCaptions');button.disabled=true;button.textContent='对齐中…';
  try{await matchScript({alignmentOnly:true});}finally{button.disabled=false;button.textContent='字幕对齐';}
};

function showCaptionDetails(caption) {
  if(!caption)return;
  const review=state.reviewCaptions.find(r=>(!r.captionTrackId || r.captionTrackId===(caption.trackId||'caption')) &&
    (!r.ownerClipId || r.ownerClipId===caption.ownerClipId) && r.start<caption.end && r.end>caption.start);
  if(review){showReviewDetails(review.id);return;}
  const dialog=document.createElement('dialog');dialog.className='review-details-dialog';
  const title=document.createElement('h3');title.textContent='字幕详情';
  const text=document.createElement('p');text.className='review-details-text';text.textContent=caption.text;
  const changes=(caption.words||[]).filter(w=>w.autoMildCorrected);
  if(changes.length){const audit=document.createElement('p');audit.className='caption-mild-note';
    audit.textContent='轻微差异，已自动处理\n'+changes.map(w=>`${w.recognizedDisplay || w.originalDisplay} → ${w.display}`).join('\n');dialog.append(title,text,audit);
  }else dialog.append(title,text);
  const close=document.createElement('button');close.className='btn';close.textContent='关闭';close.onclick=()=>dialog.close();dialog.append(close);
  dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}});
  dialog.addEventListener('close',()=>dialog.remove());document.body.append(dialog);dialog.showModal();
}

function syncCaptionToolbarOverflow(){
  const bar=$('timeline').querySelector('.timelinebar'),tools=bar.querySelector('.timelinebar-tools'),right=bar.querySelector('.timeline-right-tools');
  if(!right)return;
  // Keep timeline view and zoom controls in the toolbar. Moving them into a
  // disclosure popup made essential controls disappear until the user opened
  // “更多”, even when there was visible space beside the editing tools.
  const more=bar.querySelector('.timeline-more');
  if(right.parentElement!==tools)tools.append(right);
  if(more)more.remove();
}
syncCaptionToolbarOverflow();

let captionAnalysisActive=false;
async function runExclusiveCaptionAnalysis(action) {
  if(captionAnalysisActive){toast('字幕任务正在处理，请等待完成后再操作');return false;}
  captionAnalysisActive=true;
  const buttons=['matchScript','generateAutoCaptions','realignCaptions'].map(id=>$(id)).filter(Boolean);
  const disabled=buttons.map(button=>button.disabled);
  buttons.forEach(button=>{button.disabled=true;});
  try{return await action();}
  finally{captionAnalysisActive=false;buttons.forEach((button,index)=>{button.disabled=disabled[index];});}
}
const originalMatchScript=matchScript,originalGenerateAutoCaptions=generateAutoCaptions;
matchScript=(...args)=>runExclusiveCaptionAnalysis(()=>originalMatchScript(...args));
generateAutoCaptions=(...args)=>runExclusiveCaptionAnalysis(()=>originalGenerateAutoCaptions(...args));
