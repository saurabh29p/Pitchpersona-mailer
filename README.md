# PitchPersona Mailer

An internal, self-hosted replacement for Instantly or Smartlead: inbox warm-up plus cold-email campaigns, run from a browser control panel. It is a separate tool from the PitchPersona app.

**Warm-up:** a small self-hosted inbox warm-up. It sends ordinary work emails between your inboxes on a slow ramp, rescues them from spam, marks them read and important, replies to about a third, and charts inbox placement. Everything is managed in the panel: inboxes, app passwords, schedule, ramp, the AI model and pause or resume. Nothing needs a redeploy.

**Cost:** your Railway plan (about $5 a month), plus the AI writer on OpenRouter. With `anthropic/claude-haiku-4.5`, a full-volume day (6 inboxes at 40 a day, plus replies) is roughly $0.30, about $10 a month. A cheaper model in the panel brings that under $2 a month. With no key it uses built-in templates for free.

## What protects the domains

- It **starts paused**, and nothing is sent until you press Start. **Pause all** stops warm-up and campaigns at once, including emails already queued in the running cycle.
- **DNS gate:** a domain can send only when SPF, DKIM and DMARC are all found. This is checked every 6 hours and on demand.
- **Hard limits** the engine enforces whatever you type: at most 50 emails per inbox per day, the ramp adds at most 5 a day, and replies max out at 60%.
- **Slowdown:** if an inbox's placement over 3 days drops below 85%, its volume halves.
- **Auto-pause:** an inbox pauses itself when placement drops below 70%, when the provider refuses a send (spam, rate limit or blocked), after 3 failed sends in a row, or when its password is rejected. A rejected password isn't retried until you save a new one, so the account doesn't get locked for repeated failed logins.
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
   Then, under **Settings**, then **Config-as-code**, set **Railway Config File** to `/mailer/railway.json`. Railway doesn't apply the Root Directory to this path, so without it the service uses the PitchPersona API's `/railway.toml` and fails with "The executable `python` could not be found". If a **Custom Start Command** is set under **Deploy**, clear it.
2. Under **Settings**, then **Volumes**, add a volume mounted at `/data`. Keep **one replica**, because the database is a single SQLite file.
3. Under **Variables**, set `PANEL_PASSWORD` to a long random password. `OPENROUTER_API_KEY` is optional because you can paste the key in the panel instead.
4. Under **Settings**, then **Networking**, click **Generate Domain**. Open it and sign in.

Railway builds from the `Dockerfile` (Node 22) and health-checks `/health`.

## 3. Set it up in the panel

The panel walks you through this. Overview shows a **Get set up** checklist until warm-up is running, and the **Guide** tab has the full checklist plus how a cycle works, the warm-up plan and what each colour means. Each step ticks itself off from what the mailer can see: a volume, inboxes, passing login tests, DNS, DKIM signing on received mail, and sending. **Start warm-up** refuses, and says why, until there are at least two inboxes with a sender among them and an app password saved. An inbox's day 1 is the day you press Start, unless you picked its day 1 yourself.

1. In **Inboxes**, click **Add several** and paste one line per inbox: `email, app password, name`. App passwords come from Google Account, then Security, then 2-Step Verification, then App passwords.
2. Optionally, add one or two **seed** inboxes at other providers, such as a personal Gmail or Outlook. They receive and reply, so your mail isn't only going Google to Google.
3. Click **Test login** on each inbox.
4. In **Settings**, then **AI writer**, paste your OpenRouter key, pick a model and click **Write a test email**.
5. In Google Admin, open Apps, Google Workspace, Gmail, **Authenticate email**, and click **Start authentication** for each domain. Until then Google signs with its default key and your DKIM record goes unused. The panel confirms it from the headers of received warm-up mail.
6. In **Overview**, wait until both domains say **Ready to send**, then press **Start warm-up**.

## Ramp

Day 1 sends 3 emails per inbox, adds 2 a day up to a cap of 40, runs at half volume on weekends, and sends only between 8:00 and 18:00 in your time zone. About 35% of received emails get a reply after 20 to 150 minutes, and threads stop at 3 replies.

| Week | Per inbox per day | What to do |
|---|---|---|
| 1 | 3–15 | Warm-up only |
| 2 | 17–29 | Warm-up only. Placement should reach 90% or more |
| 3 | 31–40 | Start cold email at 10–15 a day per inbox if placement has held at 90% or more for 7 days |
| 4+ | 40 warm-up | Cold email up to 30 a day per inbox, with warm-up still running |

## Campaigns (cold email)

Open **Campaigns**, then **New campaign**.

- **Sequence:** up to 8 steps. Step 1 starts a thread, and later steps can go out as replies in the same thread after a set number of days. Templates use `{{first_name}}`, `{{company}}` or any column from your leads, and `{{first_name|there}}` gives a fallback. A lead with an unfilled variable is held back ("Needs a fix") instead of getting a broken email. Any step can be edited for one lead.
- **Leads:** import a CSV (it needs an `email` column, and every other column becomes a variable), paste them, or let PitchPersona push them in (below). With **Review** on, new leads wait until you approve them.
- **Schedule:** the inboxes to use, sending hours and days, a daily limit per inbox, and a random gap between sends.
- **Stops by itself:** a reply stops the lead's sequence, and that person is kept out of every other campaign. "Unsubscribe", "remove me" and similar replies, the unsubscribe link and bounces all go on the do-not-email list. Auto-replies don't stop anything. An address the mail server refuses as non-existent is treated as a bounce; it does not pause the inbox.
- **Replies are checked before follow-ups:** an inbox sends campaign emails in a cycle only if its reply check worked in that cycle (Gmail's All Mail and Spam, or the inbox and junk folder elsewhere), so a follow-up never goes to someone whose reply hasn't been read yet. Removing an inbox moves the leads it was emailing to **Review**, so you can check that mailbox for replies before they continue from another inbox.
- **Tracking:** replies always, clicks optionally. Open tracking is off by default because it hurts deliverability and Apple Mail fakes opens.

**Campaign safety rules (Settings, then Cold email safety):** an inbox sends campaigns only after 14 warm-up days, only while its 7-day placement is 90% or more, and at most 30 campaign emails a day across all campaigns (hard maximum 50). If more than 5% of its last 40 campaign emails bounce, it pauses itself. Every email carries a `List-Unsubscribe` header with one-click unsubscribe.

**Using PitchPersona's output (optional, no change to PitchPersona needed):** each campaign has a private link under **Add leads**. In PitchPersona, open Settings and paste that link as the Custom webhook URL, then push prospects with **Webhook**. Each prospect arrives with its three written emails (`{{email_subject}}`, `{{email_body}}`, `{{email_2_body}}`, `{{email_3_body}}`), which the "PitchPersona sequence" preset already uses. To see replies on PitchPersona's prospect timeline, paste PitchPersona's Instantly reply address under Settings, then **Send replies to PitchPersona**.

You answer replies from the inbox itself, in Gmail. The **Replies** tab lists every reply, auto-reply, bounce and opt-out, so you know where to look.

## Run locally and test

```bash
npm install
PANEL_PASSWORD=dev DATA_DIR=./data npm start     # http://localhost:8080
npm run dry                                       # one cycle, nothing sent
npm test                                          # the full test suite, nothing leaves your machine
```

`npm test` runs five files in `test/`: reply, bounce and opt-out detection against a fake mailbox; deployment guards; the start guards and setup-guide facts; an end-to-end pass in dry-run mode (sign-in, inboxes, PitchPersona webhook ingest, review, sequences and threading, pauses, inbox removal, unsubscribe and click links); and a real sending pass against local mock SMTP, IMAP and OpenRouter servers (needs `openssl`). Run it after any change before deploying.
