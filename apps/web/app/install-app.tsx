'use client';

import { Download, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

type InstallEvent = Event & { prompt: () => Promise<{ outcome: 'accepted' | 'dismissed' }> };
const snoozeKey = 'mwitu.install.snooze';

export default function InstallApp({ interrupted }: { interrupted: boolean }) {
  const promptEvent = useRef<InstallEvent | null>(null);
  const [available, setAvailable] = useState(false);
  const [canPrompt, setCanPrompt] = useState(false);
  const [appleMobile, setAppleMobile] = useState(false);
  const [offer, setOffer] = useState(false);
  const [help, setHelp] = useState(false);
  const [snoozed, setSnoozed] = useState(false);

  useEffect(() => {
    const mode = window.matchMedia('(display-mode: standalone)');
    const appleNavigator = navigator as Navigator & { standalone?: boolean };
    const updateMode = () => setAvailable(!mode.matches && !appleNavigator.standalone && window.isSecureContext);
    const onPrompt = (event: Event) => {
      event.preventDefault();
      promptEvent.current = event as InstallEvent;
      setCanPrompt(true);
    };
    const onInstalled = () => {
      promptEvent.current = null;
      setCanPrompt(false);
      setAvailable(false);
      setOffer(false);
      setHelp(false);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    mode.addEventListener('change', updateMode);
    updateMode();
    setAppleMobile(/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
    try { setSnoozed(Number(localStorage.getItem(snoozeKey)) > Date.now()); } catch { /* Storage can be disabled. */ }
    if ('serviceWorker' in navigator && window.isSecureContext) {
      void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => undefined);
    }
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
      mode.removeEventListener('change', updateMode);
    };
  }, []);

  useEffect(() => {
    if (interrupted || !available || snoozed || offer || help) return;
    const timer = window.setTimeout(() => setOffer(true), canPrompt ? 750 : 12000);
    return () => window.clearTimeout(timer);
  }, [available, canPrompt, help, interrupted, offer, snoozed]);

  function dismiss() {
    setOffer(false);
    setHelp(false);
    setSnoozed(true);
    try { localStorage.setItem(snoozeKey, String(Date.now() + 14 * 86400000)); } catch { /* In-memory dismissal still applies. */ }
  }

  async function install() {
    const request = promptEvent.current;
    if (!request) { setHelp(true); setOffer(false); return; }
    promptEvent.current = null;
    setCanPrompt(false);
    setOffer(false);
    setHelp(false);
    try {
      if ((await request.prompt()).outcome === 'accepted') setAvailable(false);
      else dismiss();
    } catch {
      setHelp(true);
    }
  }

  if (!available) return null;
  return <>
    <button className="icon install-shortcut" aria-label="Install app" title="Install app"
      aria-expanded={help && !interrupted} onClick={() => void install()}>
      <Download size={19} />
    </button>
    {!interrupted && (offer || help) && <section className="install-card" aria-label="Install Tiktok mwitu">
      <button className="icon install-close" aria-label="Dismiss installation prompt" onClick={dismiss}><X size={18} /></button>
      <div className="install-heading">
        <img src="/icons/mwitu-192.png" alt="" width="48" height="48" />
        <div><h2>Install Tiktok mwitu</h2><p>Open videos and LIVE from your home screen.</p></div>
      </div>
      {help ? <p className="install-steps">{appleMobile
        ? <>In Safari, tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>. Turn on <strong>Open as Web App</strong> if shown, then tap <strong>Add</strong>.</>
        : <>Open your browser menu and look for <strong>Install app</strong> or <strong>Add to Home Screen</strong>.</>}</p>
        : <div className="install-actions">
          <button className="primary" onClick={() => void install()}>{canPrompt ? 'Install' : 'How to install'}</button>
          <button className="link" onClick={dismiss}>Not now</button>
        </div>}
    </section>}
  </>;
}
