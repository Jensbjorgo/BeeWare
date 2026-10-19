const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

document.querySelectorAll(".form-field").forEach((field) => {
  const control = field.querySelector("input, textarea");
  const animation = field.querySelector("animate");

  control.addEventListener("focus", () => {
    if (!reducedMotion.matches) animation.beginElement();
  });
});
