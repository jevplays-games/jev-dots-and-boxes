# External integration references

Official documentation consulted on 2026-09-22 while implementing the boundary contracts. These references describe external APIs; the test report separately identifies what was actually exercised.

- TypeSafe API, request/response schema and errors: https://docs.typesafe.ai/api
- TypeSafe Choice primitive and option semantics: https://docs.typesafe.ai/primitives/choice
- TypeSafe model identifiers: https://docs.typesafe.ai/models
- Discord OAuth2, authorization code flow and identify scope: https://docs.discord.com/developers/topics/oauth2
- Discord HTTP interactions, raw-body Ed25519 verification and interaction context: https://docs.discord.com/developers/interactions/receiving-and-responding
- Cloudflare static assets: https://developers.cloudflare.com/workers/static-assets/
- Cloudflare D1 database API: https://developers.cloudflare.com/d1/worker-api/d1-database/
- Cloudflare Workers Web Crypto: https://developers.cloudflare.com/workers/runtime-apis/web-crypto/

The included user's game brief and the preceding Dots and Boxes engineering plan supplied the product requirements. Runtime source and executed tests—not assumptions about a provider—define this package's implemented behavior. Credentials, application IDs, database IDs, public origin and actual deployment revision remain operator configuration.
