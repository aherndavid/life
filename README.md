# Life - Student Edition

A single-page student planner by dPaul Studio: budget, food shop, tasks, deadlines, timetable, projects, grades, Google Calendar agenda, live trains and a focus timer. Everything is saved in the user's own browser. There's no server and no accounts.

Live copy: https://aherndavid.github.io/student/

This README is for whoever hosts a copy. People using the app don't need any of it: the How to use guide and the help in Settings cover them.

---

## 1. Hosting on GitHub Pages

1. Put `index.html` and the `assets` folder at the top level of the repo.
2. Keep an empty `.nojekyll` file at the top level, so GitHub publishes the files as they are.
3. Go to **Settings → Pages → Source → GitHub Actions** and use the **Static HTML** workflow.
4. Every push to `main` redeploys. The site is at `https://<username>.github.io/<repo>/`.

**Never commit a Python `venv` folder.** Its shortcut links make the Pages deploy fail within seconds. `.gitignore` already excludes `venv/`.

A private repo can publish Pages on GitHub Pro, and the published site is still public. Nothing secret lives in `index.html`.

## 2. Google Calendar (optional)

The client ID identifies the app, not a person. Create it once and every user signs in with their own Google account. Access is read-only (`calendar.readonly`).

1. At **console.cloud.google.com**, create a project, then enable **Google Calendar API** in APIs & Services → Library.
2. Set up **Google Auth Platform**:
   - **Branding:** set the app name to "Life - Student Edition" and add a support email.
   - **Audience:** choose **External**.
   - **Data access:** add the `.../auth/calendar.readonly` scope.
3. Go to **Clients → Create client → Web application**. Under **Authorised JavaScript origins**, add the live site's origin exactly, with no path and no trailing slash:
   - `https://aherndavid.github.io`
   - plus `https://dpaul.studio` or any other domain the app is served from
4. Paste the Client ID into `GOOGLE_CLIENT_ID` near the top of the script in `index.html`, then push.

### Letting other people connect

While the app is in **Testing**, only emails listed under **Audience → Test users** can connect, up to 100. Everyone else sees "Access blocked". Test users see a "Google hasn't verified this app" screen and press Continue.

To open it to anyone, press **Publish app** and complete Google's verification. For `calendar.readonly` (a sensitive scope) that's free, but it needs:
- a privacy policy page
- a homepage on a domain you've verified
- a short demo video

### Common errors

| What the user sees | Fix |
|---|---|
| Settings says "Not switched on yet" | `GOOGLE_CLIENT_ID` is empty in `index.html` |
| `Error 400: origin_mismatch` / "not a valid origin" | The origin in step 3 doesn't match the address bar exactly |
| "Access blocked" | Add their email to Test users, or publish the app |
| Agenda empty after connecting | They didn't tick the calendar permission box; connect again and tick it |

## 3. Live trains (optional)

National Rail data needs a private key, so the page talks to a small Cloudflare Worker (`trains-worker.js`). The Worker holds the key and returns the next 60 minutes of departures for a station. It also caches each station for 30 seconds, so every user shares the same lookups.

1. Sign up at **raildata.org.uk**, subscribe to **Live Departure Board**, and copy the **consumer key**.
2. In Cloudflare, go to **Workers & Pages → Create → Start with Hello World → Edit code**. Paste in `trains-worker.js` and press Deploy.
3. In the Worker's **Settings → Variables and Secrets**, add:
   - `RDM_KEY` (Secret): the consumer key
   - `ALLOWED_ORIGINS` (Text): `https://aherndavid.github.io,https://dpaul.studio`
4. Paste the Worker address (`https://….workers.dev`) into `TRAINS_PROXY_URL` in `index.html`, then push.

Test the Worker by opening `https://….workers.dev/departures/MCO` in a browser. You should see departure data.

Until `TRAINS_PROXY_URL` is set, the Today panel says live trains aren't switched on. The Live buses button works regardless: it opens TfGM's live departures page, and users can paste their own stop's link in Settings.

## 4. Updating

- Bump `APP_VERSION` and add a line to the version notes at the top of the script with every change.
- Commit and push to `main`. The Actions tab shows the deploy, and the site updates within a minute or two.
