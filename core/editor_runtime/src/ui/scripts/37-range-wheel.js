(() => {
  document.addEventListener("wheel", (event) => {
    const range = event.target instanceof Element
      ? event.target.closest('input[type="range"]')
      : null;
    if (!range || range.disabled) return;

    const delta = Number(event.deltaX || event.deltaY || 0);
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();

    const min = Number.isFinite(Number(range.min)) ? Number(range.min) : 0;
    const max = Number.isFinite(Number(range.max)) ? Number(range.max) : 100;
    const step = range.step === "any" ? Math.max((max - min) / 100, 0.01) : Number(range.step || 1);
    const next = Math.max(min, Math.min(max, Number(range.value) - Math.sign(delta) * step));
    if (next === Number(range.value)) return;
    range.value = String(next);
    range.dispatchEvent(new Event("input", { bubbles: true }));
    range.dispatchEvent(new Event("change", { bubbles: true }));
  }, { capture: true, passive: false });
})();
