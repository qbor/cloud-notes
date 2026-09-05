(function(){
'use strict';
var LS_NOTES='cloud_notes.notes';
var LS_MESSAGES='cloud_notes.messages';
var LS_CONFIG='cloud_notes.config';
var LS_KEYS='cloud_notes.keys';
var SITE_CONFIG={
  supabaseUrl:'https://gbredjjrpdcazcrlvniz.supabase.co',       
  supabaseAnonKey:'sb_publishable_QT0HsneR-K_OcN2fEiIUTQ_G-FODobx'    
};
var state={
  notes:[],
  messages:[],
  currentNoteId:null,
  mode:'local',
  user:null,
  filterCategory:'',
  dirty:false,
  saving:false
};
var sbClient=null;
var rtChannel=null;
var saveTimer=null;
var currentRoute='notes';
var authListenerStarted=false;
var authPromptPending=false;
var authRecovery=false;
var $=function(id){return document.getElementById(id)};
function initTheme(){
  var saved=null;
  try{saved=localStorage.getItem('cloud_notes.theme');}catch(e){}
  var theme=saved||(window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');
  applyTheme(theme);
}
function applyTheme(theme){
  var dark=theme==='dark';
  if(dark) document.documentElement.setAttribute('data-theme','dark');
  else document.documentElement.removeAttribute('data-theme');
  var im=$('themeIconMoon'),is=$('themeIconSun'),lb=$('themeLabel');
  if(im) im.style.display=dark?'none':'';
  if(is) is.style.display=dark?'':'none';
  if(lb) lb.textContent=dark?'浅色模式':'深色模式';
  var mc=document.querySelector('meta[name="theme-color"]');
  if(mc) mc.setAttribute('content',dark?'#15171C':'#FAFAF8');
}
initTheme();
$('themeToggle').addEventListener('click',function(){
  var cur=document.documentElement.getAttribute('data-theme')==='dark'?'dark':'light';
  var next=cur==='dark'?'light':'dark';
  try{localStorage.setItem('cloud_notes.theme',next);}catch(e){}
  applyTheme(next);
});
function escapeHtml(s){
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}
function uid(){
  if(window.crypto&&crypto.randomUUID) return crypto.randomUUID();
  return 'n-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10);
}
function safeUrl(u){
  if(!u) return null;
  var s=u.replace(/&amp;/g,'&');
  if(/^(https?:|mailto:)/i.test(s)) return s;
  if(/^data:image\//i.test(s)) return s;
  return null;
}
function stripMd(s){
  return String(s||'')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g,'$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g,'$1')
    .replace(/[#>*`_~\-]/g,'')
    .replace(/\s+/g,' ')
    .trim();
}
function formatTime(iso){
  if(!iso) return '';
  var t=new Date(iso);
  if(isNaN(t.getTime())) return '';
  var now=new Date();
  var diff=now-t;
  var min=Math.floor(diff/60000);
  if(min<1) return '刚刚';
  if(min<60) return min+' 分钟前';
  var hr=Math.floor(min/60);
  if(hr<24) return hr+' 小时前';
  var day=Math.floor(hr/24);
  if(day===1) return '昨天';
  if(day<7) return day+' 天前';
  var pad=function(n){return n<10?'0'+n:''+n};
  return t.getFullYear()+'-'+pad(t.getMonth()+1)+'-'+pad(t.getDate());
}
function formatClock(iso){
  if(!iso) return '';
  var t=new Date(iso);
  if(isNaN(t.getTime())) return '';
  var pad=function(n){return n<10?'0'+n:''+n};
  return pad(t.getHours())+':'+pad(t.getMinutes());
}
function parseTags(str){
  return String(str||'').split(/[,，]/).map(function(t){return t.trim();}).filter(Boolean).slice(0,10);
}
function showToast(msg,type){
  type=type||'info';
  var wrap=$('toastWrap');
  var el=document.createElement('div');
  el.className='toast '+type;
  el.textContent=msg;
  wrap.appendChild(el);
  setTimeout(function(){el.style.opacity='0';el.style.transition='opacity .3s';},2600);
  setTimeout(function(){if(el.parentNode)el.parentNode.removeChild(el);},3000);
}
var modalCb=null;
function openModal(title,desc,okText,cb){
  $('modalTitle').textContent=title;
  $('modalDesc').textContent=desc;
  $('btnModalOk').textContent=okText||'删除';
  modalCb=cb;
  $('modalScrim').classList.add('open');
}
function closeModal(){$('modalScrim').classList.remove('open');modalCb=null;}
$('btnModalCancel').addEventListener('click',closeModal);
$('modalScrim').addEventListener('click',function(e){if(e.target===this)closeModal();});
$('btnModalOk').addEventListener('click',function(){
  var cb=modalCb;
  closeModal();
  if(cb)cb();
});
function openLightbox(src){$('lightboxImg').src=src;$('lightbox').classList.add('open');}
function closeLightbox(){$('lightbox').classList.remove('open');}
$('lightbox').addEventListener('click',closeLightbox);
$('notePreview').addEventListener('click',function(e){
  if(e.target&&e.target.tagName==='IMG'){
    var src=e.target.getAttribute('src');
    if(src) openLightbox(src);
  }
});
document.addEventListener('keydown',function(e){
  if(e.key==='Escape'){closeLightbox();closeModal();}
});
function inlineMd(t){
  return t
    .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,function(m,alt,url){
      var u=safeUrl(url);
      if(!u) return m;
      return '<img src="'+u+'" alt="'+escapeHtml(alt)+'" loading="lazy">';
    })
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,function(m,text,url){
      var u=safeUrl(url);
      if(!u) return m;
      return '<a href="'+u+'" target="_blank" rel="noopener">'+text+'</a>';
    })
    .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g,'$1<em>$2</em>')
    .replace(/`([^`]+)`/g,'<code>$1</code>')
    .replace(/~~(.+?)~~/g,'<del>$1</del>');
}
function renderMarkdown(src){
  if(!src) return '';
  var lines=String(src).replace(/\r\n/g,'\n').split('\n');
  var out=[];
  var i=0;
  while(i<lines.length){
    var line=lines[i];
    var fence=line.match(/^`{3,}(\w*)\s*$/);
    if(fence){
      i++;
      var buf=[];
      while(i<lines.length&&!/^`{3,}\s*$/.test(lines[i])){buf.push(lines[i]);i++;}
      i++;
      out.push('<pre><code>'+escapeHtml(buf.join('\n'))+'</code></pre>');
      continue;
    }
    var h=line.match(/^(#{1,4})\s+(.*)$/);
    if(h){
      var lv=h[1].length;
      out.push('<h'+lv+'>'+inlineMd(escapeHtml(h[2]))+'</h'+lv+'>');
      i++;
      continue;
    }
    if(/^\s*(---|\*\*\*|___)\s*$/.test(line)){
      out.push('<hr>');
      i++;
      continue;
    }
    if(/^>\s?/.test(line)){
      var q=[];
      while(i<lines.length&&/^>\s?/.test(lines[i])){
        q.push(inlineMd(escapeHtml(lines[i].replace(/^>\s?/,''))));
        i++;
      }
      out.push('<blockquote>'+q.join('<br>')+'</blockquote>');
      continue;
    }
    if(/^\s*[-*+]\s+/.test(line)){
      var ul=[];
      while(i<lines.length&&/^\s*[-*+]\s+/.test(lines[i])){
        ul.push('<li>'+inlineMd(escapeHtml(lines[i].replace(/^\s*[-*+]\s+/,'')))+'</li>');
        i++;
      }
      out.push('<ul>'+ul.join('')+'</ul>');
      continue;
    }
    if(/^\s*\d+\.\s+/.test(line)){
      var ol=[];
      while(i<lines.length&&/^\s*\d+\.\s+/.test(lines[i])){
        ol.push('<li>'+inlineMd(escapeHtml(lines[i].replace(/^\s*\d+\.\s+/,'')))+'</li>');
        i++;
      }
      out.push('<ol>'+ol.join('')+'</ol>');
      continue;
    }
    if(!line.trim()){i++;continue;}
    var para=[];
    while(i<lines.length&&lines[i].trim()&&
          !/^(#{1,4})\s/.test(lines[i])&&!/^`{3,}/.test(lines[i])&&
          !/^>\s?/.test(lines[i])&&!/^\s*[-*+]\s+/.test(lines[i])&&
          !/^\s*\d+\.\s+/.test(lines[i])&&!/^\s*(---|\*\*\*|___)\s*$/.test(lines[i])){
      para.push(lines[i]);
      i++;
    }
    out.push('<p>'+para.map(function(l){return inlineMd(escapeHtml(l));}).join('<br>')+'</p>');
  }
  return out.join('\n');
}
function loadKeys(){
  try{
    var k=JSON.parse(localStorage.getItem(LS_KEYS)||'null');
    return k&&k.url&&k.key?k:null;
  }catch(e){return null;}
}
function saveKeys(url,key){
  localStorage.setItem(LS_KEYS,JSON.stringify({url:url,key:key}));
}
function clearKeys(){localStorage.removeItem(LS_KEYS);}
function initClient(){
  var k=null;
  if(SITE_CONFIG.supabaseUrl&&SITE_CONFIG.supabaseAnonKey){
    k={url:SITE_CONFIG.supabaseUrl,key:SITE_CONFIG.supabaseAnonKey};
  }else{
    k=loadKeys();
  }
  if(!k||!window.supabase||!window.supabase.createClient){sbClient=null;state.mode='local';return false;}
  try{
    sbClient=window.supabase.createClient(k.url,k.key);
    state.mode='cloud';
    return true;
  }catch(e){
    sbClient=null;state.mode='local';
    return false;
  }
}
function getLocalNotes(){
  try{return JSON.parse(localStorage.getItem(LS_NOTES)||'[]');}catch(e){return [];}
}
function setLocalNotes(arr){localStorage.setItem(LS_NOTES,JSON.stringify(arr));}
function getLocalMessages(){
  try{return JSON.parse(localStorage.getItem(LS_MESSAGES)||'[]');}catch(e){return [];}
}
function setLocalMessages(arr){localStorage.setItem(LS_MESSAGES,JSON.stringify(arr));}
function loadNotes(){
  if(state.mode==='cloud'&&sbClient){
    return sbClient.from('notes').select('*').order('updated_at',{ascending:false});
  }
  state.notes=getLocalNotes().sort(function(a,b){
    return new Date(b.updated_at||0)-new Date(a.updated_at||0);
  });
  return Promise.resolve({data:state.notes,error:null});
}
function saveNoteData(note){
  if(state.mode==='cloud'&&sbClient){
    var payload={
      id:note.id,
      title:note.title||'未命名笔记',
      content:note.content||'',
      user_id:state.user?state.user.id:null,
      category:(note.category||'').trim(),
      tags:parseTags(note.tags),
      updated_at:new Date().toISOString()
    };
    return sbClient.from('notes').upsert(payload).select().single().then(function(res){
      if(!res.error) state.notes=state.notes.slice();
      return res;
    });
  }
  var arr=getLocalNotes();
  var idx=arr.findIndex(function(n){return n.id===note.id;});
  var saved={
    id:note.id,
    title:note.title||'未命名笔记',
    content:note.content||'',
    category:(note.category||'').trim(),
    tags:parseTags(note.tags),
    created_at:note.created_at||new Date().toISOString(),
    updated_at:new Date().toISOString()
  };
  if(idx>=0){arr[idx]=saved;}else{arr.unshift(saved);}
  setLocalNotes(arr);
  state.notes=arr.slice();
  return Promise.resolve({data:saved,error:null});
}
function deleteNoteData(id){
  if(state.mode==='cloud'&&sbClient){
    return sbClient.from('notes').delete().eq('id',id).then(function(res){
      if(!res.error) state.notes=state.notes.filter(function(n){return n.id!==id;});
      return res;
    });
  }
  var arr=getLocalNotes().filter(function(n){return n.id!==id;});
  setLocalNotes(arr);
  state.notes=arr.slice();
  return Promise.resolve({data:null,error:null});
}
function loadMessages(){
  if(state.mode==='cloud'&&sbClient){
    return sbClient.from('messages').select('*').order('created_at',{ascending:false}).limit(200);
  }
  state.messages=getLocalMessages().sort(function(a,b){
    return new Date(b.created_at||0)-new Date(a.created_at||0);
  });
  return Promise.resolve({data:state.messages,error:null});
}
function saveMessageData(msg){
  if(state.mode==='cloud'&&sbClient){
    return sbClient.from('messages').insert(msg).select().single();
  }
  var arr=getLocalMessages();
  var saved={id:uid(),name:msg.name,email:msg.email||null,content:msg.content,created_at:new Date().toISOString()};
  arr.unshift(saved);
  setLocalMessages(arr);
  state.messages=arr.slice();
  return Promise.resolve({data:saved,error:null});
}
function watchRealtime(){
  if(!sbClient||rtChannel) return;
  rtChannel=sbClient.channel('cloud-notes-live')
    .on('postgres_changes',{event:'*',schema:'public',table:'notes'},function(payload){
      if(payload.eventType==='INSERT'){
        state.notes.unshift(payload.new);
        if(currentRoute==='notes') renderNotes();
      }else if(payload.eventType==='UPDATE'){
        var idx=state.notes.findIndex(function(n){return n.id===payload.new.id;});
        if(idx>=0) state.notes[idx]=payload.new;else state.notes.unshift(payload.new);
        if(currentRoute==='notes') renderNotes();
        if(currentRoute==='gallery') renderGallery();
        if(state.currentNoteId===payload.new.id){
          if(state.dirty||document.activeElement&&document.activeElement.id==='noteContent'){
            showToast('这篇笔记已在其他设备更新','info');
          }else{
            fillEditor(payload.new);
          }
        }
      }else if(payload.eventType==='DELETE'){
        state.notes=state.notes.filter(function(n){return n.id!==payload.old.id;});
        if(currentRoute==='notes') renderNotes();
        if(currentRoute==='gallery') renderGallery();
        if(state.currentNoteId===payload.old.id){
          showToast('这篇笔记已在其他设备被删除','info');
          navigate('#/notes');
        }
      }
    })
    .on('postgres_changes',{event:'INSERT',schema:'public',table:'messages'},function(payload){
      if(currentRoute==='messages'){
        state.messages.unshift(payload.new);
        renderMessages();
      }
    })
    .subscribe();
}
function unwatchRealtime(){
  if(rtChannel){
    sbClient.removeChannel(rtChannel);
    rtChannel=null;
  }
}
window.addEventListener('storage',function(e){
  if(e.key===LS_NOTES&&state.mode==='local'){
    state.notes=getLocalNotes();
    if(currentRoute==='notes') renderNotes();
    if(currentRoute==='gallery') renderGallery();
  }
  if(e.key===LS_MESSAGES&&state.mode==='local'&&currentRoute==='messages'){
    renderMessages();
  }
  if(e.key===LS_KEYS){
    var connected=!!loadKeys();
    if(connected!==(state.mode==='cloud')){
      initClient();
      if(state.mode==='cloud'){watchRealtime();loadNotes().then(renderAll);}
      else{unwatchRealtime();state.notes=getLocalNotes();state.messages=getLocalMessages();renderAll();}
      updateConnUI();
    }
  }
});
function parseHash(){
  var h=location.hash.replace(/^#\/?/,'')||'notes';
  var parts=h.split('/');
  if(parts[0]==='note'&&parts[1]) return {name:'note',id:parts[1]};
  if(['notes','gallery','messages','settings'].indexOf(parts[0])>=0) return {name:parts[0]};
  return {name:'notes'};
}
function navigate(hash){location.hash=hash;}
window.addEventListener('hashchange',renderRoute);

function guardRoute(name){
  if(state.mode==='cloud'&&!state.user&&['notes','gallery','note'].indexOf(name)>=0){
    return false;
  }
  return true;
}
function renderRoute(){
  var route=parseHash();
  if(!guardRoute(route.name)){
    authPromptPending=true;
    navigate('#/auth');
    return;
  }
  currentRoute=route.name;
  document.querySelectorAll('.view').forEach(function(v){v.classList.remove('active');});
  var el=document.querySelector('.view[data-view="'+route.name+'"]');
  if(el) el.classList.add('active');
  document.querySelectorAll('.nav-item').forEach(function(b){
    b.classList.toggle('active',b.getAttribute('data-route')===route.name);
  });
  closeSidebar();
  if(route.name==='notes'){renderNotes();}
  else if(route.name==='note'){openNote(route.id);}
  else if(route.name==='gallery'){renderGallery();}
  else if(route.name==='messages'){renderMessages();}
  else if(route.name==='settings'){renderSettings();}
  else if(route.name==='auth'){renderAuth();}
  window.scrollTo(0,0);
}
function closeSidebar(){$('sidebar').classList.remove('open');$('scrim').classList.remove('show');}
$('btnMenu').addEventListener('click',function(){
  $('sidebar').classList.add('open');
  $('scrim').classList.add('show');
});
$('scrim').addEventListener('click',closeSidebar);
document.querySelectorAll('.nav-item').forEach(function(b){
  b.addEventListener('click',function(){
    navigate('#/'+b.getAttribute('data-route'));
  });
});
function collectCategories(){
  var seen={};
  state.notes.forEach(function(n){
    if(n.category&&n.category.trim()&&!seen[n.category.trim()]) seen[n.category.trim()]=true;
  });
  return Object.keys(seen).sort();
}
function renderFilterRow(){
  var cats=collectCategories();
  var row=$('filterRow');
  if(!cats.length){row.innerHTML='';return;}
  var html='<button class="filter-chip'+(state.filterCategory===''?' active':'')+'" data-cat="">全部</button>';
  html+=cats.map(function(c){
    return '<button class="filter-chip'+(state.filterCategory===c?' active':'')+'" data-cat="'+escapeHtml(c)+'">'+escapeHtml(c)+'</button>';
  }).join('');
  row.innerHTML=html;
  Array.prototype.forEach.call(row.querySelectorAll('.filter-chip'),function(ch){
    ch.addEventListener('click',function(){
      state.filterCategory=ch.getAttribute('data-cat');
      renderFilterRow();
      renderNotes();
    });
  });
}
function renderNotes(){
  var q=($('searchInput').value||'').trim().toLowerCase();
  var cat=state.filterCategory;
  var list=state.notes.filter(function(n){
    if(cat&&(n.category||'').trim()!==cat) return false;
    if(!q) return true;
    return (n.title||'').toLowerCase().indexOf(q)>=0||(n.content||'').toLowerCase().indexOf(q)>=0;
  });
  $('notesCountDesc').textContent=state.notes.length+' 篇笔记'+(state.mode==='cloud'?' · 已接入云端实时同步':' · 本地模式');
  renderFilterRow();
  var grid=$('notesGrid');
  if(!state.notes.length){
    grid.innerHTML=
      '<div class="note-empty">'+
        '<div class="empty-title">把想法，安放在云端</div>'+
        '<div class="empty-sub">写下第一篇笔记，开启你的云端记录。</div>'+
        '<button class="btn-primary" id="emptyNewBtn">新建笔记</button>'+
      '</div>';
    var nb=$('emptyNewBtn');
    if(nb) nb.addEventListener('click',createNewNote);
    return;
  }
  if(!list.length){
    grid.innerHTML='<div class="note-empty">'+
      (cat?'<div class="empty-sub">「'+escapeHtml(cat)+'」分类下暂无笔记。</div>'
          :'<div class="empty-sub">没有找到与「'+escapeHtml(q)+'」相关的笔记。</div>')+
      '</div>';
    return;
  }
  grid.innerHTML=list.map(function(n){
    var cover=extractFirstImage(n.content);
    var snippet=stripMd(n.content);
    if(!snippet) snippet='空白笔记';
    var badges='';
    if(n.category&&n.category.trim()) badges+='<span class="badge-cat">'+escapeHtml(n.category.trim())+'</span>';
    (n.tags||[]).slice(0,3).forEach(function(t){badges+='<span class="badge-tag">'+escapeHtml(t)+'</span>';});
    return '<button class="note-card" data-id="'+n.id+'">'+
      (cover?'<img class="note-cover" src="'+cover+'" alt="" loading="lazy">':'')+
      '<div class="note-body">'+
        '<div class="note-title">'+escapeHtml(n.title||'未命名笔记')+'</div>'+
        '<div class="note-snippet">'+escapeHtml(snippet)+'</div>'+
        (badges?'<div class="note-badges">'+badges+'</div>':'')+
        '<div class="note-meta"><span>更新于 '+formatTime(n.updated_at)+'</span></div>'+
      '</div></button>';
  }).join('');
  Array.prototype.forEach.call(grid.querySelectorAll('.note-card'),function(card){
    card.addEventListener('click',function(){
      navigate('#/note/'+card.getAttribute('data-id'));
    });
  });
}
function extractFirstImage(md){
  if(!md) return null;
  var m=String(md).match(/!\[[^\]]*\]\(([^)\s]+)\)/);
  if(!m) return null;
  return safeUrl(m[1]);
}
$('searchInput').addEventListener('input',function(){
  if(currentRoute==='notes') renderNotes();
});
function createNewNote(){
  if(state.mode==='cloud'&&!state.user){
    authPromptPending=true;
    navigate('#/auth');
    return;
  }
  var note={id:uid(),title:'',content:'',created_at:new Date().toISOString(),updated_at:new Date().toISOString()};
  if(state.mode==='cloud'&&sbClient){
    sbClient.from('notes').insert({
      id:note.id,title:'',content:'',user_id:state.user.id,updated_at:note.updated_at
    }).select().single().then(function(res){
      if(res.error){showToast('创建失败：'+res.error.message,'error');return;}
      state.notes.unshift(res.data);
      navigate('#/note/'+res.data.id);
    });
  }else{
    var arr=getLocalNotes();
    arr.unshift(note);
    setLocalNotes(arr);
    state.notes=arr.slice();
    navigate('#/note/'+note.id);
  }
}
$('btnNewNote').addEventListener('click',createNewNote);
var editorBackup=null;
function openNote(id){
  editorBackup=null;
  var note=state.notes.find(function(n){return n.id===id;});
  if(!note){
    if(state.mode==='cloud'&&sbClient){
      sbClient.from('notes').select('*').eq('id',id).single().then(function(res){
        if(res.data){state.notes.unshift(res.data);fillEditor(res.data);}
        else{showToast('笔记不存在或已被删除','error');navigate('#/notes');}
      });
    }else{
      showToast('笔记不存在或已被删除','error');
      navigate('#/notes');
    }
    return;
  }
  state.currentNoteId=id;
  fillEditor(note);
}
function fillEditor(note){
  state.currentNoteId=note.id;
  state.dirty=false;
  setStatus('idle');
  var t=$('noteTitle'),c=$('noteContent'),cat=$('noteCategory'),tg=$('noteTags');
  if(document.activeElement!==t) t.value=note.title||'';
  if(document.activeElement!==c) c.value=note.content||'';
  if(document.activeElement!==cat) cat.value=note.category||'';
  if(document.activeElement!==tg) tg.value=(note.tags||[]).join(', ');
  renderPreview();
  setStatus('saved',note.updated_at);
}
function setStatus(kind,ts){
  var el=$('editorStatus');
  el.className='editor-status';
  if(kind==='saving'){el.classList.add('saving');el.textContent='正在保存…';}
  else if(kind==='saved'){el.classList.add('saved');el.textContent='已保存'+(ts?' · '+formatClock(ts):'');}
  else if(kind==='error'){el.classList.add('error');el.textContent='保存失败，请重试';}
  else{el.textContent='未保存';}
}
function currentDraft(){
  return {
    id:state.currentNoteId,
    title:$('noteTitle').value,
    content:$('noteContent').value,
    category:$('noteCategory').value,
    tags:$('noteTags').value
  };
}
function scheduleSave(){
  state.dirty=true;
  setStatus('saving');
  clearTimeout(saveTimer);
  saveTimer=setTimeout(doSave,800);
}
function doSave(){
  if(!state.currentNoteId) return;
  var draft=currentDraft();
  var snapshotId=state.currentNoteId;
  saveNoteData(draft).then(function(res){
    if(snapshotId!==state.currentNoteId) return;
    state.dirty=false;
    if(res.error){
      setStatus('error');
      showToast('保存失败：'+res.error.message,'error');
    }else{
      if(res.data){
        var idx=state.notes.findIndex(function(n){return n.id===res.data.id;});
        if(idx>=0) state.notes[idx]=res.data;else state.notes.unshift(res.data);
      }
      setStatus('saved',res.data?res.data.updated_at:new Date().toISOString());
    }
  });
}
$('noteTitle').addEventListener('input',scheduleSave);
$('noteCategory').addEventListener('input',scheduleSave);
$('noteTags').addEventListener('input',scheduleSave);
$('noteContent').addEventListener('input',function(){
  scheduleSave();
  renderPreview();
});
$('btnBack').addEventListener('click',function(){navigate('#/notes');});
$('btnDeleteNote').addEventListener('click',function(){
  if(!state.currentNoteId) return;
  openModal('删除这篇笔记？','删除后无法恢复，云端数据也会一并移除。','删除',function(){
    var id=state.currentNoteId;
    deleteNoteData(id).then(function(res){
      if(res.error){showToast('删除失败：'+res.error.message,'error');}
      else{showToast('笔记已删除','success');}
      state.currentNoteId=null;
      navigate('#/notes');
    });
  });
});
$('tabEdit').addEventListener('click',function(){
  $('tabEdit').classList.add('active');$('tabPreview').classList.remove('active');
  $('noteContent').classList.remove('hidden');
  $('notePreview').classList.add('hidden');
});
$('tabPreview').addEventListener('click',function(){
  $('tabPreview').classList.add('active');$('tabEdit').classList.remove('active');
  $('noteContent').classList.add('hidden');
  $('notePreview').classList.remove('hidden');
  renderPreview();
});
function renderPreview(){
  $('notePreview').innerHTML=renderMarkdown($('noteContent').value);
}
$('btnInsertImg').addEventListener('click',function(){
  var box=$('imgInsert');
  box.classList.toggle('open');
  if(box.classList.contains('open')) $('imgUrlInput').focus();
});
$('btnImgUrlOk').addEventListener('click',function(){
  var url=($('imgUrlInput').value||'').trim();
  if(!url){showToast('请先粘贴图片链接','error');return;}
  var safe=safeUrl(url);
  if(!safe){showToast('仅支持 http(s) 或 data:image 链接','error');return;}
  insertAtCursor('![图片]('+safe+')');
  $('imgUrlInput').value='';
  $('imgInsert').classList.remove('open');
});
$('imgUrlInput').addEventListener('keydown',function(e){
  if(e.key==='Enter') $('btnImgUrlOk').click();
});
$('btnImgUpload').addEventListener('click',function(){
  if(state.mode!=='cloud'||!sbClient){
    showToast('本地模式暂不支持上传，连接云端后即可上传图片','info');
    return;
  }
  $('imgFileInput').click();
});
$('imgFileInput').addEventListener('change',function(){
  var file=this.files&&this.files[0];
  if(!file) return;
  if(!/^image\//.test(file.type)){showToast('请选择图片文件','error');return;}
  if(file.size>4*1024*1024){showToast('图片需小于 4MB','error');this.value='';return;}
  var ext=(file.name.split('.').pop()||'png').toLowerCase().replace(/[^a-z0-9]/g,'')||'png';
  var path='notes/'+Date.now()+'-'+Math.random().toString(36).slice(2,8)+'.'+ext;
  var btn=$('btnImgUpload');
  btn.disabled=true;
  btn.textContent='上传中…';
  sbClient.storage.from('images').upload(path,file,{contentType:file.type,upsert:false}).then(function(res){
    if(res.error) throw res.error;
    return sbClient.storage.from('images').getPublicUrl(path);
  }).then(function(meta){
    insertAtCursor('![图片]('+meta.data.publicUrl+')');
    showToast('图片已上传','success');
  }).catch(function(err){
    showToast('上传失败：'+(err.message||'请确认已创建 images 存储桶'),'error');
  }).finally(function(){
    btn.disabled=false;
    btn.textContent='本地上传';
    $('imgFileInput').value='';
  });
});
function insertAtCursor(text){
  var ta=$('noteContent');
  var start=ta.selectionStart!=null?ta.selectionStart:ta.value.length;
  var end=ta.selectionEnd!=null?ta.selectionEnd:ta.value.length;
  var prefix=ta.value.slice(0,start),suffix=ta.value.slice(end);
  var needNl=prefix&&!/\n$/.test(prefix);
  var insert=(needNl?'\n':'')+text+'\n';
  ta.value=prefix+insert+suffix;
  var pos=start+insert.length;
  ta.selectionStart=ta.selectionEnd=pos;
  ta.focus();
  scheduleSave();
  renderPreview();
}
function collectImages(){
  var seen={};
  var out=[];
  state.notes.forEach(function(n){
    var cover=extractFirstImage(n.content);
    if(cover&&!seen[cover]){
      seen[cover]=true;
      out.push({src:cover,note:n.title||'未命名笔记'});
    }
    var re=/!\[[^\]]*\]\(([^)\s]+)\)/g;
    var m;
    while((m=re.exec(n.content||''))){
      var u=safeUrl(m[1]);
      if(u&&!seen[u]){seen[u]=true;out.push({src:u,note:n.title||'未命名笔记'});}
    }
  });
  return out;
}
function renderGallery(){
  var imgs=collectImages();
  $('galleryCountDesc').textContent=imgs.length?'共 '+imgs.length+' 张图片，来自笔记中的插图':'笔记中的图片会汇总展示在这里';
  var grid=$('galleryGrid');
  if(!imgs.length){
    grid.innerHTML='<div class="gallery-empty">暂无图片。在笔记中插入图片（粘贴链接或上传）后，会自动汇总到这里。</div>';
    return;
  }
  grid.innerHTML=imgs.map(function(img,i){
    return '<div class="gallery-item" data-i="'+i+'"><img src="'+img.src+'" alt="" loading="lazy"><div class="gallery-tag">'+escapeHtml(img.note)+'</div></div>';
  }).join('');
  Array.prototype.forEach.call(grid.querySelectorAll('.gallery-item'),function(it){
    it.addEventListener('click',function(){
      var img=imgs[parseInt(it.getAttribute('data-i'),10)];
      if(img) openLightbox(img.src);
    });
  });
}
function renderMessages(){
  var list=$('msgList');
  if(!state.messages.length){
    list.innerHTML='<div class="msg-empty">还没有留言，来写下第一条吧。</div>';
    return;
  }
  list.innerHTML=state.messages.map(function(m){
    return '<div class="msg-item">'+
      '<div class="msg-head"><span class="msg-name">'+escapeHtml(m.name)+'</span><span class="msg-time">'+formatTime(m.created_at)+'</span></div>'+
      '<div class="msg-content">'+escapeHtml(m.content)+'</div>'+
    '</div>';
  }).join('');
}
$('msgForm').addEventListener('submit',function(e){
  e.preventDefault();
  var name=($('msgName').value||'').trim();
  var email=($('msgEmail').value||'').trim();
  var content=($('msgContent').value||'').trim();
  if(!name){showToast('请填写昵称','error');$('msgName').focus();return;}
  if(!content){showToast('请填写留言内容','error');$('msgContent').focus();return;}
  if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){showToast('邮箱格式不正确','error');$('msgEmail').focus();return;}
  saveMessageData({name:name,email:email,content:content}).then(function(res){
    if(res.error){showToast('发布失败：'+res.error.message,'error');return;}
    $('msgName').value='';$('msgEmail').value='';$('msgContent').value='';
    if(state.mode==='cloud'){state.messages.unshift(res.data);}
    renderMessages();
    showToast('留言已发布','success');
  });
});
var SQL_TEXT=
'-- 笔记表（按用户隔离，支持分类与标签）\n'+
'create table if not exists notes (\n'+
'  id uuid primary key default gen_random_uuid(),\n'+
'  title text not null default \'\',\n'+
'  content text not null default \'\',\n'+
'  user_id uuid references auth.users(id) on delete cascade,\n'+
'  category text not null default \'\',\n'+
'  tags text[] not null default \'{}\',\n'+
'  created_at timestamptz not null default now(),\n'+
'  updated_at timestamptz not null default now()\n'+
');\n\n'+
'-- 留言表（公开区域，记录留言人 user_id 供标识）\n'+
'create table if not exists messages (\n'+
'  id uuid primary key default gen_random_uuid(),\n'+
'  name text not null,\n'+
'  email text,\n'+
'  content text not null,\n'+
'  user_id uuid references auth.users(id) on delete set null,\n'+
'  created_at timestamptz not null default now()\n'+
');\n\n'+
'-- 兼容旧表：补充字段\n'+
'alter table notes add column if not exists user_id uuid references auth.users(id) on delete cascade;\n'+
'alter table notes add column if not exists category text not null default \'\';\n'+
'alter table notes add column if not exists tags text[] not null default \'{}\';\n'+
'alter table messages add column if not exists user_id uuid references auth.users(id) on delete set null;\n\n'+
'-- 笔记：仅本人可读写（私有）\n'+
'alter table notes enable row level security;\n'+
'drop policy if exists "notes_all" on notes;\n'+
'create policy "notes_own" on notes\n'+
'  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);\n\n'+
'-- 留言板：所有人可读，所有人可发布\n'+
'alter table messages enable row level security;\n'+
'drop policy if exists "messages_all" on messages;\n'+
'create policy "messages_public_read" on messages for select using (true);\n'+
'create policy "messages_insert" on messages for insert with check (true);\n\n'+
'-- 存储桶（用于笔记内图片上传）\n'+
'insert into storage.buckets (id, name, public)\n'+
'values (\'images\', \'images\', true)\n'+
'on conflict (id) do nothing;';

function renderSettings(){
  var k=loadKeys();
  if(k){
    $('setUrl').value=k.url;
    $('setKey').value=k.key;
  }
  var online=state.mode==='cloud';
  var badge=$('modeBadge');
  badge.className='badge '+(online?'on':'off');
  badge.textContent=online?'云端已连接':'本地模式';
  $('modeDesc').textContent=online
    ?'笔记已接入 Supabase 云端数据库。登录后笔记按用户隔离存储，并通过实时通道在多设备间自动同步。'
    :'当前笔记仅保存在此浏览器中。配置 Supabase 后，用邮箱或手机号注册登录，笔记即存入云端并按用户隔离。';
  $('sqlBlock').textContent=SQL_TEXT;
  $('connResult').textContent='';
  updateConnUI();
}
$('btnSaveConn').addEventListener('click',function(){
  var url=($('setUrl').value||'').trim().replace(/\/+$/,'');
  var key=($('setKey').value||'').trim();
  if(!url||!key){showToast('请填写 Project URL 与 anon key','error');return;}
  if(!/^https:\/\//.test(url)){showToast('Project URL 需以 https:// 开头','error');return;}
  $('btnSaveConn').disabled=true;
  $('btnSaveConn').textContent='连接中…';
  var test=window.supabase&&window.supabase.createClient?window.supabase.createClient(url,key):null;
  if(!test){finishConnFail('浏览器环境不支持 Supabase SDK');return;}
  test.from('notes').select('id').limit(1).then(function(res){
    if(res.error){
      finishConnFail('连接失败：'+(res.error.message||'请检查 URL 与 key 是否正确'));
      return;
    }
    saveKeys(url,key);
    initClient();
    unwatchRealtime();
    watchRealtime();
    getCurrentUser().then(function(u){
      state.user=u;
      listenAuth();
      updateUserUI();
      if(u){
        loadNotes().then(function(){
          state.messages=[];
          loadMessages().then(function(){
            renderAll();
            updateConnUI();
            finishConnOk();
          });
        });
      }else{
        renderAll();
        updateConnUI();
        finishConnOk();
        authPromptPending=true;
        navigate('#/auth');
      }
    });
  }).catch(function(err){
    finishConnFail('连接失败：'+(err.message||'网络异常'));
  });
});
function finishConnFail(msg){
  $('btnSaveConn').disabled=false;
  $('btnSaveConn').textContent='保存并连接';
  showToast(msg,'error');
  $('connResult').textContent=msg;
  $('connResult').style.color='var(--danger)';
}
function finishConnOk(){
  $('btnSaveConn').disabled=false;
  $('btnSaveConn').textContent='保存并连接';
  showToast('已连接 Supabase，云同步已开启','success');
  $('connResult').textContent='连接成功，笔记已切换到云端实时同步。';
  $('connResult').style.color='var(--success)';
}
$('btnTestConn').addEventListener('click',function(){
  var url=($('setUrl').value||'').trim().replace(/\/+$/,'');
  var key=($('setKey').value||'').trim();
  if(!url||!key){showToast('请先填写 URL 与 key','error');return;}
  $('btnTestConn').disabled=true;
  $('btnTestConn').textContent='测试中…';
  var test=window.supabase&&window.supabase.createClient?window.supabase.createClient(url,key):null;
  if(!test){
    $('btnTestConn').disabled=false;$('btnTestConn').textContent='测试连接';
    showToast('浏览器环境不支持 Supabase SDK','error');
    return;
  }
  test.from('notes').select('id').limit(1).then(function(res){
    $('btnTestConn').disabled=false;$('btnTestConn').textContent='测试连接';
    if(res.error){showToast('连接失败：'+res.error.message,'error');$('connResult').textContent='连接失败：'+res.error.message;$('connResult').style.color='var(--danger)';}
    else{showToast('连接正常','success');$('connResult').textContent='连接正常，配置有效。';$('connResult').style.color='var(--success)';}
  }).catch(function(err){
    $('btnTestConn').disabled=false;$('btnTestConn').textContent='测试连接';
    showToast('连接失败：'+(err.message||'网络异常'),'error');
  });
});
$('btnDisconnect').addEventListener('click',function(){
  clearKeys();
  unwatchRealtime();
  sbClient=null;
  state.mode='local';
  state.user=null;
  authListenerStarted=false;
  state.notes=getLocalNotes();
  state.messages=getLocalMessages();
  renderAll();
  updateConnUI();
  updateUserUI();
  showToast('已断开云端连接，回到本地模式','info');
});
$('btnCopySql').addEventListener('click',function(){
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(SQL_TEXT).then(function(){
      showToast('建表 SQL 已复制','success');
    }).catch(function(){
      fallbackCopy(SQL_TEXT);
    });
  }else{
    fallbackCopy(SQL_TEXT);
  }
});
function fallbackCopy(text){
  var ta=document.createElement('textarea');
  ta.value=text;
  ta.style.position='fixed';ta.style.opacity='0';
  document.body.appendChild(ta);
  ta.select();
  try{document.execCommand('copy');showToast('建表 SQL 已复制','success');}
  catch(e){showToast('复制失败，请手动选择复制','error');}
  document.body.removeChild(ta);
}
function getCurrentUser(){
  if(!sbClient) return Promise.resolve(null);
  return sbClient.auth.getSession().then(function(r){
    return r.data.session?r.data.session.user:null;
  });
}
function listenAuth(){
  if(authListenerStarted||!sbClient) return;
  authListenerStarted=true;
  sbClient.auth.onAuthStateChange(function(event,session){
    var prevUser=state.user;
    state.user=session?session.user:null;
    if(event==='PASSWORD_RECOVERY'){
      authRecovery=true;
      if(currentRoute!=='auth'){
        navigate('#/auth');
      }else{
        showAuthPanel('reset');
        $('authNote').textContent='';
      }
      showToast('请设置新密码','info');
      updateUserUI();
      return;
    }
    if((event==='SIGNED_IN'||event==='INITIAL_SESSION')&&state.user&&state.mode==='cloud'){
      loadNotes().then(function(){
        state.messages=[];
        loadMessages().then(function(){
          if(currentRoute==='notes') renderNotes();
          if(currentRoute==='gallery') renderGallery();
          if(currentRoute==='messages') renderMessages();
        });
      });
    }
    if(event==='SIGNED_OUT'){
      state.notes=[];
      state.messages=[];
      if(currentRoute!=='auth') navigate('#/auth');
    }
    if(!prevUser&&state.user&&(event==='SIGNED_IN'||event==='INITIAL_SESSION')&&(currentRoute==='auth'||authPromptPending)){
      authPromptPending=false;
      showToast('登录成功，欢迎使用云上笔记','success');
      navigate('#/notes');
    }
    updateUserUI();
  });
}
function updateUserUI(){
  var area=$('userArea');
  if(!area) return;
  if(state.mode!=='cloud'){
    area.innerHTML='<div class="user-box"><div class="user-avatar" style="background:var(--text-3)">本</div><div class="user-info"><div class="user-email">本地模式</div><div class="user-sub">无需登录即可试用</div></div></div>';
    return;
  }
  if(!state.user){
    area.innerHTML='<button class="auth-cta" id="btnGoAuth">登录 / 注册</button>';
    var b=$('btnGoAuth');
    if(b) b.addEventListener('click',function(){navigate('#/auth');});
    return;
  }
  var email=state.user.email||state.user.phone||'用户';
  var letter=(email[0]||'用').toUpperCase();
  area.innerHTML='<div class="user-box">'+
    '<div class="user-avatar">'+escapeHtml(letter)+'</div>'+
    '<div class="user-info"><div class="user-email">'+escapeHtml(email)+'</div><div class="user-sub">'+(state.user.email?'邮箱账号':'手机账号')+'</div></div>'+
    '<button class="btn-logout" id="btnLogout">退出</button></div>';
  var lo=$('btnLogout');
  if(lo) lo.addEventListener('click',function(){
    if(sbClient) sbClient.auth.signOut().then(function(){showToast('已退出登录','info');});
  });
}
function renderAuth(){
  if(state.mode!=='cloud'){
    $('authNote').textContent='当前未连接云端，请联系站长检查服务配置。';
  }else if(state.user){
    if(authRecovery){
      $('authNote').textContent='';
      showAuthPanel('reset');
    }else{
      navigate('#/notes');
      return;
    }
  }else{
    $('authNote').textContent='';
  }
  if(authPromptPending){
    authPromptPending=false;
    showToast('请先登录后使用云笔记','info');
  }
}
var authTab='login';
var loginMethod='password';
var regMethod='email';
function showAuthPanel(name){
  var isLogin=name==='login',isRegister=name==='register';
  $('authTabLogin').classList.toggle('active',isLogin);
  $('authTabRegister').classList.toggle('active',isRegister);
  $('loginPanel').style.display=isLogin?'':'none';
  $('registerPanel').style.display=isRegister?'':'none';
  $('forgotPanel').style.display=name==='forgot'?'':'none';
  $('resetPanel').style.display=name==='reset'?'':'none';
}
function setAuthTab(tab){authTab=tab;showAuthPanel(tab);}
$('authTabLogin').addEventListener('click',function(){setAuthTab('login');});
$('authTabRegister').addEventListener('click',function(){setAuthTab('register');});
$('btnForgot').addEventListener('click',function(){showAuthPanel('forgot');});
$('btnBackLogin').addEventListener('click',function(){showAuthPanel('login');});
$('forgotForm').addEventListener('submit',function(e){
  e.preventDefault();
  if(!sbClient){showToast('尚未连接云端','error');return;}
  var email=($('forgotEmail').value||'').trim();
  if(!email){showToast('请输入邮箱','error');return;}
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){showToast('邮箱格式不正确','error');return;}
  var btn=$('forgotSubmitBtn');
  btn.disabled=true;
  sbClient.auth.resetPasswordForEmail(email,{redirectTo:location.origin+location.pathname}).then(function(res){
    btn.disabled=false;
    if(res.error){showToast('发送失败：'+res.error.message,'error');return;}
    showToast('重置邮件已发送至 '+email+'，请查收','success');
    $('forgotEmail').value='';
    showAuthPanel('login');
  }).catch(function(err){btn.disabled=false;showToast('发送失败：'+(err.message||'网络异常'),'error');});
});
$('resetForm').addEventListener('submit',function(e){
  e.preventDefault();
  if(!sbClient){showToast('尚未连接云端','error');return;}
  var p1=$('resetPassword').value||'';
  var p2=$('resetPassword2').value||'';
  if(p1.length<6){showToast('新密码至少 6 位','error');return;}
  if(p1!==p2){showToast('两次输入的密码不一致','error');return;}
  var btn=$('resetSubmitBtn');
  btn.disabled=true;
  sbClient.auth.updateUser({password:p1}).then(function(res){
    btn.disabled=false;
    if(res.error){showToast('更新失败：'+res.error.message,'error');return;}
    authRecovery=false;
    $('resetPassword').value='';$('resetPassword2').value='';
    showToast('密码已更新，请用新密码登录','success');
    sbClient.auth.signOut().then(function(){});
    showAuthPanel('login');
  }).catch(function(err){btn.disabled=false;showToast('更新失败：'+(err.message||'网络异常'),'error');});
});
function setLoginMethod(m){
  loginMethod=m;
  document.querySelectorAll('#loginPanel .method-btn').forEach(function(b){
    b.classList.toggle('active',b.getAttribute('data-method')===m);
  });
  document.querySelector('[data-lf="password"]').style.display=m==='password'?'':'none';
  document.querySelector('[data-lf="phone"]').style.display=m==='phone'?'':'none';
}
$('lmPassword').addEventListener('click',function(){setLoginMethod('password');});
$('lmPhone').addEventListener('click',function(){setLoginMethod('phone');});
function setRegMethod(m){
  regMethod=m;
  document.querySelectorAll('#registerPanel .method-btn').forEach(function(b){
    b.classList.toggle('active',b.getAttribute('data-method')===m);
  });
  document.querySelector('[data-rf="email"]').style.display=m==='email'?'':'none';
  document.querySelector('[data-rf="phone"]').style.display=m==='phone'?'':'none';
}
$('rmEmail').addEventListener('click',function(){setRegMethod('email');});
$('rmPhone').addEventListener('click',function(){setRegMethod('phone');});
function sendPhoneOtp(phone,btn){
  if(!sbClient){showToast('尚未连接云端','error');return;}
  btn.disabled=true;
  sbClient.auth.signInWithOtp({phone:phone}).then(function(res){
    if(res.error){
      btn.disabled=false;
      showToast('发送失败：'+res.error.message,'error');
      return;
    }
    showToast('验证码已发送，请注意查收','success');
    var left=60;
    var timer=setInterval(function(){
      left--;
      if(left<=0){
        clearInterval(timer);
        btn.disabled=false;
        btn.textContent='发送验证码';
      }else{
        btn.textContent=left+'s 后重发';
      }
    },1000);
  }).catch(function(err){
    btn.disabled=false;
    showToast('发送失败：'+(err.message||'网络异常'),'error');
  });
}
$('btnSendLoginOtp').addEventListener('click',function(){
  var phone=($('loginPhone').value||'').trim();
  if(!phone){showToast('请输入手机号','error');return;}
  sendPhoneOtp(phone,this);
});
$('btnSendRegOtp').addEventListener('click',function(){
  var phone=($('regPhone').value||'').trim();
  if(!phone){showToast('请输入手机号','error');return;}
  sendPhoneOtp(phone,this);
});
$('loginForm').addEventListener('submit',function(e){
  e.preventDefault();
  if(!sbClient){showToast('尚未连接云端','error');return;}
  var btn=$('loginSubmitBtn');
  if(loginMethod==='password'){
    var email=($('loginEmail').value||'').trim();
    var password=$('loginPassword').value||'';
    if(!email||!password){showToast('请填写邮箱和密码','error');return;}
    btn.disabled=true;
    sbClient.auth.signInWithPassword({email:email,password:password}).then(function(res){
      btn.disabled=false;
      if(res.error) showToast('登录失败：'+(res.error.message||'邮箱或密码错误'),'error');
    }).catch(function(err){btn.disabled=false;showToast('登录失败：'+(err.message||'网络异常'),'error');});
  }else{
    var phone=($('loginPhone').value||'').trim();
    var otp=($('loginOtp').value||'').trim();
    if(!phone||!otp){showToast('请填写手机号和验证码','error');return;}
    btn.disabled=true;
    sbClient.auth.verifyOtp({phone:phone,token:otp,type:'sms'}).then(function(res){
      btn.disabled=false;
      if(res.error) showToast('验证失败：'+res.error.message,'error');
    }).catch(function(err){btn.disabled=false;showToast('验证失败：'+(err.message||'网络异常'),'error');});
  }
});
$('registerForm').addEventListener('submit',function(e){
  e.preventDefault();
  if(!sbClient){showToast('尚未连接云端','error');return;}
  var btn=$('regSubmitBtn');
  if(regMethod==='email'){
    var email=($('regEmail').value||'').trim();
    var p1=$('regPassword').value||'';
    var p2=$('regPassword2').value||'';
    if(!email||!p1){showToast('请填写邮箱和密码','error');return;}
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){showToast('邮箱格式不正确','error');return;}
    if(p1.length<6){showToast('密码至少 6 位','error');return;}
    if(p1!==p2){showToast('两次输入的密码不一致','error');return;}
    btn.disabled=true;
    sbClient.auth.signUp({email:email,password:p1}).then(function(res){
      btn.disabled=false;
      if(res.error){
        showToast('注册失败：'+res.error.message,'error');
        return;
      }
      if(res.data.session){
        showToast('注册成功，欢迎使用云上笔记','success');
      }else{
        showToast('注册成功！确认邮件已发送至 '+email+'，请点击邮件中的链接完成验证','info');
      }
    }).catch(function(err){btn.disabled=false;showToast('注册失败：'+(err.message||'网络异常'),'error');});
  }else{
    var phone=($('regPhone').value||'').trim();
    var otp=($('regOtp').value||'').trim();
    if(!phone||!otp){showToast('请填写手机号和验证码','error');return;}
    btn.disabled=true;
    sbClient.auth.verifyOtp({phone:phone,token:otp,type:'sms'}).then(function(res){
      btn.disabled=false;
      if(res.error) showToast('验证失败：'+res.error.message,'error');
    }).catch(function(err){btn.disabled=false;showToast('验证失败：'+(err.message||'网络异常'),'error');});
  }
});
function updateConnUI(){
  var online=state.mode==='cloud';
  var dot=$('connDot');
  dot.className='conn-dot '+(online?'online':'local');
  $('connLabel').textContent=online?'云端已连接':'本地模式';
  $('connSub').textContent=online?'实时同步中':'未连接云端';
}
function renderAll(){
  if(currentRoute==='notes') renderNotes();
  if(currentRoute==='gallery') renderGallery();
  if(currentRoute==='messages') renderMessages();
  if(currentRoute==='settings') renderSettings();
}
function init(){
  initClient();
  if(state.mode==='cloud') watchRealtime();
  if(sbClient){
    listenAuth();
    getCurrentUser().then(function(u){
      state.user=u;
      updateUserUI();
      renderRoute();
    });
  }else{
    updateUserUI();
    renderRoute();
  }
  loadNotes().then(function(){
    if(currentRoute==='notes') renderNotes();
  });
  loadMessages().then(function(){
    if(currentRoute==='messages') renderMessages();
  });
  updateConnUI();
}
document.addEventListener('DOMContentLoaded',init);
})();
