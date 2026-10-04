# PitchPersona Mailer: warm-up

A small self-hosted inbox warm-up with a browser control panel. It sends ordinary work emails between your inboxes on a slow ramp, rescues them from spam, marks them read and important, replies to about a third, and charts inbox placement. Everything is managed in the panel: inboxes, app passwords, schedule, ramp, the AI model and pause or resume. Nothing needs a redeploy.

**Cost:** your Railway plan (about $5 a month), plus the AI writer on OpenRouter. With `anthropic/claude-haiku-4.5`, a full-volume day (6 inboxes at 40 a day, plus replies) is roughly $0.30, about $10 a month. A cheaper model in the panel brings that under $2 a month. With no key it uses built-in templates for free.

## What protects the domains

- It **starts paused**, and nothing is sent until you press Start.
- **DNS gate:** a domain can send only when SPF, DKIM and DMARC are all found. This is checked every 6 hours and on demand.
- **Hard limits** the engine enforces whatever you type: at most 50 emails per inbox per day, the ramp adds at most 5 a day, and replies max out at 60%.
- **Slowdown:** if an inbox's placement over 3 days drops below 85%, its volume halves.
- **Auto-pause:** an inbox pauses itself when placement drops below 70%, when the provider refuses a send (spam, rate limit or blocked), after 3 failed sends in a row, or when its password is rejected.
- **Plain text only**, with no links, images or tracking. Links and em dashes are stripped even if the AI writes them.
- Sends happen only in working hours, and weekends run at half volume. Each new inbox starts at day 1 of its own ramp.
- App passwords and the AI key are encrypted (AES-256-GCM) with a key that lives on the volume.

## 1. Fix DNS first (at your DNS host, for each domain)

As of 4 Oct 2026, both domains have Google MX records but **no SPF, no DKIM and no DMARC**. The panel will show them as blocked until these exist.

| Type | Name | Value |
|---|---|---|
| TXT | `@` | `v=spf1 include:_spf.google.com ~all` |
| TXT | `google._domainkey` | Generate it in Google Admin: Apps, then Google Workspace, then Gmail, then Authenticate email, then Generate new record (2048-bit). Then click **Start authentication** |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:hello@getpitchpersona.com` (use the matching domain) |
| Redirect | `@` and `www` | 301 to `https://pitchpersona.app` |

Also give every inbox a profile photo and a plain signature, and add both domains to Google Postmaster Tools.

## 2. Deploy on Railway

1. In Railway, create a **New Project**, choose **Deploy from GitHub repo**, and pick `pitchpersona-backend`. Under **Settings**, then **Source**, set **Root Directory** to `mailer` and the branch to the one this lives on.
2. Under **Settings**, then **Volumes**, add a volume mounted at `/data`. Keep **one replica**, because the database is a single SQLite file.
3. Under **Variables**, set `PANEL_PASSWORD` to a long random password. `OPENROUTER_API_KEY` is optional because you can paste the key in the panel instead.
4. Under **Settings**, then **Networking**, click **Generate Domain**. Open it and sign in.

Railway builds from the `Dockerfile` (Node 22) and health-checks `/health`.

## 3. Set it up in the panel

1. In **Inboxes**, click **Add several** and paste one line per inbox: `email, app password, name`. App passwords come from Google Account, then Security, then 2-Step Verification, then App passwords.
2. Optionally, add one or two **seed** inboxes at other providers, such as a personal Gmail or Outlook. They receive and reply, so your mail isn't only going Google to Google.
3. Click **Test login** on each inbox.
4. In **Settings**, then **AI writer**, paste your OpenRouter key, pick a model and click **Write a test email**.
5. In **Overview**, wait until both domains say **Ready to send**, then press **Start warm-up**.

## Ramp

Day 1 sends 3 emails per inbox, adds 2 a day up to a cap of 40, runs at half volume on weekends, and sends only between 8:00 and 18:00 in your time zone. About 35% of received emails get a reply after 20 to 150 minutes, and threads stop at 3 replies.

| Week | Per inbox per day | What to do |
|---|---|---|
| 1 | 3–15 | Warm-up only |
| 2 | 17–29 | Warm-up only. Placement should reach 90% or more |
| 3 | 31–40 | Start cold email at 10–15 a day per inbox if placement has held at 90% or more for 7 days |
| 4+ | 40 warm-up | Cold email up to 30 a day per inbox, with warm-up still running |

## Run locally

```bash
npm install
PANEL_PASSWORD=dev DATA_DIR=./data npm start     # http://localhost:8080
npm run dry                                       # one cycle, nothing sent
```
