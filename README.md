# Oral Round NBBC

A static oral-round practice site hosted on GitHub Pages. Shared score history is
provided by a Cloudflare Worker and D1 database in `backend/`.

## Enable shared scores

1. Create a Cloudflare account at https://dash.cloudflare.com/sign-up (the backend
   can start on the Free plan, subject to Cloudflare usage limits).
2. In `backend/`, run `npm install` and `npx wrangler login`.
3. Run `npx wrangler d1 create oral-round-scores`. Copy the returned database ID
   into `database_id` in `wrangler.jsonc`.
4. Run `npx wrangler d1 execute oral-round-scores --remote --file=schema.sql`.
5. Run `npx wrangler secret put NETWORK_SECRET` and supply a long random secret.
   Keep this secret stable: changing it changes the network identifiers. Never put
   it in this repository or the frontend configuration.
6. Run `npm run deploy`. Copy the deployed HTTPS Worker URL into
   `window.SCORE_API_URL` in `../score-config.js` (no trailing `/rounds`).
7. Publish the frontend changes through the repository's GitHub Pages workflow.
   The existing GitHub Pages website URL stays the same.

The website continues using browser history until a Worker URL is configured.
`ALLOWED_ORIGIN` already matches `https://j-davidsm.github.io`.

## Behavior

- Completed rounds are retained locally and immediately submitted to the API.
- Opening Highscores or clicking Refresh retrieves the current network's selected
  division. Every statistic and problem-passage list uses that division.
- On service failure, Highscores explicitly labels its browser-only fallback.
- Import this browser’s past rounds explicitly shares local history with the
  current network. Open it from each browser containing older results. Persisted
  IDs make retries safe. Legacy records without a valid division are skipped.
- Failed uploads can be retried using Import on the intended network. Local rounds
  are never silently uploaded on a later visit from a different network.
- Shared passage details contain references, points, and error counts. The original
  local records retain their full per-word detail. Existing Formspree reporting is
  preserved independently of shared-score submission.

## Network identity and limitations

The API derives an HMAC identifier from Cloudflare's trusted `CF-Connecting-IP`
header. Raw IP addresses and location text are not stored in the score database.
The browser cannot choose a network identifier. The database indexes by network
and division; duplicate round IDs on the same network are ignored.

This is a shared network history, not an individual account. Anyone on the same
public IP can read and add scores. IP changes, carrier NAT, VPNs, and per-device
IPv6 addresses can cause histories to split or unrelated users to share one.
City geolocation is deliberately not used to identify households. A household
code or sign-in would be needed for reliable identity across IP changes.

Keep database credentials and NETWORK_SECRET on the server. CORS restricts browser
origins but is not user authentication. Submitted practice scores are self-reported.

## Checks

Run `npm test` in `backend/` for network/division isolation, validation, pagination,
configuration failures, and duplicate protection. These tests mock database access;
confirm the live integration after deployment by completing a round on one device
and refreshing the same division on a second device sharing its public IP.
