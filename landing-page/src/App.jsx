import React, { useEffect, useRef, useState } from 'react';
import { Waitlist } from '@clerk/react';

const chapters = [
  {
    id: 'think',
    kicker: 'Chapter 01 / Inspiration',
    title: 'Swipe.',
    accent: 'text-lime',
    icon: '✦',
    body: 'Use the phone app to swipe through references and save the reels that match your taste. Clipnosis turns those saves into direction for the edit.',
    bullets: ['Save references from your phone', 'Group examples by project or style', 'Give Clipnosis a clear taste profile'],
  },
  {
    id: 'see',
    kicker: 'Chapter 02 / Studio',
    title: 'Edit.',
    accent: 'text-magenta',
    icon: '▣',
    body: 'Open the desktop app and let Clipnosis do the production pass: transcribe footage, find the best moments, drag in overlays and media, and assemble a reviewable cut.',
    bullets: ['Transcript-first video analysis', 'Clip selection and overlay placement', 'A draft cut you can review before export'],
  },
  {
    id: 'ship',
    kicker: 'Chapter 03 / Publish',
    title: 'Ship.',
    accent: 'text-cyan',
    icon: '↗',
    body: 'Send the finished vertical reel back to your phone with the preview, captions, and export controls ready for posting.',
    bullets: ['Desktop render returns to mobile', 'Preview the final vertical cut', 'Save, share, or post from your phone'],
  },
];

const scores = [
  ['Swipe', 'Save references on mobile', 'text-lime'],
  ['Analyze', 'Transcript and find moments', 'text-magenta'],
  ['Assemble', 'Place media, overlays, captions', 'text-cyan'],
  ['Return', 'Send the finished reel to phone', 'text-gold'],
];

const ticker = [
  'Save reference reels from your phone',
  'Clipnosis transcribes raw footage on desktop',
  'Agentic editing places overlays and media',
  'Preview the vertical cut before posting',
  'Send the finished reel back to mobile',
];

function ParticleCanvas() {
  const ref = useRef(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const particles = Array.from({ length: 120 }, () => ({
      x: Math.random(),
      y: Math.random(),
      r: Math.random() * 1.8 + 0.4,
      v: Math.random() * 0.00045 + 0.00015,
      c: ['#C7F73C', '#FF3F8B', '#4EE2EC', '#ffffff'][Math.floor(Math.random() * 4)],
    }));
    let raf = 0;

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function draw() {
      const w = window.innerWidth;
      const h = window.innerHeight;
      ctx.clearRect(0, 0, w, h);
      for (const p of particles) {
        p.y -= p.v;
        if (p.y < -0.05) p.y = 1.05;
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = p.c;
        ctx.beginPath();
        ctx.arc(p.x * w, p.y * h, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
      raf = requestAnimationFrame(draw);
    }

    resize();
    draw();
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(raf);
    };
  }, []);

  return <canvas ref={ref} className="pointer-events-none fixed inset-0 z-0 h-full w-full" />;
}

function Logo({ small = false }) {
  return (
    <div className="group flex items-center gap-3">
      <div className={`${small ? 'h-8 w-8' : 'h-11 w-11'} relative rotate-[-5deg] rounded-full text-lime transition duration-150 group-hover:rotate-1`}>
        <svg viewBox="0 0 44 44" className="h-full w-full" aria-hidden="true">
          <circle cx="22" cy="22" r="22" fill="currentColor" />
          <path d="M15.5 15.5v4M28.5 15.5v4M14.5 26.5c3.4 4.2 11.6 4.2 15 0" fill="none" stroke="#05050B" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <div className="leading-none">
        <div className={`font-logo font-black text-white tracking-[-0.04em] ${small ? 'text-lg' : 'text-2xl md:text-3xl'}`}>
          <span>Clipnosis</span>
        </div>
      </div>
    </div>
  );
}

function Button({ children, variant = 'primary' }) {
  const cls =
    variant === 'primary'
      ? 'bg-lime text-ink shadow-lime'
      : 'border border-white/20 bg-white/[0.055] text-white hover:border-white/35';
  return (
    <button className={`inline-flex items-center gap-2 rounded-xl px-5 py-3 font-display text-sm font-black transition duration-150 hover:-translate-y-0.5 md:px-6 md:py-4 md:text-base ${cls}`}>
      {children}
    </button>
  );
}

function WaitlistPanel({ clerkEnabled }) {
  if (!clerkEnabled) {
    return (
      <div className="w-full max-w-md rounded-[28px] border border-coral/30 bg-coral/[0.08] p-6 text-left">
        <p className="font-display text-2xl font-black text-white">Waitlist is almost ready.</p>
        <p className="mt-3 text-sm leading-6 text-white/65">
          Add <span className="font-mono text-coral">VITE_CLERK_PUBLISHABLE_KEY</span> in Vercel to enable the embedded Clerk waitlist.
        </p>
      </div>
    );
  }

  return (
    <div className="clerk-waitlist-shell w-full max-w-md rounded-[28px] border border-lime/30 bg-white/[0.07] p-3 shadow-[0_24px_90px_-36px_rgba(199,247,60,.6)] backdrop-blur-xl">
      <Waitlist
        appearance={{
          variables: {
            colorPrimary: '#C7F73C',
            colorBackground: '#090911',
            colorText: '#ffffff',
            colorTextSecondary: 'rgba(255,255,255,.66)',
            colorInputBackground: 'rgba(255,255,255,.07)',
            colorInputText: '#ffffff',
            borderRadius: '18px',
          },
          elements: {
            rootBox: 'w-full',
            cardBox: 'shadow-none border border-white/10',
            card: 'bg-[#090911]',
            headerTitle: 'font-display',
            formButtonPrimary: 'font-display font-black text-ink',
          },
        }}
      />
    </div>
  );
}

function Nav() {
  return (
    <nav className="fixed inset-x-0 top-0 z-50 border-b border-line bg-ink/65 px-5 py-4 backdrop-blur-2xl md:px-8">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-6">
        <Logo />
        <div className="hidden items-center gap-8 font-body text-sm font-semibold text-white/70 md:flex">
          <a href="#think" className="hover:text-white">Swipe</a>
          <a href="#see" className="hover:text-white">Edit</a>
          <a href="#ship" className="hover:text-white">Ship</a>
        </div>
        <a href="/waitlist" className="inline-flex items-center gap-2 rounded-xl bg-lime px-5 py-3 font-display text-sm font-black text-ink shadow-lime transition duration-150 hover:-translate-y-0.5 md:px-6 md:py-4 md:text-base">
          Join waitlist →
        </a>
      </div>
    </nav>
  );
}

function Hud() {
  return (
    <aside className="fixed right-5 top-24 z-40 hidden flex-col items-end gap-2 lg:flex">
      {[
        ['SCORE', '12,450', 'text-lime'],
        ['STREAK', '12 🔥', 'text-magenta'],
        ['COMBO', '×1.5', 'text-gold'],
      ].map(([label, value, color]) => (
        <div key={label} className="flex gap-2 rounded-xl border border-white/10 bg-panel/75 px-3 py-2 font-mono text-[11px] font-bold tracking-wider backdrop-blur-xl">
          <span className="text-white/40">{label}</span>
          <span className={color}>{value}</span>
        </div>
      ))}
    </aside>
  );
}

function useScrollChapter() {
  const [active, setActive] = useState('hero');

  useEffect(() => {
    const ids = ['hero', 'think', 'see', 'ship', 'scores', 'cta'];
    let raf = 0;

    function update() {
      const center = window.scrollY + window.innerHeight * 0.52;
      let next = 'hero';
      let best = Infinity;
      for (const id of ids) {
        const el = document.getElementById(id);
        if (!el) continue;
        const top = el.offsetTop;
        const mid = top + el.offsetHeight / 2;
        const dist = Math.abs(center - mid);
        if (dist < best) {
          best = dist;
          next = id;
        }
      }
      setActive(next);
    }

    function onScroll() {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(update);
    }

    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);

  return active;
}

function Phone({ state = 'hero' }) {
  const tiles = ['REF', 'SAVE', 'SKIP', 'REF', 'SAVE', 'SAVE'];
  const screenClass = (name) => {
    const visible = state === name || (name === 'hero' && !['think', 'ship'].includes(state));
    return `absolute inset-0 transition-all duration-700 ease-[cubic-bezier(.2,.8,.2,1)] ${visible ? 'translate-y-0 opacity-100 blur-0' : 'pointer-events-none translate-y-5 opacity-0 blur-[2px]'}`;
  };
  return (
    <div className="phone-tilt relative h-[520px] w-[252px] shrink-0 overflow-hidden rounded-[36px] border border-white/15 bg-ink p-4 shadow-[0_60px_140px_-40px_rgba(0,0,0,.85),0_0_70px_rgba(199,247,60,.22)] ring-8 ring-black">
      <div className="absolute left-1/2 top-3 z-10 h-7 w-24 -translate-x-1/2 rounded-full bg-black" />
      <div className="absolute -right-16 -top-20 h-52 w-52 rounded-full bg-lime/20 blur-3xl" />

      <div className={`phone-screen relative h-full ${state === 'see' ? 'opacity-20 blur-[1px]' : 'opacity-100'} transition duration-700`}>
        <div className={screenClass('think')}>
          <div className="mt-9">
            <div className="flex items-start justify-between">
              <div>
                <p className="font-display text-xl font-black tracking-tight">Inspiration</p>
                <p className="mt-1 font-mono text-[9px] tracking-widest text-white/45">SWIPE TO TEACH AI</p>
              </div>
              <div className="rounded-md border border-cyan/40 bg-cyan/15 px-2 py-1 font-mono text-[9px] font-black text-cyan">23 REFS</div>
            </div>
            <div className="relative mt-4 h-[286px]">
              <ReelCard className="absolute inset-0 rotate-[-5deg] scale-[.86] bg-[#16434A]" />
              <ReelCard className="reel-reject absolute inset-0 rotate-[3deg] scale-[.92] bg-[#354616]" who="reference" caption="SLOW HOOK" reject />
              <ReelCard className="reel-swipe absolute inset-0 bg-[#8A2350]" who="reference" caption="FAST CUT" save />
            </div>
            <div className="mt-2 flex justify-center gap-3">
              <div className="grid h-10 w-10 place-items-center rounded-full border border-coral/35 bg-coral/10 text-coral">×</div>
              <div className="grid h-12 w-12 place-items-center rounded-full bg-lime text-ink shadow-lime">♥</div>
              <div className="grid h-10 w-10 place-items-center rounded-full border border-cyan/35 bg-cyan/10 text-cyan">+</div>
            </div>
          </div>
        </div>

        <div className={screenClass('ship')}>
          <div className="mt-9">
            <div className="flex items-start justify-between">
              <div>
                <p className="font-display text-xl font-black tracking-tight">Ready to ship</p>
                <p className="mt-1 font-mono text-[9px] tracking-widest text-white/45">REEL.MP4 / 0:38</p>
              </div>
              <div className="rounded-md bg-lime px-2 py-1 font-mono text-[9px] font-black text-ink">DONE</div>
            </div>

            <div className="ship-preview relative mt-4 h-[294px] overflow-hidden rounded-[26px] border border-cyan/40 bg-[linear-gradient(155deg,rgba(78,226,236,.22),rgba(255,63,139,.24)),#121118] shadow-[0_0_54px_-22px_rgba(78,226,236,.9)]">
              <div className="absolute inset-x-0 top-0 h-20 bg-gradient-to-b from-white/10 to-transparent" />
              <div className="ship-subject absolute left-1/2 top-16 h-28 w-20 -translate-x-1/2 rounded-[36px] border border-white/25 bg-white/10" />
              <div className="absolute left-3 top-3 rounded-md bg-black/60 px-2 py-1 font-mono text-[9px] font-black tracking-widest text-cyan">1080 x 1920</div>
              <div className="absolute right-3 top-3 rounded-md bg-lime px-2 py-1 font-mono text-[9px] font-black text-ink">100%</div>
              <div className="absolute inset-0 grid place-items-center">
                <div className="ship-play grid h-16 w-16 place-items-center rounded-full bg-lime text-ink shadow-lime">▶</div>
              </div>
              <div className="overlay-chip absolute bottom-16 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-black/80 px-3 py-1 font-display text-sm font-black">
                FINAL <span className="text-lime">CUT</span> READY
              </div>
              <div className="absolute bottom-5 left-4 right-4 h-2 overflow-hidden rounded-full bg-white/15">
                <div className="ship-progress h-full rounded-full bg-cyan shadow-[0_0_18px_rgba(78,226,236,.8)]" />
              </div>
            </div>

            <div className="mt-4 grid grid-cols-3 gap-2">
              {['Save', 'Share', 'Post'].map((action, i) => (
                <div key={action} className={`ship-action rounded-2xl px-2 py-3 text-center font-display text-xs font-black ${i === 2 ? 'bg-lime text-ink shadow-lime' : 'border border-white/10 bg-white/[0.055] text-white/80'}`} style={{ animationDelay: `${i * 120}ms` }}>{action}</div>
              ))}
            </div>
          </div>
        </div>

        <div className={screenClass('hero')}>
          <>
            <div className="relative mt-9 flex items-start justify-between">
              <div>
                <p className="font-display text-2xl font-black tracking-tight">Projects</p>
                <p className="mt-1 font-mono text-[11px] text-white/45">References / footage / cuts</p>
              </div>
              <div className="rounded-md bg-coral/15 px-2 py-1 font-mono text-[10px] font-black text-coral">BETA</div>
            </div>
            <div className="mt-4 grid grid-cols-3 gap-2">
              {[
                ['147', 'REFS', 'text-lime'],
                ['12', 'PROJECTS', 'text-magenta'],
                ['6', 'CUTS', 'text-gold'],
              ].map(([n, l, c]) => (
                <div key={l} className="rounded-xl border border-white/[0.07] bg-white/[0.045] p-2">
                  <div className={`font-display text-xl font-black ${c}`}>{n}</div>
                  <div className="font-mono text-[8px] font-bold tracking-widest text-white/35">{l}</div>
                </div>
              ))}
            </div>
            <p className="mt-4 font-mono text-[10px] font-bold tracking-[0.18em] text-white/40">RECENT CLIPS</p>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {tiles.map((tile, i) => (
                <div key={`${tile}-${i}`} className={`aspect-[9/14] rounded-lg border border-white/[0.07] p-1 ${i % 3 === 0 ? 'bg-lime/15' : i % 3 === 1 ? 'bg-cyan/15' : 'bg-magenta/15'}`}>
                  <span className={`rounded bg-black/60 px-1.5 py-1 font-mono text-[7px] font-black ${tile === 'REF' ? 'text-lime' : tile === 'SAVE' ? 'text-cyan' : 'text-coral'}`}>{tile}</span>
                </div>
              ))}
            </div>
          </>
        </div>
      </div>
      <div className="absolute inset-x-4 bottom-4 flex justify-between rounded-2xl border border-white/[0.07] bg-white/[0.045] p-2 font-mono text-[8px] font-black text-white/35">
        <span>Camera</span><span className="text-lime">Projects</span><span>Clips</span><span>Stats</span>
      </div>
    </div>
  );
}

function ReelCard({ className = '', who = 'reference', caption = 'HOOK MAP', save = false, reject = false }) {
  return (
    <div className={`overflow-hidden rounded-[24px] border border-white/15 shadow-[0_20px_60px_-28px_rgba(0,0,0,.9)] ${className}`}>
      <div className="absolute inset-x-3 top-3 flex items-center gap-2">
        <span className="h-7 w-7 rounded-full border-2 border-white bg-gradient-to-br from-coral to-gold" />
        <span className="text-xs font-bold">{who}</span>
        <span className="ml-auto rounded bg-black/50 px-2 py-1 font-mono text-[9px] text-lime">0:18</span>
      </div>
      <div className="absolute left-1/2 top-24 h-28 w-20 -translate-x-1/2 rounded-[34px] border border-white/30 bg-white/15" />
      <div className="absolute bottom-8 left-1/2 -translate-x-1/2 rounded bg-black/80 px-3 py-1 font-display text-sm font-black">{caption}</div>
      {save ? <div className="save-stamp absolute right-4 top-20 rotate-12 rounded-md border-[3px] border-lime bg-black/50 px-3 py-1 font-display text-lg font-black text-lime">SAVE</div> : null}
      {reject ? <div className="reject-stamp absolute left-4 top-20 -rotate-12 rounded-md border-[3px] border-coral bg-black/50 px-3 py-1 font-display text-lg font-black text-coral">REJECT</div> : null}
    </div>
  );
}

function Desktop({ active = false }) {
  const screens = [
    {
      label: 'Creating transcript',
      note: 'Listening for hooks, pauses, emphasis',
      badge: 'TRANSCRIPT',
      accent: 'text-lime',
      body: (
        <div className="space-y-2">
          {[
            ['00:01', 'I stopped wasting dead clips...'],
            ['00:07', 'This is the exact pacing pattern.'],
            ['00:16', 'Cut here before the setup drags.'],
            ['00:23', 'Caption beat lands on the lift.'],
          ].map(([time, text], i) => (
            <div key={time} className="transcript-line flex gap-3 rounded-xl border border-white/[0.08] bg-white/[0.05] px-3 py-2.5" style={{ animationDelay: `${i * 220}ms` }}>
              <span className="font-mono text-[10px] font-bold text-lime">{time}</span>
              <span className="text-[12px] font-semibold text-white/75">{text}</span>
            </div>
          ))}
        </div>
      ),
    },
    {
      label: 'Finding clips',
      note: 'Scoring saved moments against your style',
      badge: 'CLIP MATCH',
      accent: 'text-cyan',
      body: (
        <div className="grid grid-cols-3 gap-3">
          {['HOOK', 'B-ROLL', 'CAPTION'].map((name, i) => (
            <div key={name} className="clip-tile h-[150px] rounded-xl border border-cyan/25 bg-cyan/15 p-2" style={{ animationDelay: `${i * 140}ms` }}>
              <div className="h-full rounded-lg bg-black/30">
                <div className="mx-auto pt-7">
                  <div className="mx-auto h-12 w-8 rounded-full border border-white/20 bg-white/10" />
                </div>
                <p className="mt-4 text-center font-mono text-[9px] font-black tracking-wider text-cyan">{name}</p>
              </div>
            </div>
          ))}
        </div>
      ),
    },
    {
      label: 'Editing video',
      note: 'Arranging cuts, captions, b-roll, and pacing',
      badge: 'AUTO EDIT',
      accent: 'text-magenta',
      body: (
        <div className="relative h-[205px] overflow-hidden rounded-2xl border border-white/[0.08] bg-black/35 p-3">
          <div className="absolute left-3 top-3 z-20 rounded-md bg-lime px-2 py-1 font-mono text-[8px] font-black text-ink">PLAYING</div>
          <div className="video-pulse absolute inset-3 overflow-hidden rounded-xl border border-magenta/25 bg-[radial-gradient(circle_at_50%_28%,rgba(199,247,60,.18),transparent_28%),linear-gradient(135deg,rgba(78,226,236,.16),rgba(255,63,139,.18))]">
            <div className="absolute left-1/2 top-11 h-20 w-14 -translate-x-1/2 rounded-[28px] border border-white/25 bg-white/10" />
            <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/75 to-transparent" />
            <div className="media-card media-card-a absolute left-5 top-9 rounded-lg border border-cyan/45 bg-cyan/25 px-3 py-2 font-mono text-[9px] font-black text-cyan shadow-[0_0_24px_rgba(78,226,236,.25)]">B-ROLL</div>
            <div className="media-card media-card-b absolute right-6 top-20 rounded-lg border border-lime/45 bg-lime/20 px-3 py-2 font-mono text-[9px] font-black text-lime shadow-[0_0_24px_rgba(199,247,60,.25)]">ZOOM CUT</div>
            <div className="overlay-chip absolute bottom-8 left-1/2 -translate-x-1/2 rounded bg-black/85 px-3 py-1 font-display text-xs font-black">
              FINAL <span className="text-lime">CUT</span> READY
            </div>
            <div className="agent-cursor cursor-a absolute">
              <span className="block h-0 w-0 border-l-[9px] border-r-[4px] border-t-[16px] border-l-violet border-r-transparent border-t-transparent" />
              <span className="absolute left-3 top-3 rounded-md bg-violet px-2 py-1 font-mono text-[8px] font-black text-white">Agent</span>
            </div>
            <div className="absolute bottom-3 left-4 right-4 h-1.5 overflow-hidden rounded-full bg-white/15">
              <div className="desktop-progress h-full rounded-full bg-lime" />
            </div>
          </div>
        </div>
      ),
    },
  ];

  return (
    <div className={`desktop-tilt relative mt-4 w-[560px] max-w-[66vw] transition duration-700 ${active ? 'scale-100 opacity-100' : 'scale-95 opacity-0'}`}>
      <div className="relative overflow-hidden rounded-[24px] border-[10px] border-[#090908] bg-[#171411] shadow-[0_70px_150px_-55px_rgba(0,0,0,.95),0_0_90px_rgba(137,255,59,.16),0_0_80px_rgba(180,157,255,.12)] ring-1 ring-white/15">
        <div className="absolute left-1/2 top-2 z-20 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-white/25" />
        <div className="flex items-center gap-4 border-b border-white/[0.08] bg-[#1d1a16]/95 px-5 py-3">
          <Logo small />
          <div className="ml-auto rounded-xl border border-violet/40 bg-violet/15 px-3 py-2 font-mono text-[9px] font-bold tracking-wider text-violet">ANALYZING</div>
        </div>

        <div className="relative h-[330px] bg-[#11100e]">
          {screens.map((screen, i) => (
            <section key={screen.label} className="desktop-screen absolute inset-0 p-5" style={{ animationDelay: `${i * 3.4}s` }}>
              <div className="mb-3 flex items-start justify-between">
                <div>
                  <p className={`font-mono text-[9px] font-black tracking-[0.22em] ${screen.accent}`}>{screen.badge}</p>
                  <h3 className="mt-2 font-display text-2xl font-black tracking-[-0.04em]">{screen.label}</h3>
                  <p className="mt-1 text-xs font-semibold text-white/45">{screen.note}</p>
                </div>
                <span className="agent-dot h-3 w-3 rounded-full bg-violet" />
              </div>
              {screen.body}
            </section>
          ))}
        </div>
      </div>
      <div className="mx-auto h-3 w-[92%] rounded-b-[28px] bg-gradient-to-b from-[#24201a] to-[#080808] shadow-[0_20px_45px_-20px_rgba(0,0,0,.95)]" />
      <div className="mx-auto h-2 w-[40%] rounded-b-2xl bg-[#34302a]" />
    </div>
  );
}

function DeviceStage({ state = 'hero', fixed = false }) {
  const showDesktop = state === 'see';
  const showPhone = !fixed || state !== 'see';
  if (fixed) {
    const phoneStateClass = state === 'see'
      ? 'left-[calc(50%+140px)] top-6 scale-[.72] opacity-0 blur-sm'
      : 'left-[calc(50%+230px)] top-0 scale-105 opacity-100 blur-0';
    const desktopStateClass = state === 'see'
      ? 'left-[calc(50%+40px)] top-20 scale-100 opacity-100'
      : 'left-[calc(50%+180px)] top-20 scale-90 opacity-0';
    return (
      <div className="relative h-[560px] w-screen" data-state={state}>
        <div className={`absolute transition-all duration-1000 ease-[cubic-bezier(.2,.8,.2,1)] ${showPhone ? phoneStateClass : 'pointer-events-none left-[calc(50%+140px)] top-6 scale-[.72] opacity-0 blur-sm'}`}>
          <Phone state={state} />
        </div>
        <div className={`absolute transition-all duration-1000 ease-[cubic-bezier(.2,.8,.2,1)] ${showDesktop ? desktopStateClass : `pointer-events-none ${desktopStateClass}`}`}>
          <Desktop active={showDesktop} />
        </div>
      </div>
    );
  }
  return (
    <div className={`relative flex items-start justify-center ${fixed ? 'min-h-[560px]' : 'mt-10 min-h-[680px] lg:mt-0'}`} data-state={state}>
      <div className={`transition duration-500 ${showPhone ? 'opacity-100' : 'pointer-events-none opacity-0'}`}>
        <Phone state={state} />
      </div>
      {showDesktop ? (
        <div className="transition duration-500 opacity-100">
          <Desktop active />
        </div>
      ) : null}
    </div>
  );
}

function FixedDeviceStage({ active }) {
  const visible = ['hero', 'think', 'see', 'ship'].includes(active);
  return (
    <div className={`pointer-events-none fixed left-0 top-1/2 z-20 hidden w-screen -translate-y-1/2 transition-all duration-1000 ease-[cubic-bezier(.2,.8,.2,1)] lg:block ${visible ? 'translate-x-0 opacity-100' : 'translate-x-24 opacity-0'}`}>
      <DeviceStage state={active} fixed />
    </div>
  );
}

function Hero({ active }) {
  return (
    <section id="hero" className="relative z-10 mx-auto grid min-h-screen max-w-7xl items-center gap-10 px-5 pb-20 pt-28 md:px-8 lg:grid-cols-[1fr_1.05fr] lg:pt-36">
      <div>
        <h1 className="font-display text-[64px] font-black uppercase leading-[0.86] tracking-[-0.055em] md:text-[108px]">
          <span className="block text-lime drop-shadow-[0_0_30px_rgba(199,247,60,.45)]">Swipe.</span>
          <span className="block text-magenta drop-shadow-[0_0_30px_rgba(255,63,139,.45)]">
            <span className="relative inline-block">
              Edit.
              <span className="absolute left-0 top-1/2 h-3 w-full -translate-y-1/2 rotate-[-3deg] rounded-sm bg-lime shadow-lime" />
            </span>
          </span>
          <span className="block text-cyan drop-shadow-[0_0_30px_rgba(78,226,236,.45)]">Ship.</span>
        </h1>
        <p className="mt-8 max-w-2xl text-lg leading-8 text-white/70 md:text-xl">
          Swipe through references on your phone. Clipnosis turns your saves and raw footage into a reviewable desktop cut, then sends the finished reel back to mobile.
        </p>
        <div className="mt-9 flex flex-wrap gap-3">
          <a href="#waitlist" className="inline-flex items-center gap-2 rounded-xl bg-lime px-6 py-4 font-display text-base font-black text-ink shadow-lime transition duration-150 hover:-translate-y-0.5">
            Join waitlist →
          </a>
        </div>
        <div className="mt-8 flex flex-wrap gap-3 font-mono text-[11px] font-bold tracking-widest text-white/40">
          <span>SCROLL</span><span>•</span><span>SAVE REFERENCES</span><span>•</span><span>CLIPNOSIS BUILDS THE CUT</span>
        </div>
      </div>
      <div className={`transition duration-500 lg:hidden ${active === 'hero' ? 'opacity-100' : 'opacity-0'}`}>
        <DeviceStage state="hero" />
      </div>
    </section>
  );
}

function Ticker() {
  return (
    <div className="relative z-20 overflow-hidden border-y border-line bg-panel/70 py-4 backdrop-blur-xl">
      <div className="animate-ticker flex w-max gap-10 whitespace-nowrap font-mono text-xs text-white/65">
        {[...ticker, ...ticker].map((item, i) => (
          <span key={`${item}-${i}`} className="flex items-center gap-10">
            <span><b className="text-white">{item.split(' ')[0]}</b> {item.split(' ').slice(1).join(' ')}</span>
            <span className="text-lime">●</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function Chapter({ chapter }) {
  return (
    <section id={chapter.id} className="relative z-10 min-h-screen px-5 py-24 md:px-8">
      <div className="mx-auto grid max-w-7xl items-center gap-10 lg:block lg:pr-[45vw]">
        <div>
          <div className={`mb-5 flex items-center gap-3 font-mono text-[11px] font-bold uppercase tracking-[0.2em] ${chapter.accent}`}>
            <span className="h-px w-9 bg-current" />
            {chapter.kicker}
          </div>
          <h2 className={`font-display text-6xl font-black uppercase leading-[0.9] tracking-[-0.045em] md:text-8xl ${chapter.accent}`}>
            {chapter.id === 'see' ? (
              <span className="relative inline-block">
                {chapter.title}
                <span className="absolute left-0 top-1/2 h-2 w-full -translate-y-1/2 rotate-[-3deg] rounded-sm bg-lime shadow-lime md:h-3" />
              </span>
            ) : chapter.title}
          </h2>
          <p className="mt-7 text-lg leading-8 text-white/70">{chapter.body}</p>
          <div className="mt-7 space-y-3">
            {chapter.bullets.map((bullet) => (
              <div key={bullet} className="flex items-center gap-3 rounded-xl border border-white/[0.07] bg-white/[0.045] p-4 text-sm text-white/70">
                <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white/[0.06] font-mono font-black ${chapter.accent}`}>{chapter.icon}</span>
                <span>{bullet}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function Scoreboard() {
  return (
    <section id="scores" className="relative z-10 px-5 py-24 md:px-8">
      <div className="mx-auto max-w-7xl">
        <div className="mb-6 flex items-center gap-3 font-mono text-[11px] font-bold uppercase tracking-[0.2em] text-lime">
          <span className="h-px w-9 bg-lime" />
          Product flow
        </div>
        <h2 className="max-w-4xl font-display text-5xl font-black uppercase leading-[0.95] tracking-[-0.045em] md:text-7xl">
          What Clipnosis actually does.
        </h2>
        <div className="mt-10 rounded-[28px] border border-lime/60 bg-lime/[0.04] p-5 shadow-[0_0_0_1px_rgba(199,247,60,.18),0_30px_80px_-32px_rgba(199,247,60,.45)] md:p-8">
          <div className="grid gap-px overflow-hidden rounded-2xl bg-lime/20 md:grid-cols-4">
            {scores.map(([value, label, color]) => (
              <div key={label} className="bg-[#090911] p-6">
                <div className={`font-display text-6xl font-black tracking-[-0.05em] ${color}`}>{value}</div>
                <p className="mt-4 font-mono text-[11px] leading-5 tracking-widest text-white/45">{label}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function BigCta({ clerkEnabled }) {
  return (
    <section id="cta" className="relative z-10 overflow-hidden px-5 py-28 text-center md:px-8 md:py-40">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,rgba(199,247,60,.18),transparent_58%)]" />
      <div className="relative">
        <h2 className="font-display text-6xl font-black uppercase leading-[0.86] tracking-[-0.055em] md:text-[130px]">
          Swipe references.<br />Review the cut.<br /><span className="text-lime">Ship from phone.</span>
        </h2>
        <div id="waitlist" className="mt-10 flex justify-center">
          <WaitlistPanel clerkEnabled={clerkEnabled} />
        </div>
        <p className="mt-7 font-mono text-[11px] font-bold tracking-[0.18em] text-white/40">MOBILE APP + DESKTOP WORKFLOW</p>
      </div>
    </section>
  );
}

function WaitlistPage({ clerkEnabled }) {
  return (
    <main className="min-h-screen overflow-hidden bg-ink text-white">
      <ParticleCanvas />
      <div className="pointer-events-none fixed inset-0 z-[1] bg-[radial-gradient(80%_60%_at_50%_-10%,rgba(199,247,60,.12),transparent_50%),radial-gradient(60%_50%_at_90%_30%,rgba(255,63,139,.09),transparent_60%),radial-gradient(60%_50%_at_5%_60%,rgba(78,226,236,.07),transparent_60%)]" />
      <div className="pointer-events-none fixed inset-0 z-[2] opacity-35 scanlines" />
      <Nav />
      <section className="relative z-10 mx-auto grid min-h-screen max-w-7xl items-center gap-12 px-5 pb-20 pt-32 md:px-8 lg:grid-cols-[1fr_460px]">
        <div>
          <div className="mb-5 flex items-center gap-3 font-mono text-[11px] font-bold uppercase tracking-[0.2em] text-lime">
            <span className="h-px w-9 bg-lime" />
            Private beta
          </div>
          <h1 className="font-display text-[64px] font-black uppercase leading-[0.86] tracking-[-0.055em] md:text-[112px]">
            Join the<br /><span className="text-lime">Clipnosis</span><br />waitlist.
          </h1>
          <p className="mt-8 max-w-2xl text-lg leading-8 text-white/70 md:text-xl">
            Get early access to the mobile-to-desktop creator workflow for saving references, reviewing automated cuts, and shipping vertical reels from your phone.
          </p>
        </div>
        <WaitlistPanel clerkEnabled={clerkEnabled} />
      </section>
    </main>
  );
}

function HomePage({ clerkEnabled }) {
  const active = useScrollChapter();
  return (
    <main className="min-h-screen overflow-hidden bg-ink text-white">
      <ParticleCanvas />
      <div className="pointer-events-none fixed inset-0 z-[1] bg-[radial-gradient(80%_60%_at_50%_-10%,rgba(199,247,60,.12),transparent_50%),radial-gradient(60%_50%_at_90%_30%,rgba(255,63,139,.09),transparent_60%),radial-gradient(60%_50%_at_5%_60%,rgba(78,226,236,.07),transparent_60%)]" />
      <div className="pointer-events-none fixed inset-0 z-[2] opacity-35 scanlines" />
      <Nav />
      <FixedDeviceStage active={active} />
      <Hero active={active} />
      <Ticker />
      {chapters.map((chapter) => <Chapter key={chapter.id} chapter={chapter} />)}
      <BigCta clerkEnabled={clerkEnabled} />
      <footer className="relative z-10 border-t border-line px-5 py-8 md:px-8">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 font-mono text-[11px] tracking-widest text-white/40 md:flex-row md:items-center md:justify-between">
          <Logo small />
          <div className="flex gap-6"><span>Privacy</span><span>Terms</span><span>Press</span><span>Contact</span></div>
          <span>© 2026 Clipnosis</span>
        </div>
      </footer>
    </main>
  );
}

export default function App({ clerkEnabled = false }) {
  const waitlistPath = window.location.pathname.replace(/\/$/, '') === '/waitlist';
  return waitlistPath ? <WaitlistPage clerkEnabled={clerkEnabled} /> : <HomePage clerkEnabled={clerkEnabled} />;
}
