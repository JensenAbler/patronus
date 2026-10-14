import { createDiagnostic, isApplicationPage } from "./core.js";
const diagnostic = createDiagnostic();
const state = document.getElementById("state");
let generation = 0;
let accepting = false;
let pending = 0;
function render() {
  const rows = diagnostic.snapshot();
  document.getElementById("lever").textContent = JSON.stringify(rows.lever, null, 2);
  document.getElementById("hcaptcha").textContent = JSON.stringify(rows.hcaptcha, null, 2);
}
function stop(message = "Stopped and cleared") {
  accepting = false;
  generation++;
  diagnostic.clear();
  state.textContent = message;
  render();
}
function pageUrl() {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), 2000);
    // Fixed expression reads only the page URL, never DOM or form values.
    chrome.devtools.inspectedWindow.eval("location.href", (result, exceptionInfo) => {
      clearTimeout(timer);
      resolve(!exceptionInfo && typeof result === "string" ? result : null);
    });
  });
}
document.getElementById("arm").addEventListener("click", async () => {
  stop();
  const epoch = generation;
  const url = await pageUrl();
  if (epoch !== generation) return;
  accepting = diagnostic.arm(url);
  state.textContent = accepting ? "Armed for this application; prospective metadata only" : "Cannot arm: this is not the approved application page";
});
document.getElementById("stop").addEventListener("click", () => stop());
chrome.devtools.network.onNavigated.addListener(url => {
  if (!isApplicationPage(url)) stop("Stopped and cleared after leaving the approved application");
});
chrome.devtools.network.onRequestFinished.addListener(async entry => {
  if (!accepting || !diagnostic.isArmed()) return;
  let counted = false;
  const epoch = generation;
  try {
    // Scope URL before any content access; exact top-level page checked again.
    const url = entry?.request?.url;
    let candidate;
    try { candidate = new URL(url); } catch { return; }
    if (candidate.protocol !== "https:" || candidate.username || candidate.password || candidate.port) return;
    const application = isApplicationPage(url) && entry.request.method === "POST";
    const captcha = candidate.hostname === "hcaptcha.com" || candidate.hostname.endsWith(".hcaptcha.com");
    if (!application && !captcha) return;
    // At most eight scoped events are transiently in flight, never queued.
    if (pending >= 8) {
      stop("Stopped and cleared: diagnostic event limit reached; no complete result");
      return;
    }
    pending++;
    counted = true;
    const inspectedUrl = await pageUrl();
    if (epoch !== generation || !accepting) return;
    if (!isApplicationPage(inspectedUrl)) { stop("Stopped and cleared: page scope could not be confirmed"); return; }
    await diagnostic.observe(entry, inspectedUrl);
    if (epoch === generation) render();
  } catch {
    // Exception objects might contain input. Never log or render them.
    if (epoch === generation) stop("Stopped and cleared after a diagnostic error");
  } finally { if (counted) pending--; }
});
setInterval(() => {
  if (accepting && !diagnostic.isArmed()) stop("Stopped and cleared after the 15-minute limit");
}, 1000);
window.addEventListener("pagehide", () => stop());
