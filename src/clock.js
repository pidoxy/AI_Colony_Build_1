// Single source of "now". Tests move it; production uses the system clock.
let fixed = null;
export const clock = {
  now() { return fixed ? new Date(fixed.getTime()) : new Date(); },
  set(date) { fixed = new Date(date); },
  advance(ms) { fixed = new Date((fixed ?? new Date()).getTime() + ms); },
  reset() { fixed = null; },
};
