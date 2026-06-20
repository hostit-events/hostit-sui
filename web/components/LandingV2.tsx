"use client";

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Icon } from "./Icon";
import { Button } from "@/components/ui/button";

/* eslint-disable @typescript-eslint/no-explicit-any */

// Resets on a full page reload (so the intro replays on every hard load, like
// the design); persists across SPA navigations so it doesn't replay on each
// client route change.
let introPlayed = false;

export function LandingV2() {
  const router = useRouter();
  const rootRef = useRef<HTMLDivElement>(null);
  const host = () => router.push("/create");
  const demo = () => router.push("/discover");
  // "Open app" → the public app home (discover). It's the route group's public
  // landing, so it's what "open the app" naturally means for a visitor.
  const openApp = () => router.push("/discover");

  // Mobile section-links menu (the inline `.lv-nav-links` are hidden under 880px).
  const [menuOpen, setMenuOpen] = useState(false);
  const menuToggleRef = useRef<HTMLButtonElement>(null);
  const menuPanelRef = useRef<HTMLDivElement>(null);

  // Close the mobile menu on Escape; move focus into the panel when it opens and
  // back to the toggle when it closes.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const firstLink = menuPanelRef.current?.querySelector<HTMLElement>("a, button");
    firstLink?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  const closeMenu = () => {
    setMenuOpen(false);
    menuToggleRef.current?.focus();
  };
  const goSection = (id: string) => {
    setMenuOpen(false);
    scrollToId(id);
  };

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
            <Button variant="ghost" className="lv-btn lv-btn-primary h-auto" onClick={openApp}>Open app</Button>
            <button
              ref={menuToggleRef}
              type="button"
              className="lv-nav-burger"
              aria-label={menuOpen ? "Close menu" : "Open menu"}
              aria-expanded={menuOpen}
              aria-controls="lv-nav-menu"
              onClick={() => setMenuOpen((v) => !v)}
            >
              <Icon icon={menuOpen ? "ic:round-close" : "ic:round-menu"} size={24} />
            </button>
          </div>
        </div>
      </header>

      {/* MOBILE MENU — section links + Open app, shown where inline links hide */}
      <div
        className={`lv-nav-sheet${menuOpen ? " open" : ""}`}
        hidden={!menuOpen}
      >
        <button
          type="button"
          className="lv-nav-scrim"
          aria-label="Close menu"
          tabIndex={-1}
          onClick={closeMenu}
        />
        <div
          id="lv-nav-menu"
          ref={menuPanelRef}
          className="lv-nav-menu"
          role="dialog"
          aria-modal="true"
          aria-label="Navigation"
        >
          <a href="#problem" onClick={(e) => { e.preventDefault(); goSection("problem"); }}>Why HostIt</a>
          <a href="#solution" onClick={(e) => { e.preventDefault(); goSection("solution"); }}>Platform</a>
          <a href="#proof" onClick={(e) => { e.preventDefault(); goSection("proof"); }}>Proof</a>
          <Button
            variant="ghost"
            className="lv-btn lv-btn-primary lv-nav-menu-cta h-auto"
            onClick={() => { setMenuOpen(false); openApp(); }}
          >
            Open app<Icon icon="ic:round-arrow-forward" size={19} />
          </Button>
        </div>
      </div>

      {/* HERO */}
      <section className="lv-hero" id="top">
        <div className="lv-hero-bg">
          <div className="lv-grid-lines" />
          <div className="lv-spot" />
        </div>
        <div className="lv-hero-vignette" />
        <div className="lv-wrap lv-hero-in">
          <div className="rv" style={{ marginBottom: "clamp(20px,3vw,40px)" }}>
            <span className="lv-eyebrow"><span className="bar" />Permissionless event ticketing · on Sui</span>
          </div>
          <h1 className="lv-display" data-lines>
            <Lines lines={["Sell out, pay out,", "and bet on it —"]} />
            <span className="ln"><span className="ln-i" style={{ transitionDelay: ".24s" }}><em className="lv-accent" style={{ fontStyle: "italic" }}>on-chain.</em></span></span>
          </h1>
          <div className="lv-hero-foot">
            <div className="lv-hero-lede rv" style={{ transitionDelay: ".2s" }}>
              <span className="lv-perf-tick" aria-hidden="true"><i /></span>
              <p className="lv-body">Any wallet can host. Tickets sell in any coin, gasless; payouts withdraw straight from on-chain escrow — no platform skim, no takedowns. Then a parimutuel market settles itself on the final count: no oracle, no house. Proven on EVM, now native on Sui.</p>
            </div>
            <div className="lv-hero-actions rv" style={{ transitionDelay: ".32s" }}>
              <Button variant="ghost" className="lv-btn lv-btn-primary lv-btn-lg h-auto" onClick={host}>Host your event<Icon icon="ic:round-arrow-forward" size={19} /></Button>
              <Button variant="ghost" className="lv-btn lv-btn-ghost lv-btn-lg h-auto hover:bg-transparent" onClick={demo}>See it in action</Button>
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
            <Stat n={5} suffix="+" label="tools the average organizer juggles to run a single event" cite="Industry estimate" />
            <Stat n={23} suffix="%" label="of ticket revenue lost to fees, fraud and no-shows" cite="Industry estimate" />
            <Stat n={11} suffix=" hrs" label="spent each week on admin instead of the event itself" cite="Industry estimate" />
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
            <div className="lv-sol-progress">{[0, 1, 2, 3].map((i) => <span key={i} className="seg"><i /></span>)}</div>
          </div>
          <div className="lv-sol-stage">
            <Beat n="01" tag="Host" kind="ticket" word="Hosting" on title="Anyone can host." body="No application, no gatekeeper. Connect a wallet, publish in four steps, and start selling the same afternoon — gas sponsored, so buyers never touch a faucet." list={["Permissionless — any wallet hosts", "Gasless checkout, sponsored on Sui", "Any coin: SUI, USDC and more", "Escrow-backed on-chain payouts"]} />
            <Beat n="02" tag="Predict" kind="chart" word="Markets" title="Bet on the sellout." body="Every event opens native prediction markets — will it sell out, and how many seats go? They settle trustlessly from the contract's real ticket count. No oracle, no house, no fee. Impossible on a Web2 ticketing platform." list={["Parimutuel sellout & range markets", "Settles on the event's real mint count", "No oracle, no house, no cut"]} />
            <Beat n="03" tag="Run" kind="door" word="Door" title="Run the day live." body="Watch sales land in real time, let attendees self-check-in gasless at the door, and turn every check-in into a collectible they keep." list={["Real-time sales dashboard", "Gasless self check-in at the door", "POAP collectibles after check-in"]} />
            <Beat n="04" tag="Reach" kind="speaker" word="Reach" roadmap title="Fill every seat." body="Next: reach the people who actually buy. Built-in email, discount codes and referral links — every send measured against on-chain sales." list={["Email campaigns & discount codes", "Referral & affiliate links", "A public page built to convert"]} />
          </div>
        </div>
      </section>

      {/* PROOF */}
      <section className="lv-section" id="proof">
        <div className="lv-wrap">
          <div className="lv-perf-rule" data-ground="ink" aria-hidden="true"><span className="lv-perf-notch s" /><span className="lv-perf-notch e" /></div>
          <span className="lv-eyebrow rv"><span className="bar" />Proven in the wild</span>
          <div className="lv-logos rv" style={{ marginTop: 30 }}>
            <span className="lbl">Powering events like</span>
            <div className="lv-logo-row">
              <span className="lv-logo lg-evt"><i className="w3-mark" aria-hidden="true" />Web3Lagos</span>
              <span className="lv-logo lg-evt">Borderless</span>
              <span className="lv-logo lg-evt">Anambra Web3</span>
              <span className="lv-logo lg-evt">Blockchain @ Unilag</span>
              <span className="lv-logo lg-evt">ProdFest</span>
              <span className="lv-logo lg-evt">Fuel Africa</span>
            </div>
          </div>
          <p className="lv-logo-aspire rv">We&apos;re building for the scale of a Coachella or a FIFA World Cup — earning it one real event at a time, starting with the gatherings shaping Web3 today.</p>
          <div className="lv-moat rv">
            <span className="lv-moat-item"><span className="bar" /><b>The moat</b> — sellout markets that settle on real ticket sales, on-chain. <span className="lv-accent">Impossible on a Web2 stack.</span></span>
            <span className="lv-moat-item"><span className="bar" /><b>The track record</b> — the HostIt brand and crew that filled ~50K seats on EVM, now native on Sui.</span>
          </div>
          <div className="lv-metrics">
            <Metric n={50} suffix="K+" label="attendees welcomed across our events" />
            <Metric n={6} label="flagship events powered" />
            <div className="lv-metric rv">
              <div className="lv-stat-num">Gasless</div>
              <div className="lv-stat-label">tickets &amp; check-in, sponsored on Sui</div>
            </div>
            <div className="lv-metric rv">
              <div className="lv-stat-num">Escrow</div>
              <div className="lv-stat-label">every payout backed on-chain</div>
            </div>
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
          <div className="lv-stub-band rv" style={{ transitionDelay: ".18s" }}>
            <div className="lv-stub-main">
              <Button variant="ghost" className="lv-btn lv-btn-primary lv-btn-lg h-auto" onClick={host}>Host your event<Icon icon="ic:round-arrow-forward" size={19} /></Button>
              <Button variant="ghost" className="lv-btn lv-btn-quiet lv-btn-lg h-auto hover:bg-transparent" onClick={demo}>Explore events</Button>
            </div>
            <div className="lv-stub-perf" aria-hidden="true"><span className="lv-perf-notch s" /><span className="lv-perf-notch e" /></div>
            <div className="lv-stub-tail">
              <span className="lv-close-note"><b className="lv-close-rate">3%</b> per ticket sold — that&rsquo;s it. No setup, no monthly, gas on us.</span>
            </div>
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="lv-footer">
        <div className="lv-wrap lv-footer-top">
          <div className="lv-footer-brand">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/logo-white.png" alt="HostIt" style={{ height: 26 }} />
            <p>Permissionless event ticketing on Sui — sell in any coin, settle in native prediction markets, pay out from on-chain escrow.</p>
            <div className="lv-socials">
              {[
                ["ri:twitter-x-fill", "X", "https://x.com/hostit_events"],
                ["ri:linkedin-fill", "LinkedIn", "https://www.linkedin.com/company/hostit-events"],
                ["file-icons:telegram", "Telegram", "https://t.me/hostitevents"],
                ["ri:github-fill", "GitHub", "https://github.com/hostit-events"],
              ].map(([ic, label, href]) => (
                <a key={label} className="lv-soc" aria-label={label} href={href} target="_blank" rel="noopener noreferrer"><Icon icon={ic} size={18} /></a>
              ))}
            </div>
          </div>
          <div className="lv-footer-cols">
            <FooterCol
              h="Platform"
              links={[
                { label: "Overview", href: "#top" },
                { label: "Why HostIt", href: "#problem" },
                { label: "Platform", href: "#solution" },
                { label: "Proof", href: "#proof" },
              ]}
            />
            <FooterCol
              h="Product"
              links={[
                { label: "Discover events", href: "/discover" },
                { label: "Host an event", href: "/create" },
                { label: "My tickets", href: "/wallet" },
                { label: "Dashboard", href: "/dashboard" },
              ]}
            />
            <FooterCol
              h="Connect"
              links={[
                { label: "GitHub", href: "https://github.com/hostit-events" },
                { label: "X (Twitter)", href: "https://x.com/hostit_events" },
                { label: "Telegram", href: "https://t.me/hostitevents" },
                { label: "LinkedIn", href: "https://www.linkedin.com/company/hostit-events" },
              ]}
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

function FooterCol({ h, links }: { h: string; links: { label: string; href: string }[] }) {
  return (
    <div className="lv-footer-col">
      <div className="lv-footer-h">{h}</div>
      {links.map(({ label, href }) => {
        // In-page section → smooth scroll.
        if (href.startsWith("#")) {
          return (
            <a
              key={label}
              href={href}
              onClick={(e) => { e.preventDefault(); scrollToId(href.slice(1)); }}
            >
              {label}
            </a>
          );
        }
        // External (socials, repo) → new tab.
        if (href.startsWith("http")) {
          return (
            <a key={label} href={href} target="_blank" rel="noopener noreferrer">
              {label}
            </a>
          );
        }
        // Internal app route → client navigation.
        return (
          <Link key={label} href={href}>
            {label}
          </Link>
        );
      })}
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

function Beat({ n, tag, title, body, list, kind, word, on, roadmap }: any) {
  return (
    <article className={`lv-beat${on ? " on" : ""}`}>
      <div>
        <div className="lv-beat-n">{n} — {tag}{roadmap && <span className="lv-beat-tag">On the roadmap</span>}</div>
        <h3 className="lv-display">{title}</h3>
        <p>{body}</p>
        <div className={`lv-beat-list${roadmap ? " soon" : ""}`}>{list.map((l: string) => <span key={l}>{l}</span>)}</div>
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
  if (kind === "door") {
    // Door check-in pulse: a portal that "admits" as --tk rises — the check
    // draws in, the centre dot resolves, and pulse rings ripple out. Same
    // hand-built, accent-only, --tk-driven language as the gauge/amphitheater.
    // Decorative: depicts gasless SELF check-in (no staff scanner is claimed).
    return (
      <div className="bt-door" aria-hidden="true">
        <div className="bt-door-rings"><span /><span /><span /></div>
        <svg className="bt-door-svg" viewBox="0 0 200 220" fill="none">
          <rect className="bt-door-frame" x="58" y="36" width="84" height="148" rx="6" stroke="rgba(236,235,227,.18)" strokeWidth="2" />
          <line x1="100" y1="36" x2="100" y2="184" stroke="rgba(236,235,227,.1)" strokeWidth="1" />
          <path className="bt-door-check" d="M76 112 L94 132 L128 90" style={{ stroke: "var(--accent)" }} strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
          <circle className="bt-door-dot" cx="100" cy="112" r="7" style={{ fill: "var(--accent)" }} />
        </svg>
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
