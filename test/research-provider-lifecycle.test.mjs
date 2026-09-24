import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteStore,DuelLoop,ResearchOrchestrator,KuhnPokerDomain,KuhnEvaluationAdapter,FixtureDecisionModel,PiResearchProvider,createKuhnStrategy,DuelLoopError} from '../dist/index.js';

async function withServer(work) {
  const requests=[];let reply=()=>({text:'{"status":"no_change","reason":"local fixture"}'});
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks).toString());requests.push(body);
    const response=await reply(body,requests.length);
    if(response.status){res.writeHead(response.status,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'local retryable failure',type:'server_error'}}));return;}
    res.writeHead(200,{'content-type':'text/event-stream'});
    const chunk=data=>res.write(`data: ${JSON.stringify({id:'local-lifecycle-fixture',object:'chat.completion.chunk',created:1,model:'gpt-4o',...data})}\n\n`);
    chunk({choices:[{index:0,delta:{role:'assistant',...(response.tools?{tool_calls:response.tools.map((tool,i)=>({index:i,id:`tool_${requests.length}_${i}`,type:'function',function:{name:tool.name,arguments:JSON.stringify(tool.arguments)}}))}:{content:response.text})},finish_reason:null}]});
    chunk({choices:[{index:0,delta:{},finish_reason:response.tools?'tool_calls':'stop'}],usage:{prompt_tokens:40,completion_tokens:10,total_tokens:50}});
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const provider=new PiResearchProvider({provider:'openai',model:'gpt-4o',api:'openai-completions',apiKey:'LOCAL_FIXTURE_ONLY',baseURL:`http://127.0.0.1:${server.address().port}/v1`});
  try {await work({provider,requests,respond:fn=>{reply=fn;}});}
  finally {await provider.dispose();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
function setup(store,provider,scopeId='scope') {
  const domain=new KuhnPokerDomain({applicationId:'lifecycle-test',scopeId});
  const model=new FixtureDecisionModel('lifecycle-fixture',q=>({score:0,confidence:1,probabilities:Object.fromEntries(q.criteria.map((_,i)=>[i,i===0?1:0]))}));
  const app=new DuelLoop({applicationId:'lifecycle-test',domain,model,store});
  if(!store.activeRelease(scopeId))app.bootstrap(createKuhnStrategy(),scopeId);
  const options={store,domain,model,evaluator:new KuhnEvaluationAdapter(),dependencies:app.dependencies,providers:{researcher:provider}};
  const research=new ResearchOrchestrator(options);
  const protocol={version:'3.0',id:'final',domainId:domain.id,seeds:[5,6],opponentIds:['calling'],trajectoriesPerSeed:2,knowledgeStateMode:'frozen',initialKnowledge:{},metric:{name:'reward',direction:'maximize',unit:'chips'},minSamples:2,minimumImprovement:0,maxGroupRegression:1,confidenceLevel:.95,maxP95DecisionComputeMs:5000,maxDevelopmentEvalRuns:1,maxFinalEvaluationsPerRun:1,holdoutId:'final',maxHoldoutUses:1};
  return {app,research,options,protocol};
}
const input=(sessionId,overrides={})=>({role:'researcher',prompt:'Return JSON.',tools:[],signal:new AbortController().signal,maxTokens:4096,sessionId,...overrides});

test('cross-connection cancellation blocks the next internal Pi HTTP request and retains already measured usage',{timeout:15000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'duelloop-cross-cancel-'));
  try {await withServer(async({provider,requests,respond})=>{
    const ownerStore=new SqliteStore(join(directory,'state.sqlite'));const owner=setup(ownerStore,provider);
    const controlStore=new SqliteStore(join(directory,'state.sqlite'));const controller=new ResearchOrchestrator({...owner.options,store:controlStore});
    const run=owner.research.create({scopeId:'scope',protocol:owner.protocol});
    respond((_body,n)=>{
      if(n===1){controller.cancel(run.id);return {tools:[{name:'read_strategy',arguments:{}}]};}
      return {text:'{"status":"no_change"}'};
    });
    try {
      const result=await owner.research.run(run.id);
      assert.equal(result.run.status,'cancelled');assert.equal(requests.length,1,'A cancelled persisted run cannot generate the tool-error followup request');
      await new Promise(resolve=>setImmediate(resolve));
      const usage=ownerStore.events({scopeId:'scope',allowPrivate:true}).filter(event=>event.type==='research.late_model_result').map(event=>event.data.usage);
      assert.ok(usage.some(value=>value.inputTokens===40&&value.outputTokens===10),'Usage from the response preceding cancellation remains recorded');
      await new Promise(resolve=>setImmediate(resolve));assert.equal(provider.sessionInfo(`${run.id}:single`),null);
    } finally {await owner.app.close();ownerStore.close();controlStore.close();}
  });} finally {await rm(directory,{recursive:true,force:true});}
});

test('finished real Pi research runs release sessions while preserving audit outputs',{timeout:15000},async()=>{
  await withServer(async({provider,requests})=>{
    const store=new SqliteStore();const owner=setup(store,provider);const sessions=[];
    try {
      for(let i=0;i<8;i++) {
        const run=owner.research.create({id:`finished-${i}`,scopeId:'scope',protocol:owner.protocol});sessions.push(`${run.id}:single`);
        assert.equal((await owner.research.run(run.id)).run.status,'no_change');
        await new Promise(resolve=>setImmediate(resolve));
        assert.ok(sessions.every(id=>provider.sessionInfo(id)===null));
      }
      assert.equal(requests.length,8);assert.equal(store.events({scopeId:'scope',types:['research.role_output']}).length,8);
    } finally {await owner.app.close();store.close();}
  });
});

test('releaseSession waits for its in-flight call and does not dispose another concurrent session',{timeout:15000},async()=>{
  await withServer(async({provider,respond})=>{
    let entered,finish;const called=new Promise(resolve=>{entered=resolve;});const waiting=new Promise(resolve=>{finish=resolve;});
    respond(async(body)=>{if(JSON.stringify(body.messages).includes('DELAY_THIS_SESSION')){entered();await waiting;}return {text:'{"status":"no_change"}'};});
    const pending=provider.run(input('slow',{prompt:'DELAY_THIS_SESSION'}));await called;
    let released=false;const release=provider.releaseSession('slow').then(()=>{released=true;});
    await provider.run(input('other'));await provider.releaseSession('other');
    assert.equal(provider.sessionInfo('other'),null);assert.equal(released,false);assert.equal(provider.sessionInfo('slow').busy,true);
    await assert.rejects(()=>provider.run(input('slow')),{code:'CONFLICT'});
    finish();await pending;await release;assert.equal(provider.sessionInfo('slow'),null);
    await provider.run(input('other'));assert.ok(provider.sessionInfo('other'));await provider.releaseSession('other');
  });
});

test('persisted send guard also blocks Pi JSON repair and preserves completed response usage',{timeout:15000},async()=>{
  await withServer(async({provider,requests,respond})=>{
    let allowed=true;respond(()=>{allowed=false;return {text:'The integrator returned prose, which normally triggers a repair.'};});
    try {
      await assert.rejects(()=>provider.run(input('repair',{role:'integrator',beforeModelRequest:()=>{if(!allowed)throw new DuelLoopError('CANCELLED','Persisted run was cancelled');}})),error=>{
        assert.equal(error.code,'CANCELLED');assert.equal(error.context.usage.inputTokens,40);assert.equal(error.context.usage.outputTokens,10);return true;
      });
      assert.equal(requests.length,1);
    } finally {await provider.releaseSession('repair');}
  });
});

test('Pi transport retries are disabled so a retryable failure cannot create an unguarded extra request',{timeout:15000},async()=>{
  await withServer(async({provider,requests,respond})=>{
    respond(()=>({status:503}));
    try {
      await assert.rejects(()=>provider.run(input('retryable')),{code:'MODEL_INVALID'});
      assert.equal(requests.length,1);
    } finally {await provider.releaseSession('retryable');}
  });
});
