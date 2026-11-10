async function suspendTree(root, describe, signal) {
  const original = await describe(root);
  const alreadyStopped = new Set(original.filter(p => p.state.includes('T')).map(p => p.pid));
  const frozen = new Set();
  const stop = pid => { if (!alreadyStopped.has(pid) && !frozen.has(pid)) { signal(pid, 'SIGSTOP'); frozen.add(pid); } };
  try {
    stop(root);
    for (let pass = 0; pass < 3; pass++) for (const p of await describe(root)) stop(p.pid);
    return frozen;
  } catch (error) {
    for (const pid of [...frozen].reverse()) {
      try { signal(pid, 'SIGCONT'); frozen.delete(pid); } catch {}
    }
    error.frozen = frozen;
    throw error;
  }
}
module.exports = { suspendTree };
