const MAX_FREE = 5;
let turnstileToken = null;

window.onTurnstileOK = (token) => {
  turnstileToken = token;
  const w = document.getElementById('captchaWrap');
  if (w) w.style.display = 'none';
};

function toast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(window.__tt);
  window.__tt = setTimeout(() => (t.style.display = 'none'), 3800);
}

async function me() {
  try { const r = await fetch('/me', { credentials: 'include' }); return r.json(); }
  catch { return { premium: false }; }
}

async function health() {
  try { const r = await fetch('/health'); return r.json(); }
  catch { return {}; }
}

async function generate() {
  const jobPost = document.getElementById('jobPost').value.trim();
  const skills  = document.getElementById('skills').value.trim();
  const tone    = document.getElementById('tone').value.trim() || 'concise & friendly';
  const cta     = document.getElementById('cta').value.trim()  || 'short intro call this week?';
  const variants= Number(document.getElementById('variants').value);

  const body = { jobPost, skills, tone, cta, variants, turnstileToken };
  const res  = await fetch('/generate', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(body),
    credentials:'include'
  });

  if (res.status === 401) { toast('Please complete the check and try again.'); document.getElementById('captchaWrap').style.display='block'; return; }
  if (res.status === 402) { const j = await res.json().catch(()=>({})); toast(j.message || `You’ve hit today’s free limit (${MAX_FREE}). Upgrade to continue.`); return; }
  if (!res.ok) { toast('Generation failed. Try again.'); return; }

  const data = await res.json();
  const box = document.getElementById('results'); box.innerHTML = '';
  (data.emails || []).forEach((txt, i) => {
    const card = document.createElement('div'); card.className='card';
    const pre  = document.createElement('pre'); pre.textContent = txt;
    const row  = document.createElement('div'); row.className='actions';
    const b1   = document.createElement('button'); b1.className='btn secondary'; b1.textContent='Copy';
    b1.onclick = async()=>{ await navigator.clipboard.writeText(txt); toast('Copied.'); };
    const b2   = document.createElement('button'); b2.className='btn secondary'; b2.textContent='Download .txt';
    b2.onclick = ()=>{ const blob=new Blob([txt],{type:'text/plain'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`email-${i+1}.txt`; a.click(); };
    row.append(b1,b2); card.append(pre,row); box.append(card);
  });
}

async function startCheckout(plan) {
  const r = await fetch('/checkout', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ plan }),
    credentials:'include'
  });
  const j = await r.json().catch(()=>({}));
  if (!r.ok || !j.url) return toast('Checkout failed.');
  location.href = j.url;
}

async function openPortal() {
  const email = prompt('Enter your billing email:');
  if (!email) return;
  const r = await fetch('/portal', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ email }),
    credentials:'include'
  });
  const j = await r.json().catch(()=>({}));
  if (!r.ok || !j.url) return toast('Portal unavailable.');
  location.href = j.url;
}

// wire
window.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('go').addEventListener('click', generate);
  document.getElementById('clear').addEventListener('click', () => { document.getElementById('results').innerHTML=''; });
  document.getElementById('buyStd').addEventListener('click', () => startCheckout('standard'));
  document.getElementById('buyPro').addEventListener('click', () => startCheckout('premium'));
  document.getElementById('manage').addEventListener('click', openPortal);

  const m = await me();
  const tag = document.getElementById('planTag');
  tag.textContent = `Plan: ${m.premium ? 'premium' : 'free'}`;

  const h = await health();
  // If server has Turnstile configured, provide the public site key to the widget
  if (h && h.turnstile_site_key) {
    const el = document.querySelector('.cf-turnstile');
    if (el) el.setAttribute('data-sitekey', h.turnstile_site_key);
  }
});