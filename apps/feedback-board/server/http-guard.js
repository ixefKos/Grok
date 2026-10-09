export function hostAllowed(hostHeader, port) {
  if (typeof hostHeader !== "string" || !Number.isInteger(port)) return false;
  const host = hostHeader.trim().toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

export function requireLocalHost(port) {
  return function localHost(req, res, next) {
    if (!hostAllowed(req.headers.host, port)) {
      res.status(403).json({ error: "This board only answers on localhost." });
      return;
    }
    next();
  };
}
