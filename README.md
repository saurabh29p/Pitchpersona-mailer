# PitchPersona Mailer

An internal, self-hosted replacement for Instantly or Smartlead: inbox warm-up plus cold-email campaigns, run from a browser control panel. It is a separate tool from the PitchPersona app.

**Warm-up:** a small self-hosted inbox warm-up. It sends ordinary work emails between your inboxes on a slow ramp, rescues them from spam, marks them read and important, replies to about a third, and charts inbox placement. Everything is managed in the panel: inboxes, how they sign in, schedule, ramp, the AI model and pause or resume. Nothing needs a redeploy.

**Cost:** your Railway plan (about $5 a month), plus the AI writer on OpenRouter. With `anthropic/claude-haiku-4.5`, a full-volume day (6 inboxes at 40 a day, plus replies) is roughly $0.30, about $10 a month. A cheaper model in the panel brings that under $2 a month. With no key it uses built-in templates for free.

## What protects the domains

- It **starts paused**, and nothing is sent until you press Start. **Pause all** stops warm-up and campaigns at once, including emails already queued in the running cycle.
- **DNS gate:** a domain can send only when SPF, DKIM and DMARC are all found. A passing domain is re-checked every 6 hours and a failing one every 15 minutes, or on demand. If DNS can't be reached at all, the last answer is kept rather than blocking sending.
- **Hard limits** the engine enforces whatever you type: at most 50 emails per inbox per day, the ramp adds at most 5 a day, and replies max out at 60%.
- **Slowdown:** if an inbox's placement over 3 days drops below 85%, its volume halves.
- **Auto-pause:** an inbox pauses itself when placement drops below 70%, when the provider refuses a send (spam, rate limit or blocked), after 3 failed sends in a row, or when its password is rejected. A rejected password isn't retried until you save a new one, so the account doesn't get locked for repeated failed logins.
- **Plain text only**, with no links, images or tracking. Links and em dashes are stripped even if the AI writes them.
- Sends happen only in working hours, and weekends run at half volume. Each new inbox starts at day 1 of its own ramp.
- App passwords and the AI key are encrypted (AES-256-GCM) with a key that lives on the volume.

## Staying up

- **Deploys and restarts:** on a deploy Railway stops the old copy with SIGTERM. The mailer stops starting new sends, lets the one in progress finish, then exits. Railway restarts it after any crash, and the reason is shown in Activity.
- **No double emails:** a lead is marked as sending just before its email goes out. If the mailer stops at that moment, the lead waits in **Review** with a note to check the inbox's Sent folder, instead of being sent the same email again.
- **Slow mail servers:** each mailbox visit has a 5-minute limit, so one server that stops answering can't hold up the other inboxes. At most 8 mailboxes are read and 4 warm-up emails written at once.
- **Busy mailboxes** are read 1,000 new messages per cycle. Campaign follow-ups from that inbox wait until it has caught up, so no reply is missed.
- **Lead batches** over 1,000 are not dropped silently: the answer says how many to send again.
- Activity older than 30 days and finished reply jobs older than 14 days are cleared every hour.
- **A mail server it can't reach** (a closed port, or Railway's SMTP block) is found by a plain connection check at start, before each cycle and on every login test. The inboxes using it show as blocked with the reason instead of failing sends, and sends that fail on the connection don't count toward pausing the inbox. A failed check is repeated every 5 minutes.

## Knowing what it's doing

- **The bar under the tabs** says what the mailer is doing right now (the step a cycle is on), what the last cycle sent, why it sent nothing when it didn't (outside working hours, every inbox blocked, today's emails already sent, or nothing due yet), and when the next one runs. It says so when the panel can't reach the mailer, during a deploy for example, and reconnects by itself.
- **Messages** in the corner confirm each action. Problems stay until you close them; good news fades. Start and Run a cycle now each end with a message saying what the cycle did.
- **Every failed login has a reason and a fix**, worked out from what the mail server or Google said: Railway blocking SMTP, a wrong or missing app password, IMAP turned off, a sign-in Google wants confirmed in a browser, too many attempts, a wrong server name, port or certificate, and for Google sign-in a missing delegation (with the client ID to paste), the Gmail API switched off, an address that isn't a Workspace user or a deleted key. The server's own words are one tap away. A new app password, or a switch to Google sign-in, is tested as soon as it's saved.

## Inbox tools in the panel

- **The look:** the panel uses the PitchPersona web app's theme (ink and violet, Inter,
  a left sidebar). Light, dark or follow the device is chosen in the sidebar.
- **Problems vs. to-dos:** problems that stop sending show on every page. To-dos show only
  on Overview, with a count in the sidebar.
- **Daily cap:** each sender card has a Daily cap field. Empty follows the ramp. A cap
  below the ramp's cap says on the card that it holds the inbox at that volume.
- **Send one now:** can go up to 5 emails past today's plan each day, for testing. When it
  can't send, it says nothing was sent and why. It also says how much of today's warm-up
  it used.
- **Check mailbox:** reads the inbox's Inbox and Sent folders read-only, with its own
  sign-in, and lists the newest emails on the card with the exact account address. Use it
  when warm-up mail can't be found in Gmail.
- **Next reply due:** Overview shows when the next queued warm-up reply goes out (replies
  wait 20 to 150 minutes).
- **Health:** errors from before an inbox's last passing login test (a wrong password, a
  blocked port) are setup problems that are already fixed. They show separately and don't
  lower its health score.

## 1. Fix DNS first (at your DNS host, for each domain)

getpitchpersona.com and trypitchpersona.com passed all three checks on 4 Oct 2026. For any new sending domain, add these records first. The panel shows the domain as blocked until they exist.

| Type | Name | Value |
|---|---|---|
| TXT | `@` | `v=spf1 include:_spf.google.com ~all` |
| TXT | `google._domainkey` | Generate it in Google Admin: Apps, then Google Workspace, then Gmail, then Authenticate email, then Generate new record (2048-bit). Then click **Start authentication** |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:hello@getpitchpersona.com` (use the matching domain) |
| Redirect | `@` and `www` | 301 to `https://pitchpersona.app` |

Also give every inbox a profile photo and a plain signature, and add both domains to Google Postmaster Tools.

## 2. Deploy on Railway

**On Railway's Hobby plan, use Google sign-in.** Railway blocks every email-sending (SMTP) connection on its Free, Trial and Hobby plans ([outbound networking docs](https://docs.railway.com/reference/outbound-networking)), so inboxes that sign in with an app password can't send there. Google sign-in (below) sends through the Gmail API over HTTPS, which every plan allows, and reading mail (IMAP, port 993) works on any plan. The other way is Railway's Pro plan, then a redeploy: Railway only opens the email ports on a new deploy. The mailer checks the connection to each server it uses when it starts and every few minutes, says on Overview when it can't connect, and tests those logins again by itself once it can.

1. In Railway, create a **New Project**, choose **Deploy from GitHub repo**, and pick `pitchpersona-mailer` on the `main` branch. Leave **Root Directory** empty. Railway reads `railway.json` from the repo root.
2. Under **Settings**, then **Volumes**, add a volume mounted at `/data`. Keep **one replica**, because the database is a single SQLite file.
3. Under **Variables**, set `PANEL_PASSWORD` to a long random password. `OPENROUTER_API_KEY` is optional because you can paste the key in the panel instead.
4. Under **Settings**, then **Networking**, click **Generate Domain**. Open it and sign in.

Railway builds from the `Dockerfile` (Node 22) and health-checks `/health`.

### Your own address (mailer.pitchpersona.app)

1. In Railway, open the service, then **Settings**, then **Networking**, and add a **Custom Domain**: `mailer.pitchpersona.app`. Railway shows the DNS record(s) to add.
2. At the DNS host for pitchpersona.app (Hostinger), add exactly those records: a CNAME named `mailer`, plus any verification TXT record Railway lists.
3. Wait for Railway to show the domain as active. It issues the HTTPS certificate itself. Then sign in at the new address.

A subdomain is used rather than a path like pitchpersona.app/mailer: the main site runs on Vercel, and the panel expects to sit at the root of its own address.

**Before the first campaign**, give campaign emails their own link address on a sending domain, for example `go.getpitchpersona.com`, added the same way as a second custom domain. Enter it under Settings, Cold email safety, **Address for links in campaign emails**. Unsubscribe and click-tracking links then use it, so your main domain never appears in cold email. The panel warns you if a campaign would send links on another domain.

### Moving the existing service over from pitchpersona-backend

The mailer used to live in the `mailer` folder of `pitchpersona-backend`. To point the running service at this repo without losing anything:

1. Open the service, then **Settings**, then **Source**. Disconnect the old repo and connect `pitchpersona-mailer`, branch `main`.
2. Clear **Root Directory**.
3. Under **Config-as-code**, set **Railway Config File** to `/railway.json`, or clear it.
4. Deploy. The volume at `/data` and the variables belong to the service, so inboxes, passwords and history stay.

## 3. Set it up in the panel

The panel walks you through this. Overview shows a **Get set up** checklist until warm-up is running, and the **Guide** tab has the full checklist plus how a cycle works, the warm-up plan and what each colour means. Each step ticks itself off from what the mailer can see: a volume, inboxes, passing login tests, DNS, DKIM signing on received mail, and sending. **Start warm-up** refuses, and says why, until there are at least two inboxes with a sender among them that can sign in. An inbox's day 1 is the day you press Start, unless you picked its day 1 yourself.

1. Set up **Google sign-in** (next section) for Google Workspace inboxes. Then in **Inboxes**, click **Add several** and paste one line per inbox: `email, name`. Inboxes that sign in with an app password take `email, app password, name` instead; app passwords come from Google Account, then Security, then 2-Step Verification, then App passwords.
2. Optionally, add one or two **seed** inboxes at other providers, such as a personal Gmail or Outlook. They receive and reply, so your mail isn't only going Google to Google. Personal Gmail can't use Google sign-in, so seeds use app passwords; on Railway's Hobby plan they still receive and get read, but can't reply.
3. Each inbox tests its login as soon as it's set up (or press **Test login**). A failure shows the reason and the fix on the inbox card and on Overview.
4. In **Settings**, then **AI writer**, paste your OpenRouter key, pick a model and click **Write a test email**.
5. In Google Admin, open Apps, Google Workspace, Gmail, **Authenticate email**, and click **Start authentication** for each domain. Until then Google signs with its default key and your DKIM record goes unused. The panel confirms it from the headers of received warm-up mail.
6. In **Overview**, wait until both domains say **Ready to send**, then press **Start warm-up**.

### Google sign-in (no app passwords)

One Google Cloud **service account**, allowed by your Workspace admin to act for your users (domain-wide delegation), signs the mailer in to every Google Workspace inbox. No inbox needs 2-Step Verification or an app password. Sending goes through the Gmail API over HTTPS; reading still uses IMAP, signed in with the same short-lived token (XOAUTH2). The key file is stored encrypted on the volume and never shown again. The panel's **Settings, Google sign-in** card has these steps with links:

1. In [Google Cloud](https://console.cloud.google.com/projectcreate), signed in as a Workspace admin, create a project and [enable the Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com) in it.
2. Under IAM & Admin, Service accounts, create a service account (no roles needed). Open it, then Keys, Add key, Create new key, JSON. If an organization policy blocks key creation, set "Disable service account key creation" to Not enforced under IAM & Admin, Organization policies (this needs the Organization Policy Administrator role).
3. In the panel, press **Choose key file** and pick the file. The card shows the key's client ID.
4. In [Google Admin](https://admin.google.com/ac/owl/domainwidedelegation), open Security, Access and data control, API controls, Manage Domain Wide Delegation, and add the client ID with the scope `https://mail.google.com/`. Do this in each Google Workspace account your sending domains belong to. IMAP must be on (Apps, Google Workspace, Gmail, End User Access).
5. Press **Use it for all Google inboxes**. Each one tests its sign-in. Google can take a while to apply a new delegation; a refused Google sign-in is tried again every 15 minutes, so the inbox starts working by itself once Google allows it.

Gmail gives a message sent through its API its own Message-ID, so the mailer reads back the one Gmail used and threads replies and follow-ups on it. A reply also names its Gmail thread, so conversations stay together in the sender's mailbox too. Google's sending limit pauses the inbox like an SMTP refusal does.

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

`npm test` runs eight files in `test/`: reply, bounce and opt-out detection against a fake mailbox; deployment guards; the start guards and setup-guide facts; an end-to-end pass in dry-run mode (sign-in, inboxes, PitchPersona webhook ingest, review, sequences and threading, pauses, inbox removal, unsubscribe and click links); a real sending pass against local mock SMTP, IMAP and OpenRouter servers (needs `openssl`); a stability pass (clean stop, restart mid-send, DNS failures, a mail server that stops answering, batched reading, lead search); and a feedback pass (plain-language reasons for real Gmail and Railway errors, a blocked sending port that blocks Start with the fix, logins re-tested once it connects or after a redeploy, and cycle summaries); and a Google sign-in pass against a mock Google token endpoint, Gmail API and XOAUTH2 IMAP (each setup mistake explained, a refused sign-in retried by itself, warm-up, replies and a campaign follow-up sent through the API with SMTP blocked, Gmail's Message-ID recorded, rate limits). Run it after any change before deploying.
