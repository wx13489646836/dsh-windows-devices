window.__ModuleLoader__.load({id:'dsh-windows-devices',factory:require=>{
  const React=require('react'),h=React.createElement;
  const api=async(path,body)=>{const r=await fetch('/windows-devices/'+path,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json','x-dsh-device-ui':'1'},body:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw new Error(j.error||('HTTP '+r.status));return j;};
  const box={padding:16,border:'1px solid var(--dsw-alias-border-l2,#555)',borderRadius:12,marginTop:14};
  const button={padding:'8px 12px',borderRadius:8,border:'1px solid #777',background:'transparent',color:'inherit',cursor:'pointer'};
  function Section(props){
    const session=props.useSessions(s=>s.current);
    const [state,setState]=React.useState(null),[error,setError]=React.useState(''),[message,setMessage]=React.useState(''),[busy,setBusy]=React.useState(false),[revoke,setRevoke]=React.useState(null);
    const [editing,setEditing]=React.useState(null),[name,setName]=React.useState('');
    const conversationRequests=React.useRef(new Map());
    const refresh=React.useCallback(()=>api('state?session='+encodeURIComponent(session||'')).then(setState).catch(e=>setError(e.message)),[session]);
    React.useEffect(()=>{refresh();const t=setInterval(refresh,5000);return()=>clearInterval(t);},[refresh]);
    const run=async fn=>{setBusy(true);setError('');setMessage('');try{await fn();await refresh();}catch(e){setError(e.message);}finally{setBusy(false);}};
    const btn=(label,fn,disabled=false)=>h('button',{type:'button',style:button,disabled:busy||disabled,onClick:()=>run(fn)},label);
    async function saveName(id){await api('rename',{id,name});setEditing(null);setMessage('设备名称已保存。');}
    async function startConversation(d){
      let requestId=conversationRequests.current.get(d.id);
      if(!requestId){requestId=Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);conversationRequests.current.set(d.id,requestId);}
      setMessage('正在通过 SSH 读取设备配置并创建对话……');
      await props.openDeviceConversation(d.id,requestId);
      conversationRequests.current.delete(d.id);
      props.close();
    }
    async function pair(){const r=await fetch('/windows-devices/pair',{method:'POST',headers:{'content-type':'application/json','x-dsh-device-ui':'1'},body:'{}'});if(!r.ok)throw new Error((await r.json()).error);const url=URL.createObjectURL(await r.blob()),a=document.createElement('a');a.href=url;a.download='DSH-Windows-Setup.bat';a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);setMessage('接入程序已下载。请在要控制的 Windows 电脑上双击运行，并允许管理员提权。接入包 30 分钟内有效，一包对应一台电脑。');}
    return h('div',{style:{padding:20,maxWidth:850}},
      h('h2',null,'Windows 设备'),h('p',null,'首次运行接入程序，以后连接此移动 WiFi 即可自动上线。'),
      h('div',{style:{display:'flex',gap:10}},btn('添加本机 · 下载接入程序',pair,!state?.ready),btn('刷新',refresh)),
      !session&&h('p',null,'点击设备下方“新建对话 · 核验 SSH”，即可直接开始使用。'),
      error&&h('p',{role:'alert',style:{color:'#f87171'}},error),message&&h('p',{role:'status',style:{whiteSpace:'pre-wrap'}},message),
      state?.devices.length===0&&h('div',{style:box},'还没有接入的电脑。下载接入程序并在新电脑上运行后，设备会出现在这里。'),
      ...((state?.devices||[]).map(d=>h('div',{key:d.id,style:box},
        h('strong',null,d.name),h('span',{style:{marginLeft:12,color:d.online?'#4ade80':'#a3a3a3'}},d.revoked?(d.cleanupDone?'已解除绑定':'已解除绑定 · 等待电脑清理'):!d.enabled?'已停用':d.online?'在线 · SSH 已验证':'离线 / 等待 SSH 验证'),
        h('div',{style:{marginTop:8}},editing===d.id?h('div',{style:{display:'flex',gap:8,flexWrap:'wrap'}},
          h('input',{'aria-label':'设备名称',value:name,maxLength:64,autoFocus:true,disabled:busy,onChange:e=>setName(e.target.value),onKeyDown:e=>{if(e.key==='Enter'){e.preventDefault();if(!busy)run(()=>saveName(d.id));}if(e.key==='Escape')setEditing(null);},style:{padding:8,borderRadius:6,border:'1px solid #777',background:'transparent',color:'inherit'}}),
          btn('保存名称',()=>saveName(d.id),!name.trim()),btn('取消修改',()=>setEditing(null))):btn('修改名称',()=>{setName(d.name);setEditing(d.id);})),
        h('p',null,`${d.ip}:${d.port} · ${d.username}`),state.selected===d.id&&h('p',{style:{color:'#60a5fa'}},'✓ 此对话正在使用这台电脑'),d.lastError&&h('p',{style:{color:'#fbbf24'}},d.lastError),
        !d.revoked&&h('div',{style:{display:'flex',flexWrap:'wrap',gap:8}},
          btn('新建对话 · 核验 SSH',()=>startConversation(d),!d.online),
          btn('用于当前对话',async()=>{await api('action',{id:d.id,action:'select',session});setMessage('已选择 '+d.name+'。关闭设置后，可以说：查看这台电脑的系统信息和磁盘空间。');},!session||!d.online),
          btn('测试 SSH',async()=>{const r=await api('test',{id:d.id});setMessage('SSH 验证成功：'+r.facts.hostname+' / '+r.facts.user+' / 管理员权限');},!d.enabled),
          btn(d.enabled?'停用':'恢复',()=>api('action',{id:d.id,action:d.enabled?'disable':'enable'})),
          btn('解除绑定',async()=>setRevoke(d.id))),
        revoke===d.id&&h('div',null,h('p',null,'解除后将停止控制；重新使用需要再次运行接入程序。'),btn('确认解除绑定',async()=>{await api('action',{id:d.id,action:'revoke'});setRevoke(null);}),btn('取消',async()=>setRevoke(null)))
      ))),
      h('p',{style:{marginTop:24,fontSize:12,opacity:.7}},'本插件使用真实 SSH。原有 SSH 配置保持独立；Windows 开始菜单提供停用与卸载入口。'));
  }
  return {inject:['slots','sessions','layout'],apply(ctx){ctx.slots.inject('settings.section',()=>ctx.slots.register({name:'settings.section',id:'windows-devices',order:12,label:()=> 'Windows 设备',inject:()=>({openDeviceConversation:async(id,requestId)=>{const result=await api('conversation',{id,requestId});ctx.sessions.open(result.sessionId);ctx.layout.selectPanel(null);return result;}})},Section));}};
}});
