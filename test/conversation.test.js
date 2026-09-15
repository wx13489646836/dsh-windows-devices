import {test} from 'node:test';import assert from 'node:assert/strict';
import {conversationOpener} from '../lib/conversation.js';
function fixture(facts={hostname:'TEST-PC',administrator:true,cpu:[{Name:'test CPU'}]}){
 const events=[];const d={id:'device-one',name:'工作电脑',hostname:'TEST-PC',ip:'192.168.0.71',port:2222,privateKey:'secret'};
 const bridge={get:id=>{assert.equal(id,d.id);return d;},execute:async()=>{events.push('ssh');return {exit_code:0,stdout:JSON.stringify(facts)};},action:(id,action,sessionId)=>{events.push('bind');assert.equal(id,d.id);assert.equal(action,'select');},publicDevice:()=>({id:d.id,name:d.name,hostname:d.hostname,ip:d.ip,port:d.port})};
 const controller={create:async r=>{events.push('create');return r;},rename:async()=>events.push('title'),prompt:async r=>{events.push('prompt');assert.ok(r.content[0].text.includes('test CPU'));assert.ok(!r.content[0].text.includes('secret'));}};
 return {events,bridge,controller};
}
test('new conversation verifies SSH, binds the device before prompt and deduplicates clicks',async()=>{
 const f=fixture(),open=conversationOpener(f.bridge,f.controller),request={id:'device-one',requestId:'request-12345'};
 const [a,b]=await Promise.all([open(request),open(request)]);assert.equal(a.sessionId,b.sessionId);
 assert.deepEqual(f.events,['ssh','create','bind','title','prompt']);
 await open(request);assert.equal(f.events.length,5);
});
test('failed SSH or wrong host never creates a misleading conversation',async()=>{
 const f=fixture({hostname:'WRONG-PC',administrator:true});const open=conversationOpener(f.bridge,f.controller);
 await assert.rejects(open({id:'device-one',requestId:'request-12345'}),/身份/);assert.deepEqual(f.events,['ssh']);
});
test('retry after failed admission keeps the same session and prompt request identity',async()=>{
 const f=fixture(),requests=[];f.controller.prompt=async r=>{requests.push(r);if(requests.length===1)throw new Error('temporary failure');};
 const open=conversationOpener(f.bridge,f.controller),r={id:'device-one',requestId:'request-12345'};
 await assert.rejects(open(r));await open(r);assert.equal(requests[0].sessionId,requests[1].sessionId);assert.equal(requests[0].requestId,requests[1].requestId);
});
