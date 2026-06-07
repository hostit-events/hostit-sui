"use client";

import { useEffect, useRef } from "react";

/**
 * HostIt custom cursor. Desktop / fine-pointer only. Default mode is "hostit":
 * a blue triangle pointer that lerp-follows the mouse and grows on hover (native
 * cursor hidden). The triangle was inspired by ApeChain's cursor but is its own
 * shape. Modes magnetic / halo / off are supported via `<html data-cursor>`.
 */
export function CustomCursor() {
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mqOK = window.matchMedia && window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    if (!mqOK) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const root = document.documentElement;
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ring = wrap.querySelector<HTMLElement>(".cursorx-ring")!;
    const dot = wrap.querySelector<HTMLElement>(".cursorx-dot")!;
    const tri = wrap.querySelector<HTMLElement>(".cursorx-tri")!;
    const label = wrap.querySelector<HTMLElement>(".cursorx-label")!;
    if (!root.dataset.cursor) root.dataset.cursor = "hostit";

    const HOVER =
      "a,button,[role=button],summary,label[for],.chip,.switch,.seg button," +
      ".nav-item,.topnav-item,.set-nav-item,.fo-chan,.pick,.ev-card,.ev-feat,.ev-row,.ci-pick,.dash-ev," +
      ".ticket,.poap,.mtab,.icon-btn,.qty button,.acct,.lv-btn,.lv-soc,.lv-nav-links a,.btn," +
      ".disc-cta,.ev-community,.pay-method,.team-row,.tier,.toggle-card,.fo-send,.fo-attach-btn,[onclick]";
    const TEXT =
      "input:not([type=range]):not([type=checkbox]):not([type=radio]),textarea,[contenteditable=true],[contenteditable='']";

    let mx = innerWidth / 2,
      my = innerHeight / 2,
      pmx = mx,
      pmy = my;
    let rx = mx,
      ry = my,
      dx = mx,
      dy = my,
      tx2 = mx,
      ty2 = my;
    let rw = 34,
      rh = 34,
      rr = 17;
    let down = 0,
      shown = false,
      hoverEl: Element | null = null,
      isText = false;
    let mode = "hostit";
    let raf = 0;

    function applyMode() {
      const off = mode === "off";
      root.classList.toggle("cursor-on", !off);
      wrap!.style.display = off ? "none" : "block";
      const triMode = mode === "hostit";
      ring.style.display = triMode ? "none" : "block";
      dot.style.display = triMode ? "none" : "block";
      tri.style.display = triMode ? "block" : "none";
      if (!triMode) label.style.opacity = "0";
    }

    function onMove(e: MouseEvent) {
      mx = e.clientX;
      my = e.clientY;
      if (!shown) {
        shown = true;
        wrap!.style.opacity = "1";
      }
      const t = e.target as Element | null;
      if (t && t.closest) {
        if (t.closest(TEXT)) {
          isText = true;
          hoverEl = null;
        } else {
          isText = false;
          hoverEl = t.closest(HOVER);
        }
      }
      wrap!.classList.toggle("is-hover", !!hoverEl);
      wrap!.classList.toggle("is-text", isText);
    }
    const onDown = () => wrap!.classList.add("is-down");
    const onUp = () => wrap!.classList.remove("is-down");
    const onLeave = () => {
      shown = false;
      wrap!.style.opacity = "0";
    };

    addEventListener("mousemove", onMove, { passive: true });
    addEventListener("mousedown", onDown, { passive: true });
    addEventListener("mouseup", onUp, { passive: true });
    document.addEventListener("mouseleave", onLeave);
    addEventListener("blur", onLeave);

    const lerp = (a: number, b: number, f: number) => a + (b - a) * f;
    const radiusOf = (el: Element) => {
      const v = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
      return Math.max(6, Math.min(22, v || 12));
    };

    function tick() {
      const m = root.dataset.cursor || "hostit";
      if (m !== mode) {
        mode = m;
        applyMode();
      }
      if (mode === "off") {
        raf = requestAnimationFrame(tick);
        return;
      }

      if (mode === "hostit") {
        const f = reduce ? 0.55 : 0.32;
        tx2 = lerp(tx2, mx, f);
        ty2 = lerp(ty2, my, f);
        const aScale = lerp(parseFloat(tri.dataset.s || "1"), hoverEl ? 1.5 : 1, 0.25);
        tri.dataset.s = String(aScale);
        tri.style.transform = `translate(${tx2 - 4}px,${ty2 - 3}px) scale(${aScale})`;
        label.style.opacity = "0";
        raf = requestAnimationFrame(tick);
        return;
      }

      let follow = reduce ? 0.5 : 0.22;
      const dotFollow = reduce ? 0.9 : 0.6;
      down = lerp(down, wrap!.classList.contains("is-down") ? 1 : 0, 0.3);
      const vx = mx - pmx,
        vy = my - pmy;
      pmx = mx;
      pmy = my;
      const speed = Math.min(Math.hypot(vx, vy), 90);

      let tw: number, th: number, trr: number, tx: number, ty: number;
      let sx = 1,
        sy = 1,
        ang = 0;
      const magnetic = mode === "magnetic";
      const hb = magnetic && hoverEl && (hoverEl as HTMLElement).isConnected ? hoverEl.getBoundingClientRect() : null;
      const boxed = !!hb && hb.width >= 1 && hb.width <= innerWidth;
      if (magnetic && hoverEl && !(hoverEl as HTMLElement).isConnected) hoverEl = null;

      if (boxed && hb) {
        const pad = 6;
        tw = hb.width + pad * 2;
        th = hb.height + pad * 2;
        trr = radiusOf(hoverEl!) + pad;
        tx = hb.left + hb.width / 2;
        ty = hb.top + hb.height / 2;
        follow = reduce ? 0.6 : 0.3;
      } else if (isText) {
        tw = 3;
        th = 24;
        trr = 2;
        tx = mx;
        ty = my;
      } else if (!magnetic && hoverEl && (hoverEl as HTMLElement).isConnected) {
        tw = 52;
        th = 52;
        trr = 26;
        tx = mx;
        ty = my;
      } else {
        tw = 34;
        th = 34;
        trr = 17;
        tx = mx;
        ty = my;
        if (!reduce && speed > 1) {
          const k = Math.min(speed / 180, 0.34);
          sx = 1 + k;
          sy = 1 - k * 0.65;
          ang = (Math.atan2(vy, vx) * 180) / Math.PI;
        }
      }

      const press = 1 - down * (boxed ? 0.04 : 0.22);
      rx = lerp(rx, tx, follow);
      ry = lerp(ry, ty, follow);
      rw = lerp(rw, tw, follow + 0.05);
      rh = lerp(rh, th, follow + 0.05);
      rr = lerp(rr, trr, follow + 0.05);
      dx = lerp(dx, mx, dotFollow);
      dy = lerp(dy, my, dotFollow);

      ring.style.width = rw + "px";
      ring.style.height = rh + "px";
      ring.style.borderRadius = rr + "px";
      ring.style.transform = `translate(${rx - rw / 2}px,${ry - rh / 2}px) rotate(${ang}deg) scale(${sx * press},${sy * press})`;

      const haloHover = !magnetic && hoverEl && (hoverEl as HTMLElement).isConnected;
      dot.style.opacity = isText || haloHover ? "0" : "1";
      dot.style.transform = `translate(${dx - 3}px,${dy - 3}px)`;
      raf = requestAnimationFrame(tick);
    }

    applyMode();
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      removeEventListener("mousemove", onMove);
      removeEventListener("mousedown", onDown);
      removeEventListener("mouseup", onUp);
      document.removeEventListener("mouseleave", onLeave);
      removeEventListener("blur", onLeave);
      root.classList.remove("cursor-on");
    };
  }, []);

  return (
    <div className="cursorx" ref={wrapRef} aria-hidden="true">
      <div className="cursorx-ring" />
      <div className="cursorx-dot" />
      <div className="cursorx-tri">
        <svg viewBox="0 0 24 26" width="23" height="25">
          <path d="M4 3 L20.5 12.5 L11 13.6 L7.5 22 Z" />
        </svg>
      </div>
      <div className="cursorx-label" />
    </div>
  );
}
