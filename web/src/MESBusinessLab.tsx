import {useState} from 'react';
import './MESBusinessLab.css';
import {tr} from './locale';

type Result={site:string;attempted:number;succeeded:number;conflicts:number;unknown:number;failed:number;reconciled:boolean;valid:boolean;businessRows:number;auditRows:number;projectionEvents:number;workOrderId:string;workOrderNo:string;target:number;completed:number;scrapped:number;remaining:number;status:string;elapsedMs:number};

export function MESBusinessLab(){
  const [contenders,setContenders]=useState(16),[running,setRunning]=useState(false),[result,setResult]=useState<Result|null>(null),[error,setError]=useState('');
  async function run(){
    setRunning(true);setError('');setResult(null);
    try{
      const response=await fetch('/api/stations/mes/business-lab',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({contenders}),signal:AbortSignal.timeout(55000)});
      const value=await response.json() as {success:boolean;data:Result;error?:{message:string}};
      if(!response.ok||!value.success)throw new Error(value.error?.message||`HTTP ${response.status}`);
      setResult(value.data);
    }catch(e){setError((e as Error).message)}finally{setRunning(false)}
  }
  return <section className="mes-business-lab" aria-labelledby="mes-business-lab-title">
    <header><div><p className="eyebrow">{tr('REAL MES BUSINESS / ISOLATED DATABASE')}</p><h2 id="mes-business-lab-title">{tr('Race real production reports')}</h2><p>{tr('Competing reports write to one real work order in a disposable SQLite database. Your workspace data is unchanged.')}</p></div><span className={running?'is-running':''}>{running?tr('Run in progress'):result?tr('Run reconciled'):tr('Ready')}</span></header>
    <div className="mes-business-controls"><label>{tr('Concurrent report operators')}<select disabled={running} value={contenders} onChange={e=>setContenders(Number(e.target.value))}>{[2,4,8,16,32].map(n=><option key={n} value={n}>{n}</option>)}</select></label><button disabled={running} onClick={()=>void run()}>{running?tr('Running report race…'):tr('Run isolated MES report race')}</button><small>{tr('One server run at a time; 2–32 contenders. The measured rate is not a production capacity claim.')}</small></div>
    {error&&<p className="error" role="alert">{error}</p>}
    {result&&<div className="mes-business-evidence" aria-live="polite"><div><p className="eyebrow">{tr('PERSISTED BUSINESS EVIDENCE')}</p><h3>{result.valid?tr('✓ Work order and report ledger reconciled'):tr('⚠ Review race outcomes')}</h3><p>{tr('Work order')}: <code>{result.workOrderNo}</code> · {tr('Status')}: <b>{result.status}</b></p><p>{result.completed} / {result.target} {tr('good units completed')}; {result.scrapped} {tr('scrapped')}; {result.remaining} {tr('remaining')}.</p>{!result.valid&&<p role="alert">{result.reconciled?tr('Persisted state reconciled, but request outcomes did not match the expected race.'):tr('Persisted business state could not be reconciled.')}</p>}</div><dl>{[[tr('Concurrent requests'),result.attempted],[tr('Committed reports'),result.succeeded],[tr('Capacity conflicts'),result.conflicts],[tr('Unknown outcomes'),result.unknown],[tr('Other errors'),result.failed],[tr('Persisted report rows'),result.businessRows],[tr('Audit events'),result.auditRows],[tr('Projection events'),result.projectionEvents],[tr('Elapsed'),`${result.elapsedMs.toFixed(1)} ms`]].map(([label,value])=><div key={String(label)}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></div>}
  </section>;
}
