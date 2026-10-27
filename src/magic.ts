/** A quiet "something is being made" scene over the stage: soft layered light that drifts and breathes. */
export interface Magic { show(msg: string, opts?: { colours?: string[]; stop?: () => void; long?: boolean }): void; hide(): void }

const DEFAULT = ['#f2b880', '#e0607e', '#9b5de5', '#5aa9e6', '#7ee0c3'];

export function createMagic(stage: HTMLElement): Magic {
  const el = document.createElement('div');
  el.className = 'gmagic'; el.hidden = true; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
  const cv = document.createElement('canvas'); cv.setAttribute('aria-hidden', 'true');
  const box = document.createElement('div'); box.className = 'gmagicbox';
  const title = document.createElement('b');
  const time = document.createElement('span'); time.className = 'gmagict';
  const hint = document.createElement('small');
  const stopBtn = document.createElement('button'); stopBtn.className = 'btn small gmagicstop'; stopBtn.type = 'button'; stopBtn.textContent = 'Stop';
  box.append(title, time, hint, stopBtn); el.append(cv, box); stage.append(el);

  const still = matchMedia('(prefers-reduced-motion: reduce)');
  let raf = 0, tick = 0, t0 = 0, cols = DEFAULT, onStop: (() => void) | undefined, long = true;
  const motes = Array.from({ length: 46 }, () => ({ x: Math.random(), y: Math.random(), r: 0.6 + Math.random() * 1.8, v: 0.02 + Math.random() * 0.05, p: Math.random() * 6.28 }));
  stopBtn.onclick = () => onStop?.();

  function frame(now: number) {
    const t = (now - t0) / 1000, w = el.clientWidth, hgt = el.clientHeight, dpr = Math.min(2, devicePixelRatio || 1);
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(hgt * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(hgt * dpr); }
    const g = cv.getContext('2d')!; g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, hgt);
    const cx = w / 2, cy = hgt / 2, R = Math.min(w, hgt) * 0.34;
    g.globalCompositeOperation = 'lighter';
    // stacked translucent sheets, each a slowly morphing outline: like layers finding their shape
    cols.forEach((c, k) => {
      const n = cols.length, f = 1 - k / (n + 1), spin = t * (0.05 + k * 0.012) * (k % 2 ? -1 : 1);
      g.beginPath();
      for (let i = 0; i <= 96; i++) {
        const a = (i / 96) * Math.PI * 2;
        const wob = 1 + 0.07 * Math.sin(a * 3 + spin * 4 + k) + 0.05 * Math.sin(a * 5 - t * 0.7 + k * 2) + 0.03 * Math.sin(t * 0.9 + k);
        const r = R * f * wob, x = cx + Math.cos(a + spin) * r, y = cy + Math.sin(a + spin) * r * 0.92;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      const grad = g.createRadialGradient(cx, cy, R * f * 0.2, cx, cy, R * f * 1.1);
      grad.addColorStop(0, c + '00'); grad.addColorStop(1, c + '3a');
      g.fillStyle = grad; g.fill();
      g.strokeStyle = c + '70'; g.lineWidth = 1.2; g.shadowColor = c; g.shadowBlur = 14; g.stroke(); g.shadowBlur = 0;
    });
    // drifting motes of light
    for (const m of motes) {
      const y = ((m.y - t * m.v) % 1 + 1) % 1, x = m.x + 0.02 * Math.sin(t * 0.6 + m.p);
      const a = 0.25 + 0.35 * Math.sin(t * 1.3 + m.p) ** 2;
      g.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`; g.beginPath(); g.arc(x * w, y * hgt, m.r, 0, 6.283); g.fill();
    }
    g.globalCompositeOperation = 'source-over';
    if (!still.matches) raf = requestAnimationFrame(frame);
  }
  function clock() {
    const s = Math.floor((performance.now() - t0) / 1000);
    time.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    if (long) hint.textContent = s < 75 ? 'Usually 20 to 60 seconds. Keep this tab open.'
      : s < 180 ? 'Taking longer than usual. You can wait, or stop and change your words.'
      : 'Still waiting on the node. It gives up at 4 minutes; stop any time.';
  }
  return {
    show(msg, o = {}) {
      const fresh = el.hidden;
      title.textContent = msg; cols = (o.colours?.length ? o.colours : DEFAULT).slice(0, 7).map((c) => (/^#[0-9a-f]{6}$/i.test(c) ? c : '#9b5de5'));
      onStop = o.stop; stopBtn.hidden = !o.stop; long = o.long ?? true; if (!long) hint.textContent = '';
      el.hidden = false; document.body.classList.add('gmagicon');
      if (fresh) { t0 = performance.now(); cancelAnimationFrame(raf); raf = requestAnimationFrame(frame); clearInterval(tick); tick = window.setInterval(clock, 500); clock(); }
    },
    hide() { el.hidden = true; document.body.classList.remove('gmagicon'); cancelAnimationFrame(raf); clearInterval(tick); onStop = undefined; },
  };
}
