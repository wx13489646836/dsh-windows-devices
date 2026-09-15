import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
test('new conversation button opens the returned session through native navigation',async()=>{
 const events=[];let options,component,plugin;
 const ctx={slots:{inject:(_name,fn)=>fn(),register:(o,c)=>{options=o;component=c;}},sessions:{open:id=>events.push(['open',id])},layout:{selectPanel:p=>events.push(['panel',p])}};
 const sandbox={window:{__ModuleLoader__:{load:entry=>{plugin=entry.factory(()=>({createElement:()=>{}}));}}},fetch:async(url,request)=>{assert.equal(url,'/windows-devices/conversation');assert.deepEqual(JSON.parse(request.body),{id:'device-1',requestId:'request-12345'});return {ok:true,json:async()=>({sessionId:'new-device-session'})};}};
 vm.runInNewContext(fs.readFileSync(new URL('../lib/client.js',import.meta.url),'utf8'),sandbox);
 plugin.apply(ctx);assert.equal(typeof component,'function');await options.inject().openDeviceConversation('device-1','request-12345');
 assert.deepEqual(events,[['open','new-device-session'],['panel',null]]);
});
