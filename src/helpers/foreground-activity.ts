// When this page last served something a user is waiting on (a preview
// request). Background work on the main thread (content packing) holds off
// while that's recent, so it never lands in the middle of a page load.

let lastForegroundAt = 0;
// requests being answered: a dev server can hold one for seconds (Vite
// while it pre-bundles dependencies), and the page is still loading
let inFlight = 0;

export function noteForegroundActivity(): void {
  lastForegroundAt = Date.now();
}

/** A request the page waits on has started; call the result once it's answered. */
export function beginForegroundActivity(): () => void {
  inFlight++;
  lastForegroundAt = Date.now();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    inFlight--;
    lastForegroundAt = Date.now();
  };
}

/** When the page last served something: now while a request is pending. */
export function lastForegroundActivity(): number {
  return inFlight > 0 ? Date.now() : lastForegroundAt;
}
