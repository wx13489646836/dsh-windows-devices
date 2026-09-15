import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {defineTool} from '@deepseek-ai/dsh-tools';
import {DeviceBridge,readJson,send} from './core.js';
import {conversationOpener} from './conversation.js';

export const inject=['webServer','tools','sessionController'];
const scripts=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../scripts');
const quote=s=>"'"+s.replaceAll("'","''")+"'";
export function installer(pair) {
  const config=Buffer.from(JSON.stringify(pair)).toString('base64');
  const setup=fs.readFileSync(path.join(scripts,'setup.ps1'),'utf8').replace('__PAIR_BASE64__',config)
    .replace('__MAINTAIN_BASE64__',Buffer.from(fs.readFileSync(path.join(scripts,'maintain.ps1'))).toString('base64'));
  const payload=Buffer.from('\ufeff'+setup,'utf8').toString('base64').match(/.{1,120}/g).join('\r\n');
  return '@echo off\r\nsetlocal\r\nset "DSH_SETUP_SELF=%~f0"\r\npowershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$s=Get-Content -LiteralPath $env:DSH_SETUP_SELF -Raw; $b=$s.Substring($s.LastIndexOf(\'REM DSH_PAYLOAD\')+15); $p=Join-Path $env:TEMP (\'dsh-setup-\'+[guid]::NewGuid()+\'.ps1\'); [IO.File]::WriteAllBytes($p,[Convert]::FromBase64String($b.Trim())); $a=\'-NoLogo -NoProfile -ExecutionPolicy Bypass -File \'+[char]34+$p+[char]34; Start-Process powershell.exe -Verb RunAs -ArgumentList $a -Wait; Remove-Item -LiteralPath $p -ErrorAction SilentlyContinue"\r\nif errorlevel 1 pause\r\nexit /b\r\nREM DSH_PAYLOAD\r\n'+payload+'\r\n';
}
export async function apply(ctx) {
  const bridge=new DeviceBridge({dir:path.join(os.homedir(),'.dsh','windows-devices')});
  await bridge.listen();
  ctx.on('dispose',()=>bridge.close());
  const web=ctx.get('webServer');
  const openConversation=conversationOpener(bridge,ctx.get('sessionController'));
  ctx.effect(()=>web.register({kind:'prefix',path:'/windows-devices',handler:async(req,res)=>{
    try {
      const url=new URL(req.url,'http://localhost'),sid=url.searchParams.get('session') || undefined;
      if(req.method==='GET'&&url.pathname==='/windows-devices/state')return send(res,200,bridge.list(sid));
      if(req.method!=='POST'||req.headers['x-dsh-device-ui']!=='1'||!req.headers['content-type']?.startsWith('application/json')||req.headers['sec-fetch-site']==='cross-site')return send(res,403,{error:'请从 DSH 设备页操作'});
      const b=await readJson(req);
      if(url.pathname==='/windows-devices/rename')return send(res,200,bridge.rename(b.id,b.name));
      if(url.pathname==='/windows-devices/conversation')return send(res,200,await openConversation(b));
      if(url.pathname==='/windows-devices/pair') {
        const pair=bridge.createPair();res.writeHead(200,{'content-type':'application/octet-stream','content-disposition':'attachment; filename="DSH-Windows-Setup.bat"','cache-control':'no-store'});return res.end(installer(pair));
      }
      if(url.pathname==='/windows-devices/action')return send(res,200,bridge.action(b.id,b.action,b.session));
      if(url.pathname==='/windows-devices/test')return send(res,200,await bridge.test(b.id));
      return send(res,404,{error:'Not found'});
    }catch(e){send(res,400,{error:e.message});}
  }}));
  const device={type:'string',description:'设备 ID；省略时使用此对话在 Windows 设备页选择的电脑'};
  const register=(name,description,parameters,run)=>ctx.tools.register(defineTool({name,description,parameters,output:{schema:{type:'json'},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]},async execute(args,exec){return run(args,exec);}}));
  const sid=exec=>exec.agent?.sessionId;
  register('windows_devices','列出已配对 Windows 电脑、在线状态及此对话选择的设备。远程操作请使用 windows_* 工具，不要误用 DSH 宿主的本地文件或 shell 工具。',{},(_a,e)=>bridge.list(sid(e)));
  register('windows_exec','通过真实 SSH 在目标 Windows 上执行管理员 PowerShell 脚本。工作目录使用 cwd；不会自动重试命令。', {device_id:device,script:{type:'string',required:true},cwd:{type:'string'},timeout_seconds:{type:'number'}},(a,e)=>bridge.execute(a,e.signal,sid(e)));
  register('windows_list_files','列出 Windows 指定目录，路径必须是目标电脑的路径。',{device_id:device,path:{type:'string',required:true}},(a,e)=>bridge.execute({device_id:a.device_id,script:`Get-ChildItem -LiteralPath ${quote(a.path)} -Force | Select-Object Name,FullName,Length,Mode,LastWriteTime | ConvertTo-Json -Depth 3`},e.signal,sid(e)));
  register('windows_read_file','读取 Windows UTF-8 文本文件，最大 1 MiB。',{device_id:device,path:{type:'string',required:true}},(a,e)=>bridge.execute({device_id:a.device_id,script:`$p=${quote(a.path)}; if((Get-Item -LiteralPath $p).Length -gt 1048576){throw '文件超过 1 MiB'}; [Console]::Write([IO.File]::ReadAllText($p,[Text.Encoding]::UTF8))`},e.signal,sid(e)));
  register('windows_write_file','写入目标 Windows UTF-8 文本文件。已有文件默认拒绝覆盖；只有明确需要覆盖时传 overwrite=true。',{device_id:device,path:{type:'string',required:true},content:{type:'string',required:true},overwrite:{type:'boolean'}},(a,e)=>{
    if(Buffer.byteLength(a.content)>40000)throw new Error('单次文本写入上限 40 KB；较大文件请分段或使用 SSH/SFTP');
    return bridge.execute({device_id:a.device_id,script:`$p=${quote(a.path)}; $b=[Convert]::FromBase64String('${Buffer.from(a.content).toString('base64')}'); $f=[IO.File]::Open($p,[IO.FileMode]::${a.overwrite?'Create':'CreateNew'},[IO.FileAccess]::Write,[IO.FileShare]::None); try{$f.Write($b,0,$b.Length)}finally{$f.Dispose()}; @{path=$p;bytes=$b.Length}|ConvertTo-Json -Compress`},e.signal,sid(e));
  });
}
