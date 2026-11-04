export function cacheMatch(match: () => Promise<Response | undefined>): Promise<Response | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => { settled = true; resolve(undefined); }, 100);
    Promise.resolve().then(match).then((response) => {
      if (settled) {
        try { void response?.body?.cancel().catch(() => undefined); } catch { /* Cache cleanup is optional. */ }
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(response);
    }, () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(undefined);
    });
  });
}
