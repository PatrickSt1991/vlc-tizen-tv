# Send URLs to the TV from your phone (no relay to host)

Typing stream URLs on a TV remote is miserable. This feature lets you paste a
URL on your phone and pull it onto the TV with one button — and **nobody runs
a server** for it.

## How it works

A `.wgt` in the retail WebView can't listen on a socket, so the TV can never be
a server. Instead the TV is a *client*: a phone POSTs the URL to a free public
pub/sub topic on [ntfy.sh](https://ntfy.sh) (no account, no signup), and when
you press **📲 Get URL from phone** on the TV, it does a single GET of that
topic and plays the most recent URL.

```
 phone page (GitHub Pages)  ──POST──▶  ntfy.sh/vlctv-<code>  ◀──GET──  VLC TV
```

Pairing: each TV mints a long random code once and shows it in the network
view. The phone enters it once (saved in the browser after that). The topic is
`vlctv-<code>`.

## Deploy the phone page

The page is `docs/index.html`. Enable GitHub Pages on the repo:

> Settings → Pages → Source: **Deploy from a branch** → `main` / **`/docs`**

It will be served at `https://patrickst1991.github.io/vlc-tizen-tv/`, which is
the default `PHONE_PAGE` baked into `js/url-drop.js`. (Change that constant if
you host the page elsewhere.)

## Use it

1. On the TV: **Open Network Stream → 📲 Get URL from phone**. Note the code.
2. On the phone: open the Pages URL, enter the code once, paste a URL, **Send to TV**.
3. Back on the TV: press **📲 Get URL from phone** — it fills the field and plays.

Tip: open `https://patrickst1991.github.io/vlc-tizen-tv/#<code>` to skip
entering the code (good for a QR you show on the TV later).

## Privacy

A public ntfy topic is readable by anyone who knows the code, which is why the
code is long and random. Fine for public stream URLs — don't push anything
secret through it.

## Own the pipe instead (optional)

If you'd rather not depend on a public service, ntfy self-hosts as a single
binary, **or** flip to the built-in n8n adapter in `js/url-drop.js`:

1. Set `N8N_FETCH_URL` to an n8n webhook that returns `{"url":"…"}` for the
   latest drop (keyed by the `code` query param the TV appends).
2. Change `var adapter = ntfyAdapter;` to `var adapter = n8nAdapter;`.
3. Point the phone page's POST at your n8n "store" webhook instead of ntfy.

Trade-off: every user then depends on your n8n instance, so for the public OSS
build ntfy is the better default.
