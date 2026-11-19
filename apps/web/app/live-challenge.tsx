'use client';

import { useState } from 'react';
import { Swords } from 'lucide-react';

export default function ChallengeSetup({ pending, submit }: {
  pending:boolean; submit:(action:string,data:object)=>Promise<boolean>;
}) {
  const [size,setSize]=useState(2);
  return <form className="challenge-setup" onSubmit={async event=>{
    event.preventDefault();
    const form=event.currentTarget;
    const data=new FormData(form);
    const handles=data.getAll('handle').map(handle=>String(handle).trim().replace(/^@/,''));
    const seconds=Number(data.get('seconds'));
    if(await submit(size===2?'invite':'invite-four',size===2?{handle:handles[0],seconds}:{handles,seconds}))form.reset();
  }}>
    <div className="stage-layout-picker" role="group" aria-label="Contestants">
      {[2,4].map(count=><button key={count} className="secondary" type="button" disabled={pending}
        aria-pressed={size===count} onClick={()=>setSize(count)}>{count} contestants</button>)}
    </div>
    {Array.from({length:size-1},(_,index)=><label key={index}>{size===2?'Challenger handle':'Challenger '+(index+1)}
      <input name="handle" required maxLength={25} placeholder="@handle" autoComplete="off" /></label>)}
    <label>Battle duration<select name="seconds" defaultValue="180">
      <option value="60">1 minute</option><option value="180">3 minutes</option><option value="300">5 minutes</option>
    </select></label>
    <p className="hint">The clock starts once every challenger is on camera. Viewers get one free vote each.</p>
    <button className="primary" disabled={pending}><Swords size={17} /> Send challenge invites</button>
  </form>;
}
