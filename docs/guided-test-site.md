# Guided test site

`mbot-test.themosscrew.com` is a second real React frontend for the existing mBot Studio backend, not a static prototype and not a second robot controller.

## Isolation and shared state

- Dedicated `mbot-studio-test` container built from `deploy/guided/Dockerfile`, separate `guided-test`/immutable `guided-<SHA>` image tags. The main site's `latest` tag and service are not touched by this branch workflow.
- Traefik HTTPS and the existing TinyAuth chain protect the entire test origin, including API and WebSocket upgrades. Same approved users as the main origin.
- Nginx proxies `/api/` and `/ws` to `mbot-studio:3001`. Docker DNS is re-resolved so main-backend recreation does not strand the proxy on an old container IP.
- One authoritative backend means the same live drive ownership, recording registry/transfers and emergency Stop govern both sites. Do not run an independent test MQTT controller on the production command topics.
- Robot, hardware configuration, server recordings, AI service and server diagnostics are shared. Actions on the test site can move the real robot or change its shared settings. A visible test banner explains this.
- Browser projects, profiles, badges and other localStorage remain separated by origin. They are not copied automatically from the main site. No data migration is performed by this UI deployment.
- Firmware is unchanged. Unsupported capabilities remain unsupported, not simulated successes.

## Build and deployment

The branch `feat/guided-test-site` publishes only the test image after unit and full isolated browser gates. The homelab Compose service should use an immutable `guided-<SHA>` tag and no public host port, with `t2_proxy` networking. Traefik file route targets `http://mbot-studio-test:8080`.

Health: `/test-health` verifies this frontend container; `/api/health` verifies the shared backend. Health endpoints remain behind TinyAuth on the public domain.

Rollback: return the test service to a previous immutable test tag, or remove only its route/service. No rollback of the primary UI, shared DATA_DIR or robot firmware is involved. Never merge this experimental UI branch into the production release line merely to build it.

## Acceptance

Verify actual served source revision, authenticated HTTPS, unauthorized redirects, API status/capabilities, WebSocket events, real editing/run/learning behavior, 0–100% click/hold controls and all existing recording/maintenance entry points. Use nonmoving commands for end-to-end proof by default. Compare the main container ID/start time/image before and after deployment; test-only recreation must not restart the main service.
