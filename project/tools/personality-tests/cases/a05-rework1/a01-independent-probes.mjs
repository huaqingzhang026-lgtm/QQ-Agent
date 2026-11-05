const { CANDIDATE_ROOT } = await import('./candidate-root.mjs');
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
const C=CANDIDATE_ROOT;
const P='C:/QQ-Agent-private-fixtures/A01';
const read=p=>fs.readFileSync(p,'utf8').replace(/^\uFEFF/,'');
const bridge=read(path.join(C,'qq-bridge/src/bridge.js'));
const cfg=JSON.parse(read(path.join(C,'qq-bridge/config.json')));
const {personalityV2Enabled}=await import(pathToFileURL(path.join(C,'qq-bridge/src/personality-mode.js')));
const {pickAnnoyedReply}=await import(pathToFileURL(path.join(C,'qq-bridge/src/annoyed-reply.js')));
const {buildStickerStrategyHint,buildStickerContext}=await import(pathToFileURL(path.join(C,'qq-bridge/src/sticker-lib.js')));
const st={agentToken:'synthetic-token',unread:[],recentMessages:[],sendTimes:[],wakeConfig:{mode:'active'}};
const ctx={cfg,path,readRoleState:()=>({role:'synthetic'}),selfIdentityTextV2:()=>'',getSocialV2State:()=>st,
 buildMemoryBrief:()=>'',readEvolutionPrompt:()=>'',layeredMemoryBrief:()=>'',dailyLifeBrief:()=>'',formatMemoryV2:()=>'',formatParticipationV2:()=>'',
 buildStickerStrategyHint,buildStickerContext,stickerEntries:[],replyTimingV2:()=>({quietMs:0,remainingQuietMs:0}),looksLikeUnfinished:()=>false,
 formatInitialPromptV2:()=>'',mintScopeToken:()=>'',MEMORY_SCOPE_SECRET:'synthetic',getPerson:()=>null,peopleDb:{},formatPersonLine:()=>'',
 formatCrossGroupDigest:()=>'',buildCrossGroupDigest:()=>({}),socialV2:{conversations:new Map()},groupInfoCache:new Map(),formatGroupInfoV2:()=>'',
 buildRecentRecap:()=>'',readJsonSafe:()=>({}),STATE_DIR:'synthetic',takeRotationRecap:()=>'',selfFixActive:()=>false,
 ownerSendGrants:new Map(),biliMemoryLine:()=>'',skillsIndexLine:()=>'',groupStyleLine:()=>'',topicHooksLine:()=>''};
const start=bridge.indexOf('function buildWakePromptV2(key, reason) {');
const end=bridge.indexOf('function buildWakeReminderPromptV2(',start);
if(start<0||end<0)throw Error('Wake function markers changed');
const wakeSource=bridge.slice(start,end).trim();
const buildWake=vm.runInNewContext('('+wakeSource+')',ctx,{timeout:2000});
const wake=buildWake('group:synthetic','at');
const findings=[];
function check(id,ok,detail){findings.push({id,ok,detail});console.log(JSON.stringify(findings.at(-1)));}
check('I01-no-fixed-sticker-cadence-in-real-wake-prompt',!/每\s*1[~～-]2\s*轮/.test(wake),{fixedLine:wake.split('\n').find(x=>/每\s*1[~～-]2\s*轮/.test(x)),stickerEnabled:cfg.socialV2.sticker.enabled,includeInPrompt:cfg.socialV2.sticker.includeInPrompt});
check('I02-no-exclusive-participation-rule-in-real-wake-prompt',!wake.includes('只有确实没话可说、对方已明确结束、或长时间没人说话时才潜水'),{line:wake.split('\n').find(x=>x.includes('【积极性】')),note:'This unconditional rule omits lack of interest, fatigue and refusal, contrary to the cleaned persona principles.'});
// Exercise the actual bridge legacy branch, not a duplicated helper predicate.
const branchStart=bridge.indexOf('// @ 敷衍（legacy）');
const branchEnd=bridge.indexOf('// 群聊复读',branchStart);
if(branchStart<0||branchEnd<0)throw Error('Legacy branch markers changed');
const branch=bridge.slice(branchStart,branchEnd);
const gateResults=[];
for(const setting of ['missing',true,false]){
 let calls=0,wakes=0;
 for(let i=0;i<200;i++){
  const seeded={socialV2:{annoyedReply:{enabled:true,allGroups:true,probability:1,minIntervalMs:0,lines:['synthetic legacy reply']}}};
  if(setting!=='missing')seeded.socialV2.personalityV2={enabled:setting};
  const state={};let r=0;
  const sandbox={cfg:seeded,kind:'group',isOwner:false,personalityV2Enabled,
   event:{message:[{type:'at',data:{qq:'222'}}],self_id:'222',user_id:'111'},key:'group:synthetic',
   isAttitudeSafeUser:()=>false,isSilentConversationV2:()=>false,getSocialV2State:()=>state,
   pickAnnoyedReply:args=>{calls++;return pickAnnoyedReply({...args,random:()=>r++===0?i/200:0});},
   saveSocialV2State:()=>{},setTimeout:()=>1,clearTimeout:()=>{},sendToQQ:async()=>{},scheduleWakeV2:()=>{wakes++;},log:()=>{},appendActivity:()=>{}};
  await vm.runInNewContext('(async function(){'+branch+'})()',sandbox,{timeout:1000});
 }
 gateResults.push({setting,calls,wakes});
}
check('I03a-real-bridge-default-and-enabled-gate',gateResults[0].calls===0&&gateResults[1].calls===0,gateResults.slice(0,2));
check('I03b-disable-new-mode-must-not-revive-legacy-random',gateResults[2].calls===0&&gateResults[2].wakes===0,{...gateResults[2],criterion:'Implementation plan section 7.1: closing new functionality must not resurrect legacy random hostility.'});
const {pickLeaveLine}=await import(pathToFileURL(path.join(C,'qq-bridge/src/quota.js')));
const oldCfg=JSON.parse(read(path.join(P,'evidence/pre-a01/config.json')));
const legacyQuota=oldCfg.socialV2.quotaLeave;
const quotaOutputs=[...new Set(Array.from({length:20},(_,i)=>pickLeaveLine(legacyQuota,()=>i/20)))];
check('I04-legacy-quota-config-characterization',true,{oldConfigOutputs:quotaOutputs,currentDefaultIsNeutral:true,note:'Migration observation only, not a failing acceptance case by itself.'});
const {selectRoleText}=await import(pathToFileURL(path.join(C,'qq-bridge/src/role-card.js')));
const alt=selectRoleText(read(path.join(C,'qq-bridge/roles/傲娇助手.md')),'v2');
check('I05-alternate-role-characterization',true,{retainsAskedOnlyRule:alt.includes('别人 @ 你或直接提问时才回复'),note:'Selectable alternate card; activation not established. Report as scope gap, not a default-role runtime failure.'});
const summary={at:new Date().toISOString(),method:'Actual candidate function/branch text executed in a VM with synthetic dependencies; no bridge startup, production read or network. Pure module functions imported from candidate.',sourceSha256:crypto.createHash('sha256').update(bridge).digest('hex'),findings};
if(process.env.A00_DATA_ROOT)fs.writeFileSync(path.join(process.env.A00_DATA_ROOT,'independent-probe-results.json'),JSON.stringify(summary,null,2));
if(findings.some(x=>!x.ok))process.exitCode=1;
