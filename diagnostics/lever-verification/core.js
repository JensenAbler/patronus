// Deliberately independent of the browser and server. Raw input is never retained.
export const APPLICATION_URL = "https://jobs.lever.co/Huckleberrylabs/871ce846-02d4-43c5-b54c-426060fc08c4/apply";
export const SESSION_MS = 15 * 60 * 1000;
const MAX_TEXT = 2 * 1024 * 1024;
const MAX_TOKEN = 32768;
const MAX_HASHES = 8;
const TOKEN_NAME = "h-captcha-response";

export function isApplicationPage(raw) {
  try {
    const u = new URL(raw);
    return !u.username && !u.password && u.origin + u.pathname === APPLICATION_URL;
  } catch { return false; }
}
export function classifyRequest(raw, method) {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
    if (u.origin + u.pathname === APPLICATION_URL && method === "POST") return "lever";
    if (u.hostname === "hcaptcha.com" || u.hostname.endsWith(".hcaptcha.com")) return "hcaptcha";
  } catch {}
  return null;
}

function selectedToken(postData) {
  if (!postData || typeof postData !== "object") return null;
  // Match all names before reading the sole selected value.
  if (Array.isArray(postData.params)) {
    let chosen = null;
    for (const parameter of postData.params) {
      if (parameter && parameter.name === TOKEN_NAME) {
        if (chosen) return null;
        chosen = parameter;
      }
    }
    if (chosen) return typeof chosen.value === "string" && chosen.value.length <= MAX_TOKEN ? chosen.value : null;
  }
  const mime = postData.mimeType;
  if (typeof mime !== "string") return null;
  const text = postData.text;
  if (typeof text !== "string" || text.length > MAX_TEXT) return null;
  let chosen = null;
  if (/^application\/x-www-form-urlencoded(?:;|$)/i.test(mime)) {
    let start = 0;
    while (start <= text.length) {
      const end = text.indexOf("&", start);
      const stop = end < 0 ? text.length : end;
      const equals = text.indexOf("=", start);
      const hasEquals = equals >= start && equals < stop;
      const nameEnd = hasEquals ? equals : stop;
      let name;
      try { name = decodeURIComponent(text.slice(start, nameEnd).replace(/\+/g, " ")); } catch { return null; }
      if (name === TOKEN_NAME) {
        if (chosen || stop - nameEnd > MAX_TOKEN * 3) return null;
        chosen = [hasEquals ? equals + 1 : stop, stop];
      }
      if (end < 0) break;
      start = end + 1;
    }
    if (!chosen) return null;
    try {
      const value = decodeURIComponent(text.slice(...chosen).replace(/\+/g, " "));
      return value.length <= MAX_TOKEN ? value : null;
    } catch { return null; }
  }
  if (/^multipart\/form-data(?:;|$)/i.test(mime)) {
    const lineEnd = text.indexOf("\r\n");
    if (lineEnd < 3 || lineEnd > 204) return null;
    const boundary = text.slice(0, lineEnd);
    if (!boundary.startsWith("--")) return null;
    const declared = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(mime);
    if (declared && boundary !== "--" + (declared[1] || declared[2])) return null;
    const marker = 'Content-Disposition: form-data; name="' + TOKEN_NAME + '"';
    let cursor = 0;
    while (text.startsWith(boundary + "\r\n", cursor)) {
      const head = cursor + boundary.length + 2;
      const headerEnd = text.indexOf("\r\n\r\n", head);
      if (headerEnd < 0 || headerEnd - head > 4096) return null;
      const valueStart = headerEnd + 4;
      const end = text.indexOf("\r\n" + boundary, valueStart);
      if (end < 0) return null;
      const header = text.slice(head, headerEnd);
      // Unsupported formatting that mentions the target field is ambiguous.
      if (header.includes(TOKEN_NAME)) {
        if (header !== marker || chosen || end - valueStart > MAX_TOKEN) return null;
        chosen = [valueStart, end];
      }
      cursor = end + 2;
      if (text.startsWith(boundary + "--", cursor)) {
        const rest = text.slice(cursor + boundary.length + 2);
        if (rest !== "" && rest !== "\r\n") return null;
        return chosen ? text.slice(...chosen) : null;
      }
    }
  }
  // Omitted, malformed, duplicate, oversized or unrecognized means unknown.
  return null;
}

function safeTime(raw) {
  if (typeof raw !== "string" || raw.length > 40) return "unknown";
  const time = Date.parse(raw);
  return Number.isFinite(time) ? new Date(time).toISOString() : "unknown";
}

export function createDiagnostic({ cryptoApi = globalThis.crypto, now = Date.now } = {}) {
  let armedAt = null;
  let generation = 0;
  let salt = null;
  let ordered = Promise.resolve();
  const seen = new Set();
  const rows = { lever: [], hcaptcha: [] };
  function clear() {
    generation++;
    armedAt = null;
    if (salt) salt.fill(0);
    salt = null;
    ordered = Promise.resolve();
    seen.clear();
    rows.lever.length = 0;
    rows.hcaptcha.length = 0;
  }
  function isArmed() {
    if (armedAt !== null && now() - armedAt >= SESSION_MS) clear();
    return armedAt !== null;
  }
  function arm(pageUrl) {
    clear();
    if (!isApplicationPage(pageUrl)) return false;
    salt = cryptoApi.getRandomValues(new Uint8Array(32));
    armedAt = now();
    return true;
  }
  function navigate(pageUrl) {
    if (!isApplicationPage(pageUrl)) clear();
  }
  function append(kind, row, epoch) {
    if (epoch !== generation || !isArmed()) return null;
    const frozen = Object.freeze(row);
    rows[kind].push(frozen);
    while (rows[kind].length > 64) rows[kind].shift();
    return { kind, row: frozen };
  }
  function hashToken(token) {
    const valueBytes = new TextEncoder().encode(token);
    const salted = new Uint8Array(salt.length + valueBytes.length);
    salted.set(salt);
    salted.set(valueBytes, salt.length);
    valueBytes.fill(0);
    // Convert errors immediately into fixed metadata; never queue raw errors.
    return cryptoApi.subtle.digest("SHA-256", salted).then(digest => {
      salted.fill(0);
      const bytes = new Uint8Array(digest);
      const key = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
      bytes.fill(0);
      return { key };
    }, () => {
      salted.fill(0);
      return { failed: true };
    });
  }
  function enqueue(row, hashOutcome, epoch) {
    // Queue only redacted metadata and a digest outcome, never raw requests/tokens.
    const task = ordered.then(async () => {
      const outcome = hashOutcome ? await hashOutcome : null;
      if (epoch !== generation || !isArmed()) return null;
      if (outcome?.failed) throw new Error("Diagnostic hashing unavailable");
      if (outcome) {
        row.duplicateToken = seen.has(outcome.key);
        seen.delete(outcome.key);
        seen.add(outcome.key);
        while (seen.size > MAX_HASHES) seen.delete(seen.values().next().value);
      }
      return append("lever", row, epoch);
    });
    ordered = task.catch(() => null);
    return task;
  }
  function observe(entry, pageUrl) {
    if (!isArmed() || !isApplicationPage(pageUrl)) return null;
    const kind = classifyRequest(entry?.request?.url, entry?.request?.method);
    if (!kind) return null;
    const epoch = generation;
    const timestamp = safeTime(entry.startedDateTime);
    // Finishing after arm is insufficient: do not inspect pre-arm/in-flight data.
    if (timestamp === "unknown" || Date.parse(timestamp) < armedAt) return null;
    const candidateStatus = entry.response?.status;
    const status = Number.isInteger(candidateStatus) && candidateStatus >= 0 && candidateStatus <= 599 ? candidateStatus : "unknown";
    const row = { timestamp, status, tokenPresent: "unknown", duplicateToken: "unknown", tokenAge: "unknown" };
    if (kind === "hcaptcha") return append(kind, row, epoch);
    let token = selectedToken(entry.request.postData);
    entry = null;
    let outcome = null;
    if (token !== null) {
      row.tokenPresent = token.trim().length > 0;
      if (row.tokenPresent) outcome = hashToken(token);
    }
    token = null;
    return enqueue(row, outcome, epoch);
  }
  function snapshot() {
    isArmed();
    return { lever: rows.lever.map(row => ({...row})), hcaptcha: rows.hcaptcha.map(row => ({...row})) };
  }
  return Object.freeze({ arm, clear, navigate, observe, snapshot, isArmed });
}
