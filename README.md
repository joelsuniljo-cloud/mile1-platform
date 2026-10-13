# Mile 1 platform

Your daily content desk. One login for you, one private link per client.

**The loop**

1. Write each client's brief once (voice, audience, content pillars).
2. Generate a calendar of ideas for 1 to 4 weeks. AI plans posts, carousels and reels.
3. Draft with AI, one item or all at once. Edit by hand, or type a change and let AI apply it. Earlier versions are kept.
4. **Client review** tab: pick the drafted items, send. Share the client's link by WhatsApp, email, or any message. The client needs no account.
5. The client approves, or writes what to change. You get a badge on the client and a card in the **Inbox**.
6. In the Inbox, accept or ignore each comment (you can reword the instruction), then press **Revise with AI**. The item comes back as "Revised".
7. Check it, press **Send for review again**. The client sees the new version, a note saying what changed, and approves.
8. Mark approved items as published.

## Run it on your computer (2 minutes)

You need Node 18 or newer. There is nothing to install.

```
cp .env.example .env      # then edit .env
node server.js
```

Open http://localhost:3000/platform/ (or `/` if you cleared `BASE_PATH`). Sign in with `ADMIN_EMAIL` and `ADMIN_PASSWORD` from `.env`.

Without `AI_API_KEY` the app runs in **demo mode**: the whole workflow works, but drafts are placeholders. Add a key to get real writing.

`npm test` runs three checks. The first is a 32-step run of the whole loop (login, calendar, draft, send, client comments, revision, resend, approve). The second checks the three AI provider settings. The third runs the loop again with a Redis database and the Vercel entry point.

## Which AI to use

Set `AI_PROVIDER` and `AI_API_KEY` in `.env`. You can change provider later without losing any data.

| Provider | `AI_PROVIDER` | Key from | Extra settings |
| --- | --- | --- | --- |
| Claude | `anthropic` | console.anthropic.com | none. Paid. Best writing and the most reliable structured output. |
| Google Gemini | `gemini` | aistudio.google.com | none. Has a free tier with daily limits. |
| Groq, OpenRouter, other OpenAI-style | `openai` | the service's website | `AI_BASE_URL` and `AI_MODEL` are required. Both services list free models. |

Things to know about free options:

- Free plans have request limits. A 4-week calendar plus "Draft all" for several clients can hit them. The app shows the service's message when that happens. Wait and retry.
- Free tiers may let the provider use your prompts to improve their products. Client briefs go into every prompt, so read each provider's current free-tier terms before using real client details.
- Free and smaller models follow instructions less closely. Expect more "The AI reply could not be read" errors and weaker reel scripts. If drafts disappoint, that is the first thing to change.
- Free offers, limits and model names change often. Check the provider's page for what is free today and which model name to put in `AI_MODEL`.

## Put it at mile1.co.in/platform (GitHub and Vercel)

Vercel cannot keep files between requests, so on Vercel this app keeps its data in a free Upstash Redis database instead. You set that up with a few clicks below. The app becomes its own Vercel project, and your website sends `/platform` to it. Your website code stays untouched except for two lines.

**1. Put the app on GitHub**
1. On github.com, click **New repository**. Name it `mile1-platform` and choose **Private**.
2. Unzip `mile1-platform.zip` on your computer. On the new repository page, click **uploading an existing file**, then drag in everything from inside the unzipped folder, including the `api` and `public` folders. `server.js` and `vercel.json` must sit at the top level of the repository.
3. Do not upload a `.env` file. Passwords and keys go into Vercel in step 3, never into GitHub.
4. Click **Commit changes**.

**2. Create the Vercel project**
1. In Vercel, click **Add New**, then **Project**, and import `mile1-platform`.
2. Framework Preset: **Other**. Leave everything else as it is. Click **Deploy**. It will deploy, but the app will say "Database not connected" until step 3 is done.

**3. Connect the database and settings**
1. Open the project, go to the **Storage** tab, and create a database from the Marketplace: **Upstash**, then **Redis**, free plan. Connect it to this project for all environments. Vercel adds the database settings by itself.
2. Go to **Settings**, then **Environment Variables**, and add these:

| Name | Value |
| --- | --- |
| `BASE_PATH` | `/platform` |
| `PUBLIC_URL` | `https://mile1.co.in` |
| `ADMIN_EMAIL` | your email |
| `ADMIN_PASSWORD` | a long password |
| `AI_PROVIDER` | `gemini` (or `anthropic`, or `openai`) |
| `AI_API_KEY` | your AI key |
| `COOKIE_SECURE` | `1` |

3. Go to **Deployments**, open the latest one, and click **Redeploy**. Settings only take effect on a new deployment.

**4. Check it on Vercel's own address**
Open `https://YOUR-PROJECT.vercel.app/platform/healthz`. You should see `{"ok":true,"storage":"redis"}`. Then open `https://YOUR-PROJECT.vercel.app/platform/` and sign in. Change the password.

**5. Make mile1.co.in/platform work**
In your website's repository, add these two rules to the rewrites, replacing `YOUR-PROJECT` with your project's name.

If the website has a `vercel.json`, add them inside `"rewrites"`. Put them first:

```
{ "source": "/platform", "destination": "https://YOUR-PROJECT.vercel.app/platform" },
{ "source": "/platform/:path*", "destination": "https://YOUR-PROJECT.vercel.app/platform/:path*" }
```

If the website is Next.js, put the same two in the `rewrites()` function of `next.config.js`. Commit. Once the website redeploys, open https://mile1.co.in/platform/.

If you would rather not touch the website, add `platform.mile1.co.in` under the project's **Settings, Domains** and use `platform.mile1.co.in/platform/` instead. Set `PUBLIC_URL` to match.

**If something goes wrong**
- *"Database not connected"*: finish step 3, then redeploy.
- *404 on `/platform/`*: `vercel.json` and `server.js` are probably inside a subfolder of the repository. Move them to the top level.
- *Vercel asks you to log in*: in the project, open **Settings, Deployment Protection** and turn it off for Production.
- *Works on vercel.app but not on mile1.co.in*: check that `PUBLIC_URL` and `BASE_PATH` are exactly as in the table, redeploy, and check the two website rules.
- *A calendar takes too long*: pick fewer weeks. Free AI services can be slow. The app allows up to 60 seconds per request.
- *To see errors*: Vercel project, **Logs**.

**Things to check on Vercel's side**
- The free Hobby plan is for personal, non-commercial use. An agency serving clients may need the Pro plan. Read Vercel's current terms.
- Upstash's free plan has a monthly command limit. The app is built to stay low: one command per 30-second check, and a few per action. Check Upstash's current free limits on their pricing page.

## Other hosting (cPanel or your own server)

On any host that runs Node.js 18+ continuously, the app needs no database. It keeps data in a file.

**cPanel with "Setup Node.js App":** upload the folder, then Create Application with Application root `mile1-platform`, Application URL `mile1.co.in` plus path `platform`, startup file `server.js`. Add the settings from `.env.example` in the same screen. Restart. Open `https://mile1.co.in/platform/`.

**Your own server with nginx:** run `node server.js` under a process manager (for example `pm2 start server.js --name mile1`) or use the `Dockerfile`. Set `BASE_PATH=/platform` and `PUBLIC_URL`. In your nginx server block:

```
location = /platform { return 301 /platform/; }
location /platform/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

## Settings (environment variables)

| Name | What it does |
| --- | --- |
| `BASE_PATH` | Public path, `/platform`. Empty if the app has its own domain. |
| `PUBLIC_URL` | Your site address, used in review links. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | First login. Only used the first time. Change the password in the app afterwards. |
| `AI_PROVIDER`, `AI_API_KEY` | Turns on real AI. See "Which AI to use". `ANTHROPIC_API_KEY` still works for Claude. |
| `AI_MODEL`, `AI_BASE_URL` | Model name, and the service address for `openai` style providers. Defaults: `claude-sonnet-5-5` for Claude, `gemini-2.5-flash` for Gemini. |
| `RESEND_API_KEY`, `MAIL_FROM`, `NOTIFY_EMAIL` | Optional. Lets the app email the review link, and email you when a client responds. |
| `DATA_DIR` | Where data is kept when using the file. Back this folder up. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Use a Redis database instead of the file. Vercel adds these (as `KV_REST_API_URL` and `KV_REST_API_TOKEN`) when you connect Upstash. The app understands both. |
| `SESSION_SECRET` | Optional. A long random text that signs logins. If empty, the app makes one and stores it. |
| `COOKIE_SECURE` | `1` when the site uses https. |

## Data and backups

On a normal server, everything lives in `data/db.json` (a copy is kept in `db.json.bak`). On Vercel it lives in the Upstash database. The **Backup** button in the app downloads all clients, items and comments as one file. This storage is plenty for a small agency. If you grow to many users or thousands of items, the storage layer is one small section of `server.js` and can be swapped for a database.

## Security notes

- Clients use a long random link. Anyone with the link can respond for that client, so send it only to them. **Reset link** (Client review tab) kills the old link.
- Client pages are marked no-index and show only items you have sent, and only the version you sent.
- Passwords are hashed. Sign-in is rate limited. The session cookie is HttpOnly.
- There is one agency login for now. To add teammates later, the `users` list in the data file already supports more than one.

## What has and has not been checked

- The whole workflow, both screens, and the data rules were run end to end in demo mode (32 server checks, 21 screen checks).
- Live AI calls for all three providers were checked against a fake AI server that copies each provider's request and reply format (7 checks). They have not been run against the real services, because no keys were available. The first real draft is the moment to confirm it. If it fails, the app shows the message from the AI service.
- Email through Resend is untested for the same reason.
- The Redis storage and the Vercel entry point were checked against a fake Upstash server and a copy of Vercel's rewrite rules (14 checks). They have not been run on a real Vercel project or a real Upstash database, so the deploy steps are the first real test. If a step fails, send me the message.
- It has not been deployed to your hosting.
