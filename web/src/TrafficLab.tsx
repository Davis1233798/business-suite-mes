import React, {useEffect, useRef, useState} from 'react';
import './TrafficLab.css';
import {tr} from './locale';

type Outcome = {index:number; outcome:string; ms:number; message?:string};
type Snapshot = {runId:string;capacity:number;committed:number;remaining:number;queued:number;processed:number;records:{key:string;sequence:number;createdAt:string}[]};
async function call(site:string, body?:Record<string,unknown>, runId?:string) {
  const response=await fetch(`/api/stations/${site}/traffic${runId?`?runId=${encodeURIComponent(runId)}`:''}`,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(20000),...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
  const value=await response.json() as {success:boolean;data:Snapshot & {outcome:string};error?:{message:string}};
  if(!response.ok||!value.success)throw new Error(value.error?.message||`HTTP ${response.status}`);
  return value.data;
}
export function TrafficLab({site}:{site:string}) {
  const manufacturing=site==='mes';
  const [requests,setRequests]=useState(128),[workers,setWorkers]=useState(16),[capacity,setCapacity]=useState(20);
  const [running,setRunning]=useState(false),[draining,setDraining]=useState(false),[error,setError]=useState('');
  const [results,setResults]=useState<Outcome[]>([]),[duration,setDuration]=useState(0),[active,setActive]=useState(0);
  const [snapshot,setSnapshot]=useState<Snapshot|null>(null),[runId,setRunId]=useState('');
  const stop=useRef(false),mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;stop.current=true}},[]);
  async function run() {
    stop.current=false;setRunning(true);setError('');setResults([]);setSnapshot(null);setDuration(0);setRunId('');
    let next=0,inflight=0;const outcomes:Outcome[]=[];const started=performance.now();
    try {
      const prepared=await call(site,{action:'prepare',capacity});
      if(!mounted.current)return;
      setRunId(prepared.runId);
      await Promise.all(Array.from({length:workers},async()=>{
        while(!stop.current) {
          const index=next++;if(index>=requests)break;
          const begin=performance.now();inflight++;if(mounted.current)setActive(inflight);
          try {
            // Every fifth delivery reuses the previous key to exercise retry deduplication.
            const value=await call(site,{action:'submit',runId:prepared.runId,key:`event-${index%5===4?index-1:index}`});
            outcomes.push({index,outcome:value.outcome,ms:performance.now()-begin});
          } catch(e) {outcomes.push({index,outcome:'request_error',ms:performance.now()-begin,message:(e as Error).message})}
          finally {inflight--;if(mounted.current){setActive(inflight);setResults([...outcomes]);setDuration(performance.now()-started)}}
        }
      }));
      const persisted=await call(site,undefined,prepared.runId);
      if(mounted.current)setSnapshot(persisted);
    } catch(e) {if(mounted.current)setError((e as Error).message)}
    finally {if(mounted.current){setDuration(performance.now()-started);setRunning(false);setActive(0)}}
  }
  async function drain() {
    setDraining(true);setError('');
    try {await call(site,{action:'drain',runId});setSnapshot(await call(site,undefined,runId))}
    catch(e){setError((e as Error).message)}finally{setDraining(false)}
  }
  const count=(value:string)=>results.filter(r=>r.outcome===value).length;
  const times=results.map(r=>r.ms).sort((a,b)=>a-b);
  const p95=times.length?Math.round(times[Math.ceil(times.length*.95)-1]):0;
  const invariant=snapshot&&snapshot.remaining>=0&&snapshot.committed+snapshot.remaining===snapshot.capacity&&snapshot.queued+snapshot.processed===snapshot.committed;
  return <section className="traffic-lab load-workbench" aria-label={manufacturing?tr('MES concurrency workbench'):tr('Commerce concurrency workbench')}>
    <div className="load-heading"><div><p className="eyebrow">{tr("SYNTHETIC TRAFFIC / ISOLATED LEDGER")}</p><h2>{manufacturing?tr('A synthetic MES event burst.'):tr('A flash sale. One inventory pool. Hundreds of buyers.')}</h2><p>{manufacturing?tr('Simulate report traffic against a dedicated finite ledger. No MES work orders or production reports are written.'):tr('Race checkout requests against limited inventory. The database must prevent overselling and duplicate orders.')}</p></div><span className={'load-state '+(running?'is-running':'')}>{running?tr('● Receiving traffic'):snapshot?tr('● Run complete'):tr('● Ready')}</span></div>
    <div className="load-controls"><label>{tr("Traffic volume")}<select disabled={running||draining} value={requests} onChange={e=>setRequests(Number(e.target.value))}>{[48,128,256,512].map(n=><option key={n} value={n}>{n} {tr("requests")}</option>)}</select></label><label>{tr("Concurrent clients")}<select disabled={running||draining} value={workers} onChange={e=>setWorkers(Number(e.target.value))}>{[4,8,16,32].map(n=><option key={n} value={n}>{n} {tr("in flight")}</option>)}</select></label><label>{manufacturing?tr('Lab capacity'):tr('Available units')}<input disabled={running||draining} type="number" min={1} max={1000} value={capacity} onChange={e=>setCapacity(Math.max(1,Math.min(1000,Number(e.target.value)||1)))}/></label><button disabled={running||draining} onClick={()=>void run()}>{tr("Start traffic burst")}</button>{running&&<button className="secondary" onClick={()=>{stop.current=true}}>{tr("Stop new requests")}</button>}</div>
    <p className="load-caption">{tr("Each run starts with a fresh isolated inventory or work-order ledger. Every fifth delivery repeats a request key. Existing business records are unchanged.")}</p>
    {error&&<p className="error" role="alert">{error}</p>}
    <div className="load-metrics" aria-live="polite">{[[tr('Completed'),`${results.length} / ${requests}`],[tr('In flight'),active],[tr('Committed'),count('accepted')],[tr('Retry deduplicated'),count('duplicate')],[tr('Capacity rejected'),count('capacity_rejected')],[tr('Request errors'),count('request_error')],[tr('p95 response'),`${p95} ms`],[tr('Measured rate'),duration?`${(results.length*1000/duration).toFixed(1)} req/s`:'—']].map(([label,value])=><div key={label}><small>{tr(String(label))}</small><strong>{value}</strong></div>)}</div>
    <div className="load-flow">{[[tr("01 / RECEIVE"),tr('Concurrent clients'),tr('Parallel HTTP requests reach the Go API.')],[tr('02 / VALIDATE'),tr('Identity + retry key'),tr('Workspace permissions and tenant scope are checked.')],[tr('03 / COMMIT'),manufacturing?tr('Guard lab capacity'):tr('Guard inventory'),tr('An atomic SQL transaction checks capacity and commits one durable record per key.')],[tr('04 / DISPATCH'),manufacturing?tr('Projection queue'):tr('Fulfillment queue'),tr('Committed events wait for the demo consumer; requests do not wait for fulfillment.')]].map(([step,title,detail])=><article key={step}><small>{tr(step)}</small><h3>{tr(title)}</h3><p>{tr(detail)}</p></article>)}</div>
    {snapshot&&<div className="load-evidence"><div><p className="eyebrow">{tr("PERSISTED SERVER EVIDENCE")}</p><h3>{invariant?tr('✓ Capacity and ledger agree'):tr('⚠ Invariant failed — inspect ledger')}</h3><p>{snapshot.committed} {tr("committed")} + {snapshot.remaining} {tr("remaining")} = {snapshot.capacity} {tr("capacity")}. {snapshot.queued+snapshot.processed} {tr("durable records.")}</p><p>{tr("Queue:")} <b>{snapshot.queued} {tr("pending")}</b> · <b>{snapshot.processed} {tr("processed")}</b></p><button disabled={running||draining||snapshot.queued===0} onClick={()=>void drain()}>{draining?tr('Consuming…'):manufacturing?tr('Consume projection events'):tr('Consume fulfillment events')}</button><p className="load-caption">{tr("The consumer marks isolated outbox events as processed; it does not ship products or update production equipment.")}</p></div><div className="load-ledger"><h3>{tr("Committed ledger")} <small>{tr("latest 8")}</small></h3><ol>{snapshot.records.slice(0,8).map(r=><li key={r.key}><code>{r.key}</code><span>#{r.sequence}</span><time>{r.createdAt}</time></li>)}</ol></div></div>}
    <details className="load-log"><summary>{tr("Request timeline")} · {results.length} {tr("responses")}</summary><div className="load-log-scroll"><table><thead><tr><th>{tr("Request")}</th><th>{tr("Outcome")}</th><th>{tr("Latency")}</th></tr></thead><tbody>{results.slice(-80).reverse().map(r=><tr key={r.index}><td>#{r.index+1}</td><td>{tr(r.outcome)}{r.message&&<small>{r.message}</small>}</td><td>{Math.round(r.ms)} ms</td></tr>)}</tbody></table></div></details>
    <p className="traffic-boundary">{tr("Measured against this running service: Go HTTP handlers and a SQLite ledger. SQLite writes use one database connection and serialize at commit. Rejections show exhausted capacity; request errors show transport or service failures. This bounded burst demonstrates correctness and backpressure under contention; the measured rate is not a production capacity claim.")}</p>
  </section>;
}
