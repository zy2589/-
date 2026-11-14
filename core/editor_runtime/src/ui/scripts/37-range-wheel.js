(() => {
  document.addEventListener("wheel", (event) => {
    const range = event.target instanceof Element
      ? event.target.closest('input[type="range"]')
      : null;
    if (!range || range.disabled) return;

    if (!Number(event.deltaX || event.deltaY || 0)) return;
    event.preventDefault();
    event.stopPropagation();
  }, { capture: true, passive: false });

  // Native range inputs jump to the clicked position. For precision controls,
  // only start a drag when the pointer is on the thumb; accidental clicks on
  // the track should not change a property.
  document.addEventListener("pointerdown", (event) => {
    const range = event.target instanceof Element
      ? event.target.closest('input[type="range"]')
      : null;
    if (!range || range.disabled || event.button !== 0) return;
    const rect = range.getBoundingClientRect();
    if (!rect.width) return;
    const min = Number.isFinite(Number(range.min)) ? Number(range.min) : 0;
    const max = Number.isFinite(Number(range.max)) ? Number(range.max) : 100;
    const value = Number(range.value);
    const ratio = max > min ? Math.max(0, Math.min(1, (value - min) / (max - min))) : 0.5;
    const thumbWidth = 12;
    const thumbCenter = rect.left + thumbWidth / 2 + ratio * Math.max(0, rect.width - thumbWidth);
    if (Math.abs(event.clientX - thumbCenter) > thumbWidth * 0.72) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, { capture: true });
})();
