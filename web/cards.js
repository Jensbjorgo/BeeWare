// Pointer tilt inspired by kennyotsu on Uiverse.io.
const feed = document.querySelector("#feed");
const tiltEnabled = matchMedia("(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)");
let activeCard = null;
let frame = null;
let pointerX = 0;
let pointerY = 0;

function resetTilt() {
  cancelAnimationFrame(frame);
  frame = null;
  activeCard?.classList.remove("is-tilting");
  activeCard = null;
}

// Delegation also covers cards replaced by polling or a confirmation.
feed.addEventListener("pointermove", (event) => {
  if (!tiltEnabled.matches || event.pointerType !== "mouse") return;
  const card = event.target.closest(".feed-card");
  if (card !== activeCard) {
    resetTilt();
    activeCard = card;
  }
  if (!activeCard) return;
  pointerX = event.clientX;
  pointerY = event.clientY;
  if (frame !== null) return;

  frame = requestAnimationFrame(() => {
    frame = null;
    const bounds = activeCard.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (pointerX - bounds.left) / bounds.width));
    const y = Math.max(0, Math.min(1, (pointerY - bounds.top) / bounds.height));
    activeCard.style.setProperty("--tilt-x", `${(0.5 - y) * 20}deg`);
    activeCard.style.setProperty("--tilt-y", `${(x - 0.5) * 16}deg`);
    activeCard.style.setProperty("--glow-x", `${x * 100}%`);
    activeCard.style.setProperty("--glow-y", `${y * 100}%`);
    activeCard.classList.add("is-tilting");
  });
});

feed.addEventListener("pointerleave", resetTilt);
feed.addEventListener("pointercancel", resetTilt);
document.querySelector("#sidePanel").addEventListener("scroll", resetTilt, { passive: true });
tiltEnabled.addEventListener("change", resetTilt);
