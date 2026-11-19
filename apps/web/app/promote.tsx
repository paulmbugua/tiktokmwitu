'use client';
import { useEffect, useRef, useState } from 'react';
import { send, useData } from './client';
import GiftWallet from './gift-wallet';

const categories = {
  account: ['engagement','views','followers','profile'],
  sales: ['sales'],
  live: ['live-views','live-followers'],
} as const;
const labels = {
  engagement:'More likes & comments',views:'More video views',followers:'More followers',profile:'More profile views',
  sales:'More website visits','live-views':'More LIVE viewers','live-followers':'More LIVE followers',
} as const;
type Goal = keyof typeof labels;
type Category = keyof typeof categories;
type Dashboard = {
  videos:{id:string;caption:string}[]; liveId?:string; balance:number; prices:Record<Goal,number>; ctas:string[]; enabled:boolean;
  campaigns:{id:string;goal:Goal;status:string;budget:number;impressions:number;clicks:number;refunded:number;ends_at:string}[];
};
export type Placement = {id:string;videoId:string|null;liveId:string|null;goal:Goal;destination:string|null;cta:string|null;token:string};
export function promotionEvent(placement:Placement,event:'view'|'click') {
  return send('/promote/'+placement.id+'/event','POST',{token:placement.token,event}).catch(()=>undefined);
}
export function usePlacementView(element:Element|null,placement?:Placement|null) {
  useEffect(()=>{
    if(!element||!placement)return;
    let timer:ReturnType<typeof setTimeout>|undefined;
    const observer=new IntersectionObserver(([entry])=>{
      clearTimeout(timer);
      if(entry.isIntersecting&&entry.intersectionRatio>=.5) timer=setTimeout(()=>{
        if(document.visibilityState==='visible'){observer.disconnect();void promotionEvent(placement,'view');}
      },700);
    },{threshold:.5});
    observer.observe(element);
    return ()=>{observer.disconnect();clearTimeout(timer);};
  },[element,placement]);
}

export function promotionAction(placement:Placement) {
  return placement.cta ?? ({engagement:'Comment',views:'Watch',followers:'Follow creator',profile:'View profile',
    sales:'Visit website','live-views':'Watch LIVE','live-followers':'Watch and follow'}[placement.goal]);
}

export default function Promote({ videoId, liveId }: {videoId?:string;liveId?:string}) {
  const [revision,refresh]=useState(0);
  const result=useData<Dashboard>('/promote',revision);
  const [category,setCategory]=useState<Category>(liveId?'live':'account');
  const [goal,setGoal]=useState<Goal>(liveId?'live-views':'views');
  const [creatives,setCreatives]=useState<string[]>(videoId?[videoId]:[]);
  const [budget,setBudget]=useState(300);
  const [duration,setDuration]=useState(3);
  const [wallet,setWallet]=useState(false);
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState('');
  const order=useRef<{id:string;key:string}|null>(null);
  const data=result?.data;
  const live=category==='live';
  const targetLive=liveId??data?.liveId;
  const maximum=data?Math.floor(budget/data.prices[goal]):0;
  const daily=Math.ceil(maximum/duration);
  useEffect(()=>{
    const timer=setInterval(()=>refresh(value=>value+1),15000);
    return ()=>clearInterval(timer);
  },[]);
  async function publish(form:HTMLFormElement) {
    if(busy)return;
    const fields=new FormData(form);
    const body={goal,budget,duration,creatives:live?[]:creatives,liveId:live?targetLive:undefined,
      destination:category==='sales'?String(fields.get('destination')??''):undefined,
      cta:category==='sales'?String(fields.get('cta')??''):undefined};
    const key=JSON.stringify(body);
    if(order.current?.key!==key)order.current={key,id:crypto.randomUUID()};
    setBusy(true);setNotice('');
    try{
      await send('/promote','POST',{...body,requestId:order.current.id});
      order.current=null;
      setNotice('Promotion started.');
      refresh(value=>value+1);
    }catch(error){setNotice((error as Error).message);}
    finally{setBusy(false);}
  }
  if(wallet)return <><button className="link" onClick={()=>{setWallet(false);refresh(v=>v+1);}}>Back to Promote</button><GiftWallet liveRoom={targetLive}/></>;
  return <div className="commerce-stack promote">
    <div className="commerce-heading"><strong>{data?.balance.toLocaleString()??'…'} coins</strong><button className="secondary" onClick={()=>setWallet(true)}>Get coins</button></div>
    <div className="promote-categories" role="group" aria-label="Promotion type">
      {([['account','Boost account'],['sales','Get sales'],['live','Boost LIVE']] as const).map(([key,label])=><button
        key={key} className="secondary" aria-pressed={key===category} disabled={busy}
        onClick={()=>{setCategory(key);setGoal(categories[key][0]);setDuration(old=>Math.min(old,key==='live'?12:14));setCreatives(old=>old.slice(0,key==='sales'?3:1));}}>{label}</button>)}
    </div>
    <form onSubmit={event=>{event.preventDefault();void publish(event.currentTarget);}}>
      <label>Goal<select value={goal} onChange={e=>setGoal(e.currentTarget.value as Goal)}>
        {categories[category].map(g=><option value={g} key={g}>{labels[g]}</option>)}
      </select></label>
      {!live ? <fieldset className="promote-creatives"><legend>{category==='sales'?'Select creatives · up to 3':'Select a video'}</legend>
        {data?.videos.map(video=><label key={video.id}><input type={category==='sales'?'checkbox':'radio'} name="creative"
          checked={creatives.includes(video.id)} disabled={category==='sales'&&!creatives.includes(video.id)&&creatives.length>=3}
          onChange={e=>{const checked=e.currentTarget.checked;setCreatives(old=>category!=='sales'?[video.id]:
            checked?[...old,video.id]:old.filter(id=>id!==video.id));}}/><span>{video.caption}</span></label>)}
        {data?.videos.length===0&&<p className="hint">Post a video first.</p>}
      </fieldset> : <p className="hint">{targetLive?'Your current broadcast will be featured in the LIVE directory.':'Go LIVE to promote your broadcast.'}</p>}
      {category==='sales'&&<>
        <label>Destination URL<input name="destination" type="url" placeholder="https://your-shop.co.ke" required maxLength={1000}/></label>
        <label>Call to action<select name="cta" required>{data?.ctas.map(cta=><option key={cta}>{cta}</option>)}</select></label>
      </>}
      <label>Budget · {budget.toLocaleString()} coins<input type="range" min={100} max={5000} step={50} value={budget}
        onChange={e=>setBudget(e.currentTarget.valueAsNumber)} /></label>
      <label>Duration · {live?duration*15+' min':duration+(duration===1?' day':' days')}<input type="range" min={1} max={live?12:14} step={1} value={Math.min(duration,live?12:14)}
        onChange={e=>setDuration(e.currentTarget.valueAsNumber)} /></label>
      <div className="promote-estimate" aria-live="polite"><strong>Up to {maximum.toLocaleString()} placements</strong>
        <small>About {daily.toLocaleString()} per {live?'15 minutes':'day'} at full delivery. Actual reach depends on traffic. Unused coins return to your wallet.</small>
      </div>
      <button className="primary" disabled={busy||!data?.enabled||budget>data.balance||(live?!targetLive:!creatives.length)}>Start promotion</button>
    </form>
    {notice&&<p role="status">{notice}</p>}{result?.error&&<p role="alert">{result.error}</p>}
    {!!data?.campaigns.length&&<div className="commerce-stack"><strong>Promotion activity</strong>
      {data.campaigns.map(c=><div className="invite-pass commerce-heading" key={c.id}>
        <div><strong>{labels[c.goal]} · {c.status}</strong><p className="hint">{c.impressions} impressions · {c.clicks} action clicks{c.refunded?' · '+c.refunded+' coins returned':''}</p></div>
        {c.status==='active'&&<button className="secondary" disabled={busy} onClick={async()=>{
          setBusy(true);
          try{await send('/promote/'+c.id+'/stop','POST');refresh(v=>v+1);}
          catch(error){setNotice((error as Error).message);}finally{setBusy(false);}
        }}>Stop</button>}
      </div>)}
    </div>}
  </div>;
}
