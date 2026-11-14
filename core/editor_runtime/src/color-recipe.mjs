const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value || 0)));

export function previewColorRecipe(color = {}) {
  const slices = Object.values(color.slices || {});
  const average = (key) => slices.reduce((sum, item) => sum + Number(item?.[key] || 0), 0) / 7;
  const sliceHue = average("hue"), sliceSaturation = average("saturation"), sliceIntensity = average("intensity");
  return {
    brightness: Math.max(.1, 1 + (Number(color.exposure || 0) + Number(color.lift || 0) * .24 + Number(color.gain || 0) * .3 + Number(color.gamma || 0) * .35 + Number(color.shadows || 0) * .13 + Number(color.highlights || 0) * .11 + Number(color.blacks || 0) * .08 + Number(color.whites || 0) * .1 + Number(color.pivot || 0) * -.08 + sliceIntensity * .35) / 78),
    contrast: Math.max(.1, 1 + (Number(color.contrast || 0) + Number(color.midtoneDetail || 0) * .42 + Number(color.sharpness || 0) * .08 - Number(color.fade || 0) * .48 + Number(color.gain || 0) * .12 - Number(color.lift || 0) * .12) / 72),
    saturation: Math.max(0, 1 + (Number(color.saturation || 0) + Number(color.vibrance || 0) * .7 + sliceSaturation * .5) / 70),
    sepia: clamp(Math.abs(Number(color.temperature || 0)) / 360, 0, 1),
    hue: clamp(Number(color.hue || 0) * 1.8 + Number(color.tint || 0) * .35 - Number(color.temperature || 0) * .2 + sliceHue * .6, -180, 180),
    vignette: clamp(Number(color.vignette || 0) / 100, 0, 1),
  };
}

export function colorRecipeFilters(color = {}) {
  const recipe = previewColorRecipe(color);
  const filters = [];
  if (Math.abs(recipe.brightness - 1) > .001)
    filters.push(`lutrgb=r='clip(val*${recipe.brightness.toFixed(5)},0,255)':g='clip(val*${recipe.brightness.toFixed(5)},0,255)':b='clip(val*${recipe.brightness.toFixed(5)},0,255)'`);
  filters.push(`eq=contrast=${recipe.contrast.toFixed(5)}:saturation=${recipe.saturation.toFixed(5)}`);
  if (recipe.sepia > .001) {
    const s = recipe.sepia, keep = 1 - s;
    filters.push(`colorchannelmixer=rr=${(keep + .393*s).toFixed(5)}:rg=${(.769*s).toFixed(5)}:rb=${(.189*s).toFixed(5)}:gr=${(.349*s).toFixed(5)}:gg=${(keep + .686*s).toFixed(5)}:gb=${(.168*s).toFixed(5)}:br=${(.272*s).toFixed(5)}:bg=${(.534*s).toFixed(5)}:bb=${(keep + .131*s).toFixed(5)}`);
  }
  if (Math.abs(recipe.hue) > .001) filters.push(`hue=h=${recipe.hue.toFixed(3)}`);
  if (recipe.vignette > .01) filters.push(`vignette=angle=PI/${(4.8 - recipe.vignette * 3.35).toFixed(3)}:eval=frame`);
  return filters;
}
