# Tesla Host

Tesla Host is an in-site bot setup console for the supplied [Tesla-bot repository](https://github.com/ignatiusmkuu-spec/Tesla-bot) and other compatible public GitHub repositories. Pair WhatsApp, configure a bot, then use **Deploy Now** to hand the draft to Tesla Host's protected admin review. Bot app creation is submitted from Tesla Host to Heroku through its server-side Platform API; the site does not send bot users to Heroku's generic deploy page.

## Run locally

Requires Node.js 22 or newer.

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm start
```

Open `http://localhost:3000`. The dependency-free Node server serves the website and same-origin admin APIs.

## Host Tesla Host on Vercel

The static interface is in `public/`. `vercel.json` rewrites the protected `/api/admin/*` endpoints to the single Node Function in `api/admin.js`. The function reuses the same bounded request parsing, authentication, same-origin and HTTPS checks, manifest pinning, billing acknowledgement, and safe Heroku API client used by the local/Heroku server.

Set the Vercel project's Node.js runtime to 22 or newer. In the **Production** environment, add `HEROKU_API_KEY` and `TESLA_HOST_ADMIN_PASSWORD` as encrypted environment variables. These values are required for the admin API; never put them in Git, client-side files, URLs, or build output. The Heroku key is used only by Tesla Host's server and is never forwarded to a bot. Deploy only after the Vercel project has the required credentials. No live Vercel deployment has been made yet.

## Admin configuration

Admin actions require two protected server-side values: `HEROKU_API_KEY` (a Heroku Platform API credential) and `TESLA_HOST_ADMIN_PASSWORD` (the admin-console password). Store both only in your hosting provider's secret/environment-variable store. Tesla Host's root `app.json` lists their names but no values.

## Deploy Tesla-bot or another bot inside Tesla Host

Pair using the supplied [phone-code](https://pair-tesla-md.onrender.com/pair) or [QR](https://pair-tesla-md.onrender.com/qr) page. Enter the bot app name, owner number(s), menu preference, bad-word list, and session. **Deploy Now** stages those values in the current browser tab and opens Tesla Host's protected admin section. Before sign-in and the final Deploy Now submission, Tesla Host does not receive the session; the draft is never put in a URL or browser storage. An authorized admin reviews the selected public GitHub repo, pinned source commit, configuration, buildpacks, post-deploy command, add-ons, and cost estimate, then acknowledges resource provisioning before the server submits to Heroku.

For another bot, enter its public `github.com` repository URL in the admin console. The repository needs a valid root `app.json` and must declare `SESSION`. Private GitHub repositories aren't supported by this public-tarball flow. Tesla Host resolves the selected branch to a commit, reads the manifest at that commit, and sends Heroku a tarball pinned to the same commit; if the branch moves before submission, deployment is rejected. Heroku app names must be globally unique, 3–30 lowercase letters/numbers/internal hyphens, and start with a letter.

On the final authorized submission, the session is sent over HTTPS to Tesla Host and forwarded to Heroku as the target app's `SESSION` config var. The server does not persist or log it, and the Heroku API key is never forwarded to a bot. `DATABASE_URL` is left to its declared add-on; generated secret fields are left for Heroku. The optional `HEROKU_API` bot variable is intentionally omitted, so a bot that needs an API token must be given a separate, least-privilege token directly in Heroku.

Tesla Host displays declared add-ons and asks for explicit authorization before provisioning. The supplied Tesla-bot requests Postgres Essential-0, listed at **US$5/month**; one continuously running Basic dyno is up to **US$7/month**. Budget roughly **US$12/month per bot** at 24/7 usage before tax and other charges. Other add-ons, account terms, use, and price changes may alter the bill. Review the current [Heroku usage and billing guide](https://devcenter.heroku.com/articles/usage-and-billing) before approving.

## Help

For Tesla Host deployment or setup help, use [WhatsApp support](https://wa.me/254706535581) or call [**+254 706 535 581**](tel:+254706535581). The pairing site also explains the WhatsApp pairing steps.

## Heroku website fallback

The site retains a `Procfile` and a separate, cost-gated Heroku Build API operator as an optional fallback. That operator has not been run; the current website-hosting target is Vercel.
