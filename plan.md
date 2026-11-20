# Tesla Host — implementation and design plan

## Product and implementation

Tesla Host is the place where bot setup and launch happen. The public Tesla-bot setup screen keeps WhatsApp pairing links and supported settings. **Deploy Now** stages the chosen repo, app name, owner number, preferences, and session in page memory, opens Tesla Host's protected admin section, and requires an authorized admin to review and submit the in-site Heroku setup. No bot launch redirects to a generic Heroku page. Other bots can be selected by entering a public GitHub repository with a root `app.json`; the admin form is derived from that manifest.

Resolve the selected branch to an immutable commit SHA and pin manifest inspection and the Heroku tarball to it. Before forwarding a session, recheck that the branch still points at the reviewed commit and refuse if it moved. Display required/optional variables, buildpacks, post-deploy commands, declared add-ons, app slug, and cost estimates before provisioning. Skip `DATABASE_URL` because its add-on supplies it. Never forward Tesla Host's Heroku API key as a bot variable. Return only setup ID/status and safe app metadata; allow read-only status refresh and account app inventory, not destructive actions.

**Hosting split:** deploy the Tesla Host website itself to Vercel. Keep public HTML/CSS/JavaScript as static files in `public/`; expose the protected Node admin API as a single Vercel Node Function under root `api/`. Keep `server.js` as the local/Heroku-compatible Node server and extract/reuse its admin request handler from both runtimes. Vercel's function routing must keep all existing authentication, HTTPS/same-origin, body-limit, manifest-pinning, no-log, and Heroku-resource-approval behavior. Heroku remains the target for bot apps, not for hosting the Tesla Host site. Do not run the old Heroku site-deployment operator.

The protected server values are `HEROKU_API_KEY` and `TESLA_HOST_ADMIN_PASSWORD`. For the deployed Vercel application, these values must be stored as production-only Vercel Secret environment variables; they must never appear in Git, function output, or browser code. Moving them from the current project secret store to Vercel requires the user's explicit authorization. The Vercel connector authorization request was declined, so no account operation may proceed until an authorized Vercel access path is available. Do not assume Vercel plan or cost.

The user requested a GitHub push, but the project's current canonical repository is Manus-managed. Use the platform's owner-confirmed canonical GitHub workflow to create a new private project repository only after its confirmation card is accepted. Do not overwrite the existing README-only `Tesla-host` repository or modify the supplied `Tesla-bot` repository.

The public draft-to-admin handoff is a same-page, in-memory browser event; it is never placed in a URL, browser storage, or a server request before the final admin click. The admin reviews the app manifest and resource acknowledgement before the one deployment request sends `SESSION` over HTTPS to Tesla Host and then to Heroku as the target app config var. The value is never persisted or logged. Show help contact `+254 706 535 581` with `tel:` and WhatsApp links. Keep pairing links at `https://pair-tesla-md.onrender.com/pair` and `/qr`, and keep the Tesla-bot repository link for review.

The Tesla-bot manifest requests `heroku-postgresql:essential-0`. Official Heroku billing documentation currently lists Essential-0 at US$5/month and one continuously running Basic dyno at up to US$7/month, so budget roughly US$12/month per Tesla-bot app at 24/7 usage before tax or other charges. Other repository add-ons must be reviewed at current plan prices. These are estimates, not guarantees.

The site uses semantic HTML, CSS, browser JavaScript, and a dependency-free Node HTTP server/function. Keep Node.js 22+, dynamic `PORT`, the Heroku `Procfile`, route manifest, and container declaration as local/Heroku fallbacks; add Vercel configuration without leaking secrets. Continue the existing Night Circuit visual language, with the clear cyan glow on Deploy Now and reduced-motion accessibility.

### Vercel research sources

- [Vercel Node.js Runtime](https://vercel.com/docs/functions/runtimes/node-js) — Node Functions, root `api/` structure, Node request/response compatibility, and pnpm lockfile detection.
- [Vercel Functions API reference](https://vercel.com/docs/functions/functions-api-reference) — function file routing and Web/Node handler options.
- [Vercel Git deployments](https://vercel.com/docs/git) — repository import and push-triggered deployments.
- [Vercel for GitHub](https://vercel.com/docs/git/vercel-for-github) — automatic GitHub deployments and private-repository access behavior.
- [Vercel environment variables](https://vercel.com/docs/environment-variables) — Secret values, runtime access, and production environment scope.

## Design

- **Design Movement:** Night Circuit, a midnight-blue technical console with crisp segmented surfaces and luminous cyan indicators.
- **Core Principles:** Keep the next action obvious; distinguish editable settings from sensitive credentials; show status only when known; put admin authorization and billing confirmation before provisioning.
- **Color Philosophy:** Deep navy reduces glare and supports an operational feel; cyan signals active routes and focus, mint indicates ready state, and amber marks billing or security cautions.
- **Layout Paradigm:** Keep the narrow fixed left rail and broad setup canvas; the admin workspace follows the same operational structure and collapses to a single-column flow on mobile.
- **Signature Elements:** The angular T-shaped circuit mark; fine technical dividers; compact numbered progress markers with cyan connection dots; a visibly illuminated but accessible Deploy Now button.
- **Interaction Philosophy:** Inline validation and memory-only draft transfer keep routine setup in the user's control; the protected admin flow makes its server-side credential and paid-resource handoffs explicit.
- **Animation:** Restrained, short transitions for focus, navigation, and ready feedback; a subtle cyan glow around Deploy Now; no looping motion or animation that obscures setup status. Honor `prefers-reduced-motion`.
- **Typography System:** Space Grotesk for brand and headings, a clean sans-serif system stack for body/UI, and DM Mono for identifiers and environment keys.
- **Brand Essence:** A practical, protective bot-deployment cockpit for people who want quick setup without hiding the security or billing implications.
- **Brand Voice:** Direct, calm, and precise. Examples: “Pair WhatsApp, then bring your session back here.” “Review add-ons before creating the Heroku app.” “Need help? WhatsApp +254 706 535 581.”
- **Wordmark & Logo:** “TESLA HOST” paired with the existing custom angular T-shaped circuit mark.
- **Signature Brand Color:** Luminous circuit cyan, `#51D7E8`.

## Project structure

- `public/index.html`: public Tesla-bot setup, in-site Deploy Now handoff, support contact, admin login, and workspace shell.
- `public/styles.css`: responsive Night Circuit components, glow/focus/reduced-motion states for Deploy Now, and admin form states.
- `public/app.js`: public validation and in-memory draft handoff; no Heroku redirect or URL prefill.
- `public/admin.js`: admin login, manifest-driven fields, pending draft fill-in, resource approval, deployment status, and in-memory handling of password/session values.
- `public/manus-routes.json`: actual page route; API endpoints and assets are excluded.
- `public/tesla-mark.svg`: Tesla Host identity.
- `server.js`: local/Heroku static server plus reusable admin API handler, security headers, authentication/body/rate controls, and safe API responses.
- `api/admin.js`: one Vercel Node Function for protected admin routes; `vercel.json` forwards the route suffix as a validated query parameter.
- `vercel.json`: Vercel function route and security headers.
- `lib/heroku-client.js`: server-only authenticated Heroku account status, app listing, App Setups, and polling.
- `lib/github-manifest.js`: strict public-repository parsing and commit-pinned `app.json` retrieval from GitHub's API.
- `app.json`: Tesla Host Heroku fallback manifest; declares names only, no secrets or add-ons.
- `scripts/deploy-site.js`: separate, cost-gated Heroku Build API operator retained only as an unused alternative.
- `test/admin-api.test.js`, `test/client-flow.test.js`, and `test/deploy-operator.test.js`: Node built-in security, route, handoff, provisioning, and cost-gate tests.
- `package.json`, `pnpm-lock.yaml`, `Procfile`, `Dockerfile`: runtime/toolchain and optional Heroku/container fallback.
- `README.md`: local use, Vercel hosting/secrets, admin flow, privacy boundaries, support contact, and bot billing.
- `plan.md`, `TODO.md`: product/design plan and outcome status.
- `app.config.ts`: project logo metadata with the durable HTTPS mark.
