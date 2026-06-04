# Send URLs to the TV from another device (no relay to host)

Typing stream URLs on a TV remote is miserable. This feature lets you paste a
URL from your **phone, tablet or laptop** and pull it onto the TV with one
button — and **nobody runs a server** for it.

## How it works

A `.wgt` in the retail WebView can't listen on a socket, so the TV can never be
a server. Instead the TV is a *client*: the device POSTs the URL to a free
public pub/sub topic on [ntfy.sh](https://ntfy.sh) (no account, no signup), and
when you press **📲 Get URL from device** on the TV, it does a single GET of
that topic and plays the most recent URL.

```
 device page (GitHub Pages)  ──POST──▶  ntfy.sh/vlctv-<code>  ◀──GET──  VLC TV
```

Pairing: each TV mints a long random code once. It's shown in **Settings →
Cast from another device**, together with a QR code. Scan the QR (or enter the
code once — the browser remembers it) and you're paired. The topic is
`vlctv-<code>`.

## Host the device page

The page is `docs/index.html` (plus `icon.png`). Serve it over **HTTPS** at the
URL set in `PHONE_PAGE` in `js/url-drop.js` — currently:

`https://vlc-tizen.madebypatrick.nl/`

HTTPS is required: the page POSTs to `https://ntfy.sh`, so a plain-HTTP page is
blocked by the browser as mixed content and sending fails silently. Any static
host works — your own domain, or GitHub Pages (optionally with a custom domain
via a `CNAME` file in `docs/`).

## Use it

1. On the TV: **Settings → Cast from another device** — scan the QR with any
   device, or note the code.
2. On the device: paste a URL, **Send to TV**.
3. On the TV: **Open Network Stream → 📲 Get URL from device** — it fills the
   field and plays.

The QR encodes the page URL with the code in the hash
(`…/vlc-tizen-tv/#<code>`), so scanning opens the page already paired. The QR
is generated **on the TV, offline** (bundled `js/qrcode.js`, MIT) — the pairing
code is never sent to a third-party QR service.

## Privacy

A public ntfy topic is readable by anyone who knows the code, which is why the
code is long and random. Fine for public stream URLs — don't push anything
secret through it.

## Own the pipe instead (optional)

ntfy self-hosts as a single binary, **or** flip to the built-in n8n adapter in
`js/url-drop.js`:

1. Set `N8N_FETCH_URL` to an n8n webhook that returns `{"url":"…"}` for the
   latest drop (keyed by the `code` query param the TV appends).
2. Change `var adapter = ntfyAdapter;` to `var adapter = n8nAdapter;`.
3. Point the device page's POST at your n8n "store" webhook instead of ntfy.

Trade-off: every user then depends on your n8n instance, so for the public OSS
build ntfy is the better default.
