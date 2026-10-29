/** Join and leave lines for the presence list.
 * The roster stays quiet until the room is ready and then goes quietMs
 * without a change (or maxWaitMs from ready, whichever comes first). The
 * empty list at page load is therefore not the baseline.
 */

export function peerRosterNotes(previous, next) {
  if (!previous) return [];
  const notes = [];
  for (const [key, email] of next) {
    if (!previous.has(key)) notes.push(`${email} joined`);
  }
  for (const [key, email] of previous) {
    if (!next.has(key)) notes.push(`${email} left`);
  }
  return notes;
}

export function createRosterAnnouncer(
  announce,
  {
    ready = Promise.resolve(),
    quietMs = 400,
    maxWaitMs = 1200,
    schedule = setTimeout,
    cancel = clearTimeout,
  } = {},
) {
  let pending = new Map();
  let baseline = null;
  let armed = false;
  let opened = false;
  let stopped = false;
  let timer = null;
  let readyAt = 0;

  const clearArm = () => {
    if (timer != null) cancel(timer);
    timer = null;
  };

  const arm = () => {
    if (armed || stopped || !opened) return;
    clearArm();
    const remaining = maxWaitMs - (Date.now() - readyAt);
    const wait = Math.max(0, Math.min(quietMs, remaining));
    timer = schedule(() => {
      timer = null;
      if (stopped || armed) return;
      armed = true;
      baseline = new Map(pending);
    }, wait);
  };

  Promise.resolve(ready).then(() => {
    if (stopped) return;
    opened = true;
    readyAt = Date.now();
    arm();
  }, () => {});

  return {
    see(peers) {
      if (stopped) return;
      pending = peers;
      if (!armed) {
        arm();
        return;
      }
      for (const note of peerRosterNotes(baseline, pending)) announce(note);
      baseline = new Map(pending);
    },
    destroy() {
      stopped = true;
      clearArm();
    },
  };
}
