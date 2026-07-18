export const dashboardHtml = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Codex Mesh</title>
  <style>
    :root{color-scheme:dark;--bg:#0b0d10;--panel:#14181e;--line:#28313c;--text:#e8edf2;--muted:#8e9baa;--blue:#6aa9ff;--green:#56d38b;--amber:#ffc65c;--red:#ff6b72}
    *{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 15% 0,#172332 0,transparent 32%),var(--bg);color:var(--text);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
    header{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:16px;padding:15px 24px;background:#0b0d10e8;border-bottom:1px solid var(--line);backdrop-filter:blur(14px)}
    h1{font-size:18px;margin:0}.sub{color:var(--muted)}.grow{flex:1}.dot{width:9px;height:9px;border-radius:50%;background:var(--green);box-shadow:0 0 14px var(--green)}
    button,input{font:inherit;color:inherit}button{border:1px solid #38506c;background:#1d3149;padding:8px 12px;border-radius:8px;cursor:pointer}button:hover{background:#294665}button.secondary{background:transparent;border-color:var(--line)}
    main{max-width:1260px;margin:auto;padding:24px;display:grid;grid-template-columns:360px 1fr;gap:20px}.panel{background:#14181ed9;border:1px solid var(--line);border-radius:14px;overflow:hidden}.panel h2{font-size:14px;margin:0;padding:14px 16px;border-bottom:1px solid var(--line)}
    .body{padding:14px}.node{padding:13px;border:1px solid var(--line);border-radius:10px;margin-bottom:10px}.node-head{display:flex;gap:8px;align-items:center}.online{color:var(--green)}.offline{color:var(--muted)}.labels{color:var(--blue);font-size:12px}.thread{padding:7px 0 0 17px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}details{margin-top:8px}summary{cursor:pointer;color:#c8d4e0}
    .task{margin-bottom:16px;border:1px solid var(--line);border-radius:12px;overflow:hidden}.task-meta{padding:9px 12px;background:#10141a;color:var(--muted);display:flex;gap:10px;flex-wrap:wrap}.prompt,.result,.error{padding:12px;white-space:pre-wrap;word-break:break-word}.prompt{border-bottom:1px solid var(--line)}.result{color:#c8f2d8;background:#102019}.error{color:#ffd0d2;background:#241316}.badge{padding:1px 7px;border-radius:999px;background:#29323d;color:var(--amber)}
    .empty{padding:30px;text-align:center;color:var(--muted)}#login{position:fixed;inset:0;z-index:10;background:#080a0de8;display:grid;place-items:center}.login-card{width:min(420px,90vw);padding:26px;background:var(--panel);border:1px solid var(--line);border-radius:14px}.login-card input{width:100%;margin:14px 0;padding:10px;background:#0b0d10;border:1px solid var(--line);border-radius:8px}.hidden{display:none!important}.stats{font-variant-numeric:tabular-nums;color:var(--muted)}
    @media(max-width:800px){main{grid-template-columns:1fr;padding:12px}header{padding:12px}.sub{display:none}}
  </style>
</head>
<body>
  <div id="login">
    <form class="login-card" id="loginForm"><h1>连接 Codex Mesh</h1><p class="sub">输入 Relay 的 MCP 管理 Token。Token 只保存在当前浏览器会话中。</p><input id="token" type="password" autocomplete="current-password" placeholder="MESH_MCP_TOKEN" required><button type="submit">进入控制台</button></form>
  </div>
  <header><span class="dot"></span><h1>Codex Mesh</h1><span class="sub">多电脑协作控制台</span><span class="grow"></span><span id="stats" class="stats"></span><button id="pair">生成配对码</button><button id="logout" class="secondary">退出</button></header>
  <main>
    <section class="panel"><h2>电脑与 Codex 对话</h2><div id="nodes" class="body"></div></section>
    <section class="panel"><h2>Codex 之间的协作对话</h2><div id="tasks" class="body"></div></section>
  </main>
  <script>
    const login = document.querySelector('#login');
    const tokenInput = document.querySelector('#token');
    let token = sessionStorage.getItem('meshToken') || '';
    if (token) login.classList.add('hidden');
    const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    async function api(path, options={}) {
      const response = await fetch(path, {...options, headers:{'content-type':'application/json','authorization':'Bearer '+token,...options.headers}});
      if (response.status === 401) { login.classList.remove('hidden'); throw new Error('Token 无效'); }
      if (!response.ok) throw new Error((await response.json().catch(()=>({}))).error || response.statusText);
      return response.json();
    }
    async function refresh() {
      if (!token) return;
      try {
        const data = await api('/api/snapshot');
        document.querySelector('#stats').textContent = 'Relay '+data.memoryMb+' MB · '+data.nodes.filter(n=>n.connected).length+'/'+data.nodes.length+' 在线';
        document.querySelector('#nodes').innerHTML = data.nodes.length ? data.nodes.map(n => { const dirs=[...new Set(n.threads.map(t=>t.cwd))].sort(); const projectMap=new Map(n.projects.map(p=>[p.path,p])); n.threads.forEach(t=>{if(!projectMap.has(t.cwd))projectMap.set(t.cwd,{path:t.cwd,name:t.cwd.replace(/[\\/]+$/,'').split(/[\\/]/).pop()||t.cwd,threadCount:n.threads.filter(x=>x.cwd===t.cwd).length});}); const projects=[...projectMap.values()]; return '<div class="node"><div class="node-head"><strong>'+esc(n.id)+'</strong><span class="'+(n.connected?'online':'offline')+'">'+(n.connected?'在线':'离线')+'</span></div><div class="labels">'+esc(n.hostname)+' · '+esc(n.labels.join(', '))+'</div><details open><summary>项目 '+projects.length+'</summary>'+projects.map(p=>'<div class="thread" title="'+esc(p.path)+'">▣ '+esc(p.name)+' · '+p.threadCount+' 对话</div>').join('')+'</details><details><summary>工作目录 '+dirs.length+'</summary>'+dirs.map(d=>'<div class="thread" title="'+esc(d)+'">⌂ '+esc(d)+'</div>').join('')+'</details><details><summary>全部对话 '+n.threads.length+'</summary>'+(n.threads.length?n.threads.map(t=>'<div class="thread" title="'+esc(t.cwd)+' · '+esc(t.preview)+'">↳ '+esc(t.name||t.preview||t.id)+'</div>').join(''):'<div class="thread">暂无对话</div>')+'</details></div>'; }).join('') : '<div class="empty">还没有已配对电脑</div>';
        document.querySelector('#tasks').innerHTML = data.tasks.length ? data.tasks.map(t => '<article class="task"><div class="task-meta"><span class="badge">'+esc(t.status)+'</span><span class="badge">'+esc(t.metadata?.meshPhase||'legacy')+'</span><span>'+esc(t.sourceNodeId||'Codex')+' → '+esc(t.targetNodeId)+'</span><span>'+new Date(t.createdAt).toLocaleString()+'</span><span>对话 '+esc(t.selectedThreadId||t.threadId||'自动选择')+'</span></div><div class="prompt">'+esc(t.prompt)+'</div>'+(t.result?'<div class="result">'+esc(t.result)+'</div>':'')+(t.error?'<div class="error">'+esc(t.error)+'</div>':'')+'</article>').join('') : '<div class="empty">尚无协作任务。委派会先讨论现状，再确认执行。</div>';
      } catch (error) { console.error(error); }
    }
    document.querySelector('#loginForm').addEventListener('submit', async event => { event.preventDefault(); token=tokenInput.value; try { await api('/api/snapshot'); sessionStorage.setItem('meshToken',token); login.classList.add('hidden'); refresh(); } catch(error){ alert(error.message); } });
    document.querySelector('#pair').addEventListener('click', async () => { try { const p=await api('/api/pairing-code',{method:'POST',body:'{}'}); await navigator.clipboard?.writeText(p.code); alert('一次性配对码：'+p.code+'\n10 分钟内有效，已尝试复制到剪贴板。\n\n在新电脑首次启动 Bridge 时设置 MESH_PAIRING_CODE='+p.code); } catch(error){ alert(error.message); } });
    document.querySelector('#logout').addEventListener('click',()=>{sessionStorage.removeItem('meshToken');token='';login.classList.remove('hidden');});
    setInterval(refresh,3000); refresh();
  </script>
</body>
</html>`;
