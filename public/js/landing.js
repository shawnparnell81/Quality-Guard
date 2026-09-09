/* ============================================================
   Landing page interactions: nav shadow, reveal-on-scroll, and the
   animated stat counters.

   Lifted out of an inline <script> in landing.html so the app can
   ship an enforcing Content-Security-Policy with script-src 'self'
   (audit fix C2). Behaviour is unchanged.
   ============================================================ */

/* ---------- nav shadow on scroll ---------- */
const nav = document.getElementById("nav");
addEventListener(
    "scroll",
    () => nav.classList.toggle("scrolled", scrollY > 8),
    { passive: true },
);

/* ---------- reveal on scroll ---------- */
const prefersReduced = matchMedia(
    "(prefers-reduced-motion: reduce)",
).matches;

if (!prefersReduced) {
    const io = new IntersectionObserver(
        (entries) => {
            for (const entry of entries) {
                if (entry.isIntersecting) {
                    entry.target.classList.add("in-view");
                    io.unobserve(entry.target);
                }
            }
        },
        { threshold: 0.15 },
    );

    document.querySelectorAll(".reveal").forEach((el) => io.observe(el));
} else {
    document
        .querySelectorAll(".reveal")
        .forEach((el) => el.classList.add("in-view"));
}

/* ---------- animated stat counters ---------- */
function animateCount(el) {
    const target = Number(el.dataset.count);
    if (prefersReduced || !target) {
        el.textContent = target;
        return;
    }

    const duration = 900;
    const start = performance.now();

    function tick(now) {
        const progress = Math.min((now - start) / duration, 1);
        el.textContent = Math.round(target * (1 - Math.pow(1 - progress, 3)));
        if (progress < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
}

const statIo = new IntersectionObserver(
    (entries) => {
        for (const entry of entries) {
            if (entry.isIntersecting) {
                animateCount(entry.target);
                statIo.unobserve(entry.target);
            }
        }
    },
    { threshold: 0.4 },
);

document.querySelectorAll(".stat .n").forEach((el) => statIo.observe(el));
