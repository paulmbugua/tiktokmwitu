'use client';
import { useEffect, useRef, useState } from 'react';
import { send, useData } from './client';
import GiftWallet from './gift-wallet';

type AudienceBalance = { total_seconds: number; used_seconds: number; remaining_seconds: number };
type Plans = {
  plans: { coins:number; limit:number; viewerMinutes:number }[];
  plan?: { id:string; coins:number; daily_limit:number; ends_at:string; audience?: AudienceBalance };
  maxLiveMinutes: number;
  viewerMinutePack?: { coins:number; viewerMinutes:number };
  used:number; balance:number;
};
type Pass = {code:string;expiresAt:string;claimed:boolean};
export default function LiveInvitePlans({ roomId }: {roomId?:string}) {
  const [revision, refresh] = useState(0);
  const plans = useData<Plans>('/live-invites', revision);
  const passes = useData<Pass[]>(roomId ? '/live-invites/'+roomId+'/passes' : null, revision);
  const [wallet, setWallet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message,setMessage] = useState('');
  const request = useRef<{key:string;id:string}|null>(null);
  const data = plans?.data;
  const allowance = data?.plan?.audience;
  const pack = data?.viewerMinutePack;
  useEffect(() => {
    if (!roomId) return;
    const timer = setInterval(() => refresh(value => value + 1), 12000);
    return () => clearInterval(timer);
  }, [roomId]);

  async function act(key:string, path:string, body:object) {
    if(busy) return;
    if(request.current?.key!==key) request.current={key,id:crypto.randomUUID()};
    setBusy(true);setMessage('');
    try {
      await send(path,'POST',{...body,requestId:request.current.id});
      request.current=null;
      refresh(v=>v+1);
      if (key === 'audience-top-up') setMessage('Viewer-minutes added.');
    } catch(error){setMessage((error as Error).message);}
    finally{setBusy(false);}
  }
  if(wallet) return <><button className="link" onClick={()=>{setWallet(false);refresh(v=>v+1);}}>Back to invite plans</button><GiftWallet /></>;
  return <div className="commerce-stack">
    <div className="commerce-heading"><strong>Weekly LIVE invites</strong><button className="secondary" onClick={()=>setWallet(true)}>Get coins</button></div>
    {data?.plan ? <>
      <p><strong>{Math.max(0,data.plan.daily_limit-data.used)} of {data.plan.daily_limit} invites left today</strong></p>
      <p className="hint">Daily allowance resets at midnight in Kenya. Plan ends {new Date(data.plan.ends_at).toLocaleString('en-KE',{timeZone:'Africa/Nairobi'})} EAT.</p>
      {allowance && <div className="commerce-stack">
        <p><strong>{Math.floor(allowance.remaining_seconds / 60).toLocaleString('en-KE')} viewer-minutes left this week</strong></p>
        <progress aria-label="Weekly viewer-minutes used" value={Math.min(allowance.used_seconds, allowance.total_seconds)} max={allowance.total_seconds} />
        <p className="hint">One viewer watching for one minute uses one viewer-minute. Extra minutes expire with this plan.</p>
        {pack && <button className="secondary" disabled={busy || data.balance < pack.coins} onClick={() => {
          if (window.confirm(`Spend ${pack.coins} coins on ${pack.viewerMinutes.toLocaleString('en-KE')} viewer-minutes?`)) {
            void act('audience-top-up','/live-invites/audience-top-up',{planId:data.plan!.id});
          }
        }}>Add {pack.viewerMinutes.toLocaleString('en-KE')} viewer-minutes · {pack.coins} coins</button>}
      </div>}
      {roomId ? <button className="primary" disabled={busy||data.used>=data.plan.daily_limit||allowance?.remaining_seconds===0} onClick={()=>void act('create','/live-invites/'+roomId+'/create',{})}>Create invite code</button> : <p className="hint">Go LIVE to create your invite codes.</p>}
      {passes?.data?.map(pass=><div className="commerce-heading invite-pass" key={pass.code}>
        <div><strong className="live-code-digits">{pass.code.length===6 ? pass.code.slice(0,3)+' '+pass.code.slice(3) : pass.code}</strong>
          <p className="hint">{pass.claimed?'Claimed':'Ready to share'}</p></div>
        <div className="arena-buttons">
          {(['code','link'] as const).map(action=><button className="secondary" key={action} onClick={async()=>{
            const value=action==='code'?pass.code:new URL(
              location.hostname === 'tiktokmwitu.co.ke' ? '/join/' + pass.code : '/?live=' + pass.code, location.origin).href;
            try{await navigator.clipboard.writeText(value);setMessage(action==='code'?'Invite code copied.':'Invite link copied.');}
            catch{setMessage(value);}
          }}>{action==='code'?'Copy code':'Copy link'}</button>)}
        </div>
      </div>)}
    </> : <>
      <p className="hint">Go LIVE at any follower count and share six-digit invite codes. Each broadcast lasts up to {data?.maxLiveMinutes ?? 60} minutes and draws from the weekly viewer-minute allowance.</p>
      {data?.plans.map(plan=><button key={plan.coins} className="secondary" disabled={busy||data.balance<plan.coins}
        onClick={()=>void act(String(plan.coins),'/live-invites/purchase',{coins:plan.coins})}>{plan.limit} invites/day · {plan.viewerMinutes?.toLocaleString('en-KE') ?? (plan.coins * 50).toLocaleString('en-KE')} viewer-minutes · {plan.coins.toLocaleString()} coins/week</button>)}
    </>}
    {data&&<p className="hint">Balance {data.balance.toLocaleString()} coins</p>}
    {(message||plans?.error||passes?.error)&&<p role="status">{message||plans?.error||passes?.error}</p>}
  </div>;
}
