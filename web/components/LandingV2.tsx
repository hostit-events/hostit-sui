"use client";

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "./Icon";

/* eslint-disable @typescript-eslint/no-explicit-any */

// Resets on a full page reload (so the intro replays on every hard load, like
// the design); persists across SPA navigations so it doesn't replay on each
// client route change.
let introPlayed = false;

export function LandingV2() {
  const router = useRouter();
  const rootRef = useRef<HTMLDivElement>(null);
  const host = () => router.push("/create");
  const login = () => router.push("/auth");
  const demo = () => router.push("/discover");

  const reduced =
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // The intro splash always plays on a fresh load (independent of reduced-motion
  // so it reliably shows); only `introPlayed` (reset on hard reload) gates it.
  const [intro, setIntro] = useState(() => !introPlayed);
  useEffect(() => {
    if (!intro) return;
    // mark played in the timeout (not the initializer) so React Strict Mode's dev
    // double-mount can't suppress the splash on first load.
    const t = setTimeout(() => {
      introPlayed = true;
      setIntro(false);
    }, 2600);
    return () => clearTimeout(t);
  }, [intro]);

  // reveal-on-scroll — run in a layout effect so the hidden/shown classes are
  // applied BEFORE first paint (no visible→hidden→reveal flash).
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const els = [...root.querySelectorAll<HTMLElement>(".rv,.rv-scale,[data-lines]")];
    if (reduced) {
      els.forEach((el) => el.classList.add("in"));
      return;
    }
    const vh = window.innerHeight * 0.95;
    const visible = els.filter((el) => {
      const r = el.getBoundingClientRect();
      return r.top < vh && r.bottom > 0;
    });
    root.classList.add("lv-animate");
    visible.forEach((el) => el.classList.add("in"));
    const io = new IntersectionObserver(
      (ents) => {
        ents.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.18, rootMargin: "0px 0px -8% 0px" },
    );
    els.forEach((el) => {
      if (!el.classList.contains("in")) io.observe(el);
    });
    return () => io.disconnect();
  }, [reduced]);

  // scroll engine: nav solidify, hero parallax, pinned bridge + solution beats
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const navEl = root.querySelector<HTMLElement>(".lv-nav");
    const heroBg = root.querySelector<HTMLElement>(".lv-hero-bg");
    const bridge = root.querySelector<HTMLElement>(".lv-bridge");
    const strike = root.querySelector<HTMLElement>(".lv-bridge .strike");
    const layerA = root.querySelector<HTMLElement>(".lv-bridge-layer.a");
    const layerB = root.querySelector<HTMLElement>(".lv-bridge-layer.b");
    const bcount = root.querySelector<HTMLElement>(".lv-bridge-count b");
    const solution = root.querySelector<HTMLElement>(".lv-solution");
    const beats = [...root.querySelectorAll<HTMLElement>(".lv-beat")];
    const segs = [...root.querySelectorAll<HTMLElement>(".lv-sol-progress .seg i")];
    const figs = [...root.querySelectorAll<HTMLElement>(".lv-beat-fig")];
    const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v));
    const vh = () => window.innerHeight;
    let raf = 0;

    const tick = () => {
      raf = 0;
      const y = window.scrollY;
      if (navEl) navEl.classList.toggle("solid", y > 70);
      if (heroBg && y < vh() * 1.4) heroBg.style.transform = `translateY(${y * 0.16}px)`;
      if (bridge && layerA && layerB && !reduced && getComputedStyle(bridge).height !== "auto" && window.innerWidth > 880) {
        const r = bridge.getBoundingClientRect();
        const p = clamp(-r.top / (r.height - vh()));
        const fill = clamp(p / 0.5);
        if (strike) strike.style.setProperty("--strike", fill.toFixed(3));
        layerA.style.opacity = clamp(1 - (p - 0.5) / 0.05).toFixed(3);
        layerB.style.opacity = clamp((p - 0.5) / 0.05).toFixed(3);
        if (bcount) bcount.textContent = String(Math.round(fill * 100)).padStart(2, "0");
      }
      if (solution && beats.length && !reduced && getComputedStyle(solution).height !== "auto" && window.innerWidth > 880) {
        const r = solution.getBoundingClientRect();
        const p = clamp(-r.top / (r.height - vh()));
        const n = beats.length;
        const active = Math.min(n - 1, Math.floor(p * n));
        beats.forEach((b, i) => {
          b.classList.toggle("on", i === active);
          const local = clamp(p * n - i);
          if (figs[i]) figs[i].style.setProperty("--tk", local.toFixed(4));
        });
        segs.forEach((s, i) => s.style.setProperty("--p", i <= active ? "1" : "0"));
      }
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(tick);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    tick();
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      cancelAnimationFrame(raf);
    };
  }, [reduced]);

  return (
    <div className="lv" ref={rootRef}>
      {intro && (
        <div className="lv-intro" aria-hidden="true">
          <div className="lv-intro-word">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="lv-intro-logo" src="/brand/logo-white.png" alt="HostIt" />
          </div>
          <div className="lv-intro-rule" />
        </div>
      )}

      <header className="lv-nav">
        <div className="lv-wrap lv-nav-in">
          <a
            href="#top"
            onClick={(e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: "smooth" }); }}
            aria-label="Back to top"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="brand" src="/brand/logo-white.png" alt="HostIt" style={{ height: 26 }} />
          </a>
          <nav className="lv-nav-links">
            <a href="#problem" onClick={(e) => { e.preventDefault(); scrollToId("problem"); }}>Why HostIt</a>
            <a href="#solution" onClick={(e) => { e.preventDefault(); scrollToId("solution"); }}>Platform</a>
            <a href="#proof" onClick={(e) => { e.preventDefault(); scrollToId("proof"); }}>Proof</a>
          </nav>
          <div className="lv-nav-cta">
            <button className="lv-btn lv-btn-quiet" onClick={login}>Log in</button>
            <button className="lv-btn lv-btn-primary" onClick={host}>Host your event</button>
          </div>
        </div>
      </header>

      {/* HERO */}
      <section className="lv-hero" id="top">
        <div className="lv-hero-bg">
          <div className="lv-grid-lines" />
          <div className="lv-spot" />
        </div>
        <div className="lv-hero-vignette" />
        <div className="lv-wrap lv-hero-in">
          <div className="rv" style={{ marginBottom: "clamp(20px,3vw,40px)" }}>
            <span className="lv-eyebrow"><span className="bar" />All-in-one event platform</span>
          </div>
          <h1 className="lv-display" data-lines>
            <Lines lines={["Everything to run", "your event, in"]} />
            <span className="ln"><span className="ln-i" style={{ transitionDelay: ".24s" }}><em className="lv-accent" style={{ fontStyle: "italic" }}>one place.</em></span></span>
          </h1>
          <div className="lv-hero-foot">
            <div className="lv-hero-lede rv" style={{ transitionDelay: ".2s" }}>
              <span className="tick" />
              <p className="lv-body">Sell tickets, promote, and manage every detail from a single dashboard — escrow-backed payouts and POAP collectibles built in, on Sui.</p>
            </div>
            <div className="lv-hero-actions rv" style={{ transitionDelay: ".32s" }}>
              <button className="lv-btn lv-btn-primary lv-btn-lg" onClick={host}>Host your event<Icon icon="ic:round-arrow-forward" size={19} /></button>
              <button className="lv-btn lv-btn-ghost lv-btn-lg" onClick={demo}>See it in action</button>
            </div>
          </div>
        </div>
        <div className="lv-scrollcue" aria-hidden="true"><span>Scroll</span><span className="line" /></div>
      </section>

      {/* PROBLEM */}
      <section className="lv-section lv-problem" id="problem">
        <div className="lv-wrap">
          <span className="lv-eyebrow rv"><span className="bar" />The status quo is broken</span>
          <h2 className="lv-display" data-lines>
            <Lines lines={["Running an event means", "stitching together five"]} />
            <span className="ln"><span className="ln-i" style={{ transitionDelay: ".24s" }}><span className="muted-clause">tools that never talk.</span></span></span>
          </h2>
          <div className="lv-stats">
            <Stat n={5} suffix="+" label="tools the average organizer juggles to run a single event" cite="HostIt Organizer Survey · 2025" />
            <Stat n={23} suffix="%" label="of ticket revenue lost to fees, fraud and no-shows" cite="Live Events Benchmark · 2025" />
            <Stat n={11} suffix=" hrs" label="spent each week on admin instead of the event itself" cite="Organizer Time Study · 2025" />
          </div>
        </div>
      </section>

      {/* BRIDGE */}
      <section className="lv-bridge">
        <div className="lv-bridge-stick">
          <div className="lv-bridge-layer a">
            <div className="lv-bridge-tag" style={{ color: "var(--paper-faint)" }}>The old way</div>
            <h2 className="lv-display"><span className="strike">Five disconnected</span> tools.</h2>
          </div>
          <div className="lv-bridge-layer b" style={{ opacity: 0 }}>
            <div className="lv-bridge-tag lv-accent">The HostIt way</div>
            <h2 className="lv-display">One platform.</h2>
          </div>
          <div className="lv-bridge-count"><span className="lv-eyebrow" style={{ letterSpacing: ".2em" }}>Consolidating&nbsp;·&nbsp;<b>00</b>%</span></div>
        </div>
      </section>

      {/* SOLUTION */}
      <section className="lv-solution" id="solution">
        <div className="lv-sol-stick">
          <div className="lv-sol-top">
            <span className="lv-eyebrow"><span className="bar" />What HostIt does</span>
            <div className="lv-sol-progress">{[0, 1, 2].map((i) => <span key={i} className="seg"><i /></span>)}</div>
          </div>
          <div className="lv-sol-stage">
            <Beat n="01" tag="Sell" kind="ticket" word="Ticketing" on title="Sell tickets in minutes." body="Stand up a beautiful event page and start taking payments the same afternoon — no setup fee, no monthly cost." list={["Tiered & early-bird pricing", "QR tickets & verified transfers", "Escrow-backed payouts"]} />
            <Beat n="02" tag="Promote" kind="speaker" word="Reach" title="Fill every seat." body="Reach the people who buy — built-in email, codes and referral links, all measured against real sales." list={["Email campaigns & discount codes", "Referral and affiliate links", "A public page built to convert"]} />
            <Beat n="03" tag="Manage" kind="chart" word="Control" title="Run it from one screen." body="See every sale as it happens, move people through the door in seconds, and know exactly what worked." list={["Real-time sales dashboard", "Fast contactless door check-in", "On-chain post-event analytics"]} />
          </div>
        </div>
      </section>

      {/* PROOF */}
      <section className="lv-section" id="proof">
        <div className="lv-wrap">
          <span className="lv-eyebrow rv"><span className="bar" />Trusted at scale</span>
          <div className="lv-logos rv" style={{ marginTop: 30 }}>
            <span className="lbl">Powering events like</span>
            <div className="lv-logo-row">
              <span className="lv-logo lg-coachella">COACHELLA</span>
              <span className="lv-logo lg-devcon">devcon</span>
              <span className="lv-logo lg-fifa">FIFA</span>
              <span className="lv-logo lg-token">TOKEN<b>2049</b></span>
              <span className="lv-logo lg-basel">Art Basel</span>
              <span className="lv-logo lg-lagos"><i className="w3-mark" aria-hidden="true" />Web3Lagos</span>
            </div>
          </div>
          <div className="lv-metrics">
            <Metric n={240} prefix="$" suffix="M+" label="processed in ticket sales" />
            <Metric n={10000} comma suffix="+" label="active organizers" />
            <Metric n={1.8} decimals={1} suffix="M" label="tickets issued" />
            <Metric n={98} suffix="%" label="payouts released on time" />
          </div>
          <div className="lv-quote rv">
            <blockquote>Hosting Web3Lagos on HostIt was a <span className="lv-accent">smooth experience</span> — easy integrations, hands-on support, and great post-event data.</blockquote>
            <div className="lv-quote-by">
              <div className="av">AA</div>
              <div><div className="who">Awosika Ayodeji</div><div className="org">Founder, Web3bridge</div></div>
            </div>
          </div>
        </div>
      </section>

      {/* CLOSE */}
      <section className="lv-close">
        <div className="lv-hero-bg" style={{ inset: 0 }}><div className="lv-spot" /></div>
        <div className="lv-wrap lv-close-in">
          <span className="lv-eyebrow rv"><span className="bar" />Your event, your rules</span>
          <h2 className="lv-display" data-lines style={{ marginTop: 26 }}>
            <Lines lines={["Your next event", "starts the moment"]} />
            <span className="ln"><span className="ln-i" style={{ transitionDelay: ".24s" }}>you <em className="lv-accent" style={{ fontStyle: "italic" }}>press go.</em></span></span>
          </h2>
          <div className="lv-close-row rv" style={{ transitionDelay: ".18s" }}>
            <button className="lv-btn lv-btn-primary lv-btn-lg" onClick={host}>Host your event<Icon icon="ic:round-arrow-forward" size={19} /></button>
            <button className="lv-btn lv-btn-quiet lv-btn-lg" onClick={demo}>Explore events</button>
            <span className="lv-close-note">Free to start · No monthly fee · Escrow-backed</span>
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="lv-footer">
        <div className="lv-wrap lv-footer-top">
          <div className="lv-footer-brand">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/logo-white.png" alt="HostIt" style={{ height: 26 }} />
            <p>Everything to run your event, in one place. Sell, promote and manage — escrow-backed and on-chain ready.</p>
            <div className="lv-socials">
              {[["ri:twitter-x-fill", "X"], ["ri:linkedin-fill", "LinkedIn"], ["file-icons:telegram", "Telegram"], ["ri:github-fill", "GitHub"]].map(([ic, label]) => (
                <a key={label} className="lv-soc" aria-label={label} role="link" aria-disabled="true" tabIndex={-1} onClick={(e) => e.preventDefault()}><Icon icon={ic} size={18} /></a>
              ))}
            </div>
          </div>
          <div className="lv-footer-cols">
            <FooterCol
              h="Platform"
              links={[
                { label: "Overview", href: "#top" },
                { label: "Pricing", href: "#problem" },
                { label: "Check-in", href: "#solution" },
                { label: "Changelog" },
              ]}
            />
            <FooterCol
              h="Company"
              links={[{ label: "About" }, { label: "Careers" }, { label: "Contact" }]}
            />
            <FooterCol
              h="Legal"
              links={[{ label: "Terms" }, { label: "Privacy" }, { label: "Security" }, { label: "DMCA" }]}
            />
          </div>
        </div>
        <div className="lv-wrap lv-footer-bar">
          <span className="copy">© 2026 HostIt, Inc.</span>
          <span className="copy">Events made easy.</span>
        </div>
      </footer>
    </div>
  );
}

function scrollToId(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
}

function FooterCol({ h, links }: { h: string; links: { label: string; href?: string }[] }) {
  return (
    <div className="lv-footer-col">
      <div className="lv-footer-h">{h}</div>
      {links.map(({ label, href }) =>
        href && href.startsWith("#") && href.length > 1 ? (
          <a
            key={label}
            href={href}
            onClick={(e) => { e.preventDefault(); scrollToId(href.slice(1)); }}
          >
            {label}
          </a>
        ) : (
          <a
            key={label}
            href="#"
            aria-disabled="true"
            onClick={(e) => e.preventDefault()}
          >
            {label}
          </a>
        ),
      )}
    </div>
  );
}

function Lines({ lines }: { lines: string[] }) {
  return (
    <>
      {lines.map((t, i) => (
        <span className="ln" key={i}><span className="ln-i" style={{ transitionDelay: `${0.06 + i * 0.09}s` }}>{t}</span></span>
      ))}
    </>
  );
}

function Stat({ n, suffix, prefix, label, cite, decimals = 0, comma }: any) {
  return (
    <div className="lv-stat rv">
      <div className="lv-stat-num"><Counter n={n} decimals={decimals} comma={comma} prefix={prefix} />{suffix && <span className="suf">{suffix}</span>}</div>
      <div className="lv-stat-label">{label}</div>
      <div className="lv-stat-cite">{cite}</div>
    </div>
  );
}

function Metric({ n, suffix, prefix, label, decimals = 0, comma }: any) {
  return (
    <div className="lv-metric rv">
      <div className="lv-stat-num"><Counter n={n} decimals={decimals} comma={comma} prefix={prefix} />{suffix && <span className="suf">{suffix}</span>}</div>
      <div className="lv-stat-label">{label}</div>
    </div>
  );
}

function Counter({ n, decimals = 0, comma, prefix }: any) {
  const ref = useRef<HTMLSpanElement>(null);
  const [val, setVal] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) { setVal(n); return; }
    let raf = 0;
    let started = false;
    const ease = (t: number) => 1 - Math.pow(1 - t, 4);
    const run = () => {
      const dur = 1500;
      const t0 = performance.now();
      const step = (now: number) => {
        const p = Math.min(1, (now - t0) / dur);
        setVal(n * ease(p));
        if (p < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    };
    const io = new IntersectionObserver((e) => {
      if (e[0].isIntersecting && !started) { started = true; run(); io.disconnect(); }
    }, { threshold: 0.5 });
    io.observe(el);
    return () => { io.disconnect(); cancelAnimationFrame(raf); };
  }, [n]);
  const fmt = (v: number) => {
    let s = decimals ? v.toFixed(decimals) : String(Math.round(v));
    if (comma) s = Number(s).toLocaleString("en-US");
    return s;
  };
  return <span ref={ref}>{prefix || ""}{fmt(val)}</span>;
}

function Beat({ n, tag, title, body, list, kind, word, on }: any) {
  return (
    <article className={`lv-beat${on ? " on" : ""}`}>
      <div>
        <div className="lv-beat-n">{n} — {tag}</div>
        <h3 className="lv-display">{title}</h3>
        <p>{body}</p>
        <div className="lv-beat-list">{list.map((l: string) => <span key={l}>{l}</span>)}</div>
      </div>
      <div className="lv-beat-fig">
        <span className="word tl">{word}</span>
        <BeatFig kind={kind} word={word} />
        <span className="word br">{n}</span>
        <span className="accent-line" />
      </div>
    </article>
  );
}

function BeatFig({ kind, word }: { kind: string; word: string }) {
  if (kind === "speaker") {
    const rows = 7;
    const seats: { x: number; y: number; r: number }[] = [];
    for (let i = 0; i < rows; i++) {
      const radius = 13 + i * 12;
      const count = 5 + i * 2;
      const spread = 142;
      for (let j = 0; j < count; j++) {
        const t = count === 1 ? 0.5 : j / (count - 1);
        const ang = ((-spread / 2 + t * spread) * Math.PI) / 180;
        const x = 50 + radius * Math.sin(ang) * 0.58;
        const y = 88 - radius * Math.cos(ang) * 0.92;
        seats.push({ x, y, r: (i / (rows - 1)) * 0.86 });
      }
    }
    return (
      <div className="bt-reach" aria-hidden="true">
        <div className="bt-reach-rings"><span /><span /><span /></div>
        {seats.map((s, k) => (
          <i key={k} className="bt-seat" style={{ left: s.x + "%", top: s.y + "%", ["--r" as string]: s.r.toFixed(3) } as React.CSSProperties} />
        ))}
        <div className="bt-stage" />
      </div>
    );
  }
  if (kind === "chart") {
    return (
      <div className="bt-gauge" aria-hidden="true">
        <svg className="bt-gauge-svg" viewBox="0 0 220 220" fill="none">
          <circle cx="110" cy="110" r="96" stroke="rgba(236,235,227,.18)" strokeWidth="2" strokeDasharray="1.5 9" />
          <circle cx="110" cy="110" r="54" stroke="rgba(236,235,227,.1)" strokeWidth="1" />
          <circle cx="110" cy="110" r="30" stroke="rgba(236,235,227,.1)" strokeWidth="1" />
          <line x1="110" y1="30" x2="110" y2="190" stroke="rgba(236,235,227,.07)" strokeWidth="1" />
          <line x1="30" y1="110" x2="190" y2="110" stroke="rgba(236,235,227,.07)" strokeWidth="1" />
          <circle cx="110" cy="110" r="78" stroke="rgba(236,235,227,.12)" strokeWidth="8" />
          <circle className="bt-gauge-arc" cx="110" cy="110" r="78" style={{ stroke: "var(--accent)" }} strokeWidth="8" strokeLinecap="round" transform="rotate(-90 110 110)" />
          <line className="bt-gauge-radar" x1="110" y1="110" x2="110" y2="36" style={{ stroke: "var(--accent)" }} strokeWidth="2" />
          <g className="bt-gauge-needle"><circle cx="110" cy="32" r="6" style={{ fill: "var(--accent)" }} /></g>
          <circle cx="110" cy="110" r="13" style={{ stroke: "var(--accent)" }} strokeWidth="1.5" opacity="0.4" />
          <circle cx="110" cy="110" r="7" style={{ fill: "var(--accent)" }} />
        </svg>
      </div>
    );
  }
  const barsW = [2, 1, 3, 1, 2, 1, 1, 3, 2, 1, 2, 4, 1, 1, 2, 1, 3, 1, 2, 2, 1, 3, 1, 2, 1, 2];
  const qr = Array.from({ length: 36 }, (_, i) => (i * 7 + (i % 5) + Math.floor(i / 6) * 3) % 3 === 0);
  return (
    <div className="bt-ticket" aria-hidden="true">
      <div className="bt-main">
        <div className="bt-admit">ADMIT ONE</div>
        <div className="bt-brand">HostIt</div>
        <div className="bt-line1">{word}</div>
        <div className="bt-barcode">{barsW.map((w, i) => <i key={i} style={{ width: w + "px" }} />)}</div>
      </div>
      <div className="bt-perf"><span /><span /></div>
      <div className="bt-stub">
        <div className="bt-qr">{qr.map((c, i) => <i key={i} className={c ? "on" : ""} />)}</div>
        <div className="bt-scan" />
      </div>
    </div>
  );
}
