const fs = require('fs');
const path = require('path');

module.exports = function installUserscriptDomPublishingSupport(DB, BrowserManager) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const SUBMIT_DELAY_MIN_MS = 1000;
  const SUBMIT_DELAY_MAX_MS = 3000;
  let lastSubmitDelayMs = -1;
  const nextSubmitDelayMs = () => {
    let value = Math.floor(Math.random() * (SUBMIT_DELAY_MAX_MS - SUBMIT_DELAY_MIN_MS + 1)) + SUBMIT_DELAY_MIN_MS;
    if (value === lastSubmitDelayMs) {
      value = value >= SUBMIT_DELAY_MAX_MS ? SUBMIT_DELAY_MIN_MS : value + 1;
    }
    lastSubmitDelayMs = value;
    return value;
  };
  const S = {
    box: '.publish-editor-container', area: '.publish-editor-container .editor-area',
    header: '.publish-editor-container .editor-header', edit: '.publish-editor-container .ProseMirror',
    file: '.publish-editor-container input[type=file]', send: '.publish-editor-container .publish-button button',
    preview: '.publish-editor-container .image-draggable-preview, .publish-editor-container .preview-list img, .publish-editor-container .preview-list video',
    mask: '.publish-editor-container .image-mask', scroller: '#scrollableDiv', feed: '.msgBox[data-index]',
    cEntry: '.bottom-comment-input .bottom-input', cBox: '.comment-editor-container',
    cEdit: '.comment-editor-container .ProseMirror', cSend: '.comment-editor-container .publish-button button',
    cPlaceholder: '.comment-editor-container .exeditor-placeholder-container', cItem: '.comment-richcontent'
  };
  const norm = v => String(v || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
  const noRetry = msg => { const e = new Error(msg); e.name = 'NonRetryableError'; e.retryable = false; return e; };

  async function wait(fn, timeout, interval = 150) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const v = await fn().catch(() => null); if (v) return v; await sleep(interval); }
    return null;
  }

  BrowserManager.prototype.qqcOpenEditor = async function(webContents) {
    const r = await webContents.executeJavaScript(`(async()=>{const S=${JSON.stringify(S)},q=s=>document.querySelector(s),sleep=m=>new Promise(r=>setTimeout(r,m)),vis=e=>!!e&&e.offsetParent!==null,click=e=>{if(!e)return;const v=e.ownerDocument?.defaultView; e.scrollIntoView({block:'center'});for(const t of ['pointerdown','mousedown','mouseup','click']){let x;try{x=new MouseEvent(t,{bubbles:true,cancelable:true,view:v,buttons:1})}catch(_){x=new MouseEvent(t,{bubbles:true,cancelable:true})}e.dispatchEvent(x)}try{e.click()}catch(_){}};let n=0,end=Date.now()+15000;while(Date.now()<end){let ed=q(S.edit);if(vis(ed)){ed.focus();return{ok:true,n}}const box=q(S.box);if(box){click(box.querySelector('.editor-header')||box.querySelector('.editor-area')||box);n++;await sleep(200);ed=q(S.edit);if(!vis(ed)){const ph=box.querySelector('.placeholder-text, .editor-header *');if(vis(ph)){click(ph);n++}}}await sleep(120)}return{ok:false,n,box:!!q(S.box),area:String(q(S.area)?.className||''),edit:!!q(S.edit),visible:vis(q(S.edit))}})()`, true);
    if (!r?.ok) throw noRetry(`油猴DOM：发帖编辑器未展开（box=${r?.box?'有':'无'}, area=${r?.area||'无'}, edit=${r?.edit?(r?.visible?'可见':'不可见'):'无'}, clicks=${r?.n||0}）`);
  };

  BrowserManager.prototype.qqcType = async function(webContents, selector, text) {
    const r = await webContents.executeJavaScript(`(()=>{const sel=${JSON.stringify(selector)},text=${JSON.stringify(String(text||''))},vis=e=>!!e&&e.offsetParent!==null,el=[...document.querySelectorAll(sel)].find(vis)||document.querySelector(sel);if(!el)return{ok:false};el.focus();try{const x=document.createRange();x.selectNodeContents(el);const s=getSelection();s.removeAllRanges();s.addRange(x);document.execCommand('delete',false,null)}catch(_){}const range=document.createRange();range.selectNodeContents(el);range.collapse(false);const s=getSelection();s.removeAllRanges();s.addRange(range);let ok=false;try{ok=!!document.execCommand&&document.execCommand('insertText',false,text)}catch(_){}if(!ok)try{const dt=new DataTransfer();dt.setData('text/plain',text);const ev=new ClipboardEvent('paste',{bubbles:true,cancelable:true});Object.defineProperty(ev,'clipboardData',{value:dt});el.dispatchEvent(ev);ok=true}catch(_){}if(!ok){el.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertText',data:text}));el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}))}return{ok:true,value:String(el.innerText||el.textContent||el.value||'')}})()`, true);
    if (!r?.ok) throw new Error(`油猴DOM：找不到输入框 ${selector}`);
    return r;
  };

  BrowserManager.prototype.qqcSetFile = async function(webContents, mediaPath) {
    if (!fs.existsSync(mediaPath)) throw new Error(`素材文件不存在：${mediaPath}`);
    if (!webContents.debugger.isAttached()) webContents.debugger.attach('1.3');
    const doc = await webContents.debugger.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
    const hit = await webContents.debugger.sendCommand('DOM.querySelector', { nodeId: doc.root.nodeId, selector: S.file });
    if (!hit?.nodeId) throw new Error('油猴DOM：找不到发布媒体 input[type=file]');
    await webContents.debugger.sendCommand('DOM.setFileInputFiles', { nodeId: hit.nodeId, files: [path.resolve(mediaPath)] });
  };

  BrowserManager.prototype.qqcWaitReady = async function(webContents, hasMedia) {
    const timeout = Math.max(15000, Number(this.db.getSetting('upload_timeout_ms', '120000')) || 120000);
    const ok = await wait(() => webContents.executeJavaScript(`(()=>{const S=${JSON.stringify(S)},v=e=>!!e&&e.offsetParent!==null,b=document.querySelector(S.send),m=document.querySelector(S.mask),p=document.querySelectorAll(S.preview).length;return !!(b&&v(b)&&!b.disabled&&!b.classList.contains('disabled')&&b.getAttribute('aria-disabled')!=='true'&&${hasMedia?'p>0&&!(m&&v(m))':'true'})})()`, true), timeout, 250);
    if (!ok) throw new Error(`油猴DOM：等待${hasMedia?'媒体上传和':''}发表按钮可用超时（${Math.round(timeout/1000)}秒）`);
  };

  BrowserManager.prototype.qqcSnapshot = webContents => webContents.executeJavaScript(`(()=>[...new Set([...document.querySelectorAll(${JSON.stringify(S.feed)})].map(e=>String(e.dataset.index||'')).filter(Boolean))])()`, true).catch(()=>[]);

  BrowserManager.prototype.qqcPublish = async function(webContents, before) {
    const submitDelayMs = nextSubmitDelayMs();
    this.db.log('info', `油猴DOM：发表前随机等待 ${(submitDelayMs / 1000).toFixed(3)} 秒`);
    await sleep(submitDelayMs);
    const clicked = await webContents.executeJavaScript(`(()=>{const b=document.querySelector(${JSON.stringify(S.send)});if(!b||b.disabled||b.classList.contains('disabled'))return false;b.click();return true})()`, true);
    if (!clicked) throw new Error('油猴DOM：发表按钮点击失败');
    const old = new Set(before || []);
    const created = await wait(() => webContents.executeJavaScript(`(()=>{const old=new Set(${JSON.stringify([...old])}),sc=document.querySelector(${JSON.stringify(S.scroller)});if(sc&&sc.scrollTop>0)sc.scrollTo({top:0});const first=document.querySelector(${JSON.stringify(S.feed)});if(!first)return null;const id=String(first.dataset.index||'');if(!id||old.has(id))return null;const a=first.querySelector('a[href*="/post/"]');return{feedId:id,url:a?new URL(a.getAttribute('href'),location.origin).href:new URL('/post/'+id,location.origin).href}})()`, true), 40000, 250);
    if (!created?.feedId) throw noRetry('已点击发表，但40秒内没有检测到新的 .msgBox[data-index]；为避免重复发帖，本次不自动重试');
    return created;
  };

  BrowserManager.prototype.qqcFeedId = url => (String(url || '').match(/\/post\/(B_[A-Za-z0-9]+)/) || [])[1] || null;

  BrowserManager.prototype.qqcComment = async function(webContents, postUrl, text) {
    const feedId = this.qqcFeedId(postUrl || webContents.getURL());
    if (!feedId) throw new Error(`油猴DOM：不是 /post/B_xxx 详情页，无法评论：${webContents.getURL()}`);
    const opened = await wait(() => webContents.executeJavaScript(`(()=>{const ed=document.querySelector(${JSON.stringify(S.cEdit)});if(ed&&ed.offsetParent){ed.focus();return true}const e=document.querySelector(${JSON.stringify(S.cEntry)});if(!e||!e.offsetParent)return false;const v=e.ownerDocument?.defaultView;for(const t of ['pointerdown','mousedown','mouseup','click']){let x;try{x=new MouseEvent(t,{bubbles:true,cancelable:true,view:v,buttons:1})}catch(_){x=new MouseEvent(t,{bubbles:true,cancelable:true})}e.dispatchEvent(x)}try{e.click()}catch(_){}return false})()`, true), 12000, 150);
    if (!opened) throw new Error('油猴DOM：评论输入框没有展开');
    const before = await webContents.executeJavaScript(`(()=>{const l=document.querySelector('#comment-container-'+CSS.escape(${JSON.stringify(feedId)}));return l?l.querySelectorAll(${JSON.stringify(S.cItem)}).length:0})()`, true).catch(()=>0);
    const filled = await this.qqcType(webContents, S.cEdit, text);
    if (!norm(filled?.value).includes(norm(text))) throw new Error('油猴DOM：评论内容写入校验失败');
    await sleep(300);
    const enabled = await wait(() => webContents.executeJavaScript(`(()=>{const b=document.querySelector(${JSON.stringify(S.cSend)});return !!(b&&!b.disabled&&!b.classList.contains('disabled')&&b.getAttribute('aria-disabled')!=='true')})()`, true), 10000, 120);
    if (!enabled) throw new Error('油猴DOM：评论发送按钮一直不可用');
    await webContents.executeJavaScript(`(()=>{const b=document.querySelector(${JSON.stringify(S.cSend)});if(!b)return false;b.click();return true})()`, true);
    const verified = await wait(() => webContents.executeJavaScript(`(()=>{const l=document.querySelector('#comment-container-'+CSS.escape(${JSON.stringify(feedId)})),n=l?l.querySelectorAll(${JSON.stringify(S.cItem)}).length:0;return n>${Number(before)||0}||!document.querySelector(${JSON.stringify(S.cBox)})||!!document.querySelector(${JSON.stringify(S.cPlaceholder)})})()`, true), 20000, 200);
    if (!verified) throw new Error('油猴DOM：点击发送后未确认评论成功');
    return { postUrl: webContents.getURL(), feedId };
  };

  BrowserManager.prototype.publishOneTarget = async function(record, task, target, selectors, attempt) {
    const wc = record.view.webContents, comment = norm(task.comment), already = Number(target.post_published || 0) === 1;
    if (already && !this.qqcFeedId(target.post_url)) {
      throw noRetry('该目标已标记为帖子已发布，但没有油猴流程可识别的 /post/B_xxx 详情链接；为避免重复发帖，不再回退旧发布器');
    }
    try {
      this.db.setTargetStatus(target.id, 'running');
      this.notifyPublishUpdate({ type:'target-started', instanceId:task.instance_id, taskId:task.id, channelName:target.channel_name, attempt });
      let postUrl = String(target.post_url || ''), result = { success:true, postUrl, reason:already?'already_published':'' };
      if (!already) {
        this.db.log('info', `任务 #${task.id} 打开频道：${target.channel_name}（第${attempt}次，油猴DOM）`);
        await this.navigate(task.instance_id, target.channel_url);
        if (!(await this.getLoginStatus(task.instance_id, record)).loggedIn) throw new Error('QQ 登录状态已失效，请重新登录后继续');
        const before = await this.qqcSnapshot(wc);
        await this.qqcOpenEditor(wc);
        await this.clearComposerMedia(wc).catch(()=>{});
        const body = String(task.body || '').trim();
        if (body) { const f = await this.qqcType(wc, S.edit, body); if (!norm(f?.value).includes(norm(body))) throw new Error('油猴DOM：正文写入校验失败'); await sleep(300); }
        const textOnly = task.media_type === 'text';
        if (!textOnly) { await this.qqcSetFile(wc, task.media_path); this.db.log('info', `任务 #${task.id} -> ${target.channel_name} ${task.media_type==='image'?'图片':'视频'}已选择，等待上传`); }
        await this.qqcWaitReady(wc, !textOnly);
        const made = await this.qqcPublish(wc, before);
        postUrl = made.url; result = { success:true, postUrl, feedId:made.feedId, reason:'new_msgBox_feed' };
        this.db.markTargetPostPublished?.(target.id, postUrl); this.db.setTargetPostUrl?.(target.id, postUrl);
        target.post_published = 1; target.post_url = postUrl;
        this.db.log('info', `任务 #${task.id} -> ${target.channel_name} 发布成功（feedId=${made.feedId}）`);
      } else this.db.log('info', `任务 #${task.id} -> ${target.channel_name} 帖子已发布，本次仅补发评论（油猴DOM）`);
      if (!comment) { this.db.setTargetCommentStatus?.(target.id,'skipped'); this.db.setTargetStatus(target.id,'success'); this.notifyPublishUpdate({type:'target-finished',instanceId:task.instance_id,taskId:task.id,channelName:target.channel_name,status:'success'}); return result; }
      if (!postUrl) throw new Error('帖子已发布，但没有获取到帖子详情链接');
      if (wc.getURL() !== postUrl) await this.navigate(task.instance_id, postUrl);
      if (!(await this.getLoginStatus(task.instance_id, record)).loggedIn) throw new Error('QQ 登录状态已失效，请重新登录后继续');
      const cr = await this.qqcComment(wc, postUrl, comment);
      this.db.setTargetPostUrl?.(target.id, cr.postUrl || postUrl); this.db.setTargetCommentStatus?.(target.id,'success'); this.db.setTargetStatus(target.id,'success');
      this.db.log('info', `任务 #${task.id} -> ${target.channel_name} 评论发送成功（油猴DOM）`);
      this.notifyPublishUpdate({type:'target-finished',instanceId:task.instance_id,taskId:task.id,channelName:target.channel_name,status:'success'});
      return result;
    } catch (error) {
      const published = Number(target.post_published || 0) === 1, raw = String(error?.message || error), msg = published&&comment&&!raw.startsWith('帖子已发表，但评论发送失败：') ? `帖子已发表，但评论发送失败：${raw}` : raw;
      if (published && comment) this.db.setTargetCommentStatus?.(target.id,'failed');
      const shot = await this.saveFailureScreenshot(wc, task.id, target.id, attempt), detail = shot ? `${msg}\n截图：${shot}` : msg;
      this.db.setTargetStatus(target.id,'failed',detail); this.db.log('error', `任务 #${task.id} -> ${target.channel_name} 失败：${msg}${shot?`；截图：${shot}`:''}`);
      this.notifyPublishUpdate({type:'target-finished',instanceId:task.instance_id,taskId:task.id,channelName:target.channel_name,status:'failed'});
      if (published && comment) { const e = new Error(msg); e.retryable = true; throw e; }
      throw error;
    }
  };
};
