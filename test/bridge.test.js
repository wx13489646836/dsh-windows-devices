import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import ssh2 from 'ssh2';
const {Server,utils}=ssh2;
import {DeviceBridge,psCommand} from '../lib/core.js';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-device-test-'));
const b=new DeviceBridge({dir});
const host=crypto.generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'pkcs1',format:'pem'}});
const hostBlob=utils.parseKey(host.privateKey).getPublicSSH();
let received=0;
const server=new Server({hostKeys:[host.privateKey]},c=>{
  c.on('error',()=>{});c.on('authentication',a=>a.method==='publickey'?a.accept():a.reject(['publickey'])).on('ready',()=>c.on('session',accept=>accept().on('exec',(accept,_reject,info)=>{
    const stream=accept();received++;const script=Buffer.from(info.command.split(' ').at(-1),'base64').toString('utf16le');
    if(script.includes('WAIT_FOREVER'))return;
    stream.write(script.includes('administrator=')?JSON.stringify({hostname:'TEST-PC',user:'test',administrator:true}):'中文 output');stream.exit(0);stream.end();
  })));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
function pair(){const p=b.createPair(),secret=crypto.randomBytes(32).toString('hex');b.register({id:p.id,token:p.pairingToken,deviceToken:secret,hostname:'TEST-PC',username:'test',port:2222,hostKey:hostBlob.toString('base64')},'192.168.0.71');const d=b.state.devices.at(-1);d.ip='127.0.0.1';d.port=server.address().port;return {p,d,secret};}
after(async()=>{await b.close();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});});
test('one-use pairing, secret redaction, and restart persistence',()=>{
 const {p,d,secret}=pair();assert.throws(()=>b.register({id:p.id,token:p.pairingToken},'192.168.0.71'),/已使用/);
 const text=JSON.stringify(b.list());assert.ok(!text.includes(d.privateKey));assert.ok(!text.includes(secret));assert.ok(!text.includes(d.tokenHash));
 const restored=new DeviceBridge({dir});assert.equal(restored.state.devices.at(-1).id,d.id);assert.equal(restored.pin,b.pin);
});
test('PowerShell encoding safely preserves Chinese, quotes and literal paths',()=>{
 const script="Write-Output '你好'; $a='$(x)'";const cmd=psCommand(script,"C:\\测试's\\a");const decoded=Buffer.from(cmd.split(' ').at(-1),'base64').toString('utf16le');assert.ok(decoded.includes(script));assert.ok(decoded.includes("测试''s"));assert.ok(!cmd.includes('你好'));
});
test('real SSH handshake and command channel return UTF-8',async()=>{
 const {d}=pair();const result=await b.execute({device_id:d.id,script:"Write-Output 'hello'"});assert.equal(result.stdout,'中文 output');assert.equal(result.exit_code,0);
});
test('host fingerprint mismatch never dispatches a command',async()=>{
 const {d}=pair();d.hostFingerprint='0'.repeat(64);const before=received;await assert.rejects(b.execute({device_id:d.id,script:'hello'}));assert.equal(received,before);
});
test('session target cannot silently change and stale devices fail closed',()=>{
 const a=pair().d,other=pair().d;b.action(a.id,'select','session-one');assert.throws(()=>b.get(other.id,'session-one'),/目标/);a.lastSeen=Date.now()-91000;assert.throws(()=>b.get(a.id),/离线/);
});
test('timed-out commands are not replayed',async()=>{
 const {d}=pair();const before=received;await assert.rejects(b.execute({device_id:d.id,script:'WAIT_FOREVER',timeout_seconds:1}),/超时/);assert.equal(received,before+1);
});
test('revocation immediately removes credential and rejects device use',async()=>{
 const {d,secret}=pair();b.action(d.id,'revoke');assert.equal(d.privateKey,null);assert.throws(()=>b.get(d.id));assert.equal((await b.heartbeat({id:d.id,token:secret},'192.168.0.71')).action,'revoke');assert.throws(()=>b.authenticate({id:d.id,token:'bad'}),/认证/);
});
test('rename persists and preserves SSH identity and session selection',()=>{
 const {d}=pair();b.action(d.id,'select','rename-session');
 const identity={id:d.id,hostname:d.hostname,privateKey:d.privateKey};
 b.rename(d.id,'  办公电脑 🖥  ');
 assert.equal(b.list().devices.find(x=>x.id===d.id).name,'办公电脑 🖥');
 assert.deepEqual({id:d.id,hostname:d.hostname,privateKey:d.privateKey},identity);
 const restored=new DeviceBridge({dir});assert.equal(restored.get(undefined,'rename-session').name,'办公电脑 🖥');
 for(const name of ['', '  ', 'a\nb', 'a'.repeat(65)])assert.throws(()=>b.rename(d.id,name));
});
