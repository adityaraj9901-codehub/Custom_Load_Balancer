import process from 'node:process';

// Minimal structured (JSON) logger — zero dependencies.
// One line per event to stdout/stderr so it plays nicely with container log shippers.

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

export function createLogger(level = 'info', base = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function emit(lvl, msg, fields) {
    if (LEVELS[lvl] > threshold) return;
    const record = {
      ts: new Date().toISOString(),
      level: lvl,
      msg,
      ...base,
      ...(fields || {}),
    };
    const line = `${JSON.stringify(record)}\n`;
    if (lvl === 'error') process.stderr.write(line);
    else process.stdout.write(line);
  }

  return {
    error: (msg, fields) => emit('error', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    debug: (msg, fields) => emit('debug', msg, fields),
    child: (extra) => createLogger(level, { ...base, ...extra }),
  };
}
