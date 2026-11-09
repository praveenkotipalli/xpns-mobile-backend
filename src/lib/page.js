/**
 * The shell for the few plain web pages the server serves (privacy policy,
 * account deletion). Google Play links to both, so they have to work in any
 * browser without the app. Same look as the app: true black, white, one red
 * for destructive actions.
 */

const css = `
:root {
  color-scheme: dark;
  --bg: #000; --surface: #151515; --surface-alt: #212121; --border: #333;
  --text: #fff; --body: #d4d4d4; --muted: #a1a1a1; --faint: #8a8a8a;
  --danger: #ff6b6b; --danger-soft: rgba(255, 107, 107, 0.14);
  --success: #3ecf8e; --success-soft: rgba(62, 207, 142, 0.14);
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; background: var(--bg); color: var(--body);
  font: 16px/1.65 system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif;
  -webkit-font-smoothing: antialiased;
}
main { max-width: 680px; margin: 0 auto; padding: 40px 16px 72px; }
@media (min-width: 600px) { main { padding: 64px 24px 96px; } }

.brand {
  display: inline-flex; align-items: center; gap: 10px;
  color: var(--text); text-decoration: none; font-weight: 700; font-size: 17px;
}
.mark {
  width: 30px; height: 30px; border-radius: 8px; display: grid; place-items: center;
  background: var(--text); color: var(--bg); font-weight: 800; font-size: 17px;
}

h1 {
  color: var(--text); font-size: clamp(34px, 7vw, 48px); line-height: 1.05;
  letter-spacing: -0.025em; margin: 56px 0 12px;
}
.updated { color: var(--faint); font-size: 14px; margin: 0; }
.lede { color: var(--muted); font-size: 18px; line-height: 1.55; margin: 24px 0 0; }

h2 {
  color: var(--text); font-size: 20px; letter-spacing: -0.01em; line-height: 1.3;
  margin: 56px 0 12px;
}
h2 + p { margin-top: 0; }
p { margin: 0 0 14px; }
strong { color: var(--text); font-weight: 600; }
ul { margin: 0 0 14px; padding-left: 20px; }
li { margin: 8px 0; padding-left: 4px; }
li::marker { color: var(--faint); }
a { color: var(--text); text-decoration-thickness: 1px; text-underline-offset: 3px; }
a:focus-visible, input:focus-visible, button:focus-visible {
  outline: 2px solid var(--text); outline-offset: 3px;
}

.glance {
  margin: 40px 0 0; padding: 4px 24px; border: 1px solid var(--border); border-radius: 16px;
  background: var(--surface); list-style: none;
}
.glance li { margin: 0; padding: 16px 0; border-top: 1px solid var(--border); }
.glance li:first-child { border-top: 0; }

.split { display: grid; gap: 12px; margin: 16px 0 0; }
@media (min-width: 600px) { .split { grid-template-columns: 1fr 1fr; } }
.split > div { padding: 20px; border: 1px solid var(--border); border-radius: 16px; }
.split h3 { margin: 0 0 8px; font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; }
.split .gone h3 { color: var(--danger); }
.split .kept h3 { color: var(--muted); }
.split ul { margin: 0; }

form { margin: 16px 0 0; padding: 24px; border: 1px solid var(--border); border-radius: 16px; background: var(--surface); }
label { display: block; color: var(--muted); font-size: 14px; font-weight: 600; margin: 0 0 6px; }
input[type=email], input[type=password] {
  width: 100%; margin: 0 0 18px; padding: 13px 14px; font: inherit; color: var(--text);
  background: var(--surface-alt); border: 1px solid var(--border); border-radius: 12px;
}
.check { display: flex; gap: 10px; align-items: flex-start; color: var(--body); font-weight: 400; margin: 4px 0 22px; }
.check input { width: 18px; height: 18px; margin: 3px 0 0; accent-color: var(--danger); flex: none; }
button {
  width: 100%; padding: 14px; font: inherit; font-weight: 700; cursor: pointer;
  color: var(--danger); background: var(--danger-soft); border: 0; border-radius: 12px;
  transition: background-color 0.15s ease;
}
button:hover { background: rgba(255, 107, 107, 0.22); }

.notice { margin: 32px 0 0; padding: 14px 16px; border-radius: 12px; font-weight: 600; }
.notice.error { color: var(--danger); background: var(--danger-soft); }
.notice.done { color: var(--success); background: var(--success-soft); }

footer {
  display: flex; flex-wrap: wrap; gap: 8px 20px; margin-top: 72px; padding-top: 24px;
  border-top: 1px solid var(--border); font-size: 14px; color: var(--faint);
}
footer a { color: var(--muted); }

@media (prefers-reduced-motion: reduce) { button { transition: none; } }
`;

/** Escape text for an HTML body or attribute. Anything a user typed goes through this. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderPage({ title, description, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · xpnz</title>
<meta name="description" content="${escapeHtml(description)}">
<meta name="theme-color" content="#000000">
<style>${css}</style>
</head>
<body>
<main>
<a class="brand" href="/privacy" aria-label="xpnz privacy policy"><span class="mark" aria-hidden="true">₹</span>xpnz</a>
${body}
<footer>
  <span>xpnz</span>
  <a href="/privacy">Privacy policy</a>
  <a href="/delete-account">Delete your account</a>
</footer>
</main>
</body>
</html>`;
}
