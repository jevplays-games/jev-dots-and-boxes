# Discord Activity mode

Dots and Boxes can run as a Discord Activity (Embedded App SDK). Discord loads the game in an iframe on
`https://<DISCORD_CLIENT_ID>.discordsays.com`, proxied to the game's own hostname. The normal browser flow is unchanged.

## What is different inside an Activity

- **Framing.** Only a document requested with Discord's `frame_id` query parameter is framed, and only by
  `https://discord.com`, `https://ptb.discord.com` and `https://canary.discord.com`. `X-Frame-Options` is dropped for that
  response and only the CSP `frame-ancestors` directive is replaced; the rest of the policy (`script-src 'self'` etc.) is kept.
  Every other page, and every `/api/*` response, stays `DENY` / `frame-ancestors 'none'`.
- **Sign-in.** `public/activity.js` (loaded only when `frame_id` is present) uses the vendored SDK
  (`public/vendor/discord-embedded-app-sdk.js`, `@discord/embedded-app-sdk` 2.5.0, MIT) to call `authorize` with scope `identify`,
  posts the code to `POST /api/activity/session`, then calls `authenticate`. The server exchanges the code **without**
  `redirect_uri` using the existing `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET`, upserts the user exactly like the OAuth
  callback, and issues a 24-hour session. The response carries a bearer token, the CSRF token and the Discord access token
  (returned once for `authenticate`; never stored).
- **Session transport.** Cookies are not sent inside the iframe, so the page keeps the bearer token in memory and sends
  `Authorization: Bearer <token>`. The server stores only its hash, as with cookie sessions.
- **Origin check.** `https://<DISCORD_CLIENT_ID>.discordsays.com` is accepted as the request Origin only for
  bearer-authenticated mutations. Cookie sessions still require `APP_ORIGIN`; the CSRF token is always required.
  `GET /api/activity/config` returns only the public client id.

Matches, ranked eligibility, idempotency, revision checks, leases, quotas and JEV provenance are untouched.

## Portal settings

In the Discord Developer Portal for this game's application:

1. Activities: enable Activities.
2. Activities > URL Mappings: prefix `/` -> target `dots-and-boxes.jevplay.games` (the game's hostname, no scheme).
3. OAuth2 needs no new redirect (the SDK code exchange sends none). Scope requested: `identify`.

Enabling Activities makes Discord create a primary **Entry Point** command. `npm run discord:register`
(`scripts/register-command.mjs`) POSTs only `/play` to the application command endpoint (create/upsert by name), so it does not
remove the Entry Point. If it is ever changed to a bulk overwrite (`PUT`), include the existing Entry Point command in the body.

`wrangler.jsonc` needs no change: the Worker already runs first for every path (`run_worker_first: true`), so it sees the
document request and can set the framing headers.
