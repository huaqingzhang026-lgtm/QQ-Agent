const { CANDIDATE_ROOT } = await import('./candidate-root.mjs');
import fs from 'node:fs';import path from 'node:path';import vm from 'node:vm';import {pathToFileURL} from 'node:url';
const root=process.env.A00_DATA_ROOT;if(!root)throw Error('A00 required');
const C=CANDIDATE_ROOT;
const imp=p=>import(pathToFileURL(path.join(C,p)));const aff=await imp('qq-bridge/src/personality-affect.mjs');const ad=await imp('qq-bridge/src/personality-affinity-adapter.mjs');const {createPersonalityStore}=await imp('qq-bridge/src/personality-store.mjs');
const src=fs.readFileSync(path.join(C,'qq-bridge/src/bridge.js'),'utf8');const a=src.indexOf('function bridgeClassifyIncomingEvent('),b=src.indexOf('function processIncomingPersonalityEvent(',a);const results=[];
// The original probe's assertions are unchanged; only the VM dependency surface is adapted.
// A04-rework1 adapted: include the bridge's classifier fallback and inject the real classifier.
for(const mode of ['wrong-actor','repeat-evidence']){
 const store=createPersonalityStore({dataRoot:path.join(root,mode)});const requests=Array.from({length:mode==='wrong-actor'?1:100},(_,i)=>ad.normalizeBumpRequest({uin:mode==='wrong-actor'?'22':'11',key:'group:1',delta:0.03,reason:'普通打招呼',evidenceIds:['m1']}).request);
 let submitted=0;const ctx=vm.createContext({path,ROOT:path.join(root,'qq-bridge'),affinityRequestFile:ad.requestFile,readJsonSafe:()=>requests,recordPendingObservation:()=>{},observationEventFor:ad.observationEventFor,classifyIncomingKind:aff.classifyIncomingKind,atomicWriteJson:()=>{},log:()=>{},submitPersonalityEventObject:e=>{const s=store.loadSnapshot(e.scope);const r=store.submitEvent(e,s.revision);if(r.applied)submitted++;return r;}});
 vm.runInContext(src.slice(a,b),ctx);ctx.drainAffinityRequests('group:1',{unread:[{messageId:'m1',userId:'11',text:'你好'}],recentMessages:[]});
 const rel=store.loadRelationship(mode==='wrong-actor'?'22':'11',{scope:'group:1'});results.push({id:mode,ok:mode==='wrong-actor'?submitted===0:submitted<=1,submitted,relationship:rel});store.close();
}
const texts=['“对不起”用英语怎么说？','我没有错，不需要你原谅我','解释一下这段代码'];const classifications=texts.map(text=>({text,kind:aff.classifyIncomingKind({text})}));results.push({id:'semantic-false-repair',ok:classifications.every(x=>x.kind==='casual.chat'),classifications});
fs.writeFileSync(path.join(root,'results.json'),JSON.stringify({results},null,2));for(const r of results)console.log(JSON.stringify(r));if(results.some(r=>!r.ok))process.exitCode=1;
