import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import { Client } from 'ssh2';
import selfsigned from 'selfsigned';

export const VERSION = '0.2.0';
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const token = () => crypto.randomBytes(32).toString('hex');
const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function psCommand(script, cwd) {
  const working = cwd ? `Set-Location -LiteralPath '${cwd.replaceAll("'", "''")}'\n` : '';
  return 'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(`$ErrorActionPreference='Stop'\n[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\ntry {\n${working}${script}\n} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`, 'utf16le').toString('base64');
}
export function send(res, status, value) {
  res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'});
  res.end(JSON.stringify(value));
}
export async function readJson(req) {
  let size = 0, parts = [];
  for await (const chunk of req) { size += chunk.length; if (size > 2 * 1024 * 1024) throw new Error('请求超过 2 MiB'); parts.push(chunk); }
  return JSON.parse(Buffer.concat(parts).toString() || '{}');
}
function savePrivate(file, data) {
  fs.writeFileSync(file + '.tmp', data, {mode: 0o600}); fs.renameSync(file + '.tmp', file);
}
export class DeviceBridge {
  constructor({dir, host = '192.168.0.1', port = 8118, now = () => Date.now()}) {
    this.dir = dir; this.host = host; this.port = port; this.now = now;
    this.active = new Map(); this.pending = new Map(); this.probes = new Map();
    fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    this.file = path.join(dir, 'devices.json');
    this.state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {devices: [], selections: {}};
    const certFile = path.join(dir, 'tls.json');
    if (fs.existsSync(certFile)) this.tls = JSON.parse(fs.readFileSync(certFile, 'utf8'));
    else {
      const c = selfsigned.generate([{name:'commonName', value:'DSH Windows Devices'}], {days:3650, keySize:2048, algorithm:'sha256', extensions:[{name:'basicConstraints',cA:false},{name:'keyUsage',digitalSignature:true,keyEncipherment:true},{name:'extKeyUsage',serverAuth:true},{name:'subjectAltName',altNames:[{type:7,ip:host}]}]});
      this.tls = {key:c.private,cert:c.cert}; savePrivate(certFile, JSON.stringify(this.tls));
    }
    this.pin = sha(new crypto.X509Certificate(this.tls.cert).raw);
  }
  save() { savePrivate(this.file, JSON.stringify(this.state, null, 2)); }
  publicDevice(d) {
    const p = this.probes.get(d.id);
    return {id:d.id,name:d.name,hostname:d.hostname,username:d.username,ip:d.ip,port:d.port,enabled:d.enabled,revoked:d.revoked,cleanupDone:!!d.cleanupDone,lastSeen:d.lastSeen,online:!d.revoked && d.enabled && !!p?.ok && this.now()-p.at<90000,lastError:p?.error || null};
  }
  list(sessionId) { return {version:VERSION,ready:!!this.server?.listening,port:this.port,selected:this.state.selections[sessionId] || null,devices:this.state.devices.map(d=>this.publicDevice(d))}; }
  createPair() {
    for (const [id,p] of this.pending) if (p.expires < this.now()) this.pending.delete(id);
    if (this.pending.size >= 20) throw new Error('待接入包过多，请稍后重试');
    const id=crypto.randomUUID(), pairingToken=token();
    const keys=crypto.generateKeyPairSync('rsa', {modulusLength:2048,publicKeyEncoding:{type:'pkcs1',format:'pem'},privateKeyEncoding:{type:'pkcs1',format:'pem'}});
    const jwk=crypto.createPublicKey(keys.publicKey).export({format:'jwk'});
    const field=b=>{const h=Buffer.alloc(4);h.writeUInt32BE(b.length);return Buffer.concat([h,b]);};
    const mp=s=>{let b=Buffer.from(s,'base64url'); if(b[0]&128)b=Buffer.concat([Buffer.from([0]),b]);return field(b);};
    const pub='ssh-rsa '+Buffer.concat([field(Buffer.from('ssh-rsa')),mp(jwk.e),mp(jwk.n)]).toString('base64')+' dsh-device-'+id;
    const p={id,pairingToken,privateKey:keys.privateKey,publicKey:pub,expires:this.now()+30*60*1000};
    this.pending.set(id,p);
    return {id,pairingToken,publicKey:pub,expires:p.expires,server:'https://'+this.host+':'+this.port,pin:this.pin,gateway:this.host};
  }
  register(body, ip) {
    const p=this.pending.get(body.id);
    if(!p || p.expires<this.now() || !safeEqual(body.token,p.pairingToken)) throw new Error('接入包已过期或已使用，请重新下载');
    if(!ip?.startsWith('192.168.0.') || !Number.isInteger(body.port) || body.port!==2222) throw new Error('仅允许此 WiFi 的设备及 2222 端口');
    for(const k of ['hostname','username','hostKey']) if(typeof body[k]!=='string' || body[k].length<1 || body[k].length>2048)throw new Error('设备信息不完整');
    if(!/^[a-zA-Z0-9+/]+={0,2}$/.test(body.hostKey))throw new Error('SSH 主机公钥无效');
    if(!/^[a-f0-9]{64}$/.test(body.deviceToken || ''))throw new Error('设备凭据无效');
    const d={id:p.id,name:body.hostname,hostname:body.hostname,username:body.username,ip,port:2222,hostFingerprint:sha(Buffer.from(body.hostKey,'base64')),privateKey:p.privateKey,tokenHash:sha(body.deviceToken),enabled:true,revoked:false,lastSeen:this.now()};
    this.state.devices.push(d); this.save(); this.pending.delete(p.id);
    return {ok:true,id:d.id};
  }
  authenticate(body) {
    const d=this.state.devices.find(d=>d.id===body.id);
    if(!d || !safeEqual(sha(String(body.token || '')),d.tokenHash)) throw new Error('设备认证失败');
    return d;
  }
  async heartbeat(body, ip) {
    const d=this.authenticate(body);
    if(d.revoked) { if(body.cleanupDone){d.cleanupDone=true;this.save();} return {ok:true,action:'revoke'}; }
    if(!ip?.startsWith('192.168.0.')) throw new Error('设备不在目标局域网');
    if(d.ip!==ip){this.disconnect(d.id); d.ip=ip;}
    d.lastSeen=this.now(); this.save();
    if(d.enabled) this.test(d.id).catch(()=>{});
    return {ok:true,action:d.enabled?'enable':'disable'};
  }
  get(id, sessionId) {
    const selected=sessionId && this.state.selections[sessionId];
    if(selected && id && selected!==id)throw new Error('目标与本对话选择的设备不同，请在设备页切换后再操作');
    const d=this.state.devices.find(d=>d.id===(id || selected));
    if(!d || d.revoked)throw new Error('请先在 Windows 设备页选择设备，或指定设备 ID');
    if(!d.enabled)throw new Error('此设备已停用');
    if(this.now()-(d.lastSeen||0)>90000)throw new Error('设备离线：请确认电脑连接此 WiFi');
    return d;
  }
  disconnect(id) { for(const c of this.active.get(id)||[]) c.destroy(); this.active.delete(id); this.probes.delete(id); }
  async connect(d, signal) {
    if(signal?.aborted)throw new Error('操作已取消');
    const c=new Client(); const set=this.active.get(d.id)||new Set(); set.add(c);this.active.set(d.id,set);
    const abort=()=>c.destroy(); signal?.addEventListener('abort',abort,{once:true});
    c.once('close',()=>{set.delete(c);signal?.removeEventListener('abort',abort);});
    await new Promise((resolve,reject)=>{
      c.once('ready',resolve); c.once('error',reject); c.once('close',()=>reject(new Error('SSH 连接关闭')));
      c.connect({host:d.ip,port:d.port,username:d.username,privateKey:d.privateKey,readyTimeout:10000,keepaliveInterval:10000,keepaliveCountMax:2,hostVerifier:key=>safeEqual(sha(key),d.hostFingerprint)});
    }).catch(e=>{c.destroy();throw e;});
    return c;
  }
  async execute({device_id,script,cwd,timeout_seconds=60}, signal, sessionId) {
    const d=this.get(device_id,sessionId), c=await this.connect(d,signal), timeout=Math.min(300,Math.max(1,timeout_seconds))*1000;
    try{return await new Promise((resolve,reject)=>{
      let done=false;const finish=(err,result)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);c.end();err?reject(err):resolve(result);};
      const abort=()=>finish(new Error('已取消；远端进程是否结束尚未确认，请查询后再决定是否重试'));
      const timer=setTimeout(()=>finish(new Error('命令超时；未自动重试，远端进程可能仍在运行')),timeout);
      signal?.addEventListener('abort',abort,{once:true}); c.once('error',e=>finish(e)); c.once('close',()=>finish(new Error('连接中断；命令结果未知，未自动重试')));
      c.exec(psCommand(script,cwd),(err,stream)=>{
        if(err)return finish(err);let out=[],stderr=[],size=0,truncated=false;
        const collect=(arr,b)=>{const keep=Math.max(0,1024*1024-size);if(b.length>keep)truncated=true;if(keep)arr.push(b.subarray(0,keep));size+=b.length;};
        stream.on('data',b=>collect(out,b));stream.stderr.on('data',b=>collect(stderr,b));stream.on('error',e=>finish(e));
        stream.on('close',(code,sig)=>finish(null,{device_id:d.id,hostname:d.hostname,stdout:Buffer.concat(out).toString('utf8'),stderr:Buffer.concat(stderr).toString('utf8'),exit_code:code??null,signal:sig??null,truncated}));
      });
    });}finally{c.destroy();}
  }
  async test(id) {
    const existing=this.probes.get(id);if(existing?.pending)return existing.pending;
    const pending=this.execute({device_id:id,script:"$w=[Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent(); @{hostname=$env:COMPUTERNAME; user=[Security.Principal.WindowsIdentity]::GetCurrent().Name; administrator=$w.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)} | ConvertTo-Json -Compress",timeout_seconds:15}).then(r=>{
      if(r.exit_code!==0)throw new Error(r.stderr || '远端测试失败');
      const facts=JSON.parse(r.stdout.trim());if(!facts.administrator)throw new Error('SSH 已连接，但未获得管理员权限');
      this.probes.set(id,{at:this.now(),ok:true});return {...r,facts};
    }).catch(e=>{this.probes.set(id,{at:this.now(),ok:false,error:e.message});throw e;});
    this.probes.set(id,{...existing,pending});return pending;
  }
  rename(id, name) {
    const d=this.state.devices.find(d=>d.id===id);
    if(!d)throw new Error('设备不存在');
    if(typeof name!=='string'||!name.trim()||[...name.trim()].length>64||/[\u0000-\u001f\u007f]/.test(name))throw new Error('设备名称需为 1–64 个字符，不能包含换行或控制字符');
    d.name=name.trim();this.save();return {ok:true,device:this.publicDevice(d)};
  }
  action(id, action, sessionId) {
    const d=this.state.devices.find(d=>d.id===id);if(!d)throw new Error('设备不存在');
    if(action==='select'){if(!sessionId)throw new Error('请先打开一个 DSH 对话');this.get(id);this.state.selections[sessionId]=id;}
    else if(action==='disable'){d.enabled=false;this.disconnect(id);}
    else if(action==='enable'){if(d.revoked)throw new Error('设备已解除绑定，请重新接入');d.enabled=true;}
    else if(action==='revoke'){d.revoked=true;d.enabled=false;d.privateKey=null;this.disconnect(id);for(const k of Object.keys(this.state.selections))if(this.state.selections[k]===id)delete this.state.selections[k];}
    else throw new Error('未知操作');this.save();return {ok:true};
  }
  async listen() {
    this.server=https.createServer({...this.tls,minVersion:'TLSv1.2'},async(req,res)=>{
      try {
        const url=new URL(req.url,'https://device');
        if(req.method==='GET'&&url.pathname==='/identity')return send(res,200,{service:'dsh-windows-devices',version:VERSION});
        if(req.method!=='POST')return send(res,404,{error:'Not found'});
        const body=await readJson(req),ip=req.socket.remoteAddress?.replace(/^::ffff:/,'');
        if(url.pathname==='/register')return send(res,200,this.register(body,ip));
        if(url.pathname==='/heartbeat')return send(res,200,await this.heartbeat(body,ip));
        return send(res,404,{error:'Not found'});
      }catch(e){send(res,400,{error:e.message});}
    });
    this.server.requestTimeout=15000; this.server.headersTimeout=10000;
    await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(this.port,this.host,resolve);});
    this.expiry=setInterval(()=>{for(const d of this.state.devices)if(this.now()-(d.lastSeen||0)>90000)this.disconnect(d.id);},15000);this.expiry.unref();
  }
  async close(){clearInterval(this.expiry);for(const id of this.active.keys())this.disconnect(id);if(this.server){this.server.closeAllConnections();await new Promise(r=>this.server.close(r));}}
}
